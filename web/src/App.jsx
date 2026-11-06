// The RobinCode window, in RobinAI's frame: past conversations, the folder and
// the GPU on the left, the conversation and the composer on the right. On a
// narrow window the left side folds away and the header keeps "new" and the GPU.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { api, connect } from "./api.js";
import { askingNow, initial, reducer } from "./store.js";
import { Markdown } from "./Markdown.jsx";
import { ToolGroup } from "./Tools.jsx";
import { ago, seconds, useNow } from "./time.js";

const LOGO = [
  "█▀█ █▀█ █▀▄ ▀█▀ █▄ █ █▀▀ █▀█ █▀▄ █▀▀",
  "█▀▄ █ █ █▀▄  █  █ ▀█ █   █ █ █ █ █▀ ",
  "▀ ▀ ▀▀▀ ▀▀  ▀▀▀ ▀  ▀ ▀▀▀ ▀▀▀ ▀▀  ▀▀▀",
];
const SUGGESTIONS = ["이 폴더 구조 설명해 줘", "package.json 읽어 줘", "README 고쳐 줘"];
const GPU_NAMES = { on: "켜짐", starting: "켜는 중", stopped: "멈춤", off: "꺼짐", unreachable: "확인 못 함", unknown: "확인 중" };

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

function Logo() {
  return (
    <pre className="logo" aria-label="RobinCode">
      {LOGO.map((line, k) => <span key={k}>{line}</span>)}
    </pre>
  );
}

function Empty({ info, onPick }) {
  return (
    <section className="empty">
      <Logo />
      <p className="empty-sub"><span className="prompt">&gt;</span> 무엇을 할까요?<span className="cursor" aria-hidden="true" /></p>
      <p className="empty-note">{info.folder ? <><span className="mono">{shortPath(info.cwd)}</span>에서 파일을 읽고, 찾고, 고치고, PowerShell 명령을 실행해요. 명령과 파일 수정은 실행 전에 물어봐요.</> : "연결하는 중이에요."}</p>
      <div className="starters">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="starter" onClick={() => onPick(s)}>
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

function Conversation({ state, onDecide, onPick }) {
  const scroller = useRef(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = () => {
    const el = scroller.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAway(!stick.current);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items]);
  const toBottom = () => {
    stick.current = true;
    setAway(false);
    scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      {state.items.length === 0 ? <Empty info={state.info} onPick={onPick} /> : (
        <div className="msgs">
          {state.items.map((item) => {
            if (item.kind === "user") {
              return (
                <div key={item.id} className="msg msg-user">
                  <div className="bubble"><span className="bubble-text">{item.text}</span></div>
                </div>
              );
            }
            if (item.kind === "assistant") return <div key={item.id} className="msg msg-ai"><Markdown text={item.text} streaming={item.streaming} /></div>;
            if (item.kind === "tools") return <div key={item.id} className="msg msg-tools"><ToolGroup tools={item.tools} onDecide={onDecide} /></div>;
            return <Line key={item.id} item={item} />;
          })}
        </div>
      )}
      {away && <button type="button" className="to-bottom" onClick={toBottom}>아래로</button>}
    </div>
  );
}

function Status({ state }) {
  const now = useNow(1000);
  if (!state.busy) return null;
  const asking = askingNow(state);
  const what = asking ? "허락을 기다려요" : state.phase === "tool" ? `${state.runningTool} 실행하는 중` : state.phase === "write" ? "쓰는 중" : "생각하는 중";
  return (
    <div className={`status-line${asking ? " asking" : ""}`}>
      <span className="status-mark" aria-hidden="true">{asking ? "?" : "▌"}</span>
      {what}{asking ? "" : "…"} <span className="status-time">{seconds(now - state.startedAt)}</span>
    </div>
  );
}

function Composer({ state, draft, setDraft, onSend, onStop }) {
  const box = useRef(null);
  // grow with the text; measured again when the width changes (the first
  // measure can come before the layout has a width)
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [draft, fit]);
  useEffect(() => {
    box.current?.focus();
    let width = 0;
    const watch = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - width) > 1) { width = entry.contentRect.width; fit(); }
    });
    watch.observe(box.current);
    return () => watch.disconnect();
  }, [fit]);
  const stop = state.busy && !draft.trim();
  const auto = state.mode === "auto";
  return (
    <footer className="composer">
      <Status state={state} />
      <form className="composer-box" onSubmit={(e) => { e.preventDefault(); stop ? onStop() : onSend(); }}>
        <textarea
          ref={box}
          rows={1}
          value={draft}
          placeholder={state.busy ? "이어서 할 말 (끝나면 이어서 처리해요)" : "무엇을 할까요?"}
          aria-label="메시지"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); stop ? onStop() : onSend(); }
          }}
        />
        <button type="submit" className={`btn send ${stop ? "stop" : "btn-primary"}`} disabled={!stop && !draft.trim()}>
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
        <span className="keys"><kbd>Enter</kbd> 보내기 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄 바꿈 · <kbd>Esc</kbd> 멈추기</span>
      </div>
    </footer>
  );
}

function Sidebar({ state, onNew, onOpen }) {
  const now = useNow(60000);
  return (
    <aside className="side">
      <div className="side-head">
        <span className="brand">ROBINCODE</span>
      </div>
      <button type="button" className="btn new-chat" onClick={onNew} disabled={state.busy}>
        <span className="plus" aria-hidden="true">+</span> 새 대화
      </button>
      <nav className="conv-nav" aria-label="지난 대화">
        <p className="side-label">지난 대화</p>
        {state.sessions.length === 0 ? <p className="conv-empty">아직 없어요.</p> : (
          <ul className="conv-list">
            {state.sessions.map((s) => (
              <li key={s.path} className="conv" aria-current={s.path === state.sessionFile}>
                <button type="button" className="conv-open" disabled={state.busy} onClick={() => onOpen(s.path)}>
                  <span className="conv-title">{s.title}</span>
                  <span className="conv-time">{ago(s.modified, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="side-foot">
        <div className="side-folder" title={state.info.cwd}><span className="side-label">폴더</span><span className="mono">{shortPath(state.info.cwd)}</span></div>
        <Gpu gpu={state.gpu} fake={state.fake} />
      </div>
    </aside>
  );
}

// ---- the app ---------------------------------------------------------------------
export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [draft, setDraft] = useState("");

  const loadSessions = useCallback(() => {
    api("/api/sessions").then((r) => dispatch({ type: "sessions", sessions: r.sessions })).catch(() => {});
  }, []);

  useEffect(() => connect((e) => dispatch({ type: "event", e }), (up) => dispatch({ type: "link", up })), []);
  useEffect(() => { if (state.ready) loadSessions(); }, [state.ready, state.sessionFile, state.busy, loadSessions]);
  useEffect(() => { document.title = state.title ? `${state.title} · RobinCode` : `RobinCode · ${state.info.folder}`; }, [state.title, state.info.folder]);

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
  }, []);
  const newChat = () => api("/api/new").catch((e) => dispatch({ type: "local-error", message: e.message }));
  const open = (path) => api("/api/open", { path }).catch((e) => dispatch({ type: "local-error", message: e.message }));

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && state.busy) { e.preventDefault(); stop(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.busy, stop]);

  return (
    <div className="app">
      <Sidebar state={state} onNew={newChat} onOpen={open} />
      <main className="main">
        <header className="main-head">
          <h1 className="main-title">{state.title || "새 대화"}</h1>
          {/* only on a narrow window, where the left side is folded away */}
          <div className="head-narrow">
            <Gpu gpu={state.gpu} fake={state.fake} compact />
            <button type="button" className="btn btn-small" onClick={newChat} disabled={state.busy}>새 대화</button>
          </div>
        </header>
        {state.ready && !state.link && <div className="lost">RobinCode 서버와 연결이 끊겼어요. 창을 닫고 다시 여세요.</div>}
        <Conversation state={state} onDecide={decide} onPick={(s) => send(s)} />
        <Composer state={state} draft={draft} setDraft={setDraft} onSend={() => send()} onStop={stop} />
      </main>
    </div>
  );
}
