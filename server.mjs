// RobinCode app: our own coding agent window on the RobinAI GPU model.
//
// The agent itself is Pi (@earendil-works/pi-coding-agent, MIT): its session,
// tools (read, edit, write, grep, find, ls, powershell), compaction and saved
// conversations. Everything around it is ours: the model connection, Korean
// instructions, asking before commands and file changes, and the RobinX
// window (ui/), served on 127.0.0.1 and opened as a Chromium app window
// (Edge, Chrome or Brave, its own profile so closing it ends this process).
//
//   node server.mjs [folder] [--fake] [--no-window] [--port N]
//
// --fake talks to fake-model.mjs instead of the GPU (no rented GPU needed).
// The GPU model: an open RobinCode tunnel on 127.0.0.1:8091 is reused, else
// this opens its own `ssh -L 127.0.0.1:18092 -> VPS 127.0.0.1:8091`; the key
// comes from `ssh contabo cat /root/.vastai-llama-key` into memory only.
// docs/robincode-app.md.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const FAKE = flag("--fake");
const NO_WINDOW = flag("--no-window");
const cwd = resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") || process.cwd());
const MODEL_ID = "qwen3.8-27b-uncensored-aggressive";
// ROBINCODE_HOME moves settings, saved conversations and the window profile (tests)
const appDir = process.env.ROBINCODE_HOME || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "RobinCode");
const agentDir = join(appDir, "agent");
mkdirSync(agentDir, { recursive: true });

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(file, argv, timeout = 30000) {
  return new Promise((done) => {
    execFile(file, argv, { timeout, windowsHide: true, encoding: "utf8" }, (error, stdout) => done({ ok: !error, out: stdout || "" }));
  });
}
async function health(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

// ---- the model: fake, an open RobinCode tunnel, or our own -------------------
const children = [];
let modelPort;
let apiKey;
async function connectModel() {
  if (FAKE) {
    modelPort = 18093;
    if (!(await health(modelPort))) {
      children.push(spawn(process.execPath, [join(here, "fake-model.mjs"), String(modelPort)], { stdio: "ignore", windowsHide: true }));
      for (let i = 0; i < 40 && !(await health(modelPort)); i++) await sleep(100);
    }
    apiKey = "fake";
    return;
  }
  const key = await run("ssh", ["-n", "-o", "BatchMode=yes", "contabo", "cat /root/.vastai-llama-key"]);
  apiKey = key.out.trim();
  if (!key.ok || !apiKey) throw new Error("모델 서버 키를 읽지 못했어요(ssh contabo).");
  if (await health(8091)) { modelPort = 8091; return; }
  modelPort = 18092;
  if (!(await health(modelPort))) {
    children.push(spawn("ssh", ["-N", "-n", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${modelPort}:127.0.0.1:8091`, "contabo"], { stdio: "ignore", windowsHide: true }));
  }
}

// ---- GPU state from the server, every minute (no model use) ------------------
let gpu = { state: "unknown" };
function parseGpu(text) {
  const g = { state: "off" };
  for (const l of text.split(/\r?\n/)) {
    let m;
    if ((m = l.match(/^GPU 서버: (\S+)/))) g.state = /^켜져/.test(m[1]) ? "on" : /^켜는/.test(m[1]) ? "starting" : /^멈춰/.test(m[1]) ? "stopped" : "off";
    if ((m = l.match(/^요금: 켜 둔 동안 시간당 \$([\d.]+)/))) g.rate = m[1];
    if ((m = l.match(/^남은 크레딧: \$([\d.]+)/))) g.credit = m[1];
    if ((m = l.match(/^남은 크레딧:.*약 (\d+)(분|시간|일)\s*$/))) {
      g.left = `약 ${m[1]}${m[2]}`;
      g.hours = m[2] === "분" ? 0 : m[2] === "일" ? Number(m[1]) * 24 : Number(m[1]);
    }
  }
  return g;
}
async function refreshGpu() {
  const r = await run("ssh", ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "contabo", "robinai-gpu status"], 40000);
  if (r.ok && /GPU 서버: /.test(r.out)) gpu = parseGpu(r.out);
  else if (gpu.state === "unknown") gpu = { state: "unreachable" };
  broadcast({ t: "gpu", gpu, fake: FAKE });
}

// ---- the agent ---------------------------------------------------------------
const KOREAN = `## RobinCode
- 사용자는 robin이에요. 답은 한국어 해요체로 짧고 분명하게 써요. 코드, 명령, 파일 이름, 식별자는 그대로 둬요.
- 이 PC는 Windows예요. 명령은 powershell 도구(Windows PowerShell 5.1)로 실행해요. 파일 경로는 Windows 경로를 써요.
- 파일을 고치기 전에 먼저 읽고, 고친 뒤에는 무엇을 바꿨는지 한두 줄로 말해요.
- 모르는 건 지어내지 말고 확인하거나 모른다고 말해요.`;

let session;
let runtime;
let mode = "ask"; // ask: commands and file changes wait for a yes; auto: run everything
const pending = new Map(); // toolCallId -> resolve(decision)
const ASK_TOOLS = new Set(["powershell", "bash", "edit", "write"]);

const approvals = {
  name: "robincode-approvals",
  hidden: true,
  factory: (pi) => {
    pi.on("tool_call", async (event) => {
      if (mode === "auto" || !ASK_TOOLS.has(event.toolName)) return undefined;
      broadcast({ t: "approve", id: event.toolCallId, name: event.toolName, args: event.input });
      const decision = await new Promise((r) => pending.set(event.toolCallId, r));
      pending.delete(event.toolCallId);
      if (decision === "always") { mode = "auto"; broadcast({ t: "mode", mode }); return undefined; }
      if (decision === "yes") return undefined;
      return { block: true, reason: "robin이 이 도구 호출을 허락하지 않았어요. 다른 방법을 물어보거나 멈추세요." };
    });
  },
};

async function startSession(sessionManager) {
  if (!runtime) {
    // models.json for our one provider; the key is set at runtime, never written
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        robinai: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          api: "openai-completions",
          apiKey: "set-at-runtime",
          compat: { thinkingFormat: "qwen-chat-template", supportsDeveloperRole: false, maxTokensField: "max_tokens" },
          models: [{
            id: MODEL_ID, name: "Qwen3.8-27B (RobinAI GPU)", reasoning: true, input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            // the GPU's 262144-token pool is shared by two slots and RobinAI chat
            contextWindow: 131072, maxTokens: 16384,
          }],
        },
      },
    }, null, 2));
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
    await runtime.setRuntimeApiKey("robinai", apiKey);
  }
  const model = runtime.getModel("robinai", MODEL_ID);
  if (!model) throw new Error("모델 설정을 읽지 못했어요.");
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir,
    appendSystemPromptOverride: (base) => [...base, KOREAN],
    extensionFactories: [approvals],
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: "off", resourceLoader,
    tools: ["read", "edit", "write", "grep", "find", "ls", "powershell"],
    sessionManager: sessionManager || SessionManager.create(cwd, sessionDir),
  });
  session?.dispose();
  session = created.session;
  session.subscribe(onEvent);
  broadcast({ t: "reset", state: state() });
}

const clip = (s, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 더)` : s);
const textOf = (content) => (typeof content === "string" ? content
  : (content || []).map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[그림]" : "")).join(""));

function onEvent(e) {
  switch (e.type) {
    case "message_start":
      if (e.message.role === "user") broadcast({ t: "user", text: textOf(e.message.content) });
      if (e.message.role === "assistant") broadcast({ t: "assistant_start" });
      break;
    case "message_update": {
      const a = e.assistantMessageEvent;
      if (a.type === "text_delta") broadcast({ t: "text", delta: a.delta });
      if (a.type === "thinking_delta") broadcast({ t: "thinking", delta: a.delta });
      break;
    }
    case "message_end":
      if (e.message.role === "assistant") {
        const m = e.message;
        // a stop by robin ends as "aborted" and gets its own [SKIP] line on settle
        if (m.stopReason === "error") broadcast({ t: "error", message: m.errorMessage || "모델이 오류로 끝났어요." });
        broadcast({ t: "assistant_end", context: contextUsage() });
      }
      break;
    case "tool_execution_start":
      broadcast({ t: "tool_start", id: e.toolCallId, name: e.toolName, args: e.args });
      break;
    case "tool_execution_end":
      broadcast({ t: "tool_end", id: e.toolCallId, name: e.toolName, isError: e.isError,
        output: clip(textOf(e.result?.content)), ms: e.durationMs });
      break;
    case "compaction_start": broadcast({ t: "compaction", phase: "start" }); break;
    case "compaction_end": broadcast({ t: "compaction", phase: "end", aborted: e.aborted, context: contextUsage() }); break;
    case "agent_settled": broadcast({ t: "settled", aborted: e.aborted, context: contextUsage() }); break;
  }
}
// Pi compacts once the context passes the window minus its reserve (16384 by
// default), so the bar is full at that point, not at the window's end
const RESERVE = 16384;
function contextUsage() {
  try {
    const u = session?.getContextUsage();
    if (!u || u.tokens == null) return null;
    const limit = Math.max(1, u.contextWindow - RESERVE);
    return { tokens: u.tokens, window: u.contextWindow, limit, percent: Math.min(100, Math.round((u.tokens / limit) * 100)) };
  } catch { return null; }
}
function history() {
  const out = [];
  for (const m of session?.messages || []) {
    if (m.role === "user") out.push({ role: "user", text: textOf(m.content) });
    else if (m.role === "assistant") {
      out.push({ role: "assistant",
        text: (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join(""),
        tools: (m.content || []).filter((p) => p.type === "toolCall").map((p) => ({ id: p.id, name: p.name, args: p.arguments })),
        error: m.stopReason === "error" ? m.errorMessage : undefined });
    } else if (m.role === "toolResult") out.push({ role: "tool", id: m.toolCallId, name: m.toolName, isError: m.isError, output: clip(textOf(m.content)) });
  }
  return out;
}
const titleOf = (text) => text.replace(/\s+/g, " ").trim().slice(0, 80);
const state = () => {
  const first = (session?.messages || []).find((m) => m.role === "user");
  return {
    cwd, folder: basename(cwd) || cwd, model: "Qwen3.8-27B", fake: FAKE, gpu, mode,
    busy: !!session?.isStreaming, context: contextUsage(), history: history(),
    sessionFile: session?.sessionFile || null, title: first ? titleOf(textOf(first.content)) : "",
  };
};
const sessionDir = join(agentDir, "sessions");
async function listSessions() {
  const list = await SessionManager.list(cwd, sessionDir);
  return list
    .filter((x) => x.messageCount > 0)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 60)
    .map((x) => ({ path: x.path, title: titleOf(x.name || x.firstMessage || "제목 없음"), modified: x.modified.getTime(), count: x.messageCount }));
}

// ---- the window's HTTP side ----------------------------------------------------
const token = randomBytes(18).toString("base64url");
const clients = new Set();
// the server ends when its window does; watching the browser process would not
// do, since a second RobinCode's browser hands its window to the first one's
// process (same profile) and exits at once
const EXIT_WHEN_CLOSED = !NO_WINDOW || flag("--exit-when-closed");
let closeTimer;
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000).unref();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
// the window is the React app in web/, built into web/dist (npm run build)
const DIST = join(here, "web", "dist");
const SHARED = {
  "/fonts/pretendard-latin.woff2": join(here, "..", "assets", "pretendard-latin.woff2"),
  "/fonts/robin-term.woff2": join(here, "..", "assets", "robin-term.woff2"),
  "/favicon.ico": join(here, "..", "assets", "favicon.ico"),
};
function staticFile(pathname) {
  if (SHARED[pathname]) return SHARED[pathname];
  const file = resolve(DIST, `.${pathname === "/" ? "/index.html" : decodeURIComponent(pathname)}`);
  return file.startsWith(DIST + sep) && existsSync(file) ? file : null;
}
async function readJson(req) {
  let body = "";
  for await (const part of req) { body += part; if (body.length > 1e6) throw new Error("too large"); }
  return body ? JSON.parse(body) : {};
}
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

let port;
const server = createServer(async (req, res) => {
  // only this machine, only our own page: a web page elsewhere could otherwise
  // reach 127.0.0.1 and drive an agent that runs commands
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403); res.end(); return; }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const file = req.method === "GET" && !url.pathname.startsWith("/api/") ? staticFile(url.pathname) : null;
  if (file) {
    try {
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'" });
      res.end(readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (!url.pathname.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
  if ((req.headers["x-robincode-token"] || url.searchParams.get("t")) !== token) { send(res, 401, { error: "token" }); return; }
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ t: "reset", state: state() })}\n\n`);
      clients.add(res);
      clearTimeout(closeTimer);
      req.on("close", () => {
        clients.delete(res);
        // the window is gone (a reload reconnects within a second or two)
        if (EXIT_WHEN_CLOSED && clients.size === 0) {
          closeTimer = setTimeout(() => { if (!clients.size) { log("창이 닫혀서 끝내요."); shutdown(); } }, 10000);
        }
      });
      return;
    }
    if (req.method !== "POST") { send(res, 405, {}); return; }
    const body = await readJson(req);
    switch (url.pathname) {
      case "/api/prompt": {
        const text = String(body.text || "").trim();
        if (!text) { send(res, 400, { error: "empty" }); return; }
        if (session.isStreaming) await session.followUp(text);
        else session.prompt(text).catch((e) => broadcast({ t: "error", message: e.message }));
        send(res, 200, { ok: true });
        return;
      }
      case "/api/abort":
        for (const resolveDecision of pending.values()) resolveDecision("no");
        await session.abort();
        send(res, 200, { ok: true });
        return;
      case "/api/approve": {
        const decide = pending.get(String(body.id));
        if (decide) decide(["yes", "no", "always"].includes(body.decision) ? body.decision : "no");
        send(res, 200, { ok: !!decide });
        return;
      }
      case "/api/mode":
        mode = body.mode === "auto" ? "auto" : "ask";
        broadcast({ t: "mode", mode });
        send(res, 200, { mode });
        return;
      case "/api/sessions":
        send(res, 200, { sessions: await listSessions(), current: session?.sessionFile || null });
        return;
      case "/api/open": {
        if (session.isStreaming) { send(res, 409, { error: "busy" }); return; }
        // only a conversation from our own list, never a path the page made up
        const found = (await listSessions()).find((x) => x.path === body.path);
        if (!found) { send(res, 404, { error: "no such conversation" }); return; }
        mode = "ask";
        await startSession(SessionManager.open(found.path, sessionDir));
        send(res, 200, { ok: true });
        return;
      }
      case "/api/new":
        mode = "ask"; // "allow all" was for that conversation only
        await startSession(SessionManager.create(cwd, sessionDir));
        send(res, 200, { ok: true });
        return;
      case "/api/gpu-on":
        // renting costs robin money: this only opens the on/off helper's menu, where robin picks
        spawn("cmd.exe", ["/c", "start", "RobinAI GPU", join(here, "..", "ops", "windows", "robinai-gpu.cmd")], { detached: true, stdio: "ignore" }).unref();
        send(res, 200, { ok: true });
        return;
      default: send(res, 404, {});
    }
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// ---- the window ------------------------------------------------------------------
function findBrowser() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const apps = ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe",
    "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
  for (const app of apps) for (const root of roots) { const p = join(root, app); if (existsSync(p)) return p; }
  return null;
}
function openWindow(url) {
  const browser = findBrowser();
  if (!browser) { log("앱 창을 띄울 브라우저(Edge·Chrome·Brave)가 없어요. 이 주소를 여세요:", url); return; }
  const win = spawn(browser, [`--app=${url}`, `--user-data-dir=${join(appDir, "window")}`, "--window-size=1180,860",
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"], { stdio: "ignore", detached: true });
  win.on("error", (e) => log("창을 띄우지 못했어요:", e.message, "이 주소를 여세요:", url));
  win.unref();
}

function shutdown() {
  for (const resolveDecision of pending.values()) resolveDecision("no");
  for (const c of children) { try { c.kill(); } catch { } }
  try { session?.abort(); session?.dispose(); } catch { }
  process.exit(0);
}
process.on("SIGINT", shutdown);

try {
  await connectModel();
  await startSession();
  port = Number(option("--port")) || 0;
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  port = server.address().port;
  const url = `http://127.0.0.1:${port}/#t=${token}`;
  log(`RobinCode ${FAKE ? "(가짜 모델) " : ""}폴더 ${cwd}`);
  log(`창 주소: ${url}`);
  refreshGpu();
  setInterval(refreshGpu, 60000).unref();
  if (!NO_WINDOW) openWindow(url);
} catch (e) {
  console.error(`[FAIL] ${e.message}`);
  shutdown();
}
