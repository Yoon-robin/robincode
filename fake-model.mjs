// A stand-in for the RobinAI GPU's llama-server, for building and testing
// RobinCode without renting the GPU (robin 2026-11-06: no model tests, the
// credit is nearly gone). It speaks the small part of the OpenAI chat
// completions API that Pi's "openai-completions" provider uses, streaming
// (SSE) only. Scripted turns: asked to read or list something it calls the
// matching tool first, then answers in Korean from the tool result; anything
// else gets a short canned answer. Never used with real data.
//
//   node fake-model.mjs [port]      (default 18093)
import { createServer } from "node:http";

const port = Number(process.argv[2] || process.env.ROBINCODE_FAKE_PORT || 18093);
const MODEL = "qwen3.8-27b-uncensored-aggressive";

function sse(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}
function chunk(delta, finish = null, usage) {
  const c = { id: "fake", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }] };
  if (usage) c.usage = usage;
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a longer scripted answer with the parts the window draws (heading, table,
// list, code), for looking at the window
const EXPLAIN = `작은 Node 프로젝트예요. 파일은 셋이에요.

### 구조

| 경로 | 하는 일 |
| --- | --- |
| \`package.json\` | 이름 \`rc-test\`, 판 1.0.0 |
| \`src/index.js\` | 시작 파일, 한 줄 출력 |
| \`README.md\` | 제목만 있어요 |

### 실행

\`\`\`powershell
node src\\index.js
\`\`\`

\`src/index.js\`는 이게 전부예요.

\`\`\`js
// prints a greeting
console.log("hi");
\`\`\`

- 의존성이 없어서 \`npm install\` 없이 바로 돌아가요.
- 시작 명령을 \`package.json\`의 \`scripts.start\`로 넣으면 \`npm start\`로 켤 수 있어요.`;

async function streamText(res, text, usage) {
  sse(res, chunk({ role: "assistant", content: "" }));
  for (const piece of text.match(/.{1,6}/gsu) || []) {
    sse(res, chunk({ content: piece }));
    await sleep(25);
  }
  sse(res, chunk({}, "stop"));
  sse(res, { ...chunk({}, null, usage), choices: [] });
  res.write("data: [DONE]\n\n");
  res.end();
}
async function streamToolCall(res, name, args, usage) {
  sse(res, chunk({ role: "assistant", content: "" }));
  const id = `call_${Math.random().toString(36).slice(2, 10)}`;
  const json = JSON.stringify(args);
  sse(res, chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }));
  for (const piece of json.match(/.{1,8}/gs) || []) {
    sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
    await sleep(15);
  }
  sse(res, chunk({}, "tool_calls"));
  sse(res, { ...chunk({}, null, usage), choices: [] });
  res.write("data: [DONE]\n\n");
  res.end();
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text || "").join("");
  return "";
}

createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/health" ? '{"status":"ok"}' : JSON.stringify({ data: [{ id: MODEL, object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404); res.end(); return;
  }
  let body = "";
  for await (const part of req) body += part;
  const request = JSON.parse(body);
  const messages = request.messages || [];
  const promptTokens = Math.round(JSON.stringify(messages).length / 3.2);
  const usage = { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  await sleep(300);

  const last = messages[messages.length - 1] || {};
  const tools = (request.tools || []).map((t) => t.function?.name);
  const lastUser = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
  // "둘러봐": six tool calls in a row, one per answer, then a short summary
  // (a long run of steps, which the window folds into one line once it ends)
  if (/(둘러|survey)/i.test(lastUser)) {
    const runs = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "tool").length;
    const plan = [["ls", { path: "." }], ["read", { path: "package.json" }], ["read", { path: "README.md" }],
      ["ls", { path: "src" }], ["read", { path: "src/index.js" }], ["ls", { path: "." }]];
    if (runs < plan.length && tools.includes(plan[runs][0])) await streamToolCall(res, plan[runs][0], plan[runs][1], usage);
    else await streamText(res, "폴더를 다 둘러봤어요. 파일은 셋이고, 시작 파일은 `src/index.js`예요.", usage);
    return;
  }
  if (last.role === "tool" && /(설명|구조|explain)/i.test(lastUser)) {
    await streamText(res, EXPLAIN, usage);
    return;
  }
  if (last.role === "tool") {
    const result = textOf(last.content);
    const lines = result.split("\n").filter(Boolean).length;
    await streamText(res, `확인했어요. 결과는 ${lines}줄이에요. 첫 줄은 \`${(result.split("\n")[0] || "").slice(0, 60)}\`예요.`, usage);
    return;
  }
  const said = textOf(last.content);
  if (/(설명|구조|explain)/i.test(said) && tools.includes("ls")) {
    await streamToolCall(res, "ls", { path: "." }, usage);
  } else if (/(고쳐|edit)/i.test(said) && tools.includes("edit")) {
    await streamToolCall(res, "edit", { path: "README.md", edits: [{ oldText: "# rc-test", newText: "# rc-test\n\n시험용 폴더예요." }] }, usage);
  } else if (/(목록|파일|ls|list)/i.test(said) && tools.includes("ls")) {
    await streamToolCall(res, "ls", { path: "." }, usage);
  } else if (/(읽|read|package\.json)/i.test(said) && tools.includes("read")) {
    await streamToolCall(res, "read", { path: "package.json" }, usage);
  } else if (/(명령|실행|run|command)/i.test(said) && (tools.includes("powershell") || tools.includes("bash"))) {
    const tool = tools.includes("powershell") ? "powershell" : "bash";
    // "느린 명령": prints a line every 0.35 s (the window shows them as they
    // come) and ends with a colour code (the window must not show it)
    const command = /(느린|천천|slow)/i.test(said)
      ? "1..10 | ForEach-Object { \"줄 $_\"; Start-Sleep -Milliseconds 350 }; \"$([char]27)[32m끝$([char]27)[0m\""
      : "Get-ChildItem -Name | Select-Object -First 3";
    await streamToolCall(res, tool, { command }, usage);
  } else {
    await streamText(res, "가짜 모델이에요. 화면 시험용으로 정해진 답만 해요.\n\n- 파일 목록을 물으면 `ls` 도구를 불러요.\n- `package.json`을 읽어 달라고 하면 `read` 도구를 불러요.\n\n```js\nconsole.log(\"RobinCode\");\n```", usage);
  }
}).listen(port, "127.0.0.1", () => console.log(`fake model on http://127.0.0.1:${port}/v1`));
