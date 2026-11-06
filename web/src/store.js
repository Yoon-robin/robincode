// The window's state, built from server events (server.mjs onEvent / state()).
// items is the conversation as drawn: user messages, assistant text, groups of
// tool steps (with their approval question inline) and status lines.

export const BLOCKED = "허락하지 않았어요";

export const initial = {
  link: false, // the event stream is up
  ready: false, // the first state arrived
  info: { cwd: "", folder: "", model: "Qwen3.8-27B" },
  fake: false,
  gpu: { state: "unknown" },
  mode: "ask",
  context: null,
  busy: false,
  startedAt: 0,
  phase: "think", // think | write | tool
  runningTool: "",
  items: [],
  current: null, // id of the assistant item being written
  sessionFile: null,
  title: "",
  sessions: null, // null until the list has come (no "none yet" flash)
  retry: null, // Pi retrying a request that failed on the way: { attempt, max, at }
};

let seq = 0;
const nid = () => `i${++seq}`;

function addTool(items, tool) {
  const last = items[items.length - 1];
  if (last?.kind === "tools") items[items.length - 1] = { ...last, tools: [...last.tools, tool] };
  else items.push({ kind: "tools", id: nid(), tools: [tool] });
}
function updateTool(items, id, change) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "tools") continue;
    const k = item.tools.findIndex((t) => t.id === id);
    if (k < 0) continue;
    const tools = item.tools.slice();
    tools[k] = { ...tools[k], ...(typeof change === "function" ? change(tools[k]) : change) };
    items[i] = { ...item, tools };
    return true;
  }
  return false;
}
function finished(isError, output, ms) {
  const skipped = isError && output.includes(BLOCKED);
  return { status: skipped ? "skip" : isError ? "fail" : "ok", output: skipped ? "" : output, ms, ask: false };
}

function fromHistory(history) {
  const items = [];
  for (const m of history) {
    if (m.role === "user") items.push({ kind: "user", id: nid(), text: m.text, images: m.images || [] });
    else if (m.role === "assistant") {
      if (m.text) items.push({ kind: "assistant", id: nid(), text: m.text, streaming: false });
      for (const t of m.tools) addTool(items, { id: t.id, name: t.name, args: t.args || {}, status: "run" });
      if (m.error) items.push({ kind: "line", id: nid(), tag: "[FAIL]", text: m.error, tone: "fail" });
    } else if (m.role === "tool") {
      if (!updateTool(items, m.id, finished(m.isError, m.output))) {
        addTool(items, { id: m.id, name: m.name, args: {}, ...finished(m.isError, m.output) });
      }
    }
  }
  return items;
}

const line = (tag, text, tone = "") => ({ kind: "line", id: nid(), tag, text, tone });

export function reducer(state, action) {
  switch (action.type) {
    case "link": return { ...state, link: action.up };
    case "sessions": return { ...state, sessions: action.sessions };
    case "decided": {
      const items = state.items.slice();
      updateTool(items, action.id, { ask: false, decision: action.decision });
      if (action.decision === "always") items.push(line("[ OK ]", "이번 대화는 묻지 않고 실행해요. 아래 \"바로 실행\"을 누르면 다시 물어요."));
      return { ...state, items };
    }
    case "local-error":
      return { ...state, items: [...state.items, line("[FAIL]", action.message, "fail")] };
    case "event": return onEvent(state, action.e);
    default: return state;
  }
}

function onEvent(state, e) {
  switch (e.t) {
    case "reset": {
      const s = e.state;
      return {
        ...state, ready: true, info: { cwd: s.cwd, folder: s.folder, model: s.model }, fake: s.fake, gpu: s.gpu,
        mode: s.mode, context: s.context, busy: s.busy, startedAt: s.busy ? Date.now() : 0, phase: "think",
        items: fromHistory(s.history), current: null, sessionFile: s.sessionFile, title: s.title, retry: null,
      };
    }
    case "user": {
      const items = [...state.items, { kind: "user", id: nid(), text: e.text, images: e.images || [] }];
      return {
        ...state, items, busy: true, startedAt: state.busy ? state.startedAt : Date.now(), phase: "think", retry: null,
        title: state.title || e.text.replace(/\s+/g, " ").trim().slice(0, 80) || (e.images?.length ? "그림" : ""),
      };
    }
    case "assistant_start": return { ...state, current: null, phase: "think" };
    case "text": {
      const items = state.items.slice();
      let current = state.current;
      const k = current ? items.findIndex((x) => x.id === current) : -1;
      if (k < 0) {
        current = nid();
        items.push({ kind: "assistant", id: current, text: e.delta, streaming: true });
      } else items[k] = { ...items[k], text: items[k].text + e.delta };
      return { ...state, items, current, phase: "write", retry: null };
    }
    case "assistant_end": {
      const items = state.items.map((x) => (x.id === state.current ? { ...x, streaming: false } : x));
      return { ...state, items, current: null, phase: "think", context: e.context ?? state.context };
    }
    case "tool_start": {
      const items = state.items.slice();
      if (!updateTool(items, e.id, { status: "run" })) addTool(items, { id: e.id, name: e.name, args: e.args || {}, status: "run", startedAt: Date.now() });
      return { ...state, items, phase: "tool", runningTool: e.name };
    }
    case "approve": {
      const items = state.items.slice();
      if (!updateTool(items, e.id, { ask: true, args: e.args || {} })) addTool(items, { id: e.id, name: e.name, args: e.args || {}, status: "run", ask: true });
      return { ...state, items };
    }
    case "tool_update": {
      // a command's output so far, while it still runs
      const items = state.items.slice();
      updateTool(items, e.id, (t) => (t.status === "run" ? { output: e.output } : {}));
      return { ...state, items };
    }
    case "title": return { ...state, title: e.title };
    case "tool_end": {
      const items = state.items.slice();
      updateTool(items, e.id, finished(e.isError, e.output || "", e.ms));
      return { ...state, items, phase: "think" };
    }
    case "compaction":
      if (e.phase === "start") return { ...state, items: [...state.items, line("[ .. ]", "대화가 길어서 앞부분을 요약하는 중이에요.")] };
      return {
        ...state, context: e.context ?? state.context,
        items: [...state.items, e.aborted ? line("[SKIP]", "요약을 멈췄어요.", "skip") : line("[ OK ]", "앞부분을 요약해서 줄였어요.")],
      };
    case "settled": {
      const items = state.items.map((x) => (x.kind === "tools" && x.tools.some((t) => t.ask)
        ? { ...x, tools: x.tools.map((t) => (t.ask ? { ...t, ask: false } : t)) } : x));
      if (e.aborted) items.push(line("[SKIP]", "멈췄어요.", "skip"));
      return { ...state, items, busy: false, current: null, retry: null, context: e.context ?? state.context };
    }
    case "error": return { ...state, items: [...state.items, line("[FAIL]", e.message, "fail")] };
    case "retry": {
      // the failed try's error line goes: Pi drops that answer and asks again
      const items = state.items.slice();
      const last = items[items.length - 1];
      if (last?.kind === "line" && last.tone === "fail") items.pop();
      return { ...state, items, current: null, phase: "think", retry: { attempt: e.attempt, max: e.max, at: Date.now() + (e.delayMs || 0) } };
    }
    case "retry_end": return { ...state, retry: null };
    case "gpu": return { ...state, gpu: e.gpu, fake: e.fake };
    case "mode": return { ...state, mode: e.mode };
    default: return state;
  }
}

// the tool step whose question is on screen, if any
export function askingTool(state) {
  for (const x of state.items) if (x.kind === "tools") for (const t of x.tools) if (t.ask) return t;
  return null;
}
export function askingNow(state) {
  return !!askingTool(state);
}
