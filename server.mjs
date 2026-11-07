// RobinCode app: our own coding agent window on the RobinAI GPU model.
//
// The agent itself is Pi (@earendil-works/pi-coding-agent, MIT): its session,
// tools (read, edit, write, grep, find, ls, powershell), compaction and saved
// conversations. Everything around it is ours: the model connection, Korean
// instructions, asking before commands and file changes, and the RobinX
// window (web/, React), served on 127.0.0.1 and opened as a Chromium app window
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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
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
- 모르는 건 지어내지 말고 확인하거나 모른다고 말해요.
- robin이 \`@경로\`로 가리킨 파일·폴더는 이 폴더 기준 경로예요. 필요하면 먼저 read·ls로 봐요.`;

let session;
let runtime;
let mode = "ask"; // ask: commands and file changes wait for a yes; auto: run everything
// the window's own settings (thinking on/off), in RobinCode's folder
const settingsFile = join(appDir, "robincode.json");
let settings = {};
try { settings = JSON.parse(readFileSync(settingsFile, "utf8")) || {}; } catch { /* first run */ }
const saveSettings = () => { try { writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { log("설정을 저장하지 못했어요:", e.message); } };
// Qwen thinks before it answers (Pi sends chat_template_kwargs.enable_thinking):
// slower, better on hard work. Off unless robin turns it on
const THINK_LEVEL = "medium";
const thinkingLevel = () => (settings.thinking ? THINK_LEVEL : "off");
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
    cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: thinkingLevel(), resourceLoader,
    tools: ["read", "edit", "write", "grep", "find", "ls", "powershell"],
    sessionManager: sessionManager || SessionManager.create(cwd, sessionDir),
  });
  session?.dispose();
  session = created.session;
  // a turn cut off by the switch must not lend its start to the next one
  turn = null;
  gen = null;
  // an old conversation may have saved another level: robin's choice wins
  if (session.thinkingLevel !== thinkingLevel()) session.setThinkingLevel(thinkingLevel());
  session.subscribe(onEvent);
  broadcast({ t: "reset", state: state() });
}

const clip = (s, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 더)` : s);
// the end of a command's output while it still runs (the window shows the last lines)
const tail = (s, n = 4000) => (s.length > n ? `…\n${s.slice(-n)}` : s);
// colour and cursor codes from commands would show up as junk in the window
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// colour codes out, CRLF to LF, and a line redrawn with a bare CR (progress)
// keeps only what was drawn last
const plain = (s) => s.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/[^\n]*\r(?=[^\n])/g, "");
const textOf = (content) => (typeof content === "string" ? content
  : (content || []).map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[그림]" : "")).join(""));
// robin's own words, and the pictures robin attached (drawn in the window)
const wordsOf = (content) => (typeof content === "string" ? content
  : (content || []).filter((p) => p.type === "text").map((p) => p.text).join(""));
const imagesOf = (content) => (Array.isArray(content)
  ? content.filter((p) => p.type === "image").map((p) => ({ mimeType: p.mimeType, data: p.data })) : []);

// a turn (robin's message until the agent settles): how long it took, and the
// model's speed, from each answer's first token to its end
let turn = null;
let gen = null;
const STREAMED = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
function onEvent(e) {
  switch (e.type) {
    case "message_start":
      if (e.message.role === "user") {
        turn ??= { start: Date.now(), tokens: 0, genMs: 0 };
        broadcast({ t: "user", text: wordsOf(e.message.content), images: imagesOf(e.message.content) });
      }
      if (e.message.role === "assistant") { gen = { first: 0 }; broadcast({ t: "assistant_start" }); }
      break;
    case "message_update": {
      const a = e.assistantMessageEvent;
      if (gen && !gen.first && STREAMED.has(a.type)) gen.first = Date.now();
      if (a.type === "text_delta") broadcast({ t: "text", delta: a.delta });
      if (a.type === "thinking_delta") broadcast({ t: "thinking", delta: a.delta });
      break;
    }
    case "message_end":
      if (e.message.role === "assistant") {
        const m = e.message;
        if (turn && gen?.first && m.stopReason !== "error") {
          turn.tokens += m.usage?.output || 0;
          turn.genMs += Date.now() - gen.first;
        }
        gen = null;
        // a stop by robin ends as "aborted" and gets its own [SKIP] line on settle
        if (m.stopReason === "error") broadcast({ t: "error", message: m.errorMessage || "모델이 오류로 끝났어요." });
        broadcast({ t: "assistant_end", context: contextUsage() });
      }
      break;
    case "tool_execution_start":
      broadcast({ t: "tool_start", id: e.toolCallId, name: e.toolName, args: e.args });
      break;
    case "tool_execution_update": {
      // powershell / bash send what they have so far (Pi throttles these)
      const so = plain(textOf(e.partialResult?.content));
      if (so) broadcast({ t: "tool_update", id: e.toolCallId, output: tail(so) });
      break;
    }
    case "tool_execution_end":
      broadcast({ t: "tool_end", id: e.toolCallId, name: e.toolName, isError: e.isError,
        output: clip(plain(textOf(e.result?.content))), ms: e.durationMs });
      break;
    // Pi retries a request that failed on the way (503, connection lost, …)
    // by itself, up to 3 times; the failed answer is dropped from the context
    case "auto_retry_start":
      broadcast({ t: "retry", attempt: e.attempt, max: e.maxAttempts, delayMs: e.delayMs, error: e.errorMessage });
      break;
    case "auto_retry_end": broadcast({ t: "retry_end", success: e.success }); break;
    case "compaction_start": broadcast({ t: "compaction", phase: "start", reason: e.reason }); break;
    case "compaction_end":
      broadcast({ t: "compaction", phase: "end", aborted: e.aborted, error: !e.aborted && !e.result ? compactionError(e.errorMessage) : undefined,
        context: contextUsage() });
      if (e.result && !session.isStreaming) broadcast({ t: "reset", state: state(), quiet: true });
      break;
    case "agent_settled": {
      const stats = turn && {
        ms: Date.now() - turn.start,
        tokens: turn.tokens,
        // under a second of output says nothing about the speed
        tps: turn.genMs >= 1000 && turn.tokens ? Math.round(turn.tokens / (turn.genMs / 1000)) : null,
      };
      turn = null;
      // kept in the conversation's file (not seen by the model), so the
      // window shows it again when the conversation is opened later
      if (stats && !e.aborted) {
        try { session.sessionManager.appendCustomEntry(STATS, stats); } catch (err) { log("시간을 남기지 못했어요:", err.message); }
      }
      broadcast({ t: "settled", aborted: e.aborted, context: contextUsage(), stats,
        users: branch().filter((x) => x.type === "message" && x.message.role === "user").map((x) => x.id) });
      break;
    }
  }
}
const STATS = "robincode-stats";
// Pi's reasons for not compacting, said plainly
function compactionError(message = "") {
  if (/too small/i.test(message)) return { small: true, message: "아직 줄일 만큼 길지 않아요." };
  if (/Already compacted/i.test(message)) return { small: true, message: "방금 줄여서 더 줄일 게 없어요." };
  return { message: `요약하지 못했어요: ${message.replace(/^Compaction failed:\s*/, "")}` };
}
// Pi compacts once the context passes the window minus its reserve (16384 by
// default), so the bar is full at that point, not at the window's end
const RESERVE = 16384;
function contextUsage() {
  try {
    const u = session?.getContextUsage();
    if (!u) return null;
    // right after a compaction Pi has no count until the next answer: a rough one
    const approx = u.tokens == null;
    const tokens = approx ? (session.messages || []).reduce((n, m) => n + estimateTokens(m), 0) : u.tokens;
    if (!tokens) return null;
    const limit = Math.max(1, u.contextWindow - RESERVE);
    return { tokens, window: u.contextWindow, limit, percent: Math.min(100, Math.round((tokens / limit) * 100)), approx };
  } catch { return null; }
}
function branch() {
  try { return session?.sessionManager.getBranch() || []; } catch { return []; }
}
function history() {
  const out = [];
  const entries = branch();
  const compaction = entries.findLast((x) => x.type === "compaction");
  const kept = compaction ? entries.findIndex((x) => x.id === compaction.firstKeptEntryId) : -1;
  entries.forEach((entry, k) => {
    const key = entry.id;
    const old = k < kept;
    if (entry.type === "compaction") { out.push({ role: "compaction", key, faded: kept > 0 }); return; }
    if (entry.type === "custom" && entry.customType === STATS) { out.push({ role: "stats", key, stats: entry.data }); return; }
    if (entry.type !== "message") return;
    const m = entry.message;
    if (m.role === "user") out.push({ role: "user", key, old, id: entry.id, text: wordsOf(m.content), images: imagesOf(m.content) });
    else if (m.role === "assistant") {
      out.push({ role: "assistant", key, old,
        thinking: (m.content || []).filter((p) => p.type === "thinking" && !p.redacted).map((p) => p.thinking).join("").trim(),
        text: (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join(""),
        tools: (m.content || []).filter((p) => p.type === "toolCall").map((p) => ({ id: p.id, name: p.name, args: p.arguments })),
        error: m.stopReason === "error" ? m.errorMessage : undefined });
    } else if (m.role === "toolResult") out.push({ role: "tool", key, old, id: m.toolCallId, name: m.toolName, isError: m.isError, output: clip(plain(textOf(m.content))) });
  });
  return out;
}
const titleOf = (text) => text.replace(/\s+/g, " ").trim().slice(0, 80);
const busyNow = () => !!(session?.isStreaming || session?.isCompacting);
const state = () => {
  const first = branch().find((x) => x.type === "message" && x.message.role === "user")?.message;
  const firstWords = first ? titleOf(wordsOf(first.content)) : "";
  return {
    cwd, folder: basename(cwd) || cwd, model: "Qwen3.8-27B", fake: FAKE, gpu, mode, thinking: !!settings.thinking,
    busy: busyNow(), compacting: !!session?.isCompacting, context: contextUsage(), history: history(),
    sessionFile: session?.sessionFile || null,
    // a name robin gave it, else its first message
    title: session?.sessionName || firstWords || (first ? "그림" : ""),
  };
};
const sessionDir = join(agentDir, "sessions");
async function allSessions() {
  return (await SessionManager.list(cwd, sessionDir))
    .filter((x) => x.messageCount > 0)
    .sort((a, b) => b.modified - a.modified);
}
const brief = (x) => ({ path: x.path, title: titleOf(x.name || x.firstMessage || "제목 없음"), modified: x.modified.getTime(), count: x.messageCount });
// a little of the text around the first place the words were found
function snippetOf(text, needle) {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const start = Math.max(0, at - 16);
  const end = Math.min(flat.length, at + needle.length + 48);
  const lead = start ? "…" : "";
  return { text: `${lead}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`, at: at - start + lead.length, len: needle.length };
}
// the newest 60, or with words: every conversation whose name or text has them
async function listSessions(q = "") {
  const needle = String(q).replace(/\s+/g, " ").trim().toLowerCase().slice(0, 100);
  const all = await allSessions();
  if (!needle) return all.slice(0, 60).map(brief);
  return all
    .filter((x) => `${x.name || ""}\n${x.firstMessage || ""}\n${x.allMessagesText || ""}`.toLowerCase().includes(needle))
    .slice(0, 40)
    .map((x) => ({ ...brief(x), snippet: snippetOf(x.allMessagesText || x.firstMessage || "", needle) }));
}
const findSession = async (path) => (await allSessions()).find((x) => x.path === path);
// a deleted conversation is only renamed (Pi lists *.jsonl), so the window's
// "undo" can bring it back; the next start clears the ones older than a day
const DELETED = ".deleted";
try {
  for (const name of readdirSync(sessionDir)) {
    const file = join(sessionDir, name);
    if (name.endsWith(`.jsonl${DELETED}`) && Date.now() - statSync(file).mtimeMs > 86400000) rmSync(file, { force: true });
  }
} catch { /* no conversations yet */ }

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
// pictures come inside the JSON (base64), so a prompt can be a few MB
async function readJson(req) {
  let body = "";
  for await (const part of req) { body += part; if (body.length > 40e6) throw new Error("too large"); }
  return body ? JSON.parse(body) : {};
}
// up to 4 pictures, each a PNG / JPEG / WebP / GIF under 8 MB of base64
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function picturesOf(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 4)
    .filter((x) => PICTURE_TYPES.has(x?.mimeType) && typeof x.data === "string" && x.data.length < 8e6 && /^[A-Za-z0-9+/]+={0,2}$/.test(x.data))
    .map((x) => ({ type: "image", data: x.data, mimeType: x.mimeType }));
}

// ---- files in the folder, for @ in the composer --------------------------------
// git's own list when the folder is in a repository (it knows .gitignore),
// else a walk that skips the usual heavy folders; kept for 15 s
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"]);
let fileCache = { at: 0, list: [] };
function gitFiles() {
  return new Promise((done) => {
    execFile("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10000, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => done(error ? null : stdout.split("\0").filter(Boolean)));
  });
}
function walkFiles(limit = 20000) {
  const out = [];
  const stack = [""];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = readdirSync(join(cwd, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(p); } else out.push(p);
    }
  }
  return out;
}
async function folderFiles() {
  if (Date.now() - fileCache.at < 15000) return fileCache.list;
  const files = (await gitFiles()) || walkFiles();
  // the folders too (from the files' own paths), written with a trailing /
  const dirs = new Set();
  for (const f of files) {
    for (let k = f.indexOf("/"); k > 0; k = f.indexOf("/", k + 1)) dirs.add(`${f.slice(0, k)}/`);
  }
  fileCache = { at: Date.now(), list: [...dirs, ...files] };
  return fileCache.list;
}
// the name starting with the words first, then the name having them, then the
// path; with no words, the shallow ones first
function matchFiles(all, q) {
  const needle = q.toLowerCase().replace(/\\/g, "/");
  const scored = [];
  for (const p of all) {
    const low = p.toLowerCase();
    const bare = low.endsWith("/") ? low.slice(0, -1) : low;
    const name = bare.slice(bare.lastIndexOf("/") + 1);
    let score;
    if (!needle) score = bare.split("/").length * 1000 + p.length;
    else if (name.startsWith(needle)) score = p.length;
    else if (name.includes(needle)) score = 1000 + p.length;
    else if (low.includes(needle)) score = 2000 + p.length;
    else continue;
    scored.push([score, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  return scored.slice(0, 30).map(([, p]) => p);
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
        const images = picturesOf(body.images);
        if (!text && !images.length) { send(res, 400, { error: "empty" }); return; }
        const said = text || "이 그림을 봐 주세요.";
        if (session.isCompacting) { send(res, 409, { error: "compacting" }); return; }
        // gone back to before the first message and saying something else:
        // Pi's list names a conversation after the file's first message (the
        // old one), so the new first message becomes its name
        const isUser = (x) => x.type === "message" && x.message.role === "user";
        if (!session.isStreaming && !session.sessionName && !branch().some(isUser) && session.sessionManager.getEntries().some(isUser)) {
          session.setSessionName(titleOf(text) || "그림");
          broadcast({ t: "title", title: session.sessionName });
        }
        if (session.isStreaming) await session.followUp(said, images.length ? images : undefined);
        else session.prompt(said, images.length ? { images } : undefined).catch((e) => broadcast({ t: "error", message: e.message }));
        send(res, 200, { ok: true });
        return;
      }
      case "/api/abort":
        for (const resolveDecision of pending.values()) resolveDecision("no");
        if (session.isCompacting) session.abortCompaction();
        await session.abort();
        send(res, 200, { ok: true });
        return;
      case "/api/approve": {
        const decide = pending.get(String(body.id));
        if (decide) decide(["yes", "no", "always"].includes(body.decision) ? body.decision : "no");
        send(res, 200, { ok: !!decide });
        return;
      }
      case "/api/rewind": {
        // back to just before one of robin's messages (its words go back in
        // the box), or, to undo that, back to where the conversation was.
        // The other way stays in the file; files the tools changed stay changed
        if (busyNow()) { send(res, 409, { error: "busy" }); return; }
        const target = session.sessionManager.getEntry(String(body.id || ""));
        if (!target) { send(res, 404, { error: "no such message" }); return; }
        const back = session.sessionManager.getLeafId();
        await session.navigateTree(target.id);
        broadcast({ t: "reset", state: state(), quiet: true });
        const mine = target.type === "message" && target.message.role === "user";
        send(res, 200, { back, text: mine ? wordsOf(target.message.content) : "", images: mine ? imagesOf(target.message.content) : [] });
        return;
      }
      case "/api/retry": {
        // the last answer again: back to before robin's last message, then the same message
        if (busyNow()) { send(res, 409, { error: "busy" }); return; }
        const last = branch().reverse().find((x) => x.type === "message" && x.message.role === "user");
        if (!last) { send(res, 400, { error: "nothing to retry" }); return; }
        const text = wordsOf(last.message.content);
        const images = imagesOf(last.message.content);
        await session.navigateTree(last.id);
        broadcast({ t: "reset", state: state(), quiet: true });
        session.prompt(text || "이 그림을 봐 주세요.", images.length ? { images } : undefined).catch((e) => broadcast({ t: "error", message: e.message }));
        send(res, 200, { ok: true });
        return;
      }
      case "/api/compact": {
        // summarize the start of the conversation now, not only when it is full
        if (busyNow()) { send(res, 409, { error: "busy" }); return; }
        const running = session.compact();
        running.catch(() => { /* compaction_end says how it went */ });
        // too short to compact fails at once, before the model is asked
        const early = await Promise.race([running.then(() => null, (e) => e), new Promise((r) => setTimeout(() => r(null), 300))]);
        if (early) { send(res, 400, { error: compactionError(early.message).message }); return; }
        send(res, 200, { ok: true });
        return;
      }
      case "/api/thinking":
        // it takes effect from the model's next request
        settings.thinking = !!body.on;
        saveSettings();
        session.setThinkingLevel(thinkingLevel());
        broadcast({ t: "thinking_mode", on: settings.thinking });
        send(res, 200, { on: settings.thinking });
        return;
      case "/api/mode":
        mode = body.mode === "auto" ? "auto" : "ask";
        broadcast({ t: "mode", mode });
        send(res, 200, { mode });
        return;
      case "/api/sessions":
        send(res, 200, { sessions: await listSessions(body.q), current: session?.sessionFile || null, q: String(body.q || "") });
        return;
      case "/api/files":
        send(res, 200, { files: matchFiles(await folderFiles(), String(body.q || "").slice(0, 200)) });
        return;
      case "/api/open": {
        if (busyNow()) { send(res, 409, { error: "busy" }); return; }
        // only a conversation from our own list, never a path the page made up
        const found = await findSession(body.path);
        if (!found) { send(res, 404, { error: "no such conversation" }); return; }
        mode = "ask";
        await startSession(SessionManager.open(found.path, sessionDir));
        send(res, 200, { ok: true });
        return;
      }
      case "/api/delete": {
        const found = await findSession(body.path);
        if (!found) { send(res, 404, { error: "no such conversation" }); return; }
        const current = found.path === session?.sessionFile;
        if (current && busyNow()) { send(res, 409, { error: "busy" }); return; }
        renameSync(found.path, found.path + DELETED);
        if (current) { mode = "ask"; await startSession(SessionManager.create(cwd, sessionDir)); }
        send(res, 200, { ok: true, current });
        return;
      }
      case "/api/rename": {
        const name = titleOf(String(body.name || ""));
        if (!name) { send(res, 400, { error: "empty" }); return; }
        const found = await findSession(body.path);
        if (!found) { send(res, 404, { error: "no such conversation" }); return; }
        // Pi keeps the name as a session_info entry in the conversation's own file
        if (found.path === session?.sessionFile) {
          if (busyNow()) { send(res, 409, { error: "busy" }); return; }
          session.setSessionName(name);
          broadcast({ t: "title", title: name });
        } else SessionManager.open(found.path, sessionDir).appendSessionInfo(name);
        send(res, 200, { ok: true, name });
        return;
      }
      case "/api/restore": {
        // only a file this server renamed: in the conversations folder, *.jsonl.deleted
        const file = resolve(String(body.path || ""));
        if (dirname(file) !== resolve(sessionDir) || extname(file) !== ".jsonl" || !existsSync(file + DELETED) || existsSync(file)) {
          send(res, 404, { error: "nothing to restore" });
          return;
        }
        renameSync(file + DELETED, file);
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
  // the window keeps its address between runs (what it saved and the
  // notifications robin allowed belong to it), unless that port is taken
  const listen = (p) => new Promise((ok, no) => {
    const onError = (e) => { server.off("listening", onListening); no(e); };
    const onListening = () => { server.off("error", onError); ok(); };
    server.once("error", onError).once("listening", onListening).listen(p, "127.0.0.1");
  });
  const asked = Number(option("--port"));
  if (asked) await listen(asked);
  else {
    try { await listen(settings.port || 0); } catch { await listen(0); }
    if (settings.port !== server.address().port) { settings.port = server.address().port; saveSettings(); }
  }
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
