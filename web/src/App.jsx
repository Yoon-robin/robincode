// The RobinCode window, in RobinAI's frame: past conversations, the folder and
// the GPU on the left, the conversation and the composer on the right. On a
// narrow window the left side becomes a drawer behind the menu button.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, connect, pickerUrl } from "./api.js";
import { askingTool, initial, reducer } from "./store.js";
import { Composer, PICTURE_TYPES } from "./Composer.jsx";
import { CopyButton, Markdown } from "./Markdown.jsx";
import { ANSWER_KEYS, REVEAL, ShellRun, TodoPanel, ToolGroup, describe, latestTodo } from "./Tools.jsx";
import { Icon } from "./icons.jsx";
import { ago, seconds, useNow } from "./time.js";
import { MODE_NAMES, nextMode } from "./modes.js";
import { BUILTIN, INIT_PROMPT } from "./commands.js";

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
// minutes before the server deletes the GPU for not being used (robinai-gpu
// autooff), when that is 3 or fewer; null otherwise
const offSoon = (gpu) => (gpu?.state === "on" && gpu.idle != null && gpu.idleLimit && gpu.idleLimit - gpu.idle <= 3
  ? Math.max(0, gpu.idleLimit - gpu.idle) : null);
const lampOf = (state) => (state === "on" ? "on" : state === "starting" ? "warn" : state === "unknown" ? "idle" : "bad");

// ---- turning on: where a rent or start is ------------------------------------------
// robinai-gpu says it every 10 s ("진행:" lines, server.mjs parseProgress)
const STEPS = { rent: ["빌리기", "이미지 받기", "모델 받기", "GPU에 올리기", "준비"], start: ["켜기", "GPU에 올리기", "준비"] };
// from this window's job, or from the server's status: a rent from
// robinai-gpu.cmd, or one from before this window was opened again
function progressOf(gpu, job) {
  if (job?.running && STEPS[job.action]) {
    const first = { step: 1, of: STEPS[job.action].length, name: STEPS[job.action][0], since: job.at,
      more: job.action === "rent" ? "Vast에 자리를 빌리는 중이에요" : "Vast에 켜 달라고 하는 중이에요" };
    return { action: job.action, p: job.progress || first };
  }
  if (gpu?.state === "starting" && gpu.progress) return { action: gpu.progress.of === 5 ? "rent" : "start", p: gpu.progress };
  return null;
}
const stepsOf = (action, p) => {
  let steps = STEPS[action] || [];
  if (!steps.includes(p.name)) steps = [...steps.slice(0, -2), p.name, ...steps.slice(-2)]; // the script adds one the same way
  return steps.length === p.of ? steps : Array.from({ length: p.of }, (_, i) => (i + 1 === p.step ? p.name : ""));
};
const downloadOf = (p) => (p.name === "모델 받기" && p.total ? Math.min(1, (p.got || 0) / p.total) : null);
function GpuProgress({ action, p, mini }) {
  const now = useNow(1000);
  const steps = stepsOf(action, p);
  const dl = downloadOf(p);
  const gone = p.since ? Math.max(0, Math.floor((now - p.since) / 1000)) : null;
  const when = [gone != null && `${Math.floor(gone / 60)}분 ${String(gone % 60).padStart(2, "0")}초 지남`, p.left && `약 ${p.left}분 남음`].filter(Boolean).join(" · ");
  const bar = (
    <div className="gpu-segs" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }} aria-hidden="true">
      {steps.map((_, i) => (
        <span key={i} className={`gpu-seg${i + 1 < p.step ? " done" : i + 1 === p.step ? " now" : ""}`}>
          {i + 1 === p.step && <i style={{ width: `${Math.round((dl ?? 0) * 100)}%` }} />}
        </span>
      ))}
    </div>
  );
  if (mini) {
    return (
      <div className="gpu-mini" role="status">
        {bar}
        <span className="gpu-mini-text">{p.name}{dl != null ? ` ${p.got.toFixed(1)}/${p.total.toFixed(1)}GB` : ""}{p.left ? ` · 약 ${p.left}분` : ""}</span>
      </div>
    );
  }
  return (
    <div className="gpu-progress">
      <div className="gpu-progress-head">
        <span><span className="gpu-faint">단계 {p.step}/{steps.length}</span> <b>{p.name}</b></span>
        {when && <span className="gpu-progress-when">{when}</span>}
      </div>
      {bar}
      <ol className="gpu-steps" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
        {steps.map((name, i) => (
          <li key={i} className={i + 1 < p.step ? "done" : i + 1 === p.step ? "now" : ""} aria-current={i + 1 === p.step ? "step" : undefined}>{name}</li>
        ))}
      </ol>
      {(dl != null || p.mbps) && (
        <p className="gpu-progress-dl">
          {dl != null && <>{p.got.toFixed(1)} / {p.total.toFixed(1)}GB <span className="gpu-faint">({Math.round(dl * 100)}%)</span></>}
          {p.mbps ? <span className="gpu-faint">{dl != null ? " · " : ""}{p.mbps}Mbps</span> : null}
        </p>
      )}
      {p.more && <p className="gpu-note gpu-progress-more">{p.more}</p>}
    </div>
  );
}

function Gpu({ gpu, fake, gpuFake, job, compact, onOpen }) {
  const prog = progressOf(gpu, job);
  const state = prog ? "starting" : gpu.state || "unknown"; // a rent says "켜는 중" before Vast does
  const lamp = fake && !gpuFake ? "test" : lampOf(state);
  const short = gpu.hours != null && gpu.hours <= 1;
  const can = !fake || gpuFake;
  const label = job?.running ? JOB_WORDS[job.action][0] : state === "on" || state === "starting" ? "끄기…" : "켜기…";
  const dl = prog && downloadOf(prog.p);
  return (
    <div className={`gpu${compact ? " compact" : ""}`}>
      <span className="gpu-line">
        <span className={`lamp ${lamp}`} aria-hidden="true" />
        <span className="gpu-label">GPU</span>
        <span className="gpu-state">{GPU_NAMES[state] || state}{compact && prog ? ` · ${prog.p.name}${dl != null ? ` ${Math.round(dl * 100)}%` : ""}` : ""}</span>
        {state === "on" && gpu.rate && <span className="gpu-rate">시간당 ${gpu.rate}</span>}
      </span>
      {gpu.credit != null && (
        <span className={`gpu-credit${short ? " warn" : ""}`}>크레딧 ${gpu.credit}{gpu.left ? ` · ${gpu.left}` : ""}</span>
      )}
      {fake && <span className="gpu-fake">가짜 모델로 시험 중</span>}
      {can && state !== "unknown" && state !== "unreachable" && (
        <button type="button" className={`mini-btn${job?.running ? " working" : ""}`} onClick={onOpen}
          title="GPU를 켜고 끄는 창을 열어요. 빌릴 자리는 거기서 골라요.">{label}</button>
      )}
      {prog && !compact && <GpuProgress action={prog.action} p={prog.p} mini />}
    </div>
  );
}

// how full the model's context is; pressed, it says more and can summarize
// the start of the conversation now
function ContextMeter({ context, busy, onCompact }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    // Esc here only closes this (it must not stop the agent)
    const esc = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      wrap.current?.querySelector(".ctx")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  const p = context?.percent ?? 0;
  const tone = p >= 90 ? "bad" : p >= 75 ? "warn" : "";
  const about = context?.approx ? "약 " : "";
  return (
    <span className="ctx-wrap" ref={wrap}>
      <button type="button" className={`ctx ${tone}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}
        title={context ? `${about}${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} 토큰` : "아직 대화가 없어요"}>
        <span className="ctx-label">맥락</span>
        <span className="ctx-track"><span className="ctx-fill" style={{ width: `${p}%` }} /></span>
        <span className="ctx-value">{about}{p}%</span>
      </button>
      {open && (
        <div className="ctx-pop" role="dialog" aria-label="맥락">
          <p className="ctx-pop-head"><span>맥락</span><b>{about}{p}%</b></p>
          <p className="ctx-pop-num">{context ? `${about}${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} 토큰` : "아직 대화가 없어요."}</p>
          <p className="ctx-pop-note">끝까지 차면 앞부분을 저절로 요약해요. 지금 요약하면 모델은 앞부분을 요약으로만 기억하고, 그만큼 더 오래 이어서 일해요.</p>
          <button type="button" className="btn ctx-go" disabled={busy || !context} onClick={() => { setOpen(false); onCompact(); }}>
            앞부분 지금 요약하기
          </button>
          {busy && <p className="ctx-pop-note">도는 중이라 끝난 뒤에 할 수 있어요.</p>}
        </div>
      )}
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

// drawn again in place, or summarized away: the classes the items carry
const marks = (item) => `${item.still ? " still" : ""}${item.old ? " old" : ""}`;

function Line({ item, onGpu }) {
  return (
    <div className={`line ${item.tone}${marks(item)}`}>
      <span className="line-tag">{item.tag}</span>
      <span>{item.text}</span>
      {item.gpu && onGpu && <button type="button" className="mini-btn line-btn" onClick={onGpu}>GPU 켜기…</button>}
    </div>
  );
}

// a long paste stays a few lines tall until it is opened; pictures sit above
// the words, small until one is pressed
function UserBubble({ text, images = [], foot }) {
  const long = text.split("\n").length > 12 || text.length > 900;
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(-1);
  return (
    <div className="bubble-col">
      {images.length > 0 && (
        <div className="bubble-pics">
          {images.map((im, k) => (
            <button key={k} type="button" className={`bubble-pic${big === k ? " big" : ""}`} aria-pressed={big === k}
              title={big === k ? "작게" : "크게"} onClick={() => setBig((v) => (v === k ? -1 : k))}>
              <img src={`data:${im.mimeType};base64,${im.data}`} alt={`보낸 그림 ${k + 1}`} />
            </button>
          ))}
        </div>
      )}
      {text && (
        <div className={`bubble${long && !open ? " clamped" : ""}`}>
          <span className="bubble-text">{text}</span>
          {long && <button type="button" className="bubble-more" onClick={() => setOpen((v) => !v)}>{open ? "접기" : "모두 보기"}</button>}
        </div>
      )}
      {foot}
    </div>
  );
}

// ‹ 2/3 ›: the other messages robin sent at this place, each with its answers
function AltNav({ alt, busy, onGo }) {
  const note = busy ? "끝나거나 멈춘 뒤에 볼 수 있어요" : undefined;
  return (
    <div className="msg-alt" role="group" aria-label={`이 자리에서 보낸 말 ${alt.of}개 중 ${alt.at}번째`}>
      <button type="button" className="icon-btn" disabled={busy || !alt.prev} aria-label="앞서 보낸 말과 그 답 보기"
        title={note || "앞서 보낸 말과 그 답"} onClick={() => onGo(alt.prev)}><Icon name="left" /></button>
      <span className="alt-at" aria-hidden="true">{alt.at}/{alt.of}</span>
      <button type="button" className="icon-btn" disabled={busy || !alt.next} aria-label="나중에 보낸 말과 그 답 보기"
        title={note || "나중에 보낸 말과 그 답"} onClick={() => onGo(alt.next)}><Icon name="right" /></button>
    </div>
  );
}

// Windows notifications while robin looks at another window: a question
// waiting, or the turn over. Off until robin turns them on (the browser asks
// once; the window keeps its address between runs, so it stays allowed)
const NOTIFY_KEY = "robincode.notify";
const HAS_NOTIFY = typeof Notification !== "undefined";
function notifyNow() {
  if (!HAS_NOTIFY) return "none";
  if (Notification.permission === "denied") return "blocked";
  let on = false;
  try { on = localStorage.getItem(NOTIFY_KEY) === "1"; } catch { /* storage off */ }
  return on && Notification.permission === "granted" ? "on" : "off";
}
function keepNotify(on) {
  try { localStorage.setItem(NOTIFY_KEY, on ? "1" : "0"); } catch { /* storage off */ }
}
function ping(title, body) {
  if (document.hasFocus()) return;
  try {
    const n = new Notification(title, { body, tag: "robincode", silent: true, icon: "/favicon.ico" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* not allowed any more */ }
}
// an answer's first line, without the Markdown marks
const firstWords = (text) => (text || "").trim().split("\n")[0].replace(/[#*`>_|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

function NotifyRow({ notify, onToggle }) {
  if (notify === "none") return null;
  const on = notify === "on";
  const blocked = notify === "blocked";
  return (
    <div className="side-row">
      <span className="side-label">알림</span>
      <span className="notify">
        <button type="button" className={`mode${on ? " on" : ""}`} aria-pressed={on} disabled={blocked} onClick={onToggle}
          title={on ? "다른 창을 보고 있을 때 허락이 필요하거나 끝나면 Windows 알림으로 알려요. 누르면 꺼요." : "누르면 다른 창을 보고 있을 때 허락이 필요하거나 끝나면 Windows 알림으로 알려요."}>
          <span className={`lamp ${on ? "on" : "idle"}`} aria-hidden="true" />{on ? "켬" : blocked ? "막힘" : "끔"}
        </button>
        <span className="notify-note">{blocked ? "창의 사이트 설정에서 알림을 허용해 주세요" : "다른 창일 때 허락·끝남"}</span>
      </span>
    </div>
  );
}

// commands: what they change, going back cannot put back (edit / write it can)
const COMMANDS = new Set(["powershell", "bash"]);
// "파일 2개(README.md, notes.md)"
function filesWord(names) {
  const listed = names.slice(0, 2).join(", ") + (names.length > 2 ? ` 외 ${names.length - 2}개` : "");
  return `파일 ${names.length}개(${listed})`;
}
// what /api/files-sync did, said plainly
function syncWords(r, done) {
  const parts = [];
  if (r.done.length) parts.push(`${filesWord(r.done)}를 ${done}.`);
  if (r.left.length) parts.push(`${filesWord(r.left.map((x) => x.name))}는 그대로 뒀어요: ${r.left[0].why}`);
  return parts.join(" ") || "바꿀 파일이 없어요.";
}

// a turn's time and the model's speed, under its last answer
function TurnMeta({ stats }) {
  const time = stats.ms < 10000 ? `${(stats.ms / 1000).toFixed(1)}초` : seconds(stats.ms);
  return (
    <span className="msg-meta" title={`이번 차례에 걸린 시간 ${time}${stats.tokens ? `, 모델이 쓴 토큰 ${stats.tokens.toLocaleString()}개` : ""}`}>
      {time}{stats.tps ? ` · 초당 ${stats.tps}토큰` : ""}
    </span>
  );
}

// where the next output will come: what the agent is doing, and for how long
function StatusRow({ state, quiet }) {
  const now = useNow(500);
  if (quiet) return <div className="status-row quiet" aria-hidden="true">▌</div>;
  const r = state.retry;
  if (r) {
    // the model's connection dropped and Pi asks again by itself (the tick
    // can be up to half a second old, so the clock is read here)
    const wait = Math.ceil((r.at - Math.max(now, Date.now())) / 1000);
    return (
      <div className="status-row warn" role="status">
        <span className="status-mark" aria-hidden="true">▌</span>
        {wait > 0 ? `모델 연결이 끊겨서 ${wait}초 뒤 다시 해 봐요` : "다시 해 보는 중"}… <span className="status-time">{r.attempt}/{r.max}</span>
      </div>
    );
  }
  const what = state.phase === "tool" ? `${state.runningTool} 실행하는 중` : state.phase === "write" ? "쓰는 중"
    : state.phase === "compact" ? "앞부분을 요약하는 중" : "생각하는 중";
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

// memo: what is typed lives in App, and every key drew the whole conversation
// (and the list on the left) again, which grew slow in a long one
const Conversation = memo(function Conversation({ state, asking, onDecide, onPick, onRewind, onRetry, onBranch, onGpu, onUnqueue, onPlanGo }) {
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
  }, [state.items, state.busy, last, state.queued.length]);
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
  // another branch: stay where the message is, not at the bottom
  const goBranch = (id) => { stick.current = false; onBranch(id); };
  const ends = turnEnds(state.items, state.busy);
  // the answer that can be asked for again: the conversation's last
  const lastAnswer = state.items.findLast((x) => x.kind === "assistant" || x.kind === "user");
  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      {empty ? <Empty info={state.info} ready={state.ready && state.link} onPick={onPick} /> : (
        <div className="msgs" ref={content}>
          {state.items.map((item, k) => {
            if (item.kind === "user") {
              return (
                <div key={item.id} className={`msg msg-user${marks(item)}`}>
                  {item.entryId && !state.busy && (
                    <button type="button" className="icon-btn msg-edit" aria-label="이 말 고쳐서 다시 보내기"
                      title="고쳐서 다시 보내기 (이 말 앞으로 돌아가요)" onClick={() => onRewind(item)}><Icon name="edit" /></button>
                  )}
                  <UserBubble text={item.text} images={item.images}
                    foot={item.alt && item.entryId && <AltNav alt={item.alt} busy={state.busy} onGo={goBranch} />} />
                </div>
              );
            }
            if (item.kind === "assistant") {
              return (
                <div key={item.id} className={`msg msg-ai${marks(item)}`}>
                  <Markdown text={item.text} streaming={item.streaming} />
                  {ends.has(item.id) && item.text.trim() && (
                    <div className="msg-foot">
                      <CopyButton text={item.text} className="act" />
                      {item === lastAnswer && !state.busy && (
                        <button type="button" className="act" title="마지막 말을 다시 보내서 새로 답하게 해요" onClick={onRetry}>
                          <Icon name="retry" /><span>다시 답하기</span>
                        </button>
                      )}
                      {/* a plan written in plan mode: go ahead with it (back to the mode before) */}
                      {item === lastAnswer && !state.busy && state.mode === "plan" && item.planned && (
                        <button type="button" className="act act-go" title={`${MODE_NAMES[state.planFrom] || "묻고 실행"} 모드로 바꾸고 이 계획대로 고치라고 보내요`} onClick={onPlanGo}>
                          <Icon name="right" /><span>이 계획대로 하기</span>
                        </button>
                      )}
                      {item.meta && <TurnMeta stats={item.meta} />}
                    </div>
                  )}
                </div>
              );
            }
            if (item.kind === "tools") {
              return (
                <div key={item.id} className={`msg msg-tools${marks(item)}`}>
                  <ToolGroup tools={item.tools} onDecide={onDecide} settled={!state.busy || k < state.items.length - 1} />
                </div>
              );
            }
            if (item.kind === "shell") {
              return <div key={item.id} className={`msg msg-shell${marks(item)}`}><ShellRun item={item} /></div>;
            }
            return <Line key={item.id} item={item} onGpu={onGpu} />;
          })}
          {/* kept (only hidden) while a thought shows its own clock, so the
              thread does not jump by a line as thoughts start and end */}
          {state.busy && !asking && <StatusRow state={state} quiet={!!state.think} />}
          {/* sent while it runs: told after the step it is on, or sent when
              it ends; each can be taken back (to the box, to change) */}
          {state.queued.length > 0 && (
            <div className="queued" role="group" aria-label="기다리는 말">
              {state.queued.map((q, k) => (
                <div key={q.id || k} className={`queued-bubble ${q.held ? "held" : q.kind}`}>
                  <span className="queued-when">{q.held ? "요약이 끝나면" : q.kind === "steer" ? "다음 단계 전에" : "끝나면"}</span>
                  <div className="queued-text">{q.text}{q.pictures ? <span className="queued-pics"> · 그림 {q.pictures}장</span> : null}</div>
                  <button type="button" className="icon-btn queued-x" aria-label="이 말은 보내지 않고 입력 칸으로" title="보내지 않고 입력 칸으로 (고쳐서 다시 보내요)"
                    onClick={() => onUnqueue(q.id)}><Icon name="close" /></button>
                </div>
              ))}
              <p className="queued-note">
                {state.queued.some((q) => q.kind === "steer" && !q.held) ? "모델이 지금 단계를 마치면 바로 전해요." : "이 답이 끝나면 보내요."}
                <span className="queued-keys"> 빈 칸에서 <kbd>↑</kbd>로 꺼내 고쳐요.</span>
                <button type="button" className="link-act" onClick={() => onUnqueue()}>모두 보내지 않기</button>
              </p>
            </div>
          )}
        </div>
      )}
      {away && <button type="button" className="to-bottom" onClick={toBottom}><Icon name="down" />아래로</button>}
    </div>
  );
});

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

// the first place the words are, marked
function Mark({ text, q }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

// a conversation going on: "도는 중" (or waiting for a yes) where its time was
function RunMark({ run }) {
  return run.asking
    ? <span className="conv-time conv-run conv-ask">[ ?? ] 허락을 기다려요</span>
    : <span className="conv-time conv-run">[ .. ] 도는 중<span className="cursor" aria-hidden="true" /></span>;
}

function Conv({ s, q, current, run, now, folder, onOpen, onDelete, onRename }) {
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
          <button type="button" className="conv-open" title={folder ? `${s.title}\n${folder}` : s.title} onClick={() => onOpen(s.path)}>
            <span className="conv-title"><Mark text={s.title} q={q} /></span>
            {folder && <span className="conv-time conv-folder mono">{shortPath(folder)}</span>}
            {run ? <RunMark run={run} />
              : s.snippet ? <span className="conv-snip"><Mark text={s.snippet.text} q={q} /></span>
                : !folder && <span className="conv-time">{ago(s.modified, now)}</span>}
          </button>
          {onRename && (
            <span className="conv-acts">
              <button type="button" className="icon-btn conv-act" aria-label={`"${s.title}" 이름 바꾸기`} title="이름 바꾸기"
                disabled={!!run} onClick={edit}><Icon name="edit" /></button>
              <button type="button" className="icon-btn conv-act" aria-label={`"${s.title}" 지우기`} title="지우기"
                disabled={!!run} onClick={() => onDelete(s)}><Icon name="close" /></button>
            </span>
          )}
        </>
      )}
    </li>
  );
}

// up and down between the conversations in the list
function moveInList(e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const all = [...e.currentTarget.querySelectorAll(".conv-open:not(:disabled)")];
  const k = all.indexOf(document.activeElement);
  if (k < 0) return;
  e.preventDefault();
  all[Math.max(0, Math.min(all.length - 1, k + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
}

const Sidebar = memo(function Sidebar({ state, notify, onNotify, closeRef, searchRef, onClose, onNew, onOpen, onDelete, onRename, onLeaveSearch, onGpu }) {
  const now = useNow(60000);
  const nav = useRef(null);
  const runOf = (path) => state.running.find((r) => r.path === path);
  // words to find: the server looks in every conversation's names and text
  const [q, setQ] = useState("");
  const [found, setFound] = useState(null);
  const words = q.replace(/\s+/g, " ").trim();
  useEffect(() => {
    if (!words) { setFound(null); return undefined; }
    let live = true;
    const id = setTimeout(() => {
      api("/api/sessions", { q: words }).then((r) => { if (live) setFound({ q: words, list: r.sessions }); }).catch(() => {});
    }, 120);
    return () => { live = false; clearTimeout(id); };
  }, [words, state.sessions]);
  const conv = (s, hit) => (
    <Conv key={s.path} s={s} q={hit} current={s.path === state.sessionFile} run={runOf(s.path)} now={now}
      onOpen={onOpen} onDelete={onDelete} onRename={onRename} />
  );
  // going on in another folder (this folder's list does not have them)
  const listed = new Set((state.sessions || []).map((s) => s.path));
  const elsewhere = state.running.filter((r) => r.path !== state.sessionFile && !listed.has(r.path)
    && r.cwd?.toLowerCase() !== state.info.cwd?.toLowerCase());
  return (
    <aside className="side" id="side" aria-label="대화 목록">
      <div className="side-head">
        <span className="brand">ROBINCODE</span>
        <button ref={closeRef} type="button" className="icon-btn side-close" aria-label="목록 닫기" onClick={onClose}><Icon name="close" /></button>
      </div>
      <button type="button" className="btn new-chat" onClick={onNew} title="이 폴더에서 새 대화. 도는 대화는 그대로 계속해요.">
        <Icon name="plus" /> 새 대화
      </button>
      <div className="conv-search">
        <Icon name="search" />
        <input ref={searchRef} value={q} placeholder="지난 대화 찾기" aria-label="지난 대화 찾기" spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            // Esc here clears the words, then leaves (it must not stop the agent)
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q) setQ(""); else onLeaveSearch(); }
            else if (e.key === "Enter" && found?.list.length) { e.preventDefault(); onOpen(found.list[0].path); setQ(""); }
            else if (e.key === "ArrowDown") { e.preventDefault(); nav.current?.querySelector(".conv-open:not(:disabled)")?.focus(); }
          }} />
        {q ? <button type="button" className="icon-btn search-x" aria-label="찾기 지우기" onClick={() => { setQ(""); searchRef.current?.focus(); }}><Icon name="close" /></button>
          : <kbd className="search-key">Ctrl K</kbd>}
      </div>
      <nav ref={nav} className="conv-nav" aria-label="지난 대화" onKeyDown={moveInList}>
        {!words && elsewhere.length > 0 && (
          <section className="conv-day" aria-label="다른 폴더에서 도는 대화">
            <p className="side-label">다른 폴더에서 도는 대화</p>
            <ul className="conv-list">{elsewhere.map((r) => (
              <Conv key={r.path} s={{ path: r.path, title: r.title }} q="" current={false} run={r} now={now} folder={r.cwd} onOpen={onOpen} />
            ))}</ul>
          </section>
        )}
        {words && found ? (
          <section className="conv-day" aria-label="찾은 대화">
            <p className="side-label" aria-live="polite">{found.list.length ? `찾은 대화 ${found.list.length}개` : `"${found.q}"가 든 대화가 없어요.`}</p>
            <ul className="conv-list">{found.list.map((s) => conv(s, found.q))}</ul>
          </section>
        ) : state.sessions === null ? null : state.sessions.length === 0 ? (
          <><p className="side-label">지난 대화</p><p className="conv-empty">아직 없어요.</p></>
        ) : (
          byDay(state.sessions, now).map(([day, list]) => (
            <section key={day} className="conv-day" aria-label={day}>
              <p className="side-label">{day}</p>
              <ul className="conv-list">{list.map((s) => conv(s, ""))}</ul>
            </section>
          ))
        )}
      </nav>
      <div className="side-foot">
        <NotifyRow notify={notify} onToggle={onNotify} />
        <div className="side-row folder-row" title={state.info.cwd}>
          <span className="side-label">폴더</span>
          <span className="folder-line">
            <span className="mono">{shortPath(state.info.cwd)}</span>
            {/* the folder screen, in this window; Esc there comes back */}
            <a className="mini-btn" href={pickerUrl()}
              title="다른 폴더에서 새 대화를 열어요. 이 대화는 목록에 남고, 도는 중이면 그대로 계속해요.">바꾸기</a>
          </span>
        </div>
        {/* the folder's git branch, and how many files differ from it */}
        {state.git && (
          <div className="side-row git-row" title={`git 브랜치 ${state.git.branch}${state.git.changed ? `, 바뀌었거나 새로 생긴 파일 ${state.git.changed}개` : ", 바뀐 파일 없음"}${state.git.ahead ? `, 올리지 않은 커밋 ${state.git.ahead}개` : ""}${state.git.behind ? `, 받지 않은 커밋 ${state.git.behind}개` : ""}`}>
            <span className="side-label">git</span>
            <span className="mono git-line">
              {state.git.branch}
              {state.git.changed > 0 && <span className="git-changed"> · 바뀐 파일 {state.git.changed}</span>}
              {state.git.ahead > 0 && <span className="git-ahead"> ↑{state.git.ahead}</span>}
              {state.git.behind > 0 && <span className="git-ahead"> ↓{state.git.behind}</span>}
            </span>
          </div>
        )}
        <div className="side-row"><span className="side-label">모델</span><span className="mono">{state.info.model}</span></div>
        <Gpu gpu={state.gpu} fake={state.fake} gpuFake={state.gpuFake} job={state.gpuJob} onOpen={onGpu} />
        <UpdateRow />
      </div>
    </aside>
  );
});

// the same function every time (so the memo'd parts above are not drawn
// again for a new one), always calling the newest
function useStable(fn) {
  const now = useRef(fn);
  now.current = fn;
  return useCallback((...args) => now.current(...args), []);
}

// an installed RobinCode (the zip from ai.yoonrobin.xyz) says its version and
// a new one it downloaded (RobinCode.exe's update.cjs); the repository's says nothing
function UpdateRow() {
  const shell = window.robincodeShell;
  const [u, setU] = useState(null);
  useEffect(() => {
    if (!shell?.updateState) return undefined;
    shell.updateState().then(setU).catch(() => {});
    return shell.onUpdate(setU);
  }, [shell]);
  if (!u?.version) return null;
  return (
    <div className="side-row update-row">
      <span className="side-label">판</span>
      <span className="update-line">
        <span className="mono">{u.version}</span>
        {u.ready && u.ready !== u.version ? (
          <span className="update-new">
            새 판 <span className="mono">{u.ready}</span> 받아 둠
            <button type="button" className="mini-btn" onClick={() => shell.relaunch()} title="지금 다시 켜서 새 판으로 바꿔요. 안 누르면 다음에 켤 때 바뀌어요.">다시 켜기</button>
          </span>
        ) : u.shell ? (
          <span className="update-new warn">새 판 <span className="mono">{u.shell}</span>은 <a href="https://ai.yoonrobin.xyz/" target="_blank" rel="noreferrer">ai.yoonrobin.xyz</a>에서 다시 받아야 해요</span>
        ) : u.checking ? (
          <span className="update-faint">새 판 확인 중<span className="cursor" aria-hidden="true" /></span>
        ) : u.error ? (
          <span className="update-faint" title={u.error}>새 판을 확인하지 못했어요</span>
        ) : null}
      </span>
    </div>
  );
}

function Toast({ toast, onDone }) {
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.actions.map((a) => (
        <button key={a.label} type="button" className="toast-btn" onClick={() => { onDone(); a.run(); }}>{a.label}</button>
      ))}
    </div>
  );
}

// ---- the GPU, on and off in this window (robin 2026-11-09 "앱을 다 GUI로") ----
// Renting costs robin money: a place is rented only when robin picks one and
// then presses the second button, with its price on it. Deleting asks the same
// way. The work runs on the server (`robinai-gpu`), its lines show here.
const JOB_WORDS = {
  rent: ["빌리는 중…", "빌렸어요", "빌리지 못했어요"],
  start: ["켜는 중…", "켰어요", "켜지 못했어요"],
  destroy: ["끄는 중…", "껐어요(지웠어요). 이제 요금이 안 나가요.", "끄지 못했어요"],
};
function JobLog({ job, prog, rented }) {
  const words = JOB_WORDS[job.action];
  const lines = job.lines.slice(-6);
  // a rent that did not get ready in time: the GPU is still there and billed
  const stuck = !job.running && !job.ok && job.action === "rent" && rented;
  return (
    <div className={`gpu-job${job.running ? "" : job.ok ? " ok" : " bad"}`}>
      <p className="gpu-job-head" aria-live="polite">
        {job.running ? <><span>{words[0]}</span><span className="cursor" aria-hidden="true" /></> : job.ok ? words[1] : stuck ? "준비되지 않았어요 — 요금은 나가고 있어요" : words[2]}
      </p>
      {prog && <GpuProgress action={prog.action} p={prog.p} />}
      {lines.length > 0 && <ul className="gpu-job-lines">{lines.map((l, k) => <li key={k}>{l}</li>)}</ul>}
      {job.running && <p className="gpu-note">이 창을 닫아도 서버에서 계속돼요.</p>}
      {stuck && <p className="gpu-note">아래 끄기(지우기)로 지우면 요금이 멈춰요.</p>}
    </div>
  );
}
function GpuPanel({ gpu, job, onKeep, keeping, onClose }) {
  const prog = progressOf(gpu, job);
  const state = prog ? "starting" : gpu.state || "unknown"; // a rent says "켜는 중" before Vast does
  const running = !!job?.running;
  const [offers, setOffers] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [failed, setFailed] = useState(false); // the list did not come: only "다시 받기" asks again
  const [pick, setPick] = useState(null);
  const [sure, setSure] = useState(null); // "rent" | "destroy" | "cancel": the second step
  const opened = useRef(Date.now());
  const watched = useRef(null); // the job this panel saw running: its end stays shown
  const panel = useRef(null);
  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    setFailed(false);
    setSure(null);
    api("/api/gpu-offers")
      .then((r) => { setOffers(r.offers); setPick((p) => (r.offers.some((o) => o.offer === p) ? p : r.offers[0]?.offer ?? null)); })
      .catch((e) => { setErr(e.message); setFailed(true); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (state === "off" && !running && offers === null && !loading && !failed) load(); }, [state, running, offers, loading, failed, load]);
  useEffect(() => {
    panel.current?.focus();
    // Esc closes this (it must not stop the agent)
    const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  }, [onClose]);
  const run = (action, offer) => {
    setSure(null);
    setErr("");
    api("/api/gpu-run", { action, offer }).catch((e) => setErr(e.message));
  };
  const chosen = offers?.find((o) => o.offer === pick);
  const credit = gpu.credit != null ? Number(gpu.credit) : null;
  const low = chosen && credit != null && credit < Number(chosen.hour);
  if (running) watched.current = job.at;
  const showJob = job && (running || job.at >= opened.current || watched.current === job.at);
  const rented = state === "on" || state === "starting" || state === "stopped";
  // a rent can be cancelled once the server has the instance (server.mjs)
  const canCancel = running && job.action === "rent" && job.rented;
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="gpu-panel" role="dialog" aria-modal="true" aria-label="GPU 켜기·끄기" ref={panel} tabIndex={-1}>
        <header className="gpu-panel-head">
          <p className="gpu-kicker"><span className="prompt">&gt;</span> RobinAI GPU <span className="gpu-kicker-sub">Vast.ai RTX 5090</span></p>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="gpu-now">
          <span className={`lamp ${lampOf(state)}`} aria-hidden="true" />
          <b>{GPU_NAMES[state] || state}</b>
          {rented && gpu.rate && <span>시간당 ${gpu.rate}</span>}
          {gpu.credit != null && <span className={credit != null && credit < 1 ? "warn" : ""}>크레딧 ${gpu.credit}{gpu.left ? ` · ${gpu.left}` : ""}</span>}
        </div>
        {gpu.autooff && (
          <div className="gpu-autooff-row">
            <p className={`gpu-note gpu-autooff${offSoon(gpu) != null ? " warn" : ""}`}>자동 끄기 · {gpu.autooff}</p>
            {state === "on" && gpu.idle != null && onKeep && (
              <button type="button" className="mini-btn" onClick={onKeep} disabled={keeping}>{keeping ? "알리는 중…" : "계속 켜 두기"}</button>
            )}
          </div>
        )}

        {showJob && <JobLog job={job} prog={running ? prog : null} rented={rented} />}
        {!showJob && prog && (
          <div className="gpu-job">
            <p className="gpu-job-head"><span>켜는 중…</span><span className="cursor" aria-hidden="true" /></p>
            <GpuProgress action={prog.action} p={prog.p} />
            <p className="gpu-note">서버에서 계속되는 중이에요.</p>
          </div>
        )}
        {canCancel && (sure === "cancel" ? (
          <div className="gpu-confirm">
            <p>빌리던 GPU를 지워요. 지금까지 쓴 몇 분 요금만 나가고, 이제부터는 안 나가요.</p>
            <div className="gpu-actions">
              <button type="button" className="btn" onClick={() => setSure(null)}>계속 빌리기</button>
              <button type="button" className="btn btn-danger" autoFocus onClick={() => run("destroy")}>취소하고 지우기</button>
            </div>
          </div>
        ) : (
          <div className="gpu-actions">
            <button type="button" className="btn" onClick={() => setSure("cancel")}>취소하고 지우기…</button>
          </div>
        ))}

        {!running && state === "off" && (
          <>
            <div className="gpu-sec-head">
              <p className="side-label">빌릴 수 있는 자리 <span className="gpu-faint">한국 먼저, 싼 순</span></p>
              <button type="button" className="mini-btn" onClick={load} disabled={loading}>{loading ? "받는 중…" : "다시 받기"}</button>
            </div>
            {offers === null && loading && <p className="gpu-note">자리 목록을 받는 중이에요<span className="cursor" aria-hidden="true" /></p>}
            {offers && (
              <div className="gpu-offers" role="radiogroup" aria-label="빌릴 자리">
                {offers.map((o) => (
                  <button key={o.offer} type="button" role="radio" aria-checked={pick === o.offer}
                    className={`gpu-offer${pick === o.offer ? " on" : ""}`} onClick={() => { setPick(o.offer); setSure(null); }}>
                    <span className="gpu-offer-main">
                      <b>{o.place.replace(/, [A-Z]{2}$/, "")}</b>
                      <span className="gpu-faint">{o.host} · 신뢰도 {o.rel}% · 최장 {o.days}일</span>
                    </span>
                    <span className="gpu-offer-side">
                      <b className="mono">${o.hour}<span className="gpu-faint">/시간</span></b>
                      <span className="gpu-faint">모델 받기 약 {o.mins}분</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {chosen && (sure === "rent" ? (
              <div className="gpu-confirm">
                <p>빌리면 시간당 <b>${chosen.hour}</b>가 크레딧에서 계속 나가요. 이미지와 모델을 받는 데 약 {chosen.mins + 3}분 걸려요. 다 쓰면 끄세요{gpu.idleLimit ? <>. 깜빡해도 {gpu.idleLimit}분 동안 아무도 안 쓰면 서버가 알아서 지워요.</> : "."}</p>
                <div className="gpu-actions">
                  <button type="button" className="btn" onClick={() => setSure(null)}>취소</button>
                  <button type="button" className="btn btn-primary" autoFocus onClick={() => run("rent", chosen.offer)}>빌리기 · 시간당 ${chosen.hour}</button>
                </div>
              </div>
            ) : (
              <div className="gpu-actions">
                {low && <p className="gpu-warn">크레딧이 한 시간 요금보다 적어요. Vast.ai에서 먼저 충전하세요.</p>}
                <button type="button" className="btn btn-primary" onClick={() => setSure("rent")}>이 자리 빌리기…</button>
              </div>
            ))}
          </>
        )}

        {!running && rented && (
          sure === "destroy" ? (
            <div className="gpu-confirm">
              <p>끄면 GPU 인스턴스를 지워요. 요금이 0이 되고 받아 둔 모델도 지워져요. RobinAI 채팅과 다른 RobinCode 창도 같이 멈춰요. 다음에 켜면 새로 빌려서 6~10분 걸려요.</p>
              <div className="gpu-actions">
                <button type="button" className="btn" onClick={() => setSure(null)}>취소</button>
                <button type="button" className="btn btn-danger" autoFocus onClick={() => run("destroy")}>끄기(지우기)</button>
              </div>
            </div>
          ) : (
            <div className="gpu-actions">
              {state === "stopped" && <button type="button" className="btn" onClick={() => run("start")}>다시 켜기</button>}
              <button type="button" className="btn" onClick={() => setSure("destroy")}>끄기(지우기)…</button>
            </div>
          )
        )}

        {!running && (state === "unreachable" || state === "unknown") && (
          <p className="gpu-note">{state === "unknown" ? "GPU 상태를 확인하는 중이에요." : "서버에서 GPU 상태를 읽지 못했어요(ssh contabo). 잠시 뒤 다시 열어 보세요."}</p>
        )}
        {err && <p className="gpu-warn" role="alert">{err}</p>}
      </section>
    </div>
  );
}

// ---- drafts ----------------------------------------------------------------------
// { [conversation file]: { text, at } } in this window's storage: the 30 most
// recent, each up to 20,000 characters
const DRAFTS_KEY = "robincode-drafts";
function loadDrafts() {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}
function keepDraft(all, key, text) {
  const had = all[key]?.text || "";
  const now = text.trim() ? text.slice(0, 20000) : "";
  if (had === now) return;
  if (now) all[key] = { text: now, at: Date.now() };
  else delete all[key];
  const keys = Object.keys(all);
  if (keys.length > 30) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 30)) delete all[k];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch { /* storage off or full */ }
}

// ---- what was sent (↑ ↓ in the box), the 100 most recent, every conversation's
const SENT_KEY = "robincode-sent";
function loadSent() {
  try {
    const all = JSON.parse(localStorage.getItem(SENT_KEY) || "[]");
    return Array.isArray(all) ? all.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}
function keepSent(text) {
  const t = text.trim().slice(0, 20000);
  if (!t) return;
  const all = loadSent().filter((x) => x !== t);
  all.push(t);
  try { localStorage.setItem(SENT_KEY, JSON.stringify(all.slice(-100))); } catch { /* storage off or full */ }
}

// a file to save (the window asks where)
function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- Ctrl+F: words in the conversation, marked where they are (CSS highlights)
const CAN_MARK = typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight !== "undefined";
function findRanges(root, q) {
  const out = [];
  if (!root || !q) return out;
  const want = q.toLowerCase();
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // not what cannot be seen: a folded run's steps are in the page but inert
    acceptNode: (n) => (n.parentElement?.closest(".sr, [aria-hidden='true'], button, [inert]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n && out.length < 2000; n = walk.nextNode()) {
    const text = n.nodeValue.toLowerCase();
    for (let at = text.indexOf(want); at >= 0 && out.length < 2000; at = text.indexOf(want, at + want.length)) {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + want.length);
      out.push(r);
    }
  }
  return out;
}
// How many times the words are where they cannot be seen: a step's result
// that is folded (not made yet, or shut), or a step in a folded run (its
// line too). [{ id, n }] in the conversation's order.
const count = (text, want) => { let n = 0; for (let at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + want.length)) n++; return n; };
function findFolded(items, q) {
  const out = [];
  if (!q) return out;
  const want = q.toLowerCase();
  for (const x of items) {
    if (x.kind !== "tools") continue;
    for (const t of x.tools) {
      const li = document.querySelector(`[data-step="${CSS.escape(String(t.id))}"]`);
      if (!li) continue;
      const shut = !!li.closest("[inert]");
      const body = li.querySelector(".step-out, .think-out");
      let n = 0;
      if (t.output && (shut || !body || body.closest("[inert]"))) n += count(String(t.output).toLowerCase(), want);
      if (shut) n += count((li.querySelector(".step-head")?.textContent || "").toLowerCase(), want);
      if (n) out.push({ id: t.id, n, li });
    }
  }
  return out;
}
function FindBar({ items, onClose }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [ranges, setRanges] = useState([]);
  const [folded, setFolded] = useState([]);
  const [tick, setTick] = useState(0);
  const input = useRef(null);
  const shown = useRef("");
  // a step being opened: once it has unfolded, the first match in it
  const opening = useRef(null);
  const wait = useRef(0);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => () => clearTimeout(wait.current), []);
  // looked for again as the conversation grows, a moment after it settles
  useEffect(() => {
    const t = setTimeout(() => {
      const found = findRanges(document.querySelector(".msgs"), q.trim());
      setRanges(found);
      setFolded(findFolded(items, q.trim()));
      if (opening.current != null) {
        const li = document.querySelector(`[data-step="${CSS.escape(String(opening.current))}"]`);
        const k = li ? found.findIndex((r) => li.contains(r.startContainer)) : -1;
        opening.current = null;
        if (k >= 0) setAt(k);
      }
    }, 80);
    return () => clearTimeout(t);
  }, [q, items, tick]);
  useEffect(() => { setAt(0); }, [q]);
  const now = ranges.length ? Math.min(at, ranges.length - 1) : -1;
  const hidden = folded.reduce((a, f) => a + f.n, 0);
  useEffect(() => {
    if (CAN_MARK) {
      CSS.highlights.set("find", new Highlight(...ranges));
      if (now >= 0) CSS.highlights.set("find-now", new Highlight(ranges[now])); else CSS.highlights.delete("find-now");
    }
    const r = ranges[now];
    // only when robin types or steps: the conversation growing under the bar
    // finds again but does not pull the view back each time
    const key = `${q.trim()}\n${now}`;
    if (r && shown.current !== key) {
      shown.current = key;
      const el = r.startContainer.parentElement;
      // a long code block scrolls by itself; the thread to the line
      el?.scrollIntoView({ block: "center" });
    }
  }, [ranges, now]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (CAN_MARK) { CSS.highlights.delete("find"); CSS.highlights.delete("find-now"); } }, []);
  // open the folded step after the one shown (or the first), then go to it
  const reveal = (back) => {
    const here = ranges[now]?.startContainer;
    const after = (f) => !here || (here.compareDocumentPosition(f.li) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pick = back ? (folded.findLast((f) => !after(f)) || folded.at(-1)) : (folded.find(after) || folded[0]);
    if (!pick) return false;
    opening.current = pick.id;
    window.dispatchEvent(new CustomEvent(REVEAL, { detail: pick.id }));
    // the fold takes 200ms to open
    clearTimeout(wait.current);
    wait.current = setTimeout(() => setTick((k) => k + 1), 260);
    return true;
  };
  // past the last one seen (or before the first), a folded one opens before it wraps
  const go = (d) => {
    const edge = !ranges.length || (d > 0 ? now === ranges.length - 1 : now === 0);
    if (edge && folded.length && reveal(d < 0)) return;
    if (ranges.length) setAt((k) => (Math.min(k, ranges.length - 1) + d + ranges.length) % ranges.length);
  };
  const can = ranges.length > 0 || hidden > 0;
  const said = !q.trim() ? "" : ranges.length
    ? `${now + 1}/${ranges.length}${hidden ? ` · 접힌 곳 ${hidden}` : ""}`
    : hidden ? `접힌 곳 ${hidden}` : "없음";
  return (
    <div className="find-bar" role="search">
      <Icon name="search" />
      <input ref={input} value={q} placeholder="대화에서 찾기" aria-label="대화에서 찾기" spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
          // Esc here only closes this (it must not stop the agent)
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
        }} />
      <span className="find-count" aria-live="polite" title={hidden ? "접힌 도구 결과에도 있어요. Enter로 펼쳐서 가요." : undefined}>{said}</span>
      <button type="button" className="icon-btn" aria-label="앞의 것" title="앞의 것 (Shift+Enter)" disabled={!can} onClick={() => go(-1)}><Icon name="left" /></button>
      <button type="button" className="icon-btn" aria-label="다음 것" title="다음 것 (Enter)" disabled={!can} onClick={() => go(1)}><Icon name="right" /></button>
      <button type="button" className="icon-btn" aria-label="찾기 닫기" title="닫기 (Esc)" onClick={onClose}><Icon name="close" /></button>
    </div>
  );
}

// ---- /memory and /help: a sheet over the conversation
function Sheet({ label, onClose, children }) {
  const panel = useRef(null);
  useEffect(() => {
    panel.current?.focus();
    // Esc closes this (it must not stop the agent)
    const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={label} ref={panel} tabIndex={-1}>
        <header className="gpu-panel-head">
          <p className="gpu-kicker"><span className="prompt">&gt;</span> {label}</p>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}><Icon name="close" /></button>
        </header>
        {children}
      </section>
    </div>
  );
}
function MemoryPanel({ onClose, onError }) {
  const [r, setR] = useState(null);
  const [line, setLine] = useState("");
  const [saving, setSaving] = useState(false);
  const load = (body) => api("/api/memory", body).then(setR);
  useEffect(() => { load().catch((e) => onError(`읽지 못했어요: ${e.message}`)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const add = () => {
    if (!line.trim() || saving) return;
    setSaving(true);
    load({ add: line }).then(() => setLine("")).catch((e) => onError(e.message === "busy" ? "도는 중이라 끝난 뒤에 더할 수 있어요." : `더하지 못했어요: ${e.message}`))
      .finally(() => setSaving(false));
  };
  const openFile = (path) => api("/api/open-file", { path }).catch((e) => onError(e.message));
  return (
    <Sheet label="모델이 읽는 지시 파일" onClose={onClose}>
      <p className="gpu-note">모델은 대화를 시작할 때 이 파일들을 먼저 읽어요(AGENTS.md, CLAUDE.md: 이 폴더와 위 폴더들의 것).</p>
      {r === null ? <p className="gpu-note">읽는 중<span className="cursor" aria-hidden="true" /></p>
        : r.files.length === 0 ? <p className="gpu-note">아직 없어요. 아래에 한 줄을 적거나 <span className="mono">/init</span>으로 만들어요.</p>
          : (
            <ul className="mem-files">
              {r.files.map((f) => (
                <li key={f.path} className="mem-file">
                  <div className="mem-head">
                    <span className="mono mem-path" title={f.path}>{f.shown}</span>
                    <span className="gpu-faint">{f.lines}줄</span>
                    <button type="button" className="mini-btn" onClick={() => openFile(f.path)}>편집기로 열기</button>
                  </div>
                  <pre className="mem-text">{f.content}</pre>
                </li>
              ))}
            </ul>
          )}
      {r && (
        <form className="mem-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label className="side-label" htmlFor="mem-line"><span className="mono">{r.ownShown}</span>에 한 줄 더하기</label>
          <div className="mem-add-row">
            <input id="mem-line" value={line} onChange={(e) => setLine(e.target.value)} placeholder="예: 커밋 메시지는 한국어로" spellCheck={false} maxLength={500} />
            <button type="submit" className="btn btn-primary" disabled={!line.trim() || saving}>{saving ? "더하는 중…" : "더하기"}</button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
function RulesPanel({ onClose, onError }) {
  const [rules, setRules] = useState(null);
  const load = (body) => api("/api/rules", body).then((r) => setRules(r.rules)).catch((e) => onError(`읽지 못했어요: ${e.message}`));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet label="늘 허용한 것" onClose={onClose}>
      <p className="gpu-note">물을 때 "늘 허용"(4)을 누른 것은 이 폴더에서 다시 묻지 않아요. 명령은 그 시작이 같을 때만(… 붙은 것) 또는 똑같을 때만, 이어 붙이거나(<span className="mono">; && |</span>) 넘기거나(<span className="mono">&gt;</span>) 괄호·<span className="mono">$</span>·줄 바꿈이 있으면 다시 물어요. node·python·powershell처럼 아무거나 돌리는 것은 늘 허용이 없어요.</p>
      {rules === null ? <p className="gpu-note">읽는 중<span className="cursor" aria-hidden="true" /></p>
        : rules.length === 0 ? <p className="gpu-note">아직 없어요.</p> : (
          <ul className="rule-list">
            {rules.map((r) => (
              <li key={r.key} className="rule">
                <span className="rule-kind">{r.kind === "web" ? "사이트" : r.kind === "exact" ? "이 명령만" : "명령"}</span>
                <span className="mono rule-label">{r.label}{r.kind === "cmd" ? " …" : ""}</span>
                <button type="button" className="mini-btn" onClick={() => load({ remove: r.key })}>지우기</button>
              </li>
            ))}
          </ul>
        )}
    </Sheet>
  );
}
const KEYS = [
  ["Enter", "보내기 (도는 중이면 지금 단계 다음에 전해요)"],
  ["Ctrl+Enter", "도는 중에: 다 끝난 뒤에 보내요"],
  ["Shift+Enter", "줄 바꿈"],
  ["↑ (빈 칸)", "기다리는 말을 꺼내 고쳐요. 없으면 보낸 말을 차례로"],
  ["Esc", "멈추기"],
  ["Shift+Tab", "모드 바꾸기: 묻고 실행 → 수정은 바로 → 바로 실행 → 계획만"],
  ["Ctrl+F", "대화에서 찾기"],
  ["Ctrl+K", "지난 대화 찾기"],
  ["1 2 3 4", "물을 때: 실행 · 늘 묻지 않기 · 거절 · 이 명령은 늘 허용"],
  ["@", "이 폴더의 파일 넣기"],
  ["!명령", "PowerShell로 바로 실행 (결과는 대화에 남아요)"],
];
function HelpPanel({ commands, onClose }) {
  return (
    <Sheet label="명령과 단축키" onClose={onClose}>
      <p className="side-label">명령</p>
      <dl className="help-list">
        {BUILTIN.map((c) => (
          <div key={c.name} className="help-row"><dt className="mono">/{c.name}{c.arg ? ` [${c.arg}]` : ""}</dt><dd>{c.hint}</dd></div>
        ))}
        {(commands?.prompts || []).map((p) => (
          <div key={`p-${p.name}`} className="help-row"><dt className="mono">/{p.name}</dt><dd>{p.description || "이 폴더의 프롬프트 템플릿"}</dd></div>
        ))}
        {(commands?.skills || []).map((s) => (
          <div key={`s-${s.name}`} className="help-row"><dt className="mono">/skill:{s.name}</dt><dd>{s.description || "스킬"}</dd></div>
        ))}
      </dl>
      <p className="side-label">단축키</p>
      <dl className="help-list">
        {KEYS.map(([k, v]) => <div key={k} className="help-row"><dt className="mono">{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </Sheet>
  );
}
const MODE_WORDS = { ask: "ask", 묻기: "ask", edits: "edits", edit: "edits", 수정: "edits", auto: "auto", 바로: "auto", plan: "plan", 계획: "plan" };

// ---- the app ---------------------------------------------------------------------
export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [draft, setDraft] = useState("");
  // What is being typed belongs to its conversation: opening another one
  // used to carry it along into that one, and a reload (or RobinCode
  // starting again for a new version) lost it. Kept per conversation in this
  // window's storage. A new conversation nothing was sent in yet is in no
  // list and cannot be opened again, so what was typed there waits under
  // "new" for the next new conversation.
  const drafts = useRef(null);
  if (!drafts.current) drafts.current = loadDrafts();
  const convKey = state.saved && state.sessionFile ? state.sessionFile : "new";
  const draftKey = useRef(null);
  const draftNow = useRef("");
  draftNow.current = draft;
  useEffect(() => {
    if (!state.ready) return;
    if (draftKey.current === convKey) return;
    if (draftKey.current !== null) keepDraft(drafts.current, draftKey.current, draftNow.current);
    draftKey.current = convKey;
    setDraft(drafts.current[convKey]?.text || "");
  }, [state.ready, convKey]);
  useEffect(() => {
    if (draftKey.current === null) return undefined;
    // the conversation it was typed in, even if another is open by then
    const key = draftKey.current;
    const t = setTimeout(() => keepDraft(drafts.current, key, draft), 300);
    return () => clearTimeout(t);
  }, [draft]);
  useEffect(() => {
    const save = () => { if (draftKey.current !== null) keepDraft(drafts.current, draftKey.current, draftNow.current); };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, []);
  const [side, setSide] = useState(false); // the drawer, on a narrow window
  const [toast, setToast] = useState(null);
  const [drag, setDrag] = useState(false);
  const [notify, setNotify] = useState(notifyNow);
  const [gpuOpen, setGpuOpen] = useState(false);
  const picturesRef = useRef(null); // the composer's "these are the pictures"
  const addPicturesRef = useRef(null); // the composer's "these too" (taken back from the queue)
  const askingRef = useRef(null); // the question on screen (its "늘 허용" rule)
  const [panel, setPanel] = useState(null); // "memory" | "help" | null
  const [finding, setFinding] = useState(false); // Ctrl+F
  const box = useRef(null);
  const menuRef = useRef(null);
  const closeRef = useRef(null);
  const searchRef = useRef(null);
  const attachRef = useRef(null); // the composer's "add these pictures"
  const dragDepth = useRef(0);
  const toastTimer = useRef(0);
  // one send, and one open (a conversation, a new one) at a time: a second
  // click while the server checks the model would go in twice
  const sending = useRef(false);
  const opening = useRef(false);
  // the event stream reconnects by itself: "다시 연결하는 중" first, the
  // advice to reopen only once it stays down
  const [lostLong, setLostLong] = useState(false);
  const offline = state.ready && !state.link;
  useEffect(() => {
    if (!offline) { setLostLong(false); return undefined; }
    const t = setTimeout(() => setLostLong(true), 15000);
    return () => clearTimeout(t);
  }, [offline]);

  // a note above the composer, with up to two buttons (one action, or a list)
  const say = useCallback((text, action) => {
    const actions = [].concat(action || []).filter(Boolean);
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, actions });
    toastTimer.current = setTimeout(() => setToast(null), actions.length > 1 ? 9000 : actions.length ? 6000 : 2600);
  }, []);
  const fail = useCallback((e) => say(e.message === "busy" ? "도는 중이라 지금은 못 해요. 끝나거나 멈춘 뒤에 해 주세요." : `하지 못했어요: ${e.message}`,
    e.gpuOff ? { label: "GPU 켜기…", run: () => setGpuOpen(true) } : undefined), [say]);
  const loadSessions = useCallback(() => {
    api("/api/sessions").then((r) => dispatch({ type: "sessions", sessions: r.sessions })).catch(() => {});
  }, []);

  // a conversation robin left (it goes on) ended: a note, and Windows' when allowed
  const onBg = useRef(null);
  const onUnsent = useRef(null);
  useEffect(() => connect((e) => {
    if (e.t === "bg_done") onBg.current?.(e);
    if (e.t === "settled" && e.unsent?.length) onUnsent.current?.(e.unsent);
    if (e.t === "unsent" && e.items?.length) onUnsent.current?.(e.items, e.why);
    dispatch({ type: "event", e });
  }, (up) => dispatch({ type: "link", up })), []);
  useEffect(() => { if (state.ready) loadSessions(); }, [state.ready, state.sessionFile, state.busy, state.running.length, loadSessions]);
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

  // true once the server took it; on a failure the words go back in the box
  // when: while it runs, "now" (after the step it is on) or "end" (after the turn)
  // Sent one after another (a second message typed while the first is on
  // its way goes after it, in order); the same words twice at once (a double
  // click) go once
  const inFlight = useRef(null); // { text, done }
  const send = useCallback((text, pictures = [], when = "now") => {
    const t = text.trim();
    if ((!t && !pictures.length) || (inFlight.current && inFlight.current.text === t && !pictures.length)) return Promise.resolve(false);
    setDraft("");
    if (t) keepSent(t);
    const before = inFlight.current?.done;
    const done = (async () => {
      if (before) await before;
      sending.current = true;
      try {
        await api("/api/prompt", { text: t, when, images: pictures.map(({ mimeType, data }) => ({ mimeType, data })) });
        return true;
      } catch (e) {
        dispatch({ type: "local-error", message: `보내지 못했어요: ${e.message}`, gpu: e.gpuOff });
        setDraft((d) => (d.trim() ? `${t}\n${d}` : t));
        return false;
      } finally {
        sending.current = false;
      }
    })();
    const me = { text: t, done };
    inFlight.current = me;
    done.finally(() => { if (inFlight.current === me) inFlight.current = null; });
    return done;
  }, []);
  const stop = useCallback(() => { api("/api/abort").catch(() => {}); }, []);
  // messages that waited, back in the box (above what is being typed), their pictures too
  const giveBack = useCallback((items) => {
    const list = items.map((x) => (typeof x === "string" ? { text: x, images: [] } : x));
    setDraft((d) => [...list.map((x) => x.text), d].filter((t) => t && t.trim()).join("\n"));
    const pics = list.flatMap((x) => x.images || []);
    if (pics.length) addPicturesRef.current?.(pics);
    requestAnimationFrame(() => box.current?.focus());
  }, []);
  // one of them (its id), or all
  const unqueue = useCallback((id) => {
    api("/api/unqueue", id == null ? {} : { id }).then((r) => { if (r.items?.length) giveBack(r.items); }).catch(fail);
  }, [giveBack]); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = useCallback((id, decision) => {
    const tool = askingRef.current;
    // "늘 허용" for a call that has no rule (a chained command, an interpreter): nothing to answer
    if (decision === "rule" && !(tool?.id === id && tool.rule)) return;
    dispatch({ type: "decided", id, decision, rule: tool?.id === id ? tool.rule : null });
    api("/api/approve", { id, decision }).catch((e) => dispatch({ type: "local-error", message: e.message }));
    focusBox();
  }, []);
  const once = (call) => {
    if (opening.current) return;
    opening.current = true;
    call().then(() => { closeSide(false); focusBox(); }).catch(fail).finally(() => { opening.current = false; });
  };
  const newChat = () => once(() => api("/api/new"));
  const open = (path) => once(() => api("/api/open", { path }));
  // the one on screen, deleted and brought back, is opened again (not only listed)
  const remove = (s) => api("/api/delete", { path: s.path }).then((r) => {
    loadSessions();
    say("대화를 지웠어요.", { label: "되돌리기", run: () => api("/api/restore", { path: s.path })
      .then(() => (r.current ? api("/api/open", { path: s.path }) : null)).then(loadSessions).catch(fail) });
  }).catch(fail);
  const rename = (s, name) => api("/api/rename", { path: s.path, name }).then(loadSessions).catch(fail);
  // back to just before one of robin's messages, its words (and pictures) in
  // the box to change and send again. Files edit / write changed after it
  // stay as they are unless robin has them put back too; a command's work stays
  const rewind = async (item) => {
    const before = draft;
    const from = state.items.findIndex((x) => x.id === item.id);
    const ran = state.items.slice(from).some((x) => x.kind === "tools" && x.tools.some((t) => COMMANDS.has(t.name) && t.status === "ok"));
    const commands = ran ? " 명령이 한 일은 그대로예요." : "";
    try {
      const r = await api("/api/rewind", { id: item.entryId });
      setDraft(r.text || "");
      picturesRef.current?.(r.images || []);
      focusBox();
      const back = () => api("/api/rewind", { id: r.back }).then(() => { setDraft(before); picturesRef.current?.([]); focusBox(); });
      const undo = { label: "되돌리기", run: () => back().catch(fail) };
      if (!r.files?.length) {
        say(ran ? "이 말 앞으로 돌아왔어요. 명령이 한 일은 그대로예요." : "이 말 앞으로 돌아왔어요. 고쳐서 보내세요.", undo);
        return;
      }
      // undoing both: the conversation back where it was, then its files
      const undoBoth = {
        label: "되돌리기",
        run: () => back().then(() => api("/api/files-sync")).then((u) => say(syncWords(u, "원래대로 돌렸어요"))).catch(fail),
      };
      const putBack = () => api("/api/files-sync").then((s) => say(`${syncWords(s, "되돌렸어요")}${commands}`, s.done.length ? undoBoth : undo)).catch(fail);
      say(`이 말 앞으로 돌아왔어요. 그 뒤에 고친 ${filesWord(r.files)}는 그대로예요.`, [{ label: "파일도 되돌리기", run: putBack }, undo]);
    } catch (e) { fail(e); }
  };
  // another of the messages sent at one place (‹ 2/3 ›), where robin last was
  // under it; its files can follow
  const branchTo = async (id) => {
    try {
      const r = await api("/api/branch", { id });
      if (r.text != null) { setDraft(r.text); picturesRef.current?.(r.images || []); focusBox(); }
      if (r.files?.length) {
        say(`이 갈래로 왔어요. ${filesWord(r.files)}는 지금 이 갈래 때와 달라요.`, {
          label: "파일도 맞추기", run: () => api("/api/files-sync").then((s) => say(syncWords(s, "이 갈래에 맞췄어요"))).catch(fail),
        });
      }
    } catch (e) { fail(e); }
  };
  const retry = () => {
    if (sending.current) return;
    sending.current = true;
    api("/api/retry").catch(fail).finally(() => { sending.current = false; });
  };
  const compact = (instructions) => api("/api/compact", typeof instructions === "string" && instructions ? { instructions } : {})
    .catch((e) => (e.message === "busy" || e.gpuOff ? fail(e) : say(e.message)));
  // the mode asked for last: Shift+Tab pressed again before the server
  // answered goes on from it, not from the one still on screen
  const modeNow = useRef(state.mode);
  const modeAsks = useRef(0);
  useEffect(() => { if (!modeAsks.current) modeNow.current = state.mode; }, [state.mode]);
  const setMode = (mode) => {
    modeNow.current = mode;
    modeAsks.current += 1;
    return api("/api/mode", { mode }).then(() => say(`모드: ${MODE_NAMES[mode]}`)).catch(fail)
      .finally(() => { modeAsks.current -= 1; });
  };
  const cycleMode = useStable(() => setMode(nextMode(modeNow.current || "ask")));
  // the `/` commands the window does itself (commands.js)
  const runCommand = (name, arg) => {
    focusBox();
    if (name === "new" || name === "clear") { newChat(); return; }
    if (name === "compact") { compact(arg); return; }
    if (name === "init") { send(INIT_PROMPT); return; }
    if (name === "memory") {
      if (!arg) { setPanel("memory"); return; }
      api("/api/memory", { add: arg }).then((r) => say(`${r.ownShown}에 더했어요. 다음 말부터 모델이 읽어요.`))
        .catch((e) => (e.message === "busy" ? fail(e) : say(`더하지 못했어요: ${e.message}`)));
      return;
    }
    if (name === "mode") {
      const want = MODE_WORDS[arg.toLowerCase()];
      if (arg && !want) { say(`그런 모드는 없어요: ask · edits · auto · plan`); return; }
      setMode(want || nextMode(state.mode || "ask"));
      return;
    }
    if (name === "plan") { setMode("plan"); return; }
    if (name === "permissions") { setPanel("rules"); return; }
    if (name === "think") {
      api("/api/thinking", { on: !state.thinking }).then((r) => say(r.on ? "생각 켬: 답하기 전에 먼저 생각해요." : "생각 끔: 바로 답해요.")).catch(fail);
      return;
    }
    if (name === "export") {
      if (!state.items.length) { say("아직 저장할 대화가 없어요."); return; }
      api("/api/export").then((r) => { saveFile(r.name, r.text); say(`${r.name}로 저장해요.`); }).catch(fail);
      return;
    }
    if (name === "help") setPanel("help");
  };
  // robin's own `!명령` (true once it started)
  const shell = (command, raw) => {
    keepSent(raw);
    setDraft("");
    return api("/api/shell", { command }).then(() => true).catch((e) => { setDraft(raw); fail(e); return false; });
  };
  // a plan written in plan mode: back to the mode before it, and go
  const planGo = () => api("/api/mode", { mode: state.planFrom && state.planFrom !== "plan" ? state.planFrom : "ask" })
    .then(() => send("이 계획대로 진행해 주세요.")).catch(fail);
  const [commands, setCommands] = useState(null);
  useEffect(() => {
    if (!state.ready) return;
    api("/api/commands").then(setCommands).catch(() => {});
  }, [state.ready, state.info.cwd]);
  const pastRef = useRef(loadSent);
  const todo = useMemo(() => latestTodo(state.items), [state.items]);
  const shellRunning = state.items.some((x) => x.kind === "shell" && x.status === "run");

  const asking = askingTool(state);
  askingRef.current = asking;
  onUnsent.current = (items, why) => {
    giveBack(items);
    const n = items.length;
    say(`${why ? `${why} ` : ""}${n > 1 ? `보내지 않은 말 ${n}개를 입력 칸에 돌려놨어요.` : "보내지 않은 말을 입력 칸에 돌려놨어요."}`);
  };
  onBg.current = (e) => {
    const how = e.why ? (/도구를 \d+번 써서/.test(e.why) ? "너무 길어져서 멈췄어요" : "되풀이에 빠져서 멈췄어요")
      : e.aborted ? "멈췄어요" : e.failed ? "막혔어요" : "끝났어요";
    say(`"${e.title}" 대화가 ${how}.`, { label: "열기", run: () => open(e.path) });
    if (notify === "on" && !e.aborted) ping(e.failed ? "막혔어요" : "끝났어요", `${e.title}\n${e.said || ""}`.trim());
  };
  // one robin left asks for a yes (it waits until robin opens it)
  const askedBefore = useRef(new Set());
  useEffect(() => {
    const now = new Set(state.running.filter((r) => r.asking && r.path !== state.sessionFile).map((r) => r.path));
    for (const path of now) {
      if (askedBefore.current.has(path)) continue;
      const r = state.running.find((x) => x.path === path);
      say(`"${r.title}" 대화가 허락을 기다려요.`, { label: "열기", run: () => open(path) });
      if (notify === "on") ping("허락을 기다려요", r.title);
    }
    askedBefore.current = now;
  }, [state.running]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleNotify = async () => {
    if (notify === "on") { keepNotify(false); setNotify("off"); return; }
    const answer = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    keepNotify(answer === "granted");
    setNotify(answer === "granted" ? "on" : answer === "denied" ? "blocked" : "off");
  };
  // a question just came, or the turn just ended
  const seen = useRef({ waiting: false, busy: false });
  useEffect(() => {
    const was = seen.current;
    seen.current = { waiting, busy: state.busy };
    if (notify !== "on") return;
    const where = state.title || state.info.folder;
    if (waiting && !was.waiting && asking) {
      ping("허락을 기다려요", `${where}\n${asking.name} ${describe(asking.name, asking.args)}`.trim());
    } else if (was.busy && !state.busy) {
      const last = state.items[state.items.length - 1];
      const answer = [...state.items].reverse().find((x) => x.kind === "assistant");
      if (last?.kind === "line" && last.tone === "skip") return; // robin stopped it, here
      ping(last?.kind === "line" && last.tone === "fail" ? "막혔어요" : "끝났어요",
        `${where}\n${last?.kind === "line" ? last.text : firstWords(answer?.text)}`.trim());
    }
  }, [waiting, state.busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing) return;
      // Ctrl+K: find a past conversation (the drawer opens on a narrow window)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isNarrow()) setSide(true);
        requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); });
        return;
      }
      // Ctrl+F: words in this conversation
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFinding(true);
        requestAnimationFrame(() => { const el = document.querySelector(".find-bar input"); el?.focus(); el?.select(); });
        return;
      }
      // Shift+Tab in the message box (or nowhere): the next mode, as in Claude Code
      if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
        && (e.target === box.current || e.target === document.body) && !panel && !gpuOpen) {
        e.preventDefault();
        cycleMode();
        return;
      }
      if (e.key === "Escape") {
        if (side && isNarrow()) { e.preventDefault(); closeSide(true); }
        else if (state.busy || shellRunning) { e.preventDefault(); stop(); }
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
  }, [side, state.busy, shellRunning, asking, stop, decide, panel, gpuOpen, cycleMode]);

  // the server deletes an unused GPU (20 minutes): a bar 3 minutes before, a
  // Windows notification when the window is not in front, "계속 켜 두기"
  const soon = offSoon(state.gpu);
  const [keeping, setKeeping] = useState(false);
  const keepGpu = () => {
    setKeeping(true);
    api("/api/gpu-keep").then((r) => say(r.said || "더 켜 둬요.")).catch(fail).finally(() => setKeeping(false));
  };
  const warned = useRef(false);
  useEffect(() => {
    if (soon == null) { warned.current = false; return; }
    if (warned.current || notify !== "on") return;
    warned.current = true;
    ping("GPU가 곧 꺼져요", `${state.gpu.idle}분째 안 써서 약 ${soon}분 뒤 서버가 꺼요. 계속 쓰려면 RobinCode에서 "계속 켜 두기"를 누르세요.`);
  }, [soon, notify]); // eslint-disable-line react-hooks/exhaustive-deps

  // for the memo'd conversation and list: the same functions while robin types
  const on = {
    unqueue: useStable(unqueue),
    unqueueLast: useStable(() => { const last = state.queued.at(-1); if (last) unqueue(last.id); }),
    planGo: useStable(planGo),
    command: useStable(runCommand),
    shell: useStable(shell),
    say: useStable(say),
    closePanel: useStable(() => { setPanel(null); focusBox(); }),
    closeFind: useStable(() => { setFinding(false); focusBox(); }),
    pick: useStable((s) => send(s)),
    rewind: useStable(rewind),
    retry: useStable(retry),
    branch: useStable(branchTo),
    gpu: useStable(() => setGpuOpen(true)),
    notify: useStable(toggleNotify),
    close: useStable(() => closeSide(true)),
    new: useStable(newChat),
    open: useStable(open),
    remove: useStable(remove),
    rename: useStable(rename),
    leaveSearch: useStable(() => { if (isNarrow()) closeSide(true); else focusBox(); }),
    sideGpu: useStable(() => { closeSide(false); setGpuOpen(true); }),
  };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const dropProps = {
    onDragEnter: (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDrag(true); },
    onDragOver: (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: (e) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDrag(false); },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDrag(false);
      attachRef.current?.(e.dataTransfer.files);
    },
  };
  return (
    <div className="app" data-side={side ? "open" : undefined}>
      <Sidebar state={state} notify={notify} onNotify={on.notify} closeRef={closeRef} searchRef={searchRef} onClose={on.close} onNew={on.new} onOpen={on.open}
        onDelete={on.remove} onRename={on.rename} onLeaveSearch={on.leaveSearch} onGpu={on.sideGpu} />
      <div className="scrim" onClick={() => closeSide(true)} aria-hidden="true" />
      <main className="main" {...dropProps}>
        <header className="main-head">
          <button ref={menuRef} type="button" className="icon-btn menu-btn" aria-label="대화 목록 열기" aria-controls="side"
            aria-expanded={side} onClick={openSide}><Icon name="menu" /></button>
          <h1 className="main-title" key={state.title}>{state.title || "새 대화"}</h1>
          <div className="head-narrow"><Gpu gpu={state.gpu} fake={state.fake} gpuFake={state.gpuFake} job={state.gpuJob} compact onOpen={() => setGpuOpen(true)} /></div>
        </header>
        {offline && <div className="lost" role="alert">{lostLong ? "RobinCode 서버와 연결이 끊겼어요. 창을 닫고 다시 여세요." : "RobinCode 서버와 다시 연결하는 중이에요…"}</div>}
        {soon != null && (
          <div className="gpu-soon" role="status">
            <span>GPU를 {state.gpu.idle}분째 안 써서 {soon ? `약 ${soon}분 뒤` : "곧"} 서버가 꺼요. 다시 켜려면 6~10분 걸려요.</span>
            <button type="button" className="mini-btn" onClick={keepGpu} disabled={keeping}>{keeping ? "알리는 중…" : "계속 켜 두기"}</button>
          </div>
        )}
        {finding && <FindBar items={state.items} onClose={on.closeFind} />}
        <Conversation state={state} asking={asking} onDecide={decide} onPick={on.pick} onRewind={on.rewind} onRetry={on.retry} onBranch={on.branch} onGpu={on.gpu}
          onUnqueue={on.unqueue} onPlanGo={on.planGo} />
        <TodoPanel todo={todo} busy={state.busy} />
        <Composer state={state} convKey={convKey} meter={<ContextMeter context={state.context} busy={state.busy} onCompact={compact} />} box={box} draft={draft}
          setDraft={setDraft} pastRef={pastRef} attachRef={attachRef} picturesRef={picturesRef} addPicturesRef={addPicturesRef} commands={commands}
          onSend={send} onStop={stop} onError={say} onCommand={on.command} onShell={on.shell} onMode={cycleMode} onUnqueueLast={on.unqueueLast}
          notice={toast && <Toast key={toast.id} toast={toast} onDone={() => setToast(null)} />} />
        {panel === "memory" && <MemoryPanel onClose={on.closePanel} onError={on.say} />}
        {panel === "help" && <HelpPanel commands={commands} onClose={on.closePanel} />}
        {panel === "rules" && <RulesPanel onClose={on.closePanel} onError={on.say} />}
        {gpuOpen &&<GpuPanel gpu={state.gpu} job={state.gpuJob} onKeep={keepGpu} keeping={keeping} onClose={() => { setGpuOpen(false); focusBox(); }} />}
        {drag && (
          <div className="drop" aria-hidden="true">
            <p><Icon name="image" />여기에 놓으면 그림을 붙여요 <span className="drop-note">{PICTURE_TYPES.map((t) => t.slice(6).toUpperCase()).join("·")} · 4장까지</span></p>
          </div>
        )}
      </main>
    </div>
  );
}
