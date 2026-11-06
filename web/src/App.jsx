// The RobinCode window, in RobinAI's frame: past conversations, the folder and
// the GPU on the left, the conversation and the composer on the right. On a
// narrow window the left side becomes a drawer behind the menu button.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { api, connect } from "./api.js";
import { askingTool, initial, reducer } from "./store.js";
import { CopyButton, Markdown } from "./Markdown.jsx";
import { ANSWER_KEYS, ToolGroup } from "./Tools.jsx";
import { Icon } from "./icons.jsx";
import { ago, seconds, useNow } from "./time.js";

const LOGO = [
  "█▀█ █▀█ █▀▄ ▀█▀ █▄ █ █▀▀ █▀█ █▀▄ █▀▀",
  "█▀▄ █ █ █▀▄  █  █ ▀█ █   █ █ █ █ █▀ ",
  "▀ ▀ ▀▀▀ ▀▀  ▀▀▀ ▀  ▀ ▀▀▀ ▀▀▀ ▀▀  ▀▀▀",
];
const SUGGESTIONS = ["이 폴더 구조 설명해 줘", "package.json 읽어 줘", "README 고쳐 줘"];
const GPU_NAMES = { on: "켜짐", starting: "켜는 중", stopped: "멈춤", off: "꺼짐", unreachable: "확인 못 함", unknown: "확인 중" };
const NARROW = "(max-width: 860px)";
const isNarrow = () => window.matchMedia(NARROW).matches;

function shortPath(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return path.length > 44 && parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : path;
}

// ---- small parts ---------------------------------------------------------------
function Gpu({ gpu, fake, compact }) {
  const state = gpu.state || "unknown";
  const lamp = fake ? "test" : state === "on" ? "on" : state === "starting" ? "warn" : state === "unknown" ? "idle" : "bad";
  const short = gpu.hours != null && gpu.hours <= 1;
  return (
    <div className={`gpu${compact ? " compact" : ""}`}>
      <span className="gpu-line">
        <span className={`lamp ${lamp}`} aria-hidden="true" />
        <span className="gpu-label">GPU</span>
        <span className="gpu-state">{GPU_NAMES[state] || state}</span>
        {state === "on" && gpu.rate && <span className="gpu-rate">시간당 ${gpu.rate}</span>}
      </span>
      {gpu.credit != null && (
        <span className={`gpu-credit${short ? " warn" : ""}`}>크레딧 ${gpu.credit}{gpu.left ? ` · ${gpu.left}` : ""}</span>
      )}
      {fake && <span className="gpu-fake">가짜 모델로 시험 중</span>}
      {!fake && (state === "off" || state === "stopped") && (
        <button type="button" className="mini-btn" title="GPU 켜기·끄기 도우미를 열어요. 빌릴지는 거기서 골라요."
          onClick={() => api("/api/gpu-on").catch(() => {})}>켜기…</button>
      )}
    </div>
  );
}

function ContextMeter({ context }) {
  const p = context?.percent ?? 0;
  const tone = p >= 90 ? "bad" : p >= 75 ? "warn" : "";
  return (
    <span className={`ctx ${tone}`} title={context ? `${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} 토큰 — 여기서 앞부분을 요약해 줄여요` : "아직 대화가 없어요"}>
      <span className="ctx-label">맥락</span>
      <span className="ctx-track"><span className="ctx-fill" style={{ width: `${p}%` }} /></span>
      <span className="ctx-value">{p}%</span>
    </span>
  );
}

// text that types itself in, as the brand's terminal lines do
function Typed({ text, delay = 0, step = 34 }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let k = 0;
    let timer;
    const tick = () => { k += 1; setShown(k); if (k < text.length) timer = setTimeout(tick, step); };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  }, [text, delay, step]);
  return <><span className="sr">{text}</span><span aria-hidden="true">{text.slice(0, shown)}</span></>;
}

function Logo() {
  return (
    <pre className="logo" aria-label="RobinCode">
      {LOGO.map((line, k) => <span key={k}>{line}</span>)}
    </pre>
  );
}

// the empty conversation boots like the site's gate: the logo a line at a
// time, the question typed in, then the note and the starters
function Empty({ info, ready, onPick }) {
  return (
    <section className="empty">
      <Logo />
      <p className="empty-sub"><span className="prompt">&gt;</span> <Typed text="무엇을 할까요?" delay={180} /><span className="cursor" aria-hidden="true" /></p>
      <p className="empty-note">{info.folder ? <><span className="mono">{shortPath(info.cwd)}</span>에서 파일을 읽고, 찾고, 고치고, PowerShell 명령을 실행해요. 명령과 파일 수정은 실행 전에 물어봐요.</> : "연결하는 중이에요."}</p>
      <div className="starters">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="starter" disabled={!ready} onClick={() => onPick(s)}>
            <span className="prompt">&gt;</span> {s}
          </button>
        ))}
      </div>
    </section>
  );
}

function Line({ item }) {
  return (
    <div className={`line ${item.tone}`}>
      <span className="line-tag">{item.tag}</span>
      <span>{item.text}</span>
    </div>
  );
}

// a long paste stays a few lines tall until it is opened
function UserBubble({ text }) {
  const long = text.split("\n").length > 12 || text.length > 900;
  const [open, setOpen] = useState(false);
  return (
    <div className={`bubble${long && !open ? " clamped" : ""}`}>
      <span className="bubble-text">{text}</span>
      {long && <button type="button" className="bubble-more" onClick={() => setOpen((v) => !v)}>{open ? "접기" : "모두 보기"}</button>}
    </div>
  );
}

// where the next output will come: what the agent is doing, and for how long
function StatusRow({ state }) {
  const now = useNow(1000);
  const what = state.phase === "tool" ? `${state.runningTool} 실행하는 중` : state.phase === "write" ? "쓰는 중" : "생각하는 중";
  return (
    <div className="status-row" role="status">
      <span className="status-mark" aria-hidden="true">▌</span>
      {what}… <span className="status-time">{seconds(now - state.startedAt)}</span>
    </div>
  );
}

// the last answer of each turn (before robin's next message, or the end once
// it settled) gets a copy button; answers between tool steps do not
function turnEnds(items, busy) {
  const ends = new Set();
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== "assistant" || items[i].streaming) continue;
    let j = i + 1;
    while (j < items.length && items[j].kind !== "user" && items[j].kind !== "assistant") j++;
    if (j < items.length ? items[j].kind === "user" : !busy) ends.add(items[i].id);
  }
  return ends;
}

function Conversation({ state, asking, onDecide, onPick }) {
  const scroller = useRef(null);
  const content = useRef(null);
  const stick = useRef(true);
  const busy = useRef(state.busy);
  busy.current = state.busy;
  const [away, setAway] = useState(false);
  const onScroll = () => {
    const el = scroller.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAway(!stick.current);
  };
  // another conversation, or something robin just sent: back to the bottom
  const last = state.items[state.items.length - 1];
  useLayoutEffect(() => { stick.current = true; setAway(false); }, [state.sessionFile]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (last?.kind === "user") stick.current = true;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.busy, last]);
  // while it runs, keep following what grows (a fold opening, a code block)
  const empty = state.items.length === 0;
  useEffect(() => {
    if (empty || !content.current) return undefined;
    const watch = new ResizeObserver(() => {
      const el = scroller.current;
      if (el && stick.current && busy.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(content.current);
    return () => watch.disconnect();
  }, [empty]);
  const toBottom = () => {
    stick.current = true;
    setAway(false);
    scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  const ends = turnEnds(state.items, state.busy);
  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      {empty ? <Empty info={state.info} ready={state.ready && state.link} onPick={onPick} /> : (
        <div className="msgs" ref={content}>
          {state.items.map((item, k) => {
            if (item.kind === "user") return <div key={item.id} className="msg msg-user"><UserBubble text={item.text} /></div>;
            if (item.kind === "assistant") {
              return (
                <div key={item.id} className="msg msg-ai">
                  <Markdown text={item.text} streaming={item.streaming} />
                  {ends.has(item.id) && item.text.trim() && <div className="msg-foot"><CopyButton text={item.text} className="act" /></div>}
                </div>
              );
            }
            if (item.kind === "tools") {
              return (
                <div key={item.id} className="msg msg-tools">
                  <ToolGroup tools={item.tools} onDecide={onDecide} settled={!state.busy || k < state.items.length - 1} />
                </div>
              );
            }
            return <Line key={item.id} item={item} />;
          })}
          {state.busy && !asking && <StatusRow state={state} />}
        </div>
      )}
      {away && <button type="button" className="to-bottom" onClick={toBottom}><Icon name="down" />아래로</button>}
    </div>
  );
}

function Composer({ state, box, draft, setDraft, lastSent, onSend, onStop }) {
  // grow with the text; measured again when the width changes (the first
  // measure can come before the layout has a width)
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [box]);
  useLayoutEffect(fit, [draft, fit]);
  useEffect(() => {
    box.current?.focus();
    let width = 0;
    const watch = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - width) > 1) { width = entry.contentRect.width; fit(); }
    });
    watch.observe(box.current);
    return () => watch.disconnect();
  }, [box, fit]);
  const offline = state.ready && !state.link;
  const stop = state.busy && !draft.trim();
  const auto = state.mode === "auto";
  return (
    <footer className="composer">
      <form className="composer-box" onSubmit={(e) => { e.preventDefault(); stop ? onStop() : onSend(); }}>
        <textarea
          ref={box}
          rows={1}
          value={draft}
          disabled={offline}
          placeholder={offline ? "서버와 연결이 끊겼어요" : state.busy ? "이어서 할 말 (끝나면 이어서 처리해요)" : "무엇을 할까요?"}
          aria-label="메시지"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); stop ? onStop() : onSend(); }
            // like a shell: the last thing sent comes back on an empty line
            else if (e.key === "ArrowUp" && !draft && lastSent) { e.preventDefault(); setDraft(lastSent); }
          }}
        />
        <button type="submit" className={`btn send ${stop ? "stop" : "btn-primary"}`} disabled={offline || (!stop && !draft.trim())}>
          {stop ? "멈추기" : "보내기"}
        </button>
      </form>
      <div className="composer-foot">
        <button type="button" className={`mode${auto ? " auto" : ""}`} aria-pressed={auto}
          title={auto ? "명령과 파일 수정을 묻지 않고 실행해요. 누르면 다시 물어요." : "명령 실행과 파일 수정 전에 물어요. 누르면 묻지 않아요."}
          onClick={() => api("/api/mode", { mode: auto ? "ask" : "auto" }).catch(() => {})}>
          <span className={`lamp ${auto ? "warn" : "idle"}`} aria-hidden="true" />{auto ? "바로 실행" : "묻고 실행"}
        </button>
        <ContextMeter context={state.context} />
        <span className="keys"><kbd>Enter</kbd> 보내기 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄 바꿈 · <kbd>↑</kbd> 보낸 말 · <kbd>Esc</kbd> 멈추기</span>
      </div>
    </footer>
  );
}

// past conversations by day, newest first (the list comes sorted)
const DAY = 86400000;
function byDay(sessions, now) {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const label = (t) => (t >= midnight ? "오늘" : t >= midnight - DAY ? "어제" : t >= midnight - 6 * DAY ? "이번 주" : "그 전");
  const groups = [];
  for (const s of sessions) {
    const name = label(s.modified);
    if (groups[groups.length - 1]?.[0] !== name) groups.push([name, []]);
    groups[groups.length - 1][1].push(s);
  }
  return groups;
}

function Conv({ s, current, busy, busyNote, now, onOpen, onDelete, onRename }) {
  const [editing, setEditing] = useState(false);
  const done = useRef(false);
  const finish = (value) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const name = value.replace(/\s+/g, " ").trim();
    if (name && name !== s.title) onRename(s, name);
  };
  const edit = () => { done.current = false; setEditing(true); };
  return (
    <li className="conv" aria-current={current}>
      {editing ? (
        <input className="conv-input" defaultValue={s.title} autoFocus maxLength={80} aria-label="대화 이름" spellCheck={false}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => finish(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") { e.preventDefault(); finish(e.currentTarget.value); }
            // Esc here only puts the name back (it must not stop the agent)
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done.current = true; setEditing(false); }
          }} />
      ) : (
        <>
          <button type="button" className="conv-open" disabled={busy} title={busyNote || s.title} onClick={() => onOpen(s.path)}>
            <span className="conv-title">{s.title}</span>
            <span className="conv-time">{ago(s.modified, now)}</span>
          </button>
          <span className="conv-acts">
            <button type="button" className="icon-btn conv-act" aria-label={`"${s.title}" 이름 바꾸기`} title="이름 바꾸기"
              disabled={current && busy} onClick={edit}><Icon name="edit" /></button>
            <button type="button" className="icon-btn conv-act" aria-label={`"${s.title}" 지우기`} title="지우기"
              disabled={current && busy} onClick={() => onDelete(s)}><Icon name="close" /></button>
          </span>
        </>
      )}
    </li>
  );
}

function Sidebar({ state, closeRef, onClose, onNew, onOpen, onDelete, onRename }) {
  const now = useNow(60000);
  const busyNote = state.busy ? "끝나거나 멈춘 뒤에 열 수 있어요" : undefined;
  return (
    <aside className="side" id="side" aria-label="대화 목록">
      <div className="side-head">
        <span className="brand">ROBINCODE</span>
        <button ref={closeRef} type="button" className="icon-btn side-close" aria-label="목록 닫기" onClick={onClose}><Icon name="close" /></button>
      </div>
      <button type="button" className="btn new-chat" onClick={onNew} disabled={state.busy} title={busyNote}>
        <Icon name="plus" /> 새 대화
      </button>
      <nav className="conv-nav" aria-label="지난 대화">
        {state.sessions.length === 0 ? <><p className="side-label">지난 대화</p><p className="conv-empty">아직 없어요.</p></> : (
          byDay(state.sessions, now).map(([day, list]) => (
            <section key={day} className="conv-day" aria-label={day}>
              <p className="side-label">{day}</p>
              <ul className="conv-list">
                {list.map((s) => (
                  <Conv key={s.path} s={s} current={s.path === state.sessionFile} busy={state.busy} busyNote={busyNote} now={now}
                    onOpen={onOpen} onDelete={onDelete} onRename={onRename} />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
      <div className="side-foot">
        <div className="side-row" title={state.info.cwd}><span className="side-label">폴더</span><span className="mono">{shortPath(state.info.cwd)}</span></div>
        <div className="side-row"><span className="side-label">모델</span><span className="mono">{state.info.model}</span></div>
        <Gpu gpu={state.gpu} fake={state.fake} />
      </div>
    </aside>
  );
}

function Toast({ toast, onDone }) {
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.action && <button type="button" className="toast-btn" onClick={() => { onDone(); toast.action.run(); }}>{toast.action.label}</button>}
    </div>
  );
}

// ---- the app ---------------------------------------------------------------------
export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [draft, setDraft] = useState("");
  const [side, setSide] = useState(false); // the drawer, on a narrow window
  const [toast, setToast] = useState(null);
  const box = useRef(null);
  const menuRef = useRef(null);
  const closeRef = useRef(null);
  const toastTimer = useRef(0);

  const say = useCallback((text, action) => {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, action });
    toastTimer.current = setTimeout(() => setToast(null), action ? 6000 : 2600);
  }, []);
  const fail = useCallback((e) => say(e.message === "busy" ? "도는 중이라 지금은 못 해요. 끝나거나 멈춘 뒤에 해 주세요." : `하지 못했어요: ${e.message}`), [say]);
  const loadSessions = useCallback(() => {
    api("/api/sessions").then((r) => dispatch({ type: "sessions", sessions: r.sessions })).catch(() => {});
  }, []);

  useEffect(() => connect((e) => dispatch({ type: "event", e }), (up) => dispatch({ type: "link", up })), []);
  useEffect(() => { if (state.ready) loadSessions(); }, [state.ready, state.sessionFile, state.busy, loadSessions]);
  // the taskbar shows it too: a question waiting, or still running
  const waiting = !!askingTool(state);
  useEffect(() => {
    const name = state.title ? `${state.title} · RobinCode` : `RobinCode · ${state.info.folder}`;
    document.title = waiting ? `[ ?? ] 허락을 기다려요 · ${name}` : state.busy ? `[ .. ] ${name}` : name;
  }, [state.title, state.info.folder, state.busy, waiting]);
  // the drawer means nothing on a wide window
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = () => { if (!query.matches) setSide(false); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const focusBox = () => requestAnimationFrame(() => box.current?.focus());
  const openSide = () => { setSide(true); requestAnimationFrame(() => closeRef.current?.focus()); };
  const closeSide = (toMenu) => { setSide(false); if (toMenu && isNarrow()) menuRef.current?.focus(); };

  const send = useCallback(async (text = draft) => {
    const t = text.trim();
    if (!t) return;
    setDraft("");
    try { await api("/api/prompt", { text: t }); } catch (e) {
      dispatch({ type: "local-error", message: `보내지 못했어요: ${e.message}` });
      setDraft(t);
    }
  }, [draft]);
  const stop = useCallback(() => { api("/api/abort").catch(() => {}); }, []);
  const decide = useCallback((id, decision) => {
    dispatch({ type: "decided", id, decision });
    api("/api/approve", { id, decision }).catch((e) => dispatch({ type: "local-error", message: e.message }));
    focusBox();
  }, []);
  const newChat = () => api("/api/new").then(() => { closeSide(false); focusBox(); }).catch(fail);
  const open = (path) => api("/api/open", { path }).then(() => { closeSide(false); focusBox(); }).catch(fail);
  const remove = (s) => api("/api/delete", { path: s.path }).then(() => {
    loadSessions();
    say("대화를 지웠어요.", { label: "되돌리기", run: () => api("/api/restore", { path: s.path }).then(loadSessions).catch(fail) });
  }).catch(fail);
  const rename = (s, name) => api("/api/rename", { path: s.path, name }).then(loadSessions).catch(fail);

  const asking = askingTool(state);
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        if (side && isNarrow()) { e.preventDefault(); closeSide(true); }
        else if (state.busy) { e.preventDefault(); stop(); }
        return;
      }
      // 1 / 2 / 3 answer the question on screen, unless something is being
      // typed (anything in the message box, or any other field at all)
      const answer = ANSWER_KEYS[e.key];
      if (!asking || !answer || e.ctrlKey || e.altKey || e.metaKey) return;
      const field = e.target.closest?.("textarea, input");
      if (field && (field !== box.current || field.value)) return;
      e.preventDefault();
      decide(asking.id, answer);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [side, state.busy, asking, stop, decide]);

  const lastSent = [...state.items].reverse().find((x) => x.kind === "user")?.text || "";
  return (
    <div className="app" data-side={side ? "open" : undefined}>
      <Sidebar state={state} closeRef={closeRef} onClose={() => closeSide(true)} onNew={newChat} onOpen={open} onDelete={remove} onRename={rename} />
      <div className="scrim" onClick={() => closeSide(true)} aria-hidden="true" />
      <main className="main">
        <header className="main-head">
          <button ref={menuRef} type="button" className="icon-btn menu-btn" aria-label="대화 목록 열기" aria-controls="side"
            aria-expanded={side} onClick={openSide}><Icon name="menu" /></button>
          <h1 className="main-title" key={state.title}>{state.title || "새 대화"}</h1>
          <div className="head-narrow"><Gpu gpu={state.gpu} fake={state.fake} compact /></div>
        </header>
        {state.ready && !state.link && <div className="lost" role="alert">RobinCode 서버와 연결이 끊겼어요. 창을 닫고 다시 여세요.</div>}
        <Conversation state={state} asking={asking} onDecide={decide} onPick={(s) => send(s)} />
        <Composer state={state} box={box} draft={draft} setDraft={setDraft} lastSent={lastSent} onSend={() => send()} onStop={stop} />
        {toast && <Toast key={toast.id} toast={toast} onDone={() => setToast(null)} />}
      </main>
    </div>
  );
}
