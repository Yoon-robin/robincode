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
  if (last.role === "tool") {
    const result = textOf(last.content);
    const lines = result.split("\n").filter(Boolean).length;
    await streamText(res, `확인했어요. 결과는 ${lines}줄이에요. 첫 줄은 \`${(result.split("\n")[0] || "").slice(0, 60)}\`예요.`, usage);
    return;
  }
  const said = textOf(last.content);
  if (/(고쳐|edit)/i.test(said) && tools.includes("edit")) {
    await streamToolCall(res, "edit", { path: "README.md", edits: [{ oldText: "# rc-test", newText: "# rc-test\n\n시험용 폴더예요." }] }, usage);
  } else if (/(목록|파일|ls|list)/i.test(said) && tools.includes("ls")) {
    await streamToolCall(res, "ls", { path: "." }, usage);
  } else if (/(읽|read|package\.json)/i.test(said) && tools.includes("read")) {
    await streamToolCall(res, "read", { path: "package.json" }, usage);
  } else if (/(명령|실행|run|command)/i.test(said) && (tools.includes("powershell") || tools.includes("bash"))) {
    const tool = tools.includes("powershell") ? "powershell" : "bash";
    await streamToolCall(res, tool, { command: "Get-ChildItem -Name | Select-Object -First 3" }, usage);
  } else {
    await streamText(res, "가짜 모델이에요. 화면 시험용으로 정해진 답만 해요.\n\n- 파일 목록을 물으면 `ls` 도구를 불러요.\n- `package.json`을 읽어 달라고 하면 `read` 도구를 불러요.\n\n```js\nconsole.log(\"RobinCode\");\n```", usage);
  }
}).listen(port, "127.0.0.1", () => console.log(`fake model on http://127.0.0.1:${port}/v1`));
