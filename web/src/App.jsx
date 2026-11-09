// The RobinCode window, in RobinAI's frame: past conversations, the folder and
// the GPU on the left, the conversation and the composer on the right. On a
// narrow window the left side becomes a drawer behind the menu button.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { api, connect, pickerUrl } from "./api.js";
import { askingTool, initial, reducer } from "./store.js";
import { Composer, PICTURE_TYPES } from "./Composer.jsx";
import { CopyButton, Markdown } from "./Markdown.jsx";
import { ANSWER_KEYS, ToolGroup, describe } from "./Tools.jsx";
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
function StatusRow({ state }) {
  const now = useNow(500);
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

function Conversation({ state, asking, onDecide, onPick, onRewind, onRetry, onBranch, onGpu }) {
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
            return <Line key={item.id} item={item} onGpu={onGpu} />;
          })}
          {state.busy && !asking && !state.think && <StatusRow state={state} />}
        </div>
      )}
      {away && <button type="button" className="to-bottom" onClick={toBottom}><Icon name="down" />아래로</button>}
    </div>
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

function Sidebar({ state, notify, onNotify, closeRef, searchRef, onClose, onNew, onOpen, onDelete, onRename, onLeaveSearch, onGpu }) {
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
        <div className="side-row"><span className="side-label">모델</span><span className="mono">{state.info.model}</span></div>
        <Gpu gpu={state.gpu} fake={state.fake} gpuFake={state.gpuFake} job={state.gpuJob} onOpen={onGpu} />
        <UpdateRow />
      </div>
    </aside>
  );
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

// ---- the app ---------------------------------------------------------------------
export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [draft, setDraft] = useState("");
  const [side, setSide] = useState(false); // the drawer, on a narrow window
  const [toast, setToast] = useState(null);
  const [drag, setDrag] = useState(false);
  const [notify, setNotify] = useState(notifyNow);
  const [gpuOpen, setGpuOpen] = useState(false);
  const picturesRef = useRef(null); // the composer's "these are the pictures"
  const box = useRef(null);
  const menuRef = useRef(null);
  const closeRef = useRef(null);
  const searchRef = useRef(null);
  const attachRef = useRef(null); // the composer's "add these pictures"
  const dragDepth = useRef(0);
  const toastTimer = useRef(0);

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
  useEffect(() => connect((e) => {
    if (e.t === "bg_done") onBg.current?.(e);
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
  const send = useCallback(async (text, pictures = []) => {
    const t = text.trim();
    if (!t && !pictures.length) return false;
    setDraft("");
    try {
      await api("/api/prompt", { text: t, images: pictures.map(({ mimeType, data }) => ({ mimeType, data })) });
      return true;
    } catch (e) {
      dispatch({ type: "local-error", message: `보내지 못했어요: ${e.message}`, gpu: e.gpuOff });
      setDraft(t);
      return false;
    }
  }, []);
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
  const retry = () => api("/api/retry").catch(fail);
  const compact = () => api("/api/compact").catch((e) => (e.message === "busy" || e.gpuOff ? fail(e) : say(e.message)));

  const asking = askingTool(state);
  onBg.current = (e) => {
    const how = e.aborted ? "멈췄어요" : e.failed ? "막혔어요" : "끝났어요";
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

  const lastSent = [...state.items].reverse().find((x) => x.kind === "user")?.text || "";
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
      <Sidebar state={state} notify={notify} onNotify={toggleNotify} closeRef={closeRef} searchRef={searchRef} onClose={() => closeSide(true)} onNew={newChat} onOpen={open}
        onDelete={remove} onRename={rename} onLeaveSearch={() => { if (isNarrow()) closeSide(true); else focusBox(); }}
        onGpu={() => { closeSide(false); setGpuOpen(true); }} />
      <div className="scrim" onClick={() => closeSide(true)} aria-hidden="true" />
      <main className="main" {...dropProps}>
        <header className="main-head">
          <button ref={menuRef} type="button" className="icon-btn menu-btn" aria-label="대화 목록 열기" aria-controls="side"
            aria-expanded={side} onClick={openSide}><Icon name="menu" /></button>
          <h1 className="main-title" key={state.title}>{state.title || "새 대화"}</h1>
          <div className="head-narrow"><Gpu gpu={state.gpu} fake={state.fake} gpuFake={state.gpuFake} job={state.gpuJob} compact onOpen={() => setGpuOpen(true)} /></div>
        </header>
        {state.ready && !state.link && <div className="lost" role="alert">RobinCode 서버와 연결이 끊겼어요. 창을 닫고 다시 여세요.</div>}
        {soon != null && (
          <div className="gpu-soon" role="status">
            <span>GPU를 {state.gpu.idle}분째 안 써서 {soon ? `약 ${soon}분 뒤` : "곧"} 서버가 꺼요. 다시 켜려면 6~10분 걸려요.</span>
            <button type="button" className="mini-btn" onClick={keepGpu} disabled={keeping}>{keeping ? "알리는 중…" : "계속 켜 두기"}</button>
          </div>
        )}
        <Conversation state={state} asking={asking} onDecide={decide} onPick={(s) => send(s)} onRewind={rewind} onRetry={retry} onBranch={branchTo} onGpu={() => setGpuOpen(true)} />
        <Composer state={state} meter={<ContextMeter context={state.context} busy={state.busy} onCompact={compact} />} box={box} draft={draft}
          setDraft={setDraft} lastSent={lastSent} attachRef={attachRef} picturesRef={picturesRef} onSend={send} onStop={stop} onError={say}
          notice={toast && <Toast key={toast.id} toast={toast} onDone={() => setToast(null)} />} />
        {gpuOpen && <GpuPanel gpu={state.gpu} job={state.gpuJob} onKeep={keepGpu} keeping={keeping} onClose={() => { setGpuOpen(false); focusBox(); }} />}
        {drag && (
          <div className="drop" aria-hidden="true">
            <p><Icon name="image" />여기에 놓으면 그림을 붙여요 <span className="drop-note">{PICTURE_TYPES.map((t) => t.slice(6).toUpperCase()).join("·")} · 4장까지</span></p>
          </div>
        )}
      </main>
    </div>
  );
}
