// RobinCode app: our own coding agent window on the RobinAI GPU model.
//
// The agent itself is Pi (@earendil-works/pi-coding-agent, MIT): its session,
// tools (read, edit, write, grep, find, ls, powershell), compaction and saved
// conversations. Everything around it is ours: the model connection, Korean
// instructions, asking before commands and file changes, and the RobinX
// window (web/, React), served on 127.0.0.1 and opened as a Chromium app window
// (Edge, Chrome or Brave, its own profile so closing it ends this process).
//
//   node server.mjs [folder | --pick] [--fake] [--no-window] [--port N] [--hidden]
//
// --pick opens the window on the folder screen (web/picker, the same page
// robincode.cmd shows) and the conversation after a folder is chosen; this is
// how the desktop shortcut starts it, with no console (robincode.vbs, --hidden:
// a failure before the window shows up comes as a message box).
// The packages (npm ci) and the window's build are made here when missing or
// older than their sources, while the folder screen is up, so no console has
// to show it.
// --fake talks to fake-model.mjs instead of the GPU (no rented GPU needed).
// The GPU model: an open RobinCode tunnel on 127.0.0.1:8091 is reused, else
// this opens its own `ssh -L 127.0.0.1:18092 -> VPS 127.0.0.1:8091`; the key
// comes from `ssh contabo cat /root/.vastai-llama-key` into memory only.
// docs/robincode-app.md.
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
// no fs.rmSync: on Node 24.13 for Windows it kills the process on any path with
// Korean in it (2026-11-09); fs.promises.rm and unlinkSync are fine
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { addRecent, allFolders, cleanPath, folderExists, hideRecent, rows as folderRows, unhideRecent } from "./folders.mjs";

// Pi, loaded once its packages are there (getReady)
let createAgentSession, DefaultResourceLoader, estimateTokens, ModelRuntime, SessionManager;

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const FAKE = flag("--fake");
const NO_WINDOW = flag("--no-window");
const PICK = flag("--pick");
const HIDDEN = flag("--hidden");
const given = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
// null until a folder is chosen on the folder screen (--pick)
let cwd = PICK && !given ? null : resolve(given || process.cwd());
// the folder the list always has: this repository
const HOME_REPO = resolve(here, "..");
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
// started with no console (the desktop shortcut): a failure before the window
// is up has nowhere else to show
function alertBox(text) {
  if (!HIDDEN) return;
  spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:RC_MSG, 'RobinCode', 'OK', 'Error')"],
  { env: { ...process.env, RC_MSG: text }, windowsHide: true });
}

// ---- getting ready: packages, the window's build, the agent, the model --------
// each step once; a failed one is tried again the next time a folder is opened
let phase = { text: "준비하는 중이에요.", error: null, ready: false };
const setPhase = (text) => { phase = { text, error: null, ready: false }; log(text); };
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
function newestIn(dir, skip) {
  let t = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const d of entries) {
    if (skip.includes(d.name)) continue;
    const p = join(dir, d.name);
    t = Math.max(t, d.isDirectory() ? newestIn(p, skip) : mtime(p));
  }
  return t;
}
// npm is a .cmd file: through cmd.exe (Node does not start those by itself)
function npm(line) {
  return new Promise((done, fail) => {
    const p = spawn("cmd.exe", ["/d", "/s", "/c", `npm ${line}`], { cwd: here, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (b) => { tail = (tail + b).slice(-3000); };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    p.on("error", fail);
    p.on("close", (code) => (code ? fail(new Error(`npm ${line.split(" ").slice(0, 2).join(" ")}이 실패했어요: ${tail.trim().split(/\r?\n/).slice(-2).join(" / ")}`)) : done()));
  });
}
const steps = { packages: false, built: false, agent: false, model: false };
async function getReady() {
  const lock = join(here, "package-lock.json");
  const stamp = join(here, "node_modules", ".package-lock.json");
  if (!steps.packages) {
    // the first time, or when package-lock.json changed since the last install
    // (a git pull; npm ci writes node_modules\.package-lock.json)
    if (!mtime(stamp) || mtime(lock) > mtime(stamp)) {
      setPhase("에이전트 패키지를 받는 중이에요(처음이거나 바뀌어서 1~2분).");
      await npm("ci --ignore-scripts --no-audit --no-fund");
    }
    steps.packages = true;
  }
  if (!steps.built) {
    // web\dist is not in git: built when missing or older than any source
    const built = join(here, "web", "dist", "index.html");
    const source = Math.max(newestIn(join(here, "web"), ["dist", "picker"]), mtime(join(here, "vite.config.js")), mtime(lock));
    if (!mtime(built) || source > mtime(built)) {
      setPhase("창 화면을 빌드하는 중이에요.");
      await npm("run build");
    }
    steps.built = true;
  }
  if (!steps.agent) {
    setPhase("에이전트를 불러오는 중이에요.");
    ({ createAgentSession, DefaultResourceLoader, estimateTokens, ModelRuntime, SessionManager } = await import("@earendil-works/pi-coding-agent"));
    steps.agent = true;
  }
  if (!steps.model) {
    setPhase(FAKE ? "가짜 모델을 켜는 중이에요." : "모델 서버에 연결하는 중이에요.");
    await connectModel();
    steps.model = true;
  }
  phase = { text: "준비됐어요.", error: null, ready: true };
}
let readying = null;
function whenReady() {
  readying ??= getReady().catch((e) => {
    readying = null;
    phase = { text: e.message, error: e.message, ready: false };
    log("[FAIL]", e.message);
    throw e;
  });
  return readying;
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
// ROBINCODE_FAKE_GPU (a JSON file for its state) answers with fake-gpu.mjs
// instead of the server, for tests: nothing is rented
const FAKE_GPU = process.env.ROBINCODE_FAKE_GPU;
function gpuProcess(command) {
  if (FAKE_GPU) return spawn(process.execPath, [join(here, "fake-gpu.mjs"), ...command.split(" ")], { windowsHide: true });
  // -n: no input, BatchMode: never a password prompt nobody can see
  return spawn("ssh", ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "contabo", `robinai-gpu ${command}`], { windowsHide: true });
}
function gpuRun(command, timeout = 40000) {
  return new Promise((done) => {
    const p = gpuProcess(command);
    let out = "";
    p.stdout.on("data", (b) => { out += b; });
    p.stderr.on("data", (b) => { out += b; });
    const timer = setTimeout(() => p.kill(), timeout);
    p.on("error", () => { clearTimeout(timer); done({ ok: false, out }); });
    p.on("close", (code) => { clearTimeout(timer); done({ ok: code === 0, out }); });
  });
}
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
    // the server deletes an unused GPU by itself (robinai-gpu autooff, cron)
    if ((m = l.match(/^자동 끄기: (.+)$/))) {
      g.autooff = m[1].trim();
      const n = g.autooff.match(/(\d+)분(?:이 되면| 동안 아무도)/);
      if (n) g.idleLimit = Number(n[1]);
    }
  }
  return g;
}
async function refreshGpu() {
  const r = await gpuRun("status");
  if (r.ok && /GPU 서버: /.test(r.out)) gpu = parseGpu(r.out);
  else if (gpu.state === "unknown") gpu = { state: "unreachable" };
  broadcast({ t: "gpu", gpu, fake: FAKE });
}

// ---- turning the GPU on and off from the window --------------------------------
// renting costs robin money: only on robin's own click on one offer, never on
// its own. The places come from `robinai-gpu offers` (6, Korea first, cheapest
// first); renting takes the offer's id (not its number, the list may change).
let offers = [];
let job = null; // { action, lines, running, ok }
const OFFER = /^(\d+)\) (.+?) (데이터센터|개인 호스트) · 시간당 \$([\d.]+) · 최장 (\d+)일 · 신뢰도 ([\d.]+)% · 모델 받기 약 (\d+)분\((\d+)Mbps, \$([\d.]+)\)\s+\[offer (\d+)\]/;
async function listOffers() {
  const r = await gpuRun("offers", 60000);
  const list = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(OFFER);
    if (m) list.push({ n: +m[1], place: m[2], host: m[3], hour: m[4], days: +m[5], rel: m[6], mins: +m[7], mbps: +m[8], fetch: m[9], offer: m[10] });
  }
  if (!list.length) throw new Error(r.out.trim().split(/\r?\n/).pop() || "자리 목록을 받지 못했어요(ssh contabo).");
  offers = list;
  return list;
}
function startGpuJob(action, offer) {
  job = { action, offer: offer || null, lines: [], running: true, ok: null, at: Date.now() };
  const p = gpuProcess(action === "rent" ? `rent ${offer}` : action);
  let carry = "";
  const take = (b) => {
    const parts = (carry + b.toString("utf8")).split(/\r?\n/);
    carry = parts.pop();
    for (const line of parts.map((l) => plain(l).trim()).filter(Boolean)) job.lines.push(line);
    job.lines = job.lines.slice(-30);
    broadcast({ t: "gpu_job", job });
  };
  p.stdout.on("data", take);
  p.stderr.on("data", take);
  // the state moves while it runs (starting, then on)
  const watch = setInterval(refreshGpu, 20000);
  const end = (ok, extra) => {
    if (!job.running) return;
    clearInterval(watch);
    if (carry.trim()) job.lines.push(plain(carry).trim());
    if (extra) job.lines.push(extra);
    job.running = false;
    job.ok = ok;
    broadcast({ t: "gpu_job", job });
    refreshGpu();
  };
  p.on("error", (e) => end(false, e.message));
  p.on("close", (code) => end(code === 0));
  children.push(p);
  broadcast({ t: "gpu_job", job });
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
      // the file as it is right before the change runs (after robin said yes)
      const going = () => { if (FILE_TOOLS.has(event.toolName)) beforeChange(event.toolCallId, event.input?.path); return undefined; };
      if (mode === "auto" || !ASK_TOOLS.has(event.toolName)) return going();
      broadcast({ t: "approve", id: event.toolCallId, name: event.toolName, args: event.input });
      const decision = await new Promise((r) => pending.set(event.toolCallId, r));
      pending.delete(event.toolCallId);
      if (decision === "always") { mode = "auto"; broadcast({ t: "mode", mode }); return going(); }
      if (decision === "yes") return going();
      return { block: true, reason: "robin이 이 도구 호출을 허락하지 않았어요. 다른 방법을 물어보거나 멈추세요." };
    });
  },
};

// ---- files the model changed, so going back can put them back -----------------
// edit and write only: right before one runs, the file as it was; after, as it
// became. Kept next to the conversation (<conversation>.jsonl.files/: index.json
// and the contents under their sha256). What a command (powershell) changes is
// not tracked. `known`: what this server last left in each file, so a file
// changed since by anything else is left alone.
const FILE_TOOLS = new Set(["edit", "write"]);
const BIG = 8e6; // a larger file is not kept, and going back leaves it
const FILES = ".files";
let shelf = null; // { file, dir, index: { calls: { toolCallId: { path, before, after, at } }, known: { key: hash } } }
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
// Windows paths do not care about case
const keyOf = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const absPath = (p) => {
  let s = String(p || "").trim().replace(/^@/, "");
  if (s === "~" || /^~[\\/]/.test(s)) s = join(homedir(), s.slice(1));
  return resolve(cwd, s);
};
const shown = (p) => { const r = relative(cwd, p); return r && !r.startsWith("..") && !isAbsolute(r) ? r.replace(/\\/g, "/") : p; };
function theShelf() {
  const file = session?.sessionFile;
  if (!file) return null;
  if (shelf?.file !== file) {
    let index = {};
    try { index = JSON.parse(readFileSync(join(`${file}${FILES}`, "index.json"), "utf8")) || {}; } catch { /* nothing kept yet */ }
    shelf = { file, dir: `${file}${FILES}`, index: { calls: index.calls || {}, known: index.known || {} } };
  }
  return shelf;
}
function keepShelf() {
  try {
    mkdirSync(shelf.dir, { recursive: true });
    writeFileSync(join(shelf.dir, "index.json"), JSON.stringify(shelf.index));
  } catch (e) { log("고친 파일 기록을 남기지 못했어요:", e.message); }
}
// the file now: the hash of its contents (kept on the shelf), null when there
// is no such file, "big" / "unread" when it cannot be kept
function take(path, keep = true) {
  let buf;
  try { buf = readFileSync(path); } catch (e) { return e.code === "ENOENT" ? null : "unread"; }
  if (buf.length > BIG) return "big";
  const hash = sha(buf);
  if (keep) {
    const blob = join(shelf.dir, hash);
    if (!existsSync(blob)) { mkdirSync(shelf.dir, { recursive: true }); writeFileSync(blob, buf); }
  }
  return hash;
}
const keepable = (h) => h !== "big" && h !== "unread";
function beforeChange(id, p) {
  if (!p || !theShelf()) return;
  const path = absPath(p);
  try { shelf.index.calls[id] = { path, before: take(path), at: Date.now() }; } catch (e) { log("고치기 전 파일을 담지 못했어요:", e.message); }
}
function afterChange(id) {
  const rec = theShelf()?.index.calls[id];
  if (!rec || "after" in rec) return;
  try { rec.after = take(rec.path); } catch { rec.after = "unread"; }
  // a failed edit changed nothing
  if (rec.after === rec.before) delete shelf.index.calls[id];
  else shelf.index.known[keyOf(rec.path)] = rec.after;
  keepShelf();
}
// every changed file as it should be where the conversation is: as the last
// change on this branch left it, or, changed only on another branch, as it was
// before the first change
function filesAt(leafId) {
  const calls = Object.entries(shelf.index.calls).filter(([, r]) => "after" in r).sort((a, b) => a[1].at - b[1].at);
  const want = new Map();
  for (const [, r] of calls) if (!want.has(keyOf(r.path))) want.set(keyOf(r.path), { path: r.path, hash: r.before });
  const ran = new Set();
  for (const x of leafId ? session.sessionManager.getBranch(leafId) : []) {
    if (x.type !== "message" || x.message.role !== "assistant") continue;
    for (const p of x.message.content || []) if (p.type === "toolCall") ran.add(p.id);
  }
  for (const [id, r] of calls) if (ran.has(id)) want.set(keyOf(r.path), { path: r.path, hash: r.after });
  return want;
}
// the files that differ from where the conversation is now
function filePlan() {
  if (!theShelf()) return [];
  const out = [];
  for (const [key, w] of filesAt(session.sessionManager.getLeafId())) {
    const known = shelf.index.known[key];
    if (known !== undefined && known !== w.hash) out.push({ key, path: w.path, want: w.hash, known });
  }
  return out;
}
const planNames = (plan) => plan.map((c) => shown(c.path));
// put the files back as the conversation has them now; a file changed since by
// something else (a command, robin's editor) is left as it is
function syncFiles() {
  const done = [];
  const left = [];
  for (const c of filePlan()) {
    const name = shown(c.path);
    if (!keepable(c.want) || !keepable(c.known)) { left.push({ name, why: "커서 담아 두지 않았어요" }); continue; }
    const now = take(c.path, false);
    if (now !== c.known) { left.push({ name, why: "그 뒤에 다른 데서 바뀌었어요" }); continue; }
    try {
      if (c.want === null) { try { unlinkSync(c.path); } catch (e) { if (e.code !== "ENOENT") throw e; } }
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, readFileSync(join(shelf.dir, c.want)));
      }
      shelf.index.known[c.key] = c.want;
      done.push(name);
    } catch (e) { left.push({ name, why: e.message }); }
  }
  if (done.length) { keepShelf(); fileCache.at = 0; }
  return { done, left };
}

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
      if (FILE_TOOLS.has(e.toolName)) afterChange(e.toolCallId);
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
      const users = branch().filter(isUser);
      const side = alts();
      broadcast({ t: "settled", aborted: e.aborted, context: contextUsage(), stats,
        users: users.map((x) => x.id), alts: Object.fromEntries(users.map((x) => [x.id, side.get(x.id) ?? null])) });
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
const isUser = (x) => x.type === "message" && x.message.role === "user";
// robin's message changed and sent again, or answered again: the messages
// side by side, oldest first. Side by side = after the same message (Pi puts
// its own entries, model and thinking level, in front of a new first message,
// so the parent itself can differ). userId -> { at, of, prev, next } | null
function alts() {
  const all = session?.sessionManager.getEntries() || [];
  const byId = new Map(all.map((x) => [x.id, x]));
  const place = (x) => {
    let p = x.parentId && byId.get(x.parentId);
    while (p && p.type !== "message") p = p.parentId && byId.get(p.parentId);
    return p ? p.id : "";
  };
  const groups = new Map();
  for (const x of all) {
    if (!isUser(x)) continue;
    const at = place(x);
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(x);
  }
  const out = new Map();
  for (const list of groups.values()) {
    list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    list.forEach((x, k) => out.set(x.id, list.length < 2 ? null
      : { at: k + 1, of: list.length, prev: list[k - 1]?.id || null, next: list[k + 1]?.id || null }));
  }
  return out;
}
// where robin last was under a message: the newest entry below it
function lastUnder(entry) {
  const sm = session.sessionManager;
  let newest = entry;
  const stack = [entry];
  while (stack.length) {
    const x = stack.pop();
    if (x.timestamp > newest.timestamp) newest = x;
    stack.push(...sm.getChildren(x.id));
  }
  return newest;
}
function history() {
  const out = [];
  const entries = branch();
  const side = alts();
  const compaction = entries.findLast((x) => x.type === "compaction");
  const kept = compaction ? entries.findIndex((x) => x.id === compaction.firstKeptEntryId) : -1;
  entries.forEach((entry, k) => {
    const key = entry.id;
    const old = k < kept;
    if (entry.type === "compaction") { out.push({ role: "compaction", key, faded: kept > 0 }); return; }
    if (entry.type === "custom" && entry.customType === STATS) { out.push({ role: "stats", key, stats: entry.data }); return; }
    if (entry.type !== "message") return;
    const m = entry.message;
    if (m.role === "user") out.push({ role: "user", key, old, id: entry.id, text: wordsOf(m.content), images: imagesOf(m.content), alt: side.get(entry.id) ?? null });
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
    cwd, folder: cwd ? basename(cwd) || cwd : "", model: "Qwen3.8-27B", fake: FAKE, gpuFake: !!FAKE_GPU, gpu, gpuJob: job, mode, thinking: !!settings.thinking,
    busy: busyNow(), compacting: !!session?.isCompacting, context: contextUsage(), history: history(),
    sessionFile: session?.sessionFile || null,
    // a name robin gave it, else its first message
    title: session?.sessionName || firstWords || (first ? "그림" : ""),
  };
};
const sessionDir = join(agentDir, "sessions");
// another folder from the folder screen: a new conversation there (its past
// ones are in the list); "allow all" and the file lists were for the old one
async function openFolder(path) {
  await whenReady();
  cwd = cleanPath(path);
  addRecent(cwd);
  fileCache = { at: 0, list: [] };
  shelf = null;
  mode = "ask";
  await startSession(SessionManager.create(cwd, sessionDir));
  log(`폴더 ${cwd}`);
}
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
    if (name.endsWith(`.jsonl${DELETED}`) && Date.now() - statSync(file).mtimeMs > 86400000) {
      rm(file, { force: true }).catch(() => {});
      // and the files its tools changed, kept for going back
      rm(file.slice(0, -DELETED.length) + FILES, { recursive: true, force: true }).catch(() => {});
    }
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
// the window is the React app in web/, built into web/dist (npm run build);
// the folder screen is web/picker, built into ops/windows/robincode-picker
// (in git, robincode.cmd shows it too), with Korean Pretendard from RobinMail
const DIST = join(here, "web", "dist");
const PICKER = resolve(here, "..", "ops", "windows", "robincode-picker");
const PRETENDARD = resolve(here, "..", "robinmail", "plugins", "robinmail", "fonts", "pretendard");
const SHARED = {
  "/fonts/pretendard-latin.woff2": join(here, "..", "assets", "pretendard-latin.woff2"),
  "/fonts/robin-term.woff2": join(here, "..", "assets", "robin-term.woff2"),
  "/favicon.ico": join(here, "..", "assets", "favicon.ico"),
};
function inside(base, rel) {
  const file = resolve(base, `.${rel}`);
  try { return file.startsWith(base + sep) && statSync(file).isFile() ? file : null; } catch { return null; }
}
function staticFile(pathname) {
  if (SHARED[pathname]) return SHARED[pathname];
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.startsWith("/picker/")) return inside(PICKER, p === "/picker/" ? "/index.html" : p.slice("/picker".length));
  if (p.startsWith("/fonts/pretendard/")) return inside(PRETENDARD, p.slice("/fonts/pretendard".length));
  return inside(DIST, p === "/" ? "/index.html" : p);
}

// ---- the folder screen's calls (/picker/api/*), as robincode-ui.ps1 answers
// them for robincode.cmd; the token comes in x-robincode or ?t= ----
let folders = null; // { at, list }, kept for 10 s while robin types
const folderList = () => {
  if (!folders || Date.now() - folders.at > 10000) folders = { at: Date.now(), list: allFolders(HOME_REPO) };
  return folders.list;
};
function browseFolder(start) {
  // the Explorer folder dialog of robincode-ui.ps1 (Select-Folder)
  const ui = join(here, "..", "ops", "windows", "robincode-ui.ps1");
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; . ([scriptblock]::Create([IO.File]::ReadAllText($env:RC_UI, [Text.Encoding]::UTF8))); $p = Select-Folder $env:RC_START; if ($p) { [Console]::Out.Write($p) }";
  return new Promise((done) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-Command", script],
      { windowsHide: true, encoding: "utf8", env: { ...process.env, RC_UI: ui, RC_START: start, RA_SELF: `${dirname(ui)}\\` } },
      (error, out, err) => done(error ? { error: (err || error.message).trim().split(/\r?\n/)[0] } : { path: out.trim() || null }));
  });
}
function leaveSoon() {
  // the page went away: the end, unless the conversation (or the folder
  // screen again) comes back within 10 s
  if (!EXIT_WHEN_CLOSED || clients.size) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { if (!clients.size) { log("창이 닫혀서 끝내요."); shutdown(); } }, 10000);
}
async function pickerCall(req, res, url) {
  const name = url.pathname.slice("/picker/api/".length);
  if (name !== "bye") clearTimeout(closeTimer);
  const body = req.method === "POST" ? await readJson(req) : {};
  const back = cwd ? `/#t=${token}` : null;
  switch (name) {
    case "rows":
      send(res, 200, { ...folderRows(folderList(), url.searchParams.get("q") || "", 60), back: !!back });
      return;
    case "status":
      send(res, 200, phase);
      return;
    case "open": {
      const p = String(body.path || "");
      if (!folderExists(p)) { send(res, 404, { error: `그 폴더가 없어요: ${p}` }); return; }
      if (busyNow()) { send(res, 409, { error: "지금 하는 일이 있어서 폴더를 바꿀 수 없어요. 끝나거나 멈춘 뒤에 해 주세요." }); return; }
      await openFolder(p);
      folders = null;
      send(res, 200, { path: cwd, next: `/#t=${token}` });
      return;
    }
    case "browse": {
      const start = String(body.start || "");
      const r = await browseFolder(folderExists(start) ? start : cwd || HOME_REPO);
      if (r.error) { send(res, 500, { error: r.error }); return; }
      // only named: the page opens it as any other folder (and shows the getting ready)
      send(res, 200, { path: r.path ? cleanPath(r.path) : null, pick: true });
      return;
    }
    case "hide": hideRecent(String(body.path || "")); folders = null; send(res, 200, { ok: true }); return;
    case "unhide": unhideRecent(String(body.path || "")); folders = null; send(res, 200, { ok: true }); return;
    case "cancel":
      // Esc on an empty box: back to the conversation, or, before any folder, the end
      if (back) { send(res, 200, { next: back }); return; }
      send(res, 200, { close: true });
      if (EXIT_WHEN_CLOSED) setTimeout(shutdown, 1500);
      return;
    case "bye": send(res, 200, { ok: true }); leaveSoon(); return;
    default: send(res, 404, { error: "no such call" });
  }
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
  if (url.pathname.startsWith("/picker/api/")) {
    if ((req.headers["x-robincode"] || url.searchParams.get("t")) !== token) { send(res, 401, { error: "토큰이 달라요." }); return; }
    try { await pickerCall(req, res, url); } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }
  if (url.pathname === "/picker") { res.writeHead(302, { location: `/picker/${url.search}` }); res.end(); return; }
  if (!url.pathname.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
  if ((req.headers["x-robincode-token"] || url.searchParams.get("t")) !== token) { send(res, 401, { error: "token" }); return; }
  // the conversation's calls need a folder and the agent (the folder screen comes first)
  if (!session) { send(res, 409, { error: "아직 폴더를 고르지 않았어요." }); return; }
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ t: "reset", state: state() })}\n\n`);
      clients.add(res);
      clearTimeout(closeTimer);
      req.on("close", () => {
        clients.delete(res);
        // the window is gone (a reload reconnects within a second or two, the
        // folder screen asks for its list)
        leaveSoon();
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
        // The other way stays in the file. Files the tools changed stay as
        // they are; `files` names the ones robin can have put back (files-sync)
        if (busyNow()) { send(res, 409, { error: "busy" }); return; }
        const target = session.sessionManager.getEntry(String(body.id || ""));
        if (!target) { send(res, 404, { error: "no such message" }); return; }
        const back = session.sessionManager.getLeafId();
        await session.navigateTree(target.id);
        broadcast({ t: "reset", state: state(), quiet: true });
        const mine = isUser(target);
        send(res, 200, { back, text: mine ? wordsOf(target.message.content) : "", images: mine ? imagesOf(target.message.content) : [],
          files: planNames(filePlan()) });
        return;
      }
      case "/api/branch": {
        // another of the messages side by side: back to where robin last was under it
        if (busyNow()) { send(res, 409, { error: "busy" }); return; }
        const target = session.sessionManager.getEntry(String(body.id || ""));
        if (!target || !isUser(target)) { send(res, 404, { error: "no such message" }); return; }
        const to = lastUnder(target);
        // a message never answered (stopped at once): Pi goes to just before
        // it, and its words go back in the box
        const r = await session.navigateTree(to.id);
        broadcast({ t: "reset", state: state(), quiet: true });
        const open = isUser(to);
        send(res, 200, { text: open ? r.editorText ?? wordsOf(to.message.content) : null, images: open ? imagesOf(to.message.content) : [],
          files: planNames(filePlan()) });
        return;
      }
      case "/api/files-sync":
        // the files edit / write changed, as the conversation has them where it is now
        if (busyNow()) { send(res, 409, { error: "busy" }); return; }
        send(res, 200, syncFiles());
        return;
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
      case "/api/gpu-offers":
        if (FAKE && !FAKE_GPU) { send(res, 400, { error: "가짜 모델로 시험 중이에요." }); return; }
        try { send(res, 200, { offers: await listOffers(), gpu }); } catch (e) { send(res, 502, { error: e.message }); }
        return;
      case "/api/gpu-run": {
        // rent: one of the offers this window was shown, by its id; start: a
        // stopped one again; destroy: delete it (nothing billed after)
        if (FAKE && !FAKE_GPU) { send(res, 400, { error: "가짜 모델로 시험 중이에요." }); return; }
        if (job?.running) { send(res, 409, { error: "GPU 일이 이미 도는 중이에요." }); return; }
        const action = String(body.action || "");
        if (!["rent", "start", "destroy"].includes(action)) { send(res, 400, { error: "모르는 일이에요." }); return; }
        const offer = String(body.offer || "");
        if (action === "rent" && !offers.some((o) => o.offer === offer)) { send(res, 400, { error: "자리 목록을 다시 받아 주세요." }); return; }
        startGpuJob(action, action === "rent" ? offer : null);
        send(res, 200, { ok: true });
        return;
      }
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
  if (!browser) { log("앱 창을 띄울 브라우저(Edge·Chrome·Brave)가 없어요. 이 주소를 여세요:", url); return false; }
  const win = spawn(browser, [`--app=${url}`, `--user-data-dir=${join(appDir, "window")}`, "--window-size=1180,860",
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"], { stdio: "ignore", detached: true });
  win.on("error", (e) => log("창을 띄우지 못했어요:", e.message, "이 주소를 여세요:", url));
  win.unref();
  return true;
}

function shutdown() {
  for (const resolveDecision of pending.values()) resolveDecision("no");
  for (const c of children) { try { c.kill(); } catch { } }
  try { session?.abort(); session?.dispose(); } catch { }
  process.exit(0);
}
process.on("SIGINT", shutdown);

try {
  if (cwd) {
    await whenReady();
    addRecent(cwd);
    await startSession();
  } else {
    // the packages, the build and the model while robin picks a folder
    whenReady().catch(() => { /* the folder screen shows it, and tries again */ });
  }
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
  const url = cwd ? `http://127.0.0.1:${port}/#t=${token}` : `http://127.0.0.1:${port}/picker/?t=${token}`;
  log(`RobinCode ${FAKE ? "(가짜 모델) " : ""}${cwd ? `폴더 ${cwd}` : "폴더 고르는 화면"}`);
  log(`창 주소: ${url}`);
  // ROBINCODE_URLFILE: the address goes there too (tests open it headless)
  if (process.env.ROBINCODE_URLFILE) writeFileSync(process.env.ROBINCODE_URLFILE, url);
  refreshGpu();
  setInterval(refreshGpu, 60000).unref();
  if (!NO_WINDOW) {
    if (!openWindow(url)) { alertBox("RobinCode 창을 띄울 브라우저(Edge·Chrome·Brave)가 없어요."); shutdown(); }
    // no page at all within a minute: the window never came
    closeTimer = setTimeout(() => { if (!clients.size) { log("창이 오지 않아서 끝내요."); shutdown(); } }, 60000);
  }
} catch (e) {
  console.error(`[FAIL] ${e.message}`);
  alertBox(`RobinCode를 켜지 못했어요.\n\n${e.message}`);
  shutdown();
}
