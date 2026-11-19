// The window's state, built from server events (server.mjs onEvent / state()).
// items is the conversation as drawn: user messages, assistant text, groups of
// tool steps (with their approval question inline) and status lines.

export const BLOCKED = "허락하지 않았어요";

export const initial = {
  link: false, // the event stream is up
  ready: false, // the first state arrived
  info: { cwd: "", folder: "", chat: false, model: "Qwen3.8-27B" }, // chat: a plain conversation (no folder)
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
  running: [], // conversations going on, this one too: [{ path, title, asking }]
  // robin's messages sent while the turn runs: [{ kind: steer | follow, text,
  // pictures, held }] — steer: told after the step the model is on; follow:
  // sent when the turn ends; held: kept until a summary (or a check) is done
  queued: [],
  saved: false, // something was ever sent in it (a new one is in no list until then)
  git: null, // the folder's { branch, changed, ahead, behind }, or null (not a repository)
  planFrom: "ask", // the mode "이 계획대로 하기" goes back to
  // which RobinCode this is, what changed, a newer one (server.mjs readVersion)
  version: null,
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
      if (m.text) items.push({ kind: "assistant", id: id("a", m), text: m.text, streaming: false, planned: !!m.planned, ...flags(m) });
      for (const t of m.tools) addTool(items, { id: t.id, name: t.name, args: t.args || {}, status: "run" }, { id: `g-${t.id}`, ...flags(m) });
      if (m.error) items.push({ kind: "line", id: id("e", m), tag: "[FAIL]", text: m.error, tone: "fail", ...flags(m) });
    } else if (m.role === "tool") {
      if (!updateTool(items, m.id, finished(m.isError, m.output))) {
        addTool(items, { id: m.id, name: m.name, args: {}, ...finished(m.isError, m.output) }, { id: `g-${m.id}`, ...flags(m) });
      }
    } else if (m.role === "shell") {
      items.push({ kind: "shell", id: id("s", m), command: m.command, output: m.output, exitCode: m.exitCode, cancelled: m.cancelled, status: "done", ...flags(m) });
    } else if (m.role === "compaction") {
      items.push({ kind: "line", id: id("c", m), tag: "[ OK ]", tone: "",
        text: m.faded ? "앞부분을 요약했어요. 흐린 부분은 모델이 요약으로만 기억해요." : "앞부분을 요약해서 줄였어요.", ...(still && { still }) });
    } else if (m.role === "note") {
      const skip = m.tone === "skip";
      items.push({ kind: "line", id: id("n", m), tag: skip ? "[SKIP]" : "[FAIL]", text: m.text, tone: skip ? "skip" : "fail", ...flags(m) });
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
      if (action.decision === "always" && state.mode === "plan") items.push(line("[ OK ]", "이번만 허용했어요. 계획 모드는 그대로예요."));
      else if (action.decision === "always") items.push(line("[ OK ]", "이번 대화는 묻지 않고 실행해요. 아래 모드 버튼(Shift+Tab)으로 다시 묻게 할 수 있어요."));
      if (action.decision === "rule" && action.rule) items.push(line("[ OK ]", `${action.rule.key.startsWith("web:") ? `${action.rule.label} 페이지는` : `"${action.rule.label}" 명령은`} 이 폴더에서 이제 묻지 않아요.`));
      return { ...state, items };
    }
    // the answer did not reach the server (it still waits): the buttons come back
    case "undecided": {
      const items = state.items.slice();
      // only a call still waiting: one that ran (its end came) stays as it is
      updateTool(items, action.id, (t) => (t.status === "run" ? { ask: true, decision: undefined } : {}));
      return { ...state, items: [...items, { ...line("[FAIL]", `답을 보내지 못했어요: ${action.message} 다시 골라 주세요.`, "fail") }] };
    }
    case "local-error":
      return { ...state, items: [...state.items, { ...line("[FAIL]", action.message, "fail"), gpu: !!action.gpu }] };
    case "event": return onEvent(state, action.e);
    default: return state;
  }
}

// the questions still waiting on the server get their buttons back (a window
// that connected again)
function withAsking(items, asking) {
  if (!asking?.length) return items;
  const out = items.slice();
  for (const a of asking) if (!updateTool(out, a.id, { ask: true, status: "run", args: a.args || {}, rule: a.rule || null, risk: a.risk || null, was: a.was })) addTool(out, { id: a.id, name: a.name, args: a.args || {}, status: "run", ask: true, rule: a.rule || null, risk: a.risk || null, was: a.was });
  return out;
}

// what the model is writing right now, in a conversation robin came back to
function withLive(items, live) {
  if (!live || (!live.thinking && !live.text)) return { items, think: null, current: null };
  const out = items.slice();
  let think = null;
  let current = null;
  if (live.thinking) {
    const step = thinkStep(live.thinking, { status: live.text ? "ok" : "run", startedAt: Date.now() });
    addTool(out, step);
    if (!live.text) think = step.id;
  }
  if (live.text) {
    current = nid();
    // a plan being written keeps its "이 계획대로 하기" (a window that connected again)
    out.push({ kind: "assistant", id: current, text: live.text, streaming: true, planned: !!live.planned });
  }
  return { items: out, think, current };
}

function onEvent(state, e) {
  switch (e.t) {
    case "reset": {
      const s = e.state;
      const now = withLive(withAsking(fromHistory(s.history, true), s.asking), s.live);
      // a `!명령` still running there: it shows (and Esc stops it) again
      if (s.shell) now.items = [...now.items, { kind: "shell", id: `sh-${s.shell.id}`, command: s.shell.command, output: s.shell.output || "", status: "run", startedAt: s.shell.startedAt || Date.now() }];
      return {
        ...state, ready: true, info: { cwd: s.cwd, folder: s.folder, chat: !!s.chat, model: s.model }, fake: s.fake, gpu: s.gpu, gpuFake: !!s.gpuFake, gpuJob: s.gpuJob || null,
        mode: s.mode, thinking: !!s.thinking, think: now.think, context: s.context, busy: s.busy, startedAt: s.busy ? s.startedAt || Date.now() : 0,
        phase: s.compacting ? "compact" : now.current ? "write" : "think", compacting: !!s.compacting, compactOnly: !!s.compacting,
        items: now.items, current: now.current, sessionFile: s.sessionFile, title: s.title, retry: null, running: s.running || [], queued: s.queued || [], saved: !!s.saved,
        git: s.git ?? null, planFrom: s.planFrom || "ask", version: s.version || state.version,
      };
    }
    // robin's own `!명령`, running in the folder
    case "shell_start":
      return { ...state, items: [...state.items, { kind: "shell", id: `sh-${e.id}`, command: e.command, output: "", status: "run", startedAt: Date.now() }] };
    case "shell_update":
    case "shell_end": {
      const items = state.items.map((x) => (x.id === `sh-${e.id}`
        ? { ...x, output: e.output, ...(e.t === "shell_end" && { status: "done", exitCode: e.exitCode, cancelled: e.cancelled, ms: Date.now() - (x.startedAt || Date.now()) }) } : x));
      // its end, for a command this window did not see start
      if (e.t === "shell_end" && !state.items.some((x) => x.id === `sh-${e.id}`) && e.command) {
        items.push({ kind: "shell", id: `sh-${e.id}`, command: e.command, output: e.output, exitCode: e.exitCode, cancelled: e.cancelled, status: "done" });
      }
      return { ...state, items };
    }
    case "git": return { ...state, git: e.git ?? null };
    case "user": {
      // midway: robin's word to a turn that runs (it does not end its task list)
      const items = [...state.items, { kind: "user", id: nid(), text: e.text, images: e.images || [], ...(state.busy ? { midway: true } : {}) }];
      return {
        ...state, items, busy: true, startedAt: state.busy ? state.startedAt : Date.now(), phase: "think", retry: null, saved: true,
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
        items.push({ kind: "assistant", id: current, text: e.delta, streaming: true, planned: state.mode === "plan" });
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
      if (!updateTool(items, e.id, { ask: true, args: e.args || {}, rule: e.rule || null, risk: e.risk || null, was: e.was })) addTool(items, { id: e.id, name: e.name, args: e.args || {}, status: "run", ask: true, rule: e.rule || null, risk: e.risk || null, was: e.was });
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
      // stopped by RobinCode (going round in circles): why, as a failure
      if (e.aborted) items.push(e.why ? line("[FAIL]", e.why, "fail") : line("[SKIP]", "멈췄어요.", "skip"));
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
      return { ...state, items, busy: state.compacting, compactOnly: state.compacting, current: null, retry: null, think: null, context: e.context ?? state.context,
        queued: e.aborted ? [] : state.queued };
    }
    // a loop was cut and the turn goes on (still busy)
    case "loop_retry": {
      state = endThink(state);
      return { ...state, items: [...state.items, line("[SKIP]", e.text, "skip")], current: null, phase: "think" };
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
    case "running": return { ...state, running: e.running || [] };
    case "queued": return { ...state, queued: e.queued || [] };
    case "gpu": return { ...state, gpu: e.gpu, fake: e.fake };
    case "version": return { ...state, version: e.version };
    case "gpu_job": return { ...state, gpuJob: e.job };
    // to "바로 실행": the server said yes to the question on screen too
    case "mode": {
      const items = e.mode !== "auto" ? state.items : state.items.map((x) => (x.kind === "tools" && x.tools.some((t) => t.ask)
        ? { ...x, tools: x.tools.map((t) => (t.ask ? { ...t, ask: false, decision: "yes" } : t)) } : x));
      return { ...state, items, mode: e.mode, planFrom: e.planFrom || state.planFrom };
    }
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
