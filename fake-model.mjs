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
import { appendFileSync } from "node:fs";

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

// with thinking on (Pi sends chat_template_kwargs.enable_thinking), the answer
// starts with a few lines of reasoning_content, as llama-server sends Qwen's
async function opening(res) {
  sse(res, chunk({ role: "assistant", content: "" }));
  for (const piece of (res.thought || "").match(/.{1,6}/gsu) || []) {
    sse(res, chunk({ reasoning_content: piece }));
    await sleep(40);
  }
}
async function streamText(res, text, usage, step = 25) {
  await opening(res);
  for (const piece of text.match(/.{1,6}/gsu) || []) {
    sse(res, chunk({ content: piece }));
    await sleep(step);
  }
  sse(res, chunk({}, "stop"));
  sse(res, { ...chunk({}, null, usage), choices: [] });
  res.write("data: [DONE]\n\n");
  res.end();
}
async function streamToolCall(res, name, args, usage) {
  await opening(res);
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

const failedAt = new Map(); // "끊김" message -> when its first try failed

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
  const last = messages[messages.length - 1] || {};
  // "끊김": the first try of each such message fails with a 503, as a dropped
  // GPU tunnel would (Pi retries it by itself, and the retry goes through)
  if (last.role === "user" && /(끊김|끊겨|dropped)/i.test(textOf(last.content))) {
    const key = `${messages.length}:${textOf(last.content)}`;
    // Pi's retry comes within seconds; the same words in a later test fail again
    if (!(Date.now() - (failedAt.get(key) || 0) < 10000)) {
      failedAt.set(key, Date.now());
      await sleep(400);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "503 Service Unavailable (fake)", type: "server_error" } }));
      return;
    }
  }
  // pictures come as image_url parts (Pi sends them as data URLs)
  const pictures = last.role === "user" && Array.isArray(last.content) ? last.content.filter((p) => p.type === "image_url").length : 0;
  const promptTokens = Math.round(JSON.stringify(messages).length / 3.2);
  const usage = { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  await sleep(300);

  // Pi's compaction asks for a summary of the conversation so far
  if (/summarization assistant/i.test(textOf(messages[0]?.content))) {
    await streamText(res, "## 목표\n가짜 모델로 RobinCode 창을 시험해요.\n\n## 한 일\n- 폴더의 파일을 읽고 목록을 봤어요.\n\n## 다음\n- robin이 다음에 시키는 것.", usage);
    return;
  }
  // what was asked for (sampling), for a test to read back
  if (process.env.ROBINCODE_FAKE_REQLOG) {
    const { temperature, top_p, top_k, min_p, presence_penalty, max_tokens, chat_template_kwargs } = request;
    appendFileSync(process.env.ROBINCODE_FAKE_REQLOG, `${JSON.stringify({ temperature, top_p, top_k, min_p, presence_penalty, max_tokens, thinking: !!chat_template_kwargs?.enable_thinking })}\n`);
  }
  const tools = (request.tools || []).map((t) => t.function?.name);
  const lastUser = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
  if (request.chat_template_kwargs?.enable_thinking) {
    res.thought = last.role === "tool"
      ? "결과를 받았어요.\n이걸로 충분한지 보고, 모자라면 하나 더 보고, 아니면 robin에게 짧게 정리해 주면 되겠어요."
      : `robin이 "${lastUser.slice(0, 30)}"라고 했어요.\n무엇을 먼저 봐야 할지 정리해 볼게요.\n폴더 안을 보고 필요한 파일을 읽은 다음 답하면 되겠어요.`;
  }
  // "같은 호출": ls "." again and again, as a model stuck in a loop does
  if (/(같은 호출|same call)/i.test(lastUser) && tools.includes("ls")) {
    const runs = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "tool").length;
    if (runs < 10) await streamToolCall(res, "ls", { path: "." }, usage);
    else await streamText(res, "열 번 불렀어요.", usage);
    return;
  }
  // "잘림": a long answer (not a loop) cut at max_tokens
  if (/(잘림|cut off)/i.test(lastUser)) {
    await opening(res);
    for (let i = 1; i <= 40; i++) { sse(res, chunk({ content: `${i}번째 문단은 다른 이야기를 해요. ` })); await sleep(10); }
    sse(res, chunk({}, "length"));
    sse(res, { ...chunk({}, null, usage), choices: [] });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
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
  const pointed = said.match(/@(\S+)/)?.[1];
  if (pictures) {
    await streamText(res, `그림 ${pictures}장을 받았어요. 가짜 모델이라 그림 안은 못 봐요.`, usage);
  } else if (/(긴 답|long answer)/i.test(said)) {
    // "긴 답": about 8 s of writing (a conversation that goes on while robin is in another)
    const words = "천천히 길게 답하는 중이에요. 다른 대화로 가도 이 답은 계속 써져요. ";
    await streamText(res, words.repeat(8), usage, 120);
  } else if (/^\(RobinCode 알림\)/.test(said) && !/계속 되풀이/.test(textOf([...messages].reverse().find((m) => m.role === "user" && !/^\(RobinCode 알림\)/.test(textOf(m.content)))?.content))) {
    // RobinCode cut a loop and said so: this time it answers
    await streamText(res, "되풀이를 멈추고 확인된 것만으로 답해요.", usage);
  } else if (/(되풀이|loop)/i.test(said)) {
    // "되풀이": the same thought over and over until max_tokens (finish
    // "length"), as the real model sometimes does with thinking on; with
    // thinking off in the answer ("계속 되풀이": again after RobinCode's note)
    sse(res, chunk({ role: "assistant", content: "" }));
    const field = request.chat_template_kwargs?.enable_thinking ? "reasoning_content" : "content";
    for (let i = 0; i < 600; i++) { sse(res, chunk({ [field]: "잠깐, 다시 확인해 볼게요. " })); await sleep(20); }
    sse(res, chunk({}, "length"));
    sse(res, { ...chunk({}, null, usage), choices: [] });
    res.write("data: [DONE]\n\n");
    res.end();
  } else if (/(끊김|끊겨|dropped)/i.test(said)) {
    await streamText(res, "다시 연결돼서 답해요. 첫 요청은 503으로 끊겼어요.", usage);
  } else if (pointed && tools.includes(pointed.endsWith("/") ? "ls" : "read")) {
    await streamToolCall(res, pointed.endsWith("/") ? "ls" : "read", { path: pointed }, usage);
  } else if (/(설명|구조|explain)/i.test(said) && tools.includes("ls")) {
    await streamToolCall(res, "ls", { path: "." }, usage);
  } else if (/(새 파일|new file)/i.test(said) && tools.includes("write")) {
    // "새 파일": writes notes.md (going back can take it away again)
    await streamToolCall(res, "write", { path: "notes.md", content: "# 메모\n\n가짜 모델이 쓴 파일이에요.\n" }, usage);
  } else if (/(고쳐|edit)/i.test(said) && tools.includes("edit")) {
    // "다르게 고쳐": another change to the same line (two branches, two READMEs)
    const line = /(다르게|differently)/i.test(said) ? "다르게 고친 판이에요." : "시험용 폴더예요.";
    await streamToolCall(res, "edit", { path: "README.md", edits: [{ oldText: "# rc-test", newText: `# rc-test\n\n${line}` }] }, usage);
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
