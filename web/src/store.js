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
  gpuFake: false, // a fake GPU helper (tests): the on/off buttons show with the fake model
  gpuJob: null, // renting, turning on, deleting: { action, lines, running, ok, at }
  mode: "ask",
  thinking: false, // the model thinks before it answers (robin's switch)
  think: null, // id of the thinking step being written
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
  compacting: false, // Pi summarizing the start of the conversation
  compactOnly: false, // ...and that is all that is going on (not a turn)
};

let seq = 0;
const nid = () => `i${++seq}`;

// `group`: what a new group gets (its id from the saved conversation, and its flags)
function addTool(items, tool, group) {
  const last = items[items.length - 1];
  if (last?.kind === "tools") items[items.length - 1] = { ...last, tools: [...last.tools, tool] };
  else items.push({ kind: "tools", id: nid(), ...group, tools: [tool] });
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

// what the model thought before an answer: a step on the tool rail
const THINK = "생각";
const thinkStep = (text, extra) => ({ id: nid(), name: THINK, think: true, args: {}, output: text, ...extra });

// The saved conversation as items. Ids come from its entries, so drawing it
// again (after going back, or a compaction) keeps every item where it was;
// `still`: drawn in place, without coming up again. `old`: the start that
// the model now only has as a summary
function fromHistory(history, still = false) {
  const items = [];
  const id = (prefix, m) => (m.key ? `${prefix}-${m.key}` : nid());
  const flags = (m) => ({ ...(still && { still }), ...(m.old && { old: true }) });
  for (const m of history) {
    if (m.role === "user") items.push({ kind: "user", id: id("u", m), entryId: m.id, text: m.text, images: m.images || [], alt: m.alt || null, ...flags(m) });
    else if (m.role === "assistant") {
      if (m.thinking) addTool(items, { ...thinkStep(m.thinking, { status: "ok" }), id: id("t", m) }, { id: id("g", m), ...flags(m) });
      if (m.text) items.push({ kind: "assistant", id: id("a", m), text: m.text, streaming: false, ...flags(m) });
      for (const t of m.tools) addTool(items, { id: t.id, name: t.name, args: t.args || {}, status: "run" }, { id: `g-${t.id}`, ...flags(m) });
      if (m.error) items.push({ kind: "line", id: id("e", m), tag: "[FAIL]", text: m.error, tone: "fail", ...flags(m) });
    } else if (m.role === "tool") {
      if (!updateTool(items, m.id, finished(m.isError, m.output))) {
        addTool(items, { id: m.id, name: m.name, args: {}, ...finished(m.isError, m.output) }, { id: `g-${m.id}`, ...flags(m) });
      }
    } else if (m.role === "compaction") {
      items.push({ kind: "line", id: id("c", m), tag: "[ OK ]", tone: "",
        text: m.faded ? "앞부분을 요약했어요. 흐린 부분은 모델이 요약으로만 기억해요." : "앞부분을 요약해서 줄였어요.", ...(still && { still }) });
    } else if (m.role === "stats") {
      // under the last answer of its turn
      for (let i = items.length - 1; i >= 0 && items[i].kind !== "user"; i--) {
        if (items[i].kind === "assistant") { items[i] = { ...items[i], meta: m.stats }; break; }
      }
    }
  }
  return items;
}

const line = (tag, text, tone = "") => ({ kind: "line", id: nid(), tag, text, tone });

// the thinking step ends once anything else comes from the model
function endThink(state) {
  if (!state.think) return state;
  const items = state.items.slice();
  updateTool(items, state.think, (t) => ({ status: "ok", ms: Date.now() - (t.startedAt || Date.now()) }));
  return { ...state, items, think: null };
}

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
        ...state, ready: true, info: { cwd: s.cwd, folder: s.folder, model: s.model }, fake: s.fake, gpu: s.gpu, gpuFake: !!s.gpuFake, gpuJob: s.gpuJob || null,
        mode: s.mode, thinking: !!s.thinking, think: null, context: s.context, busy: s.busy, startedAt: s.busy ? Date.now() : 0,
        phase: s.compacting ? "compact" : "think", compacting: !!s.compacting, compactOnly: !!s.compacting,
        items: fromHistory(s.history, !!e.quiet), current: null, sessionFile: s.sessionFile, title: s.title, retry: null,
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
    case "thinking": {
      const items = state.items.slice();
      if (state.think && updateTool(items, state.think, (t) => ({ output: (t.output || "") + e.delta }))) return { ...state, items, phase: "think" };
      const step = thinkStep(e.delta, { status: "run", startedAt: Date.now() });
      addTool(items, step);
      return { ...state, items, think: step.id, phase: "think", retry: null };
    }
    case "text": {
      state = endThink(state);
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
      state = endThink(state);
      const items = state.items.map((x) => (x.id === state.current ? { ...x, streaming: false } : x));
      return { ...state, items, current: null, phase: "think", context: e.context ?? state.context };
    }
    case "tool_start": {
      state = endThink(state);
      const items = state.items.slice();
      if (!updateTool(items, e.id, { status: "run" })) addTool(items, { id: e.id, name: e.name, args: e.args || {}, status: "run", startedAt: Date.now() });
      return { ...state, items, phase: "tool", runningTool: e.name };
    }
    case "approve": {
      state = endThink(state);
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
    case "compaction": {
      // the status row says it while it runs (by hand, or because the context is full)
      if (e.phase === "start") {
        return { ...state, compacting: true, compactOnly: !state.busy, busy: true, startedAt: state.busy ? state.startedAt : Date.now(), phase: "compact" };
      }
      const after = { ...state, compacting: false, compactOnly: false, busy: state.compactOnly ? false : state.busy, phase: "think", context: e.context ?? state.context };
      // too short to compact: the window says so in a note, not here
      if (e.error?.small) return after;
      const said = e.aborted ? line("[SKIP]", "요약을 멈췄어요.", "skip")
        : e.error ? line("[FAIL]", e.error.message, "fail") : line("[ OK ]", "앞부분을 요약해서 줄였어요.");
      return { ...after, items: [...state.items, said] };
    }
    case "settled": {
      state = endThink(state);
      const items = state.items.map((x) => (x.kind === "tools" && x.tools.some((t) => t.ask)
        ? { ...x, tools: x.tools.map((t) => (t.ask ? { ...t, ask: false } : t)) } : x));
      if (e.aborted) items.push(line("[SKIP]", "멈췄어요.", "skip"));
      // robin's messages from this turn get their ids (to go back to them)
      if (e.users) {
        let j = e.users.length - 1;
        for (let i = items.length - 1; i >= 0 && j >= 0; i--) {
          if (items[i].kind !== "user") continue;
          const alt = e.alts?.[e.users[j]] ?? null;
          if (items[i].entryId !== e.users[j] || items[i].alt?.at !== alt?.at || items[i].alt?.of !== alt?.of) {
            items[i] = { ...items[i], entryId: e.users[j], alt };
          }
          j--;
        }
      }
      // the turn's time and speed go under its last answer
      if (e.stats && !e.aborted) {
        for (let i = items.length - 1; i >= 0 && items[i].kind !== "user"; i--) {
          if (items[i].kind === "assistant") { items[i] = { ...items[i], meta: e.stats }; break; }
        }
      }
      return { ...state, items, busy: state.compacting, compactOnly: state.compacting, current: null, retry: null, think: null, context: e.context ?? state.context };
    }
    case "error": return { ...state, items: [...state.items, line("[FAIL]", e.message, "fail")] };
    case "retry": {
      // the failed try's error line goes: Pi drops that answer and asks again
      state = endThink(state);
      const items = state.items.slice();
      const last = items[items.length - 1];
      if (last?.kind === "line" && last.tone === "fail") items.pop();
      return { ...state, items, current: null, phase: "think", retry: { attempt: e.attempt, max: e.max, at: Date.now() + (e.delayMs || 0) } };
    }
    case "retry_end": return { ...state, retry: null };
    case "gpu": return { ...state, gpu: e.gpu, fake: e.fake };
    case "gpu_job": return { ...state, gpuJob: e.job };
    case "mode": return { ...state, mode: e.mode };
    case "thinking_mode": return { ...state, thinking: e.on };
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
