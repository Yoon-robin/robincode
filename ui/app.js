// RobinCode window: shows the agent's conversation from server.mjs (events
// over SSE) and sends prompts, stops and approvals back. The page only talks
// to its own server, with the token the server put after the # in its address.
"use strict";

const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const sendButton = $("send");
const statusLine = $("status");

let token = (location.hash.match(/t=([\w-]+)/) || [])[1];
// opened first without the token (a plain address), then given it after the #
window.addEventListener("hashchange", () => location.reload());
try {
  if (token) sessionStorage.setItem("robincode-token", token);
  else token = sessionStorage.getItem("robincode-token");
} catch { /* storage can be off; the address still has it */ }

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-robincode-token": token || "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

// ---- small safe markdown: everything is escaped first, then a few marks ------------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function inline(text) {
  return text.split(/(`[^`\n]+`)/).map((part) => {
    if (/^`[^`\n]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  }).join("");
}
const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
function markdown(src) {
  const lines = src.replace(/\r/g, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*```\s*([\w+#.-]*)/))) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre>${m[1] ? `<span class="lang">${esc(m[1])}</span>` : ""}<code>${esc(code.join("\n"))}</code></pre>`);
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>"); i++;
    } else if (/^\s*>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdown(quote.join("\n"))}</blockquote>`);
    } else if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length && (LIST.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        const item = lines[i].match(LIST);
        if (item) items.push(inline(item[2])); else items[items.length - 1] += `<br>${inline(lines[i].trim())}`;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (line.includes("|") && TABLE_RULE.test(lines[i + 1] || "")) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])
        && !LIST.test(lines[i]) && !/^\s*>/.test(lines[i]); i++) para.push(inline(lines[i]));
      out.push(`<p>${para.join("<br>")}</p>`);
    }
  }
  return out.join("");
}

// ---- the conversation ------------------------------------------------------------------
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
let atBottom = true;
log.addEventListener("scroll", () => { atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
const follow = () => { if (atBottom) log.scrollTop = log.scrollHeight; };
function add(node) {
  $("empty").hidden = true;
  log.append(node);
  follow();
  return node;
}

let current = null; // the assistant message being written: { node, text }
let renderQueued = false;
function renderCurrent() {
  renderQueued = false;
  if (!current) return;
  current.node.innerHTML = markdown(current.text);
  follow();
}
function addUser(text) { add(el("div", "user", text)); }
function addSay(text) { const node = add(el("div", "say")); node.innerHTML = markdown(text); return node; }
function addLine(tag, text, cls = "") {
  const node = el("div", `line ${cls}`);
  node.append(el("span", "tag", tag), document.createTextNode(text));
  return add(node);
}

const tools = new Map(); // toolCallId -> row
const BLOCKED = "허락하지 않았어요";
function describe(name, args = {}) {
  switch (name) {
    case "read": return args.path + (args.offset ? ` (${args.offset}줄부터)` : "");
    case "ls": return args.path || ".";
    case "find": case "grep": return [args.pattern, args.path].filter(Boolean).join("  ");
    case "powershell": case "bash": return String(args.command || "").split("\n")[0];
    case "edit": case "write": return args.path || "";
    default: return JSON.stringify(args);
  }
}
function toolRow(id, name, args) {
  let row = tools.get(id);
  if (row) return row;
  row = el("details", "tool run");
  const summary = el("summary");
  summary.append(el("span", "tag", "[ .. ]"), el("span", "name", name), el("span", "what", describe(name, args)), el("span", "ms"));
  row.append(summary);
  tools.set(id, row);
  add(row);
  return row;
}
function finishTool(id, name, isError, output, ms) {
  const row = toolRow(id, name, {});
  const skipped = isError && output.includes(BLOCKED);
  row.className = `tool ${skipped ? "skip" : isError ? "fail" : "ok"}`;
  row.querySelector(".tag").textContent = skipped ? "[SKIP]" : isError ? "[FAIL]" : "[ OK ]";
  if (ms != null) row.querySelector(".ms").textContent = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`;
  row.querySelector(".out")?.remove();
  if (output && !skipped) row.append(el("div", "out", output));
  if (isError && !skipped) row.open = true;
}

// asking before a command or a file change
const asks = new Map();
function showAsk(id, name, args = {}) {
  const card = el("section", "ask");
  const detail = el("div", "detail");
  let title;
  let yes;
  if (name === "edit" || name === "write") {
    title = name === "edit" ? "이 파일을 고칠까요?" : "이 파일을 쓸까요?";
    yes = name === "edit" ? "고치기" : "쓰기";
    detail.append(el("span", "path", args.path || ""));
    if (name === "write") detail.append(el("span", "add", clip(String(args.content ?? ""))));
    for (const edit of name === "edit" ? (Array.isArray(args.edits) ? args.edits : [args]) : []) {
      const del = String(edit.oldText ?? "").split("\n").map((l) => `- ${l}`).join("\n");
      const addText = String(edit.newText ?? "").split("\n").map((l) => `+ ${l}`).join("\n");
      detail.append(el("span", "del", `${del}\n`), el("span", "add", `${addText}\n\n`));
    }
  } else {
    title = "이 명령을 실행할까요?";
    yes = "실행";
    detail.textContent = String(args.command ?? JSON.stringify(args));
  }
  const buttons = el("div", "buttons");
  const choices = [["yes", yes, "primary"], ["always", "이번 대화는 모두 허용", "ghost"], ["no", "안 돼요", "ghost"]];
  for (const [decision, label, cls] of choices) {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", () => decide(id, decision));
    buttons.append(b);
  }
  card.append(el("h3", null, title), detail, buttons);
  asks.set(id, card);
  add(card);
  card.scrollIntoView({ block: "nearest" });
  updateStatus();
}
function clip(s, n = 4000) { return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 더)` : s; }
function closeAsk(id, decision) {
  const card = asks.get(id);
  if (!card) return;
  asks.delete(id);
  // the tool row above already shows the command and how it went
  card.remove();
  if (decision === "always") addLine("[ OK ]", " 이번 대화는 묻지 않고 실행해요. 위의 \"바로 실행\"을 누르면 다시 물어요.");
  updateStatus();
}
async function decide(id, decision) {
  closeAsk(id, decision);
  try { await api("/api/approve", { id, decision }); } catch (e) { addLine("[FAIL]", ` ${e.message}`, "fail"); }
}

// ---- top bar ---------------------------------------------------------------------------
function setMeter(id, text, level = "") {
  const node = $(id);
  node.hidden = text == null;
  node.classList.toggle("warn", level === "warn");
  node.classList.toggle("bad", level === "bad");
  if (text != null) $(`${id}-value`).textContent = text;
}
let fake = false;
function showGpu(gpu = {}) {
  const names = { on: "켜짐", starting: "켜는 중", stopped: "멈춤", off: "꺼짐", unreachable: "확인 못 함", unknown: "확인 중" };
  let text = names[gpu.state] || "확인 중";
  if (gpu.state === "on" && gpu.rate) text += ` · 시간당 $${gpu.rate}`;
  $("fake").hidden = !fake;
  $("gpu-on").hidden = fake || !["off", "stopped"].includes(gpu.state);
  // with the fake model the GPU's state is only for information
  setMeter("gpu", text, fake ? "" : gpu.state === "on" ? "" : gpu.state === "starting" ? "warn" : "bad");
  if (gpu.credit != null) {
    const short = gpu.hours != null && gpu.hours <= 1;
    setMeter("credit", `$${gpu.credit}${gpu.left ? ` · ${gpu.left}` : ""}`, short ? "warn" : "");
  } else setMeter("credit", null);
}
function showContext(ctx) {
  if (!ctx) return;
  const p = ctx.percent ?? 0;
  $("ctx-fill").style.width = `${p}%`;
  $("ctx-value").textContent = `${p}%`;
  $("ctx").classList.toggle("warn", p >= 75 && p < 90);
  $("ctx").classList.toggle("bad", p >= 90);
  $("ctx").title = `${ctx.tokens.toLocaleString()} / ${ctx.limit.toLocaleString()} 토큰 (여기서 자동으로 대화를 줄여요)`;
}
let mode = "ask";
function showMode(next) {
  mode = next;
  const auto = mode === "auto";
  $("mode").textContent = auto ? "바로 실행" : "묻고 실행";
  $("mode").setAttribute("aria-pressed", String(auto));
  $("mode").title = auto ? "명령과 파일 수정을 묻지 않고 실행해요. 누르면 다시 물어요." : "명령 실행과 파일 수정 전에 물어요. 누르면 묻지 않아요.";
}
$("mode").addEventListener("click", () => api("/api/mode", { mode: mode === "auto" ? "ask" : "auto" }).catch(() => {}));
$("gpu-on").addEventListener("click", () => api("/api/gpu-on").catch(() => {}));
$("new").addEventListener("click", () => {
  if (busy) return;
  api("/api/new").catch((e) => addLine("[FAIL]", ` ${e.message}`, "fail"));
});

// ---- busy state and the status line --------------------------------------------------------
let busy = false;
let startedAt = 0;
let phase = "think"; // think | write | tool
let runningTool = "";
function setBusy(next) {
  if (next && !busy) { startedAt = Date.now(); phase = "think"; }
  busy = next;
  $("new").disabled = busy;
  updateSend();
  updateStatus();
}
function updateSend() {
  const stop = busy && !input.value.trim();
  sendButton.textContent = stop ? "멈추기" : "보내기";
  sendButton.classList.toggle("primary", !stop);
  sendButton.classList.toggle("ghost", stop);
}
function updateStatus() {
  if (!busy) { statusLine.hidden = true; return; }
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const time = s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
  const what = asks.size ? "허락을 기다려요" : phase === "tool" ? `${runningTool} 실행하는 중…` : phase === "write" ? "쓰는 중…" : "생각하는 중…";
  statusLine.textContent = `${what} ${time}`;
  statusLine.hidden = false;
}
setInterval(updateStatus, 1000);

// ---- events from the server ----------------------------------------------------------------
function reset(state) {
  for (const node of [...log.children]) if (node.id !== "empty") node.remove();
  tools.clear(); asks.clear(); current = null;
  fake = state.fake;
  const parts = state.cwd.split(/[\\/]/).filter(Boolean);
  $("folder").textContent = state.cwd.length > 42 && parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : state.cwd;
  $("folder").title = state.cwd;
  $("model-name").textContent = state.model;
  document.title = `RobinCode · ${state.folder}`;
  showGpu(state.gpu);
  showContext(state.context);
  showMode(state.mode);
  $("empty").hidden = state.history.length > 0;
  for (const m of state.history) {
    if (m.role === "user") addUser(m.text);
    else if (m.role === "assistant") {
      if (m.text) addSay(m.text);
      for (const t of m.tools) toolRow(t.id, t.name, t.args);
      if (m.error) addLine("[FAIL]", ` ${m.error}`, "fail");
    } else if (m.role === "tool") finishTool(m.id, m.name, m.isError, m.output);
  }
  setBusy(state.busy);
  log.scrollTop = log.scrollHeight;
}

function onEvent(e) {
  switch (e.t) {
    case "reset": reset(e.state); break;
    case "user": addUser(e.text); setBusy(true); break;
    case "assistant_start": current = { node: null, text: "" }; phase = "think"; break;
    case "text":
      if (!current) current = { node: null, text: "" };
      if (!current.node) current.node = add(el("div", "say"));
      current.text += e.delta;
      phase = "write";
      if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderCurrent); }
      break;
    case "assistant_end":
      renderCurrent();
      current = null;
      phase = "think";
      showContext(e.context);
      break;
    case "tool_start": toolRow(e.id, e.name, e.args); phase = "tool"; runningTool = e.name; updateStatus(); break;
    case "approve": showAsk(e.id, e.name, e.args); break;
    case "tool_end": closeAsk(e.id); finishTool(e.id, e.name, e.isError, e.output, e.ms); phase = "think"; break;
    case "compaction":
      if (e.phase === "start") addLine("[ .. ]", " 대화가 길어서 앞부분을 줄이는 중이에요.");
      else { addLine(e.aborted ? "[SKIP]" : "[ OK ]", e.aborted ? " 줄이기를 멈췄어요." : " 앞부분을 요약해 줄였어요."); showContext(e.context); }
      break;
    case "settled":
      for (const id of [...asks.keys()]) closeAsk(id, "no");
      if (e.aborted) addLine("[SKIP]", " 멈췄어요.");
      setBusy(false);
      showContext(e.context);
      break;
    case "error": addLine("[FAIL]", ` ${e.message}`, "fail"); break;
    case "gpu": fake = e.fake; showGpu(e.gpu); break;
    case "mode": showMode(e.mode); break;
  }
}

let events;
function connect() {
  events = new EventSource(`/api/events?t=${encodeURIComponent(token || "")}`);
  events.onmessage = (m) => onEvent(JSON.parse(m.data));
  events.onerror = () => {
    if (events.readyState === EventSource.CLOSED) {
      addLine("[FAIL]", " RobinCode 서버와 연결이 끊겼어요. 창을 닫고 다시 여세요.", "fail");
    }
  };
}

// ---- the composer --------------------------------------------------------------------------
function grow() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
  updateSend();
}
input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && busy) { e.preventDefault(); stop(); }
});
$("form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
async function submit() {
  const text = input.value.trim();
  if (!text) { if (busy) stop(); return; }
  input.value = "";
  grow();
  try { await api("/api/prompt", { text }); } catch (e) { addLine("[FAIL]", ` 보내지 못했어요: ${e.message}`, "fail"); input.value = text; grow(); }
}
async function stop() {
  try { await api("/api/abort"); } catch { /* the settled event says how it ended */ }
}

connect();
input.focus();
