// The RobinCode window, in RobinAI's frame: past conversations, the folder and
// the GPU on the left, the conversation and the composer on the right. On a
// narrow window the left side becomes a drawer behind the menu button.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, connect, pickerUrl, glide } from "./api.js";
import { askingTool, initial, reducer } from "./store.js";
import { fileHunks } from "./hunks.js";
import { Composer, PICTURE_TYPES } from "./Composer.jsx";
import { CopyButton, Markdown } from "./Markdown.jsx";
import { ANSWER_KEYS, REVEAL, ShellRun, TodoPanel, ToolGroup, describe, latestTodo } from "./Tools.jsx";
import { AppMark, Icon, Tag } from "./icons.jsx";
import { ago, seconds, useNow } from "./time.js";
import { MODES, MODE_NAMES, MODE_TIPS, nextMode } from "./modes.js";
import { BUILTIN, FOLDER_ONLY, INIT_PROMPT } from "./commands.js";

const SUGGESTIONS = ["이 폴더 구조 설명해 줘", "package.json 읽어 줘", "README 고쳐 줘"];
// a plain conversation's (no folder: talking, writing, thinking together)
const CHAT_SUGGESTIONS = ["RobinCode로 뭘 할 수 있어?", "오늘 할 일 정리하는 거 도와줘", "아이디어 같이 생각해 줘"];
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
// the GPU's state as a status chip: amber while it turns on (or is the fake
// one), red only when the server cannot be asked; off is not an error
const chipTone = (state, lamp) => (lamp === "warn" || lamp === "test" ? " warn" : state === "unreachable" ? " bad" : "");

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

// the GPU in the top bar: a lamp and a word, the whole of it in the title;
// pressed, the GPU window (turn on, off, rent)
function HeadGpu({ gpu, fake, gpuFake, job, onOpen }) {
  const prog = progressOf(gpu, job);
  const state = prog ? "starting" : gpu.state || "unknown"; // a rent says "켜는 중" before Vast does
  const lamp = fake && !gpuFake ? "test" : lampOf(state);
  const can = (!fake || gpuFake) && state !== "unknown" && state !== "unreachable";
  const short = gpu.hours != null && gpu.hours <= 1;
  const dl = prog && downloadOf(prog.p);
  const words = `${GPU_NAMES[state] || state}${prog ? ` · ${prog.p.name}${dl != null ? ` ${Math.round(dl * 100)}%` : ""}` : ""}`;
  const title = [`GPU ${words}`, state === "on" && gpu.rate ? `시간당 $${gpu.rate}` : "",
    gpu.credit != null ? `크레딧 $${gpu.credit}${gpu.left ? ` · ${gpu.left}` : ""}` : "", fake ? "가짜 모델로 시험 중" : "",
    can ? "누르면 GPU를 켜고 끄는 창을 열어요" : ""].filter(Boolean).join("\n");
  const inner = <><span className={`lamp ${lamp}`} aria-hidden="true" /><span className="hg-word">GPU</span><span className="gpu-state">{words}</span></>;
  const cls = `head-btn head-gpu${short ? " warn" : ""}${job?.running ? " working" : ""}`;
  return can ? <button type="button" className={cls} onClick={onOpen} title={title}>{inner}</button>
    : <span className={`${cls} still`} title={title}>{inner}</span>;
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
        <span className="ctx-track"><span className="ctx-fill" style={{ transform: `scaleX(${p / 100})` }} /></span>
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

// the app's mark and name (brand V3: the pixel logo is gone)
function Logo() {
  return (
    <div className="logo">
      <AppMark size="big" />
      <span className="logo-name">RobinCode</span>
    </div>
  );
}

// Where a new conversation works, chosen on its empty screen (robin
// 2026-11-19 "왜 시작부터 폴더를골라야해", "왜 일반채팅은 없어"; Claude Code's
// folder picker under a new session): no folder (a plain conversation) or a
// folder robin opened lately, or another one from Explorer. Once something is
// sent the place stays (the header and the list say it).
function PlacePicker({ info, ready, onPlace }) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState(null);
  const [busy, setBusy] = useState(false);
  const button = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    api("/api/places").then((r) => { if (live) setFolders(r.folders || []); }).catch(() => { if (live) setFolders([]); });
    const away = (e) => { if (!menu.current?.contains(e.target) && !button.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => { live = false; document.removeEventListener("pointerdown", away); };
  }, [open]);
  // the menu opens on the one in use (keyboard: arrows, Enter, Esc)
  const items = () => [...(menu.current?.querySelectorAll("[role=menuitemradio], [role=menuitem]") || [])];
  useEffect(() => {
    // (not again when the folders arrive after robin moved in the menu)
    if (!open || menu.current?.contains(document.activeElement)) return;
    const all = items();
    (all.find((x) => x.getAttribute("aria-checked") === "true") || all[0])?.focus();
  }, [open, folders]);
  const go = (place) => {
    setOpen(false);
    button.current?.focus();
    if (place.toLowerCase() === (info.chat ? "chat" : (info.cwd || "").toLowerCase())) return;
    setBusy(true);
    Promise.resolve(onPlace(place)).finally(() => setBusy(false));
  };
  const browse = async () => {
    setOpen(false);
    // RobinCode.exe: the Windows folder dialog; a browser window: the folder screen
    if (!window.robincodeShell?.pickFolder) { location.href = pickerUrl(); return; }
    const path = await window.robincodeShell.pickFolder(info.chat ? "" : info.cwd).catch(() => null);
    button.current?.focus();
    if (path) go(path);
  };
  const keys = (e) => {
    const all = items();
    const k = all.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(k + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") { e.preventDefault(); all[e.key === "Home" ? 0 : all.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };
  const here = (p) => !info.chat && p.toLowerCase() === (info.cwd || "").toLowerCase();
  return (
    <div className="place">
      <button ref={button} type="button" className="place-btn" aria-haspopup="menu" aria-expanded={open} disabled={!ready || busy}
        aria-label={`새 대화를 열 곳: ${info.chat ? "일반 대화, 폴더 없음" : info.cwd}. 눌러서 바꿔요`}
        title={info.chat ? "폴더 없이 이야기만 해요. 눌러서 폴더를 골라요." : `${info.cwd}\n눌러서 다른 곳을 골라요.`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
        <Icon name={info.chat ? "chat" : "folder"} />
        <span className="place-name">{info.chat ? "일반 대화" : info.folder || "…"}</span>
        {!info.chat && info.cwd && <span className="place-path mono">{shortPath(info.cwd)}</span>}
        <Icon name="chevdown" />
      </button>
      {open && (
        <div ref={menu} className="place-menu" role="menu" aria-label="새 대화를 열 곳" onKeyDown={keys}>
          <p className="list-head" role="presentation"><Icon name="folder" /><span>새 대화를 열 곳</span></p>
          <button type="button" role="menuitemradio" aria-checked={!!info.chat} className="place-item" onClick={() => go("chat")}>
            <Icon name="chat" />
            <span className="place-text"><span className="place-item-name">일반 대화</span><span className="place-item-note">폴더 없이 이야기만 해요. 웹 페이지는 물어보고 읽어요.</span></span>
            {info.chat && <span className="place-check"><Icon name="check" /></span>}
          </button>
          <p className="place-label" role="presentation">최근 폴더</p>
          {folders === null ? <p className="place-wait" role="presentation">불러오는 중…</p>
            : folders.map((f) => (
              <button key={f.path} type="button" role="menuitemradio" aria-checked={here(f.path)} className="place-item" onClick={() => go(f.path)} title={f.path}>
                <Icon name="folder" />
                <span className="place-text">
                  <span className="place-item-name">{f.name}{f.branch && <span className="place-branch mono"> {f.branch}</span>}</span>
                  <span className="place-item-note mono">{f.short}</span>
                </span>
                {here(f.path) && <span className="place-check"><Icon name="check" /></span>}
              </button>
            ))}
          <button type="button" role="menuitem" className="place-item place-more" onClick={browse}>
            <Icon name="search" /><span className="place-text"><span className="place-item-name">다른 폴더 찾기…</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

// the empty conversation: the mark, the question, where it works, the starters
function Empty({ info, ready, onPick, onPlace }) {
  const linked = !!(info.chat || info.folder);
  return (
    <section className="empty">
      <Logo />
      <h1 className="empty-sub">무엇을 할까요?</h1>
      {linked && <PlacePicker info={info} ready={ready} onPlace={onPlace} />}
      <p className="empty-note">{!linked ? "연결하는 중이에요."
        : info.chat ? "폴더 없이 이야기해요. 파일을 읽거나 명령을 실행하려면 위에서 폴더를 골라요."
          : "이 폴더의 파일을 읽고, 찾고, 고치고, PowerShell 명령을 실행해요. 명령과 파일 수정은 실행 전에 물어봐요."}</p>
      <div className="starters">
        {(info.chat ? CHAT_SUGGESTIONS : SUGGESTIONS).map((s) => (
          <button key={s} type="button" className="starter" disabled={!ready} onClick={() => onPick(s)}>
            <span>{s}</span><Icon name="right" />
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
      <span className="line-tag"><Tag tag={item.tag} /></span>
      <span>{item.text}</span>
      {item.gpu && onGpu && <button type="button" className="mini-btn line-btn" onClick={onGpu}>GPU 켜기…</button>}
    </div>
  );
}

// a long paste stays a few lines tall until it is opened; pictures sit above
// the words, small until one is pressed
// a sent message's pictures: a data URL of a few MB was made again (and
// compared) every token while an answer came
const BubblePics = memo(function BubblePics({ images, big, onBig }) {
  return (
    <div className="bubble-pics">
      {images.map((im, k) => (
        <button key={k} type="button" className={`bubble-pic${big === k ? " big" : ""}`} aria-pressed={big === k}
          title={big === k ? "작게" : "크게"} onClick={() => onBig((v) => (v === k ? -1 : k))}>
          <img src={`data:${im.mimeType};base64,${im.data}`} alt={`보낸 그림 ${k + 1}`} decoding="async" />
        </button>
      ))}
    </div>
  );
});
const NO_IMAGES = [];
function UserBubble({ text, images = NO_IMAGES, foot }) {
  const long = text.split("\n").length > 12 || text.length > 900;
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(-1);
  return (
    <div className="bubble-col">
      {images.length > 0 && <BubblePics images={images} big={big} onBig={setBig} />}
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
        <span className="sr">모델 연결이 끊겨서 다시 해 봐요. {r.attempt}/{r.max}번째</span>
        <span aria-hidden="true">{wait > 0 ? `모델 연결이 끊겨서 ${wait}초 뒤 다시 해 봐요` : "다시 해 보는 중"}… <span className="status-time">{r.attempt}/{r.max}</span></span>
      </div>
    );
  }
  const what = state.phase === "tool" ? `${state.runningTool} 실행하는 중` : state.phase === "write" ? "쓰는 중"
    : state.phase === "compact" ? "앞부분을 요약하는 중" : "생각하는 중";
  return (
    <div className="status-row" role="status">
      {/* while the answer is written, its own end blinks: this one stays still */}
      <span className={`status-mark${state.phase === "write" ? " still" : ""}`} aria-hidden="true">▌</span>
      {what}… <span className="status-time" aria-hidden="true">{seconds(now - state.startedAt)}</span>
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
// where robin was reading in each conversation (this window, the 30 last):
// coming back to one put robin at its bottom (codex B9 / B-438)
const readAt = new Map();
const ASK_WHAT = { powershell: "명령 실행", bash: "명령 실행", edit: "파일 고치기", write: "파일 쓰기", read: "파일 읽기", grep: "파일 안 찾기", webfetch: "웹 페이지 읽기" };
const Conversation = memo(function Conversation({ state, outbox = [], asking, onDecide, onPick, onPlace, onRewind, onRetry, onBranch, onGpu, onUnqueue, onPlanGo }) {
  const scroller = useRef(null);
  const content = useRef(null);
  const stick = useRef(true);
  const busy = useRef(state.busy);
  busy.current = state.busy;
  const [away, setAway] = useState(false);
  // the window made narrower or wider (or maximized): the text wraps again and
  // the browser keeps the old scrollTop, so what was at the bottom is not —
  // that scroll is the layout's, not robin's, and the view stays at the bottom
  const size = useRef("");
  const resized = (el) => {
    const now = `${el.clientWidth}x${el.clientHeight}`;
    if (now === size.current) return false;
    size.current = now;
    return true;
  };
  const onScroll = () => {
    const el = scroller.current;
    if (resized(el) && stick.current) { el.scrollTop = el.scrollHeight; return; }
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAway(!stick.current);
    const key = fileNow.current || "new";
    readAt.delete(key);
    if (!stick.current) { readAt.set(key, el.scrollTop); while (readAt.size > 30) readAt.delete(readAt.keys().next().value); }
  };
  const fileNow = useRef(state.sessionFile);
  // another conversation, or something robin just sent: back to the bottom
  const last = state.items[state.items.length - 1];
  useLayoutEffect(() => {
    fileNow.current = state.sessionFile;
    const top = readAt.get(state.sessionFile || "new");
    const el = scroller.current;
    if (top != null && el && el.scrollHeight - el.clientHeight > top) { stick.current = false; setAway(true); el.scrollTop = top; return; }
    stick.current = true;
    setAway(false);
  }, [state.sessionFile]);
  // "something robin just sent" is also a message that is still waiting (sent while a turn or a summary runs):
  // by the time it is in the conversation the reply may already be the last item — with a fast model both land
  // in one render — and the view, left up where robin was reading or where find jumped, never came back down
  // with "아래로" showing (test/ui.mjs "창 크기를 바꿔도 맨 아래" failed two runs in three; 2026-11-22: the log
  // showed find leaving the view at 45px and nothing bringing it back)
  const waiting = outbox.length + state.queued.length;
  const waitingBefore = useRef(waiting);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (last?.kind === "user" || waiting > waitingBefore.current) stick.current = true;
    waitingBefore.current = waiting;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.busy, last, waiting]);
  // while it runs, keep following what grows (a fold opening, a code block)
  // (a first message being sent is not an empty conversation: its bubble shows)
  // (what waits for a GPU slot shows too: a new conversation's first message)
  const empty = state.items.length === 0 && outbox.length === 0 && state.queued.length === 0;
  useEffect(() => {
    if (empty || !content.current) return undefined;
    const watch = new ResizeObserver(() => {
      const el = scroller.current;
      if (!el) return;
      const reflowed = resized(el);
      if (stick.current && (busy.current || reflowed)) el.scrollTop = el.scrollHeight;
    });
    watch.observe(content.current);
    if (scroller.current) watch.observe(scroller.current);
    return () => watch.disconnect();
  }, [empty]);
  const toBottom = () => {
    stick.current = true;
    setAway(false);
    scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: glide() });
  };
  // a question came while robin reads above: robin goes to it when ready
  const toAsk = () => {
    // answered cards stay (hidden, inert): the one still asking is the last live one
    const card = [...(scroller.current?.querySelectorAll(".ask") || [])].findLast((el) => !el.closest("[inert]"));
    if (!card) { toBottom(); return; }
    card.scrollIntoView({ block: "center", behavior: glide() });
    // the card, not its yes: a screen reader reads the question first, and a
    // stray Enter does not say yes
    card.focus({ preventScroll: true });
  };
  // a turn that ended, told once (cleared when the next starts)
  const [ended, setEnded] = useState(false);
  const wasBusy = useRef(state.busy);
  useEffect(() => {
    if (state.busy) setEnded(false);
    else if (wasBusy.current) setEnded(true);
    wasBusy.current = state.busy;
  }, [state.busy]);
  // another branch: stay where the message is, not at the bottom
  const goBranch = (id) => { stick.current = false; onBranch(id); };
  const ends = turnEnds(state.items, state.busy);
  // the answer that can be asked for again: the conversation's last
  const lastAnswer = state.items.findLast((x) => x.kind === "assistant" || x.kind === "user");
  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      {empty ? <Empty info={state.info} ready={state.ready && state.link} onPick={onPick} onPlace={onPlace} /> : (
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
          {/* sent, not yet taken: the model is checked first (it can take a
              few seconds; the box was empty with nothing in the thread) */}
          {outbox.map((o) => (
            <div key={o.id} className="msg msg-user sending" aria-live="polite">
              <div className="bubble-col">
                <div className="bubble"><span className="bubble-text">{o.text}</span></div>
                <span className="sending-note">보내는 중…</span>
              </div>
            </div>
          ))}
          {state.queued.length > 0 && (
            <div className="queued" role="group" aria-label="기다리는 말">
              {state.queued.map((q, k) => (
                <div key={q.id || k} className={`queued-bubble ${q.held ? "held" : q.kind}`}>
                  <span className="queued-when">{q.slot ? "GPU 자리가 나면" : q.held ? "요약이 끝나면" : q.kind === "steer" ? "다음 단계 전에" : "다 끝나면"}</span>
                  <div className="queued-text">{q.text}{q.pictures ? <span className="queued-pics"> · 그림 {q.pictures}장</span> : null}</div>
                  <button type="button" className="icon-btn queued-x" aria-label="이 말은 보내지 않고 입력 칸으로" title="보내지 않고 입력 칸으로 (고쳐서 다시 보내요)"
                    onClick={() => onUnqueue(q.id)}><Icon name="close" /></button>
                </div>
              ))}
              <p className="queued-note">
                {state.queued.some((q) => q.slot) ? "다른 대화 둘이 GPU를 쓰는 중이에요. 하나가 끝나면 바로 보내요. Esc를 누르면 보내지 않고 입력 칸으로 돌려줘요."
                  : state.queued.some((q) => q.kind === "steer" && !q.held) ? "모델이 지금 단계를 마치면 바로 전해요." : "이 답이 끝나면 보내요."}
                <span className="queued-keys"> 빈 칸에서 <kbd>↑</kbd>로 꺼내 고쳐요.</span>
                <button type="button" className="link-act" onClick={() => onUnqueue()}>모두 보내지 않기</button>
              </p>
            </div>
          )}
        </div>
      )}
      {/* for a screen reader: a question waiting, and a turn that ended (the
          region is always there, so a change is read out) */}
      <p className="sr" role="status">{asking ? `허락을 기다려요: ${ASK_WHAT[asking.name] || asking.name} ${describe(asking.name, asking.args)}${asking.risk ? ` (${asking.risk})` : ""}. 1은 허락, 3은 안 돼요.` : ended ? "답이 끝났어요." : ""}</p>
      {away && (asking
        ? <button type="button" className="to-bottom" onClick={toAsk}><Icon name="down" />허락 요청으로</button>
        : <button type="button" className="to-bottom" onClick={toBottom}><Icon name="down" />아래로</button>)}
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

// a conversation going on: "도는 중" (or waiting for a yes) where its time was;
// one that ended while robin was in another: "끝났어요" until it is opened
// (the one on screen has its own blinking status line: no second cursor here)
// (a third one waits for one of the GPU's two slots: "자리를 기다려요")
// (one line of a 32px row: short words, the whole sentence in the row's title)
// (a status chip, docs/brand.md 부품 더: amber asks or waits, red failed)
function RunMark({ run, here }) {
  if (run.done) return <span className="conv-run conv-done chip-state">끝났어요<span className="sr"> · 아직 안 봤어요</span></span>;
  if (run.asking) return <span className="conv-run conv-ask chip-state warn"><Tag tag="[ ?? ]" />허락을 기다려요</span>;
  if (run.waiting) return <span className="conv-run conv-wait chip-state warn"><Tag tag="[ ·· ]" />자리를 기다려요</span>;
  if (run.failed) return <span className="conv-run conv-fail chip-state bad"><Tag tag="[ !! ]" />보내지 못했어요</span>;
  return <span className="conv-run chip-state">{here ? <span className="lamp on" aria-hidden="true" /> : <Tag tag="[ .. ]" />}도는 중</span>;
}
const runWords = (run) => (run.done ? "끝났어요 · 아직 안 봤어요" : run.asking ? "허락을 기다려요" : run.waiting ? "GPU 자리를 기다려요"
  : run.failed ? "보내지 못했어요 · 열면 쓴 말이 돌아와요" : "도는 중");
// where a conversation works: its folder's name, or none (a plain conversation)

function Conv({ s, q, current, run, now, pinned, onPin, onOpen, onDelete, onRename }) {
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
          <button type="button" className="conv-open"
            title={[s.title, s.chat ? "일반 대화 (폴더 없음)" : s.cwd || s.folder || "", run ? runWords(run) : s.modified ? ago(s.modified, now) : ""].filter(Boolean).join("\n")}
            onClick={() => onOpen(s.path)}>
            <Icon name={s.chat ? "chat" : "folder"} />
            <span className="conv-text">
              <span className="conv-title"><Mark text={s.title} q={q} /></span>
              {s.snippet && !run && <span className="conv-snip"><Mark text={s.snippet.text} q={q} /></span>}
            </span>
            {/* every folder's conversations are in one list: each says where (a
                plain one has its own icon), or what it is doing now */}
            <span className="conv-time">
              {run ? <RunMark run={run} here={!!current} /> : !s.chat && s.folder ? <span className="conv-place">{s.folder}</span> : null}
            </span>
          </button>
          {onRename && (
            <span className="conv-acts">
              {onPin && (
                <button type="button" className={`icon-btn conv-act${pinned ? " on" : ""}`} aria-pressed={!!pinned}
                  aria-label={`"${s.title}" ${pinned ? "고정 풀기" : "위에 고정"}`} title={pinned ? "고정 풀기" : "위에 고정"}
                  onClick={() => onPin(s.path)}><Icon name="pin" /></button>
              )}
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

const Sidebar = memo(function Sidebar({ state, closeRef, searchRef, onClose, onNew, onOpen, onDelete, onRename, onLeaveSearch, shellU, settings, onSettings }) {
  const now = useNow(60000);
  const nav = useRef(null);
  // ended while robin was elsewhere: marked until opened (this window's run only)
  const [unseen, setUnseen] = useState(() => new Set());
  const wasRunning = useRef([]);
  useEffect(() => {
    const live = new Set(state.running.map((r) => r.path));
    const ended = wasRunning.current.filter((p) => !live.has(p) && p !== state.sessionFile);
    wasRunning.current = [...live];
    if (ended.length) setUnseen((u) => new Set([...u, ...ended]));
  }, [state.running, state.sessionFile]);
  useEffect(() => {
    setUnseen((u) => (u.has(state.sessionFile) ? new Set([...u].filter((p) => p !== state.sessionFile)) : u));
  }, [state.sessionFile]);
  const [pins, setPins] = useState(loadPins);
  const pin = useCallback((path) => setPins((p) => {
    const next = p.includes(path) ? p.filter((x) => x !== path) : [path, ...p].slice(0, 20);
    keepPins(next);
    return next;
  }), []);
  const runOf = (path) => state.running.find((r) => r.path === path) || (unseen.has(path) ? { done: true } : undefined);
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
      pinned={pins.includes(s.path)} onPin={pin} onOpen={onOpen} onDelete={onDelete} onRename={onRename} />
  );
  // pinned ones on top, in the order pinned (one deleted falls away by itself)
  const pinned = pins.map((p) => (state.sessions || []).find((s) => s.path === p)).filter(Boolean);
  const rest = (state.sessions || []).filter((s) => !pins.includes(s.path));
  // going on but not in the list (older than its newest 80)
  const listed = new Set((state.sessions || []).map((s) => s.path));
  const elsewhere = state.running.filter((r) => r.path !== state.sessionFile && !listed.has(r.path));
  return (
    <aside className="side" id="side" aria-label="대화 목록">
      {/* the brand cell: as tall as the top bar, its rule on the same line */}
      <div className="side-head">
        <span className="brand"><AppMark />
          <span className="brand-text"><span className="brand-name">RobinCode</span><span className="brand-sub" title="이 앱이 쓰는 모델">{state.info.model}</span></span>
        </span>
        <button ref={closeRef} type="button" className="icon-btn side-close" aria-label="목록 닫기" onClick={onClose}><Icon name="close" /></button>
      </div>
      <button type="button" className="side-item new-chat" onClick={onNew}
        title={"지금과 같은 곳에서 새 대화를 열어요(Ctrl+N). 폴더나 일반 대화는 새 대화 첫 화면에서 바꿔요.\n도는 대화는 그대로 계속해요."}>
        <Icon name="plus" /><span>새 대화</span><kbd className="search-key">Ctrl N</kbd>
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
          <section className="conv-day" aria-label="도는 대화">
            <p className="side-label">도는 대화</p>
            <ul className="conv-list">{elsewhere.map((r) => (
              <Conv key={r.path} s={{ path: r.path, title: r.title, folder: r.folder, chat: r.chat, cwd: r.cwd }} q="" current={false} run={r} now={now} onOpen={onOpen} />
            ))}</ul>
          </section>
        )}
        {words && found ? (
          <section className="conv-day" aria-label="찾은 대화">
            <p className="side-label" aria-live="polite">{found.list.length ? `찾은 대화 ${found.list.length}개` : `찾은 대화가 없어요: "${found.q}"`}</p>
            <ul className="conv-list">{found.list.map((s) => conv(s, found.q))}</ul>
          </section>
        ) : state.sessions === null ? null : state.sessions.length === 0 ? (
          <><p className="side-label">지난 대화</p><p className="conv-empty">아직 없어요.</p></>
        ) : (
          [...(pinned.length ? [["고정", pinned]] : []), ...byDay(rest, now)].map(([day, list]) => (
            <section key={day} className="conv-day" aria-label={day}>
              <p className="side-label">{day}</p>
              <ul className="conv-list">{list.map((s) => conv(s, ""))}</ul>
            </section>
          ))
        )}
      </nav>
      <AccountRow version={state.version} shellU={shellU} open={settings} onOpen={onSettings} />
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

// ---- which RobinCode this is, and a newer one (robin 2026-11-19 "현재 버전이랑
// 업데이트 됫다는 UX가 부족하잖아"). The server says the version and what
// changed (both kinds: the repository's from git, an installed copy's from its
// version.json) and, for the repository, a newer one on GitHub; an installed
// copy's downloads are RobinCode.exe's (update.cjs), told to this window.
function useShellUpdate() {
  const shell = window.robincodeShell;
  const [u, setU] = useState(null);
  useEffect(() => {
    if (!shell?.updateState) return undefined;
    shell.updateState().then(setU).catch(() => {});
    return shell.onUpdate(setU);
  }, [shell]);
  return u?.version ? u : null;
}
// "20261119-1442-18c75c4" -> { when: "11.19 14:42", hash: "18c75c4" }
function verLabel(v) {
  const m = String(v || "").match(/^\d{4}(\d\d)(\d\d)-(\d\d)(\d\d)-(\w+)/);
  return m ? { when: `${m[1]}.${m[2]} ${m[3]}:${m[4]}`, hash: m[5] } : { when: String(v || ""), hash: "" };
}
const shortDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, "0")}`; };
// one word for where the updates stand: { kind, mark, tone, text, detail, relaunch }
function updateStatus(v, u, now = Date.now()) {
  const checked = (at) => (at ? ` · ${ago(at, now)} 확인` : "");
  if (u) {
    if (u.downloading) return { kind: "downloading", mark: "[ .. ]", text: `새 판 ${verLabel(u.downloading).when}을 받는 중이에요`, detail: "다 받으면 여기서 다시 켤 수 있어요. 받는 동안에도 그대로 써요." };
    if (u.ready && u.ready !== u.version) return { kind: "ready", mark: "[NEW]", tone: "new", text: `새 판 ${verLabel(u.ready).when}을 받아 뒀어요`, detail: "지금 다시 켜거나, 다음에 켤 때 바뀌어요.", relaunch: true };
    if (u.shell) return { kind: "shell", mark: "[ !! ]", tone: "warn", text: `새 판 ${verLabel(u.shell).when}은 ai.yoonrobin.xyz에서 다시 받아야 해요`, detail: "앱 껍데기(Electron)가 바뀐 판이라 알아서 받지 못해요." };
    if (u.checking) return { kind: "checking", mark: "[ .. ]", text: "새 판이 있는지 보는 중이에요" };
    if (u.error) return { kind: "error", mark: "[FAIL]", tone: "bad", text: "새 판을 확인하지 못했어요", detail: `${u.error}${checked(u.checkedAt)}` };
    if (u.checkedAt) return { kind: "ok", mark: "[ OK ]", text: `최신 판이에요${checked(u.checkedAt)}` };
    return { kind: "none", mark: "[ .. ]", text: "켜고 조금 뒤에 새 판을 확인해요" };
  }
  const p = v?.pending;
  if (p && p.blocked) return { kind: "blocked", mark: "[ !! ]", tone: "warn", text: `새 판이 GitHub에 있어요 (바뀐 것 ${p.count}개)`, detail: p.blocked };
  if (p) return { kind: "pending", mark: "[NEW]", tone: "new", text: `새 판이 GitHub에 있어요 (바뀐 것 ${p.count}개)`, detail: "다시 켜면 받아서 바뀌어요.", relaunch: true };
  if (v?.checking) return { kind: "checking", mark: "[ .. ]", text: "새 판이 있는지 보는 중이에요" };
  if (v?.error) return { kind: "error", mark: "[FAIL]", tone: "bad", text: "새 판을 확인하지 못했어요", detail: `${v.error}${checked(v.checkedAt)}` };
  if (v?.checkedAt) return { kind: "ok", mark: "[ OK ]", text: `최신 판이에요${checked(v.checkedAt)}` };
  if (v?.canCheck) return { kind: "none", mark: "[ .. ]", text: "켜고 조금 뒤에 새 판을 확인해요" };
  return { kind: "none", mark: "[ -- ]", text: "저장소에서 켠 판이에요", detail: "바탕화면 바로가기로 켜면 새 판을 알아서 받아요." };
}

// the account row at the foot of the sidebar (docs/brand.md 뼈대): the app's
// mark, its name, the version (and a new one) under it; the whole row opens
// the settings
function AccountRow({ version, shellU, open, onOpen }) {
  const s = version?.version ? updateStatus(version, shellU) : null;
  const fresh = version?.fresh?.length || 0;
  const tag = !s ? null : s.tone === "new" ? <span className="ver-tag new"><Tag tag="[NEW]" /> 새 판</span>
    : s.kind === "downloading" ? <span className="ver-tag"><Tag tag="[ .. ]" />받는 중</span>
    : s.tone === "warn" ? <span className="ver-tag warn">새 판 있음</span>
    : fresh ? <span className="ver-tag">바뀐 것 {fresh}</span>
    : s.kind === "error" ? <span className="ver-tag faint">확인 못 함</span> : null;
  return (
    <button type="button" className="acct" onClick={onOpen} aria-pressed={!!open} title="설정: 알림, 모드, 폴더, GPU, 판">
      <AppMark />
      <span className="acct-line">
        <span className="acct-name">RobinCode</span>
        <span className="acct-sub">{version?.version ? <><span className="sr">판 </span>{verLabel(version.version).when}</> : "설정"}{tag}</span>
      </span>
      <Chev />
    </button>
  );
}
// the original's small marks: › (6x10) and ⌄ (9x5)
const Chev = () => <svg className="chev-r" viewBox="0 0 6 10" aria-hidden="true"><path d="M1 1l4 4-4 4" /></svg>;
const ChevDown = () => <svg className="chev-d" viewBox="0 0 9 5" aria-hidden="true"><path d="M.75.75 4.5 4.25 8.25.75" /></svg>;

// ---- the settings, from the account row (robin 2026-11-19 "네버루즈랑 완전히
// 똑같게"): what the sidebar's card held and the commands' sheets, laid out as
// the original's page — small heads over cards, a row per setting (name left,
// its control right), two columns when there is room. Only what RobinCode has.
function SetRow({ name, off, tip, className = "", children }) {
  return (
    <div className={`set-row${off ? " off" : ""}${className ? ` ${className}` : ""}`} data-tip={off ? tip : undefined}>
      <span className="set-name">{name}</span>
      <span className="set-ctl">{children}</span>
    </div>
  );
}
// a row that opens a page of its own: the whole row is the button
// (`val`: the row's one value, in blue)
function SubRow({ name, value, val, off, tip, title, href, onClick }) {
  const inner = <><span className="set-name">{name}</span>{value != null && <span className={`set-value${val ? " val" : ""}`}>{value}</span>}<Chev /></>;
  if (off) return <div className="set-row sub off" role="button" aria-disabled="true" tabIndex={0} data-tip={tip}>{inner}</div>;
  if (href) return <a className="set-row sub" href={href} title={title}>{inner}</a>;
  return <button type="button" className="set-row sub" onClick={onClick} title={title}>{inner}</button>;
}
// a select (the original's dropdown button, 132x24): its menu is the kit's
// dropdown; arrows, Enter, Esc
function Select({ label, value, options, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    // Esc here only closes the menu (it must not stop the agent)
    const esc = (e) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    const all = [...(menu.current?.querySelectorAll("[role=menuitemradio]") || [])];
    (all.find((x) => x.getAttribute("aria-checked") === "true") || all[0])?.focus();
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  const keys = (e) => {
    const all = [...menu.current.querySelectorAll("[role=menuitemradio]")];
    const k = all.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); all[(k + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); all[e.key === "Home" ? 0 : all.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };
  const now = options.find((o) => o.value === value) || options[0];
  const pick = (o) => { setOpen(false); btn.current?.focus(); if (o.value !== value) onChange(o.value); };
  return (
    <span className="sel">
      <button ref={btn} type="button" className="set-select" aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        aria-label={`${label}: ${now.label}`} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
        <span className="sel-text">{now.label}</span><ChevDown />
      </button>
      {open && (
        <div ref={menu} className="pop sel-menu" role="menu" aria-label={label} onKeyDown={keys}>
          {options.map((o) => (
            <button key={o.value} type="button" role="menuitemradio" aria-checked={o.value === value} className="place-item" onClick={() => pick(o)}>
              <span className="place-text"><span className="place-item-name">{o.label}</span>{o.hint && <span className="pop-note">{o.hint}</span>}</span>
              {o.value === value && <span className="place-check"><Icon name="check" /></span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
function Settings({ state, notify, shellU, onNotify, onMode, onThink, onGpu, onPanel, onClose }) {
  const page = useRef(null);
  useEffect(() => {
    page.current?.focus();
    // Esc closes the page (a sheet or a select over it closes itself first)
    const esc = (e) => {
      if (e.key !== "Escape" || document.querySelector("[aria-modal='true'], .sel-menu")) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  }, [onClose]);
  const { info, git: g, gpu } = state;
  const chat = !!info.chat;
  const prog = progressOf(gpu, state.gpuJob);
  const gState = prog ? "starting" : gpu.state || "unknown";
  const can = (!state.fake || state.gpuFake) && gState !== "unknown" && gState !== "unreachable";
  // the state as a status chip (its lamp's tone), the rate after it
  const gLamp = state.fake && !state.gpuFake ? "test" : lampOf(gState);
  const gpuWords = <><span className={`chip-state${chipTone(gState, gLamp)}`}><span className={`lamp ${gLamp}`} aria-hidden="true" />{GPU_NAMES[gState] || gState}{prog ? ` · ${prog.p.name}` : ""}</span>{gState === "on" && gpu.rate ? ` · 시간당 $${gpu.rate}` : ""}</>;
  const v = state.version;
  const us = v?.version ? updateStatus(v, shellU) : null;
  const blocked = notify === "blocked";
  const noFolder = "일반 대화에는 폴더가 없어요. 새 대화에서 폴더를 고르면 써요.";
  return (
    <section className="set-page" ref={page} tabIndex={-1} aria-label="설정">
      <div className="set-grid">
        <div className="set-col">
          <h2 className="set-head">이 대화</h2>
          <div className="set-card">
            <SetRow name="폴더">
              {chat ? <span className="set-value val">일반 대화</span> : <span className="set-value val mono" title={info.cwd}>{info.folder || shortPath(info.cwd || "")}</span>}
            </SetRow>
            {!chat && g && (
              <SetRow name="git">
                <span className="set-value mono">{g.branch}
                  {g.changed > 0 && <span className="git-changed"> · 바뀐 파일 {g.changed}</span>}
                  {g.ahead > 0 && <span className="git-ahead"> ↑{g.ahead}</span>}
                  {g.behind > 0 && <span className="git-ahead"> ↓{g.behind}</span>}
                </span>
              </SetRow>
            )}
            <SetRow name="모드" off={chat} tip="일반 대화는 파일도 명령도 쓰지 않아서 모드가 없어요.">
              <Select label="모드" value={state.mode || "ask"} disabled={chat} onChange={onMode}
                options={MODES.map((m) => ({ value: m, label: MODE_NAMES[m], hint: MODE_TIPS[m] }))} />
            </SetRow>
            <SetRow name="답하기 전에 생각">
              <button type="button" className={`toggle${state.thinking ? " on" : ""}`} aria-pressed={!!state.thinking} aria-label="답하기 전에 생각"
                title={state.thinking ? "모델이 답하기 전에 먼저 생각해요. 누르면 꺼요 (/think)" : "누르면 모델이 답하기 전에 먼저 생각해요 (/think)"} onClick={onThink}>
                <span className="switch" aria-hidden="true" />
              </button>
            </SetRow>
            <SubRow name="다른 폴더에서 새 대화" href={pickerUrl()} title="폴더 화면을 열어요. 이 대화는 목록에 남고, 도는 중이면 그대로 계속해요." />
          </div>
          <h2 className="set-head">모델</h2>
          <div className="set-card">
            <SetRow name="모델"><span className="set-value val mono">{info.model}</span></SetRow>
            {can ? <SubRow name="GPU" value={gpuWords} onClick={onGpu} title="GPU를 켜고 끄는 창을 열어요. 빌릴 자리는 거기서 골라요." />
              : <SetRow name="GPU"><span className="set-value">{gpuWords}</span></SetRow>}
            {gpu.credit != null && (
              <SetRow name="크레딧"><span className={`set-value${gpu.hours != null && gpu.hours <= 1 ? " warn" : gpu.left ? "" : " val"}`}>${gpu.credit}{gpu.left ? ` · ${gpu.left}` : ""}</span></SetRow>
            )}
            {state.fake && <SetRow name="시험"><span className="set-value"><span className="chip-state warn">가짜 모델로 시험 중</span></span></SetRow>}
          </div>
        </div>
        <div className="set-col">
          <h2 className="set-head">앱</h2>
          <div className="set-card">
            {notify !== "none" && (
              <SetRow name="Windows 알림" off={blocked}
                tip={window.robincodeShell ? "막혀 있어요. Windows 설정 > 알림에서 RobinCode를 켜 주세요." : "막혀 있어요. 창의 사이트 설정에서 알림을 허용해 주세요."}>
                <button type="button" className={`toggle${notify === "on" ? " on" : ""}`} aria-pressed={notify === "on"} aria-label="Windows 알림" disabled={blocked} onClick={onNotify}
                  title={blocked ? undefined : "다른 창을 보고 있을 때 허락이 필요하거나 끝나면 Windows 알림으로 알려요."}>
                  <span className="switch" aria-hidden="true" />
                </button>
              </SetRow>
            )}
            <SubRow name="판" val={!!v?.version} onClick={() => onPanel("version")} title="판과 바뀐 것, 새 판 (/version)"
              value={v?.version ? <>{verLabel(v.version).when}{us?.tone === "new" && <> <Tag tag="[NEW]" /></>}</> : "확인 중"} />
          </div>
          <h2 className="set-head">규칙과 지시</h2>
          <div className="set-card">
            <SubRow name="늘 허용한 것" onClick={() => onPanel("rules")} title="&quot;늘 허용&quot;한 명령과 사이트를 보고 지워요 (/permissions)" />
            <SubRow name="지시 파일" off={chat} tip={noFolder} onClick={() => onPanel("memory")} title="모델이 읽는 지시 파일 (/memory)" />
            <SubRow name="명령과 단축키" onClick={() => onPanel("help")} title="/help" />
          </div>
        </div>
      </div>
    </section>
  );
}

function VersionPanel({ version: v, shellU: u, running, onClose, onError }) {
  const shell = window.robincodeShell;
  const [sure, setSure] = useState(false);
  const now = useNow(30000);
  // looked at: what is new now is not new the next time (the marks stay here)
  useEffect(() => { if (v?.fresh?.length) api("/api/version", { seen: true }).catch(() => {}); }, [v?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v?.version) {
    return <Sheet label="RobinCode 판" onClose={onClose}><p className="chg-note">판을 아직 몰라요. 잠시 뒤에 다시 열어 주세요.</p></Sheet>;
  }
  const s = updateStatus(v, u, now);
  const l = verLabel(v.version);
  const busy = s.kind === "checking" || s.kind === "downloading";
  const canCheck = u ? !!shell?.checkUpdate : !!v.canCheck;
  const check = () => (u ? shell.checkUpdate() : api("/api/version", { check: true })).catch(onError);
  // a start again ends what runs: asked once more when something does
  const going = running.length;
  const relaunch = () => {
    if (going && !sure) { setSure(true); return; }
    shell.relaunch();
  };
  const fresh = new Set(v.fresh || []);
  // the foot: "다시 확인" an outline button, "그만두기" as words, the start again filled (red when it stops a turn)
  const foot = (canCheck || (s.relaunch && shell?.relaunch)) && (
    <>
      {sure && <p className="ver-sure">도는 대화 {going}개가 멈춰요. 쓰는 중인 답은 남지 않을 수 있어요.</p>}
      {canCheck && !sure && <button type="button" className="btn" disabled={busy} onClick={check}>{busy ? "보는 중…" : "다시 확인"}</button>}
      {sure && <button type="button" className="btn btn-text" onClick={() => setSure(false)}>그만두기</button>}
      {s.relaunch && shell?.relaunch && (
        <button type="button" className={`btn ${sure ? "btn-danger" : "btn-primary"}`} autoFocus={sure} onClick={relaunch}>{sure ? "멈추고 다시 켜기" : "다시 켜기"}</button>
      )}
    </>
  );
  return (
    <Sheet label="RobinCode 판" foot={foot} onClose={onClose}>
      <div className="ver-now">
        <p className="ver-big">{l.when}</p>
        <p className="ver-sub">
          {l.hash && <span className="mono">{l.hash}</span>}
          <span>{v.mode === "installed" ? "설치판" : "저장소"}</span>
          {v.at && <span>{ago(new Date(v.at).getTime(), now)} 만든 판</span>}
        </p>
      </div>
      <div className={`ver-state${s.tone ? ` ${s.tone}` : ""}`} role="status">
        <span className="ver-mark"><Tag tag={s.mark} /></span>
        <div>
          <p className="ver-state-text">{s.text}{busy && <span className="cursor" aria-hidden="true" />}</p>
          {s.detail && <p className="ver-detail">{s.detail}</p>}
          {s.kind === "shell" && <p className="ver-detail"><a href="https://ai.yoonrobin.xyz/" target="_blank" rel="noreferrer">ai.yoonrobin.xyz에서 받기</a></p>}
        </div>
      </div>
      {s.relaunch && !shell?.relaunch && <p className="ver-detail">RobinCode를 닫았다가 다시 켜면 바뀌어요.</p>}
      {v.pending?.notes?.length > 0 && (
        <section className="ver-sec">
          <p className="side-label">받을 것</p>
          <ol className="ver-notes">
            {v.pending.notes.map((n, i) => (
              <li key={n.commit} style={{ "--i": i }}><span className="ver-date">{shortDate(n.at)}</span><span className="ver-subj">{n.subject}</span></li>
            ))}
          </ol>
        </section>
      )}
      {v.notes?.length > 0 && (
        <section className="ver-sec">
          <p className="side-label">{fresh.size ? `바뀐 것 · 새로 ${fresh.size}개` : "바뀐 것"}</p>
          <ol className="ver-notes">
            {v.notes.map((n, i) => (
              <li key={n.commit} className={fresh.has(n.commit) ? "fresh" : undefined} style={{ "--i": i }}>
                <span className="ver-date">{shortDate(n.at)}</span>
                <span className="ver-subj">{fresh.has(n.commit) && <span className="ver-new"><Tag tag="[NEW]" /></span>}{n.subject}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </Sheet>
  );
}

// a sheet or the GPU window over the conversation: the focus goes in, Tab
// goes round inside it (it went on to the hidden page behind), Esc closes it
// (it must not stop the agent), and the focus comes back to where it was
// (2026-11-19 codex, web-design-guidelines, impeccable: B-433)
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
function useModal(panel, onClose) {
  useEffect(() => {
    const before = document.activeElement;
    panel.current?.focus();
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const all = [...panel.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!all.length) { e.preventDefault(); return; }
      const first = all[0];
      const last = all[all.length - 1];
      const at = document.activeElement;
      if (!panel.current.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (at === first || at === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (before && before.isConnected && typeof before.focus === "function") before.focus();
    };
  }, [panel, onClose]);
}

function Toast({ toast, onDone, onHold }) {
  // the mouse over it or the focus in it: it goes only when neither is (codex 2026-11-19)
  const held = useRef({ pointer: false, focus: false });
  const hold = (why, on) => { held.current[why] = on; onHold(held.current.pointer || held.current.focus); };
  // the icon's colour says how it went, read off the words
  const kind = /못했|실패|오류|안 돼|없어요|끊겼/.test(toast.text) ? "err" : /했어요|됐어요|지웠어요|옮겼어요|바꿨어요/.test(toast.text) ? "ok" : "info";
  return (
    <div className={`toast${toast.leaving ? " leaving" : ""}`} data-kind={kind} role="status" onPointerEnter={() => hold("pointer", true)} onPointerLeave={() => hold("pointer", false)}
      onFocus={() => hold("focus", true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) hold("focus", false); }}>
      <span className="toast-ico"><Icon name={kind === "err" ? "alert" : kind === "ok" ? "check" : "ask"} /></span>
      <span>{toast.text}</span>
      {toast.actions.map((a) => (
        <button key={a.label} type="button" className="toast-btn" onClick={() => { onDone(); a.run(); }}>{a.label}</button>
      ))}
      <button type="button" className="toast-x" aria-label="닫기" onClick={onDone}><Icon name="close" /></button>
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
  destroy: ["끄는 중…", "껐어요. GPU를 지워서 이제 요금이 안 나가요.", "끄지 못했어요"],
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
      {stuck && <p className="gpu-note">아래 "끄고 지우기"를 누르면 요금이 멈춰요.</p>}
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
  useModal(panel, onClose);
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
  // the step it is at: what the second press will do (said in the body) and
  // its buttons (in the foot: "취소" as words, the main one filled, red when it deletes)
  let confirm = null;
  let foot = null;
  if (canCancel) {
    if (sure === "cancel") {
      confirm = <p>빌리던 GPU를 지워요. 지금까지 쓴 몇 분 요금만 나가고, 이제부터는 안 나가요.</p>;
      foot = (
        <>
          <button type="button" className="btn btn-text" onClick={() => setSure(null)}>계속 빌리기</button>
          <button type="button" className="btn btn-danger" autoFocus onClick={() => run("destroy")}>취소하고 지우기</button>
        </>
      );
    } else foot = <button type="button" className="btn" onClick={() => setSure("cancel")}>취소하고 지우기…</button>;
  } else if (!running && state === "off" && chosen) {
    if (sure === "rent") {
      confirm = <p>빌리면 시간당 <b>${chosen.hour}</b>가 크레딧에서 계속 나가요. 이미지와 모델을 받는 데 약 {chosen.mins + 3}분 걸려요. 다 쓰면 끄세요{gpu.idleLimit ? <>. 깜빡해도 {gpu.idleLimit}분 동안 아무도 안 쓰면 서버가 알아서 지워요.</> : "."}</p>;
      foot = (
        <>
          <button type="button" className="btn btn-text" autoFocus onClick={() => setSure(null)}>취소</button>
          <button type="button" className="btn btn-primary" onClick={() => run("rent", chosen.offer)}>빌리기 · 시간당 ${chosen.hour}</button>
        </>
      );
    } else foot = <button type="button" className="btn btn-primary" onClick={() => setSure("rent")}>이 자리 빌리기…</button>;
  } else if (!running && rented) {
    if (sure === "destroy") {
      confirm = <p>끄면 GPU 인스턴스를 지워요. 요금이 0이 되고 받아 둔 모델도 지워져요. RobinAI 채팅과 다른 RobinCode 창도 같이 멈춰요. 다음에 켜면 새로 빌려서 6~10분 걸려요.</p>;
      foot = (
        <>
          <button type="button" className="btn btn-text" autoFocus onClick={() => setSure(null)}>취소</button>
          <button type="button" className="btn btn-danger" onClick={() => run("destroy")}>끄고 지우기</button>
        </>
      );
    } else if (sure === "start") {
      confirm = <p>다시 켜면 그 GPU의 시간당 요금이 크레딧에서 다시 나가요. 받아 둔 모델이 있어서 몇 분이면 돼요. 다 쓰면 꺼 주세요.</p>;
      foot = (
        <>
          <button type="button" className="btn btn-text" autoFocus onClick={() => setSure(null)}>취소</button>
          <button type="button" className="btn btn-primary" onClick={() => run("start")}>다시 켜기</button>
        </>
      );
    } else {
      foot = (
        <>
          {state === "stopped" && <button type="button" className="btn" onClick={() => setSure("start")}>다시 켜기…</button>}
          <button type="button" className="btn" onClick={() => setSure("destroy")}>끄고 지우기…</button>
        </>
      );
    }
  }
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="gpu-panel" role="dialog" aria-modal="true" aria-label="GPU 켜기·끄기" ref={panel} tabIndex={-1}>
        <DialogHead label="RobinAI GPU" note="Vast.ai RTX 5090" onClose={onClose} />
        <div className="dlg-body">
          <div className="gpu-now">
            <span className={`chip-state${chipTone(state, lampOf(state))}`}><span className={`lamp ${lampOf(state)}`} aria-hidden="true" />{GPU_NAMES[state] || state}</span>
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
              <p className="gpu-note">서버에서 계속하고 있어요.</p>
            </div>
          )}

          {!running && state === "off" && (
            <>
              <div className="gpu-sec-head">
                <p className="side-label">빌릴 수 있는 자리 <span className="gpu-faint">한국 먼저, 싼 순</span></p>
                <button type="button" className="mini-btn" onClick={load} disabled={loading}>{loading ? "받는 중…" : "다시 받기"}</button>
              </div>
              {offers === null && loading && <p className="gpu-note">자리 목록을 받는 중<span className="cursor" aria-hidden="true" /></p>}
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
              {chosen && sure !== "rent" && low && <p className="gpu-warn">크레딧이 한 시간 요금보다 적어요. Vast.ai에서 먼저 충전해 주세요.</p>}
            </>
          )}

          {confirm && <div className="gpu-confirm">{confirm}</div>}

          {!running && (state === "unreachable" || state === "unknown") && (
            <p className="gpu-note">{state === "unknown" ? "GPU 상태를 확인하는 중이에요." : "서버에서 GPU 상태를 읽지 못했어요(ssh contabo). 잠시 뒤 다시 열어 보세요."}</p>
          )}
          {err && <p className="gpu-warn" role="alert">{err}</p>}
        </div>
        {foot && <footer className="dlg-foot">{foot}</footer>}
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

// ---- pinned conversations: their files, the 20 most recent pins
const PINS_KEY = "robincode-pins";
function loadPins() {
  try {
    const all = JSON.parse(localStorage.getItem(PINS_KEY) || "[]");
    return Array.isArray(all) ? all.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}
function keepPins(list) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(list)); } catch { /* storage off or full */ }
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

// ---- /memory and /help: a sheet over the conversation, as a dialog
// (docs/brand.md 부품 더): a head (the title, "· name" in blue when it is about
// a named thing, a note under it, the x), a body that scrolls, a foot for its
// buttons when it has any
function DialogHead({ label, name, note, onClose }) {
  return (
    <header className="dlg-head">
      <div className="dlg-titles">
        <p className="dlg-title" title={name ? `${label} · ${name}` : undefined}>{label}{name && <> · <span className="dlg-name">{name}</span></>}</p>
        {note && <p className="dlg-note">{note}</p>}
      </div>
      <button type="button" className="icon-btn dlg-x" aria-label="닫기" onClick={onClose}><Icon name="close" /></button>
    </header>
  );
}
function Sheet({ label, name, wide, foot, onClose, children }) {
  const panel = useRef(null);
  useModal(panel, onClose);
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`sheet${wide ? " sheet-wide" : ""}`} role="dialog" aria-modal="true" aria-label={label} ref={panel} tabIndex={-1}>
        <DialogHead label={label} name={name} onClose={onClose} />
        <div className="dlg-body">{children}</div>
        {foot && <footer className="dlg-foot">{foot}</footer>}
      </section>
    </div>
  );
}
// ---- /changes: what this conversation changed, file by file, each can be put back
const STATE_WORD = { added: "새 파일", deleted: "지워짐", big: "너무 커서 못 보여요" };
function FileDiff({ before, now }) {
  const d = useMemo(() => fileHunks(before, now), [before, now]);
  if (!d.hunks.length) return <p className="chg-none">바뀐 줄이 없어요.</p>;
  return (
    <div className="chg-diff" role="table">
      {d.hunks.map((h, k) => (
        <div key={k} className="chg-hunk">
          <div className="chg-at" role="row"><span>@@ {h.oldStart ?? 0} → {h.newStart ?? 0}</span></div>
          {h.rows.map(([sign, text, a, b], i) => (
            <div key={i} className={`chg-row ${sign === "+" ? "add" : sign === "-" ? "del" : "same"}`} role="row">
              <span className="chg-no">{a ?? ""}</span><span className="chg-no">{b ?? ""}</span>
              <span className="chg-sign" aria-hidden="true">{sign}</span><span className="chg-text">{text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
function ChangeFile({ f, busy, open, onToggle, onRevert, onPut }) {
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!sure) return undefined; const t = setTimeout(() => setSure(false), 4000); return () => clearTimeout(t); }, [sure]);
  const stat = useMemo(() => (f.state === "big" ? null : fileHunks(f.before, f.now)), [f]);
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
  return (
    <li className={`chg-file${f.reverted ? " reverted" : ""}`}>
      <div className="chg-head">
        <button type="button" className="chg-toggle" aria-expanded={open} onClick={onToggle} disabled={f.state === "big" || f.reverted}>
          <Icon name={open ? "chevdown" : "right"} />
          <span className="chg-path mono"><span className="chg-dir">{dir}</span>{f.path.slice(dir.length)}</span>
          {STATE_WORD[f.state] && <span className="chg-badge">{STATE_WORD[f.state]}</span>}
          {stat && !f.reverted && <span className="step-delta"><span className="add">+{stat.add}</span>{stat.del > 0 && <span className="del">−{stat.del}</span>}</span>}
        </button>
        {f.reverted ? (
          <span className="chg-done">되돌렸어요{f.undo !== undefined && f.undo !== null && <button type="button" className="mini-btn" disabled={busy} onClick={onPut}>다시 살리기</button>}</span>
        ) : f.undo ? (
          <button type="button" className={`mini-btn${sure ? " sure" : ""}`} disabled={busy} title={busy ? "도는 동안에는 되돌리지 않아요" : "이 대화가 고치기 전으로"}
            onClick={() => { if (sure) { setSure(false); onRevert(); } else setSure(true); }}>
            {sure ? (f.state === "added" ? "정말 지울까요?" : "정말 되돌릴까요?") : "되돌리기"}
          </button>
        ) : null}
      </div>
      {open && !f.reverted && f.state !== "big" && <FileDiff before={f.before} now={f.now} />}
    </li>
  );
}
function ChangesPanel({ busy, conv, name, onClose, onError }) {
  const [files, setFiles] = useState(null);
  const [others, setOthers] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => {
    api("/api/changes").then((r) => {
      setOthers(r.others || null);
      setFiles(r.files);
      // a few: all open; many: the first only
      setOpen(new Set((r.files.length <= 3 ? r.files : r.files.slice(0, 1)).map((f) => f.path)));
    }).catch((e) => { onError(`읽지 못했어요: ${e.message}`); setFiles([]); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const swap = (path, change) => setFiles((all) => all.map((f) => (f.path === path ? { ...f, ...change } : f)));
  const revert = (f) => api("/api/changes", { revert: f.path, conv })
    .then((r) => swap(f.path, { reverted: true, undo: r.undo }))
    .catch((e) => onError(`되돌리지 못했어요: ${e.message}`));
  const put = (f) => api("/api/changes", { put: f.path, hash: f.undo, conv })
    .then((r) => swap(f.path, { ...r.file, reverted: false }))
    .catch((e) => onError(`다시 살리지 못했어요: ${e.message}`));
  const total = useMemo(() => (files || []).reduce((t, f) => {
    if (f.state === "big" || f.reverted) return t;
    const d = fileHunks(f.before, f.now);
    return { add: t.add + d.add, del: t.del + d.del };
  }, { add: 0, del: 0 }), [files]);
  const toggle = (path) => setOpen((o) => { const n = new Set(o); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  return (
    <Sheet label="이 대화가 바꾼 파일" name={name} wide onClose={onClose}>
      {files === null ? <p className="chg-note">읽는 중…</p> : files.length === 0 ? (
        <p className="chg-note">이 대화는 아직 edit·write로 파일을 바꾸지 않았어요.</p>
      ) : (
        <>
          <p className="chg-note">
            파일 {files.length}개 · <span className="chg-add">+{total.add}</span>{total.del > 0 && <> <span className="chg-del">−{total.del}</span></>}
            <span className="chg-hint"> — 이 대화가 고치기 전과 지금 파일을 견줘요. 되돌리기는 그 파일 하나만 고치기 전으로 돌려요.</span>
          </p>
          <ul className="chg-files">
            {files.map((f) => (
              <ChangeFile key={f.path} f={f} busy={busy} open={open.has(f.path)} onToggle={() => toggle(f.path)}
                onRevert={() => revert(f)} onPut={() => put(f)} />
            ))}
          </ul>
        </>
      )}
      {others?.length > 0 && (
        <div className="chg-others">
          <p className="chg-note">그 밖에 git이 바뀌었다고 보는 파일 {others.length}개 <span className="chg-hint">— 명령이나 다른 프로그램이 바꾼 것일 수 있어요. 여기서는 되돌리지 않아요(git으로).</span></p>
          <ul>{others.map((o) => <li key={o.name}><span className="chg-how">{o.how}</span> <span className="mono">{o.name}</span></li>)}</ul>
        </div>
      )}
    </Sheet>
  );
}

function MemoryPanel({ name, onClose, onError }) {
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
    <Sheet label="모델이 읽는 지시 파일" name={name} onClose={onClose}>
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
function RulesPanel({ name, onClose, onError }) {
  const [rules, setRules] = useState(null);
  const load = (body) => api("/api/rules", body).then((r) => setRules(r.rules)).catch((e) => onError(`읽지 못했어요: ${e.message}`));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet label="늘 허용한 것" name={name} onClose={onClose}>
      <p className="gpu-note">물을 때 "늘 허용"(4)을 누른 것은 이 폴더에서 다시 묻지 않아요. 명령은 시작이 같거나(… 붙은 것) 똑같을 때만 그래요. 이어 붙이거나(<span className="mono">; && |</span>) 넘기거나(<span className="mono">&gt;</span>) 괄호·<span className="mono">$</span>·줄 바꿈이 들어가면 다시 물어요. node·python·powershell처럼 무엇이든 돌릴 수 있는 명령은 늘 허용할 수 없어요.</p>
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
  ["Enter", "보내기 (도는 중이면 다음 단계 전에 전해요)"],
  ["Ctrl+Enter", "도는 중에: 다 끝나면 보내요"],
  ["Shift+Enter", "줄 바꿈"],
  ["↑ (빈 칸)", "기다리는 말을 꺼내 고쳐요. 없으면 보낸 말을 차례로 불러와요"],
  ["Esc", "멈추기"],
  ["Shift+Tab", "모드 바꾸기: 묻고 실행 → 수정은 바로 → 바로 실행 → 계획만"],
  ["Ctrl+F", "대화에서 찾기"],
  ["Ctrl+K", "지난 대화 찾기"],
  ["1 2 3 4", "물을 때: 하기 · 이번 대화는 모두 허용 · 안 돼요 · 늘 허용"],
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
  // words that did not go out, back in the box of the conversation they were
  // typed in — not the one on screen by then (2026-11-19 codex)
  const here = useRef({ key: "new", file: null });
  here.current = { key: convKey, file: state.sessionFile || null };
  const giveBackTo = useCallback((key, t) => {
    if (!t) return;
    if (draftKey.current === key) { setDraft((d) => (d.trim() ? `${t}\n${d}` : t)); return; }
    const had = drafts.current[key]?.text || "";
    keepDraft(drafts.current, key, had.trim() ? `${t}\n${had}` : t);
  }, []);
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
  const [panel, setPanel] = useState(null); // "settings" | "memory" | "help" | "rules" | "changes" | "version" | null
  const backTo = useRef(null); // a sheet opened from the settings goes back to them
  // another conversation (opened, new) is on screen: the settings give way to it
  useEffect(() => { setPanel((p) => (p === "settings" ? null : p)); }, [convKey]);
  // another conversation opened (Ctrl+K works over a panel): its files are not
  // the ones on the changes panel, so a revert there was the other's file
  useEffect(() => { setPanel((p) => (p === "changes" ? null : p)); }, [state.sessionFile]);
  // files this conversation's edits and writes changed (the review sheet has the truth)
  const changed = useMemo(() => {
    const paths = new Set();
    for (const it of state.items) if (it.kind === "tools") for (const t of it.tools) if ((t.name === "edit" || t.name === "write") && t.status === "ok" && t.args?.path) paths.add(String(t.args.path).replace(/\\/g, "/").replace(/^\.\//, ""));
    return paths.size;
  }, [state.items]);
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

  // a note goes: a short fall and fade first (it vanished at once), unless a
  // new one came meanwhile
  const leaveTimer = useRef(0);
  const dropToast = useCallback(() => {
    clearTimeout(toastTimer.current);
    setToast((t) => (t && !t.leaving ? { ...t, leaving: true } : t));
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setToast((t) => (t?.leaving ? null : t)), 140);
  }, []);
  // a note above the composer, with up to two buttons (one action, or a list)
  const say = useCallback((text, action) => {
    const actions = [].concat(action || []).filter(Boolean);
    clearTimeout(toastTimer.current);
    const ms = actions.length > 1 ? 9000 : actions.length ? 6000 : 2600;
    toastLife.current = ms;
    setToast({ id: Date.now(), text, actions });
    toastTimer.current = setTimeout(dropToast, ms);
  }, []);
  // pointed at or focused, a note stays (robin reading it, or reaching for
  // its button with Tab); let go, it goes after its time again
  const toastLife = useRef(0);
  const holdToast = useCallback((on) => {
    clearTimeout(toastTimer.current);
    if (!on) toastTimer.current = setTimeout(dropToast, Math.max(2600, toastLife.current));
  }, []);
  const fail = useCallback((e) => say(e.message === "busy" ? "도는 중이라 지금은 못 해요. 끝나거나 멈춘 뒤에 해 주세요." : `하지 못했어요: ${e.message}`,
    e.gpuOff ? { label: "GPU 켜기…", run: () => setGpuOpen(true) } : undefined), [say]);
  // the version: once a window after an update ("새 판으로 바뀌었어요", and it
  // is not new the next time), and once for each newer one that is ready
  const shellU = useShellUpdate();
  const toldFresh = useRef(false);
  useEffect(() => {
    const v = state.version;
    if (toldFresh.current || !v?.fresh?.length) return;
    toldFresh.current = true;
    api("/api/version", { seen: true }).catch(() => {});
    say(`새 판으로 바뀌었어요 · ${verLabel(v.version).when}`, { label: "바뀐 것 보기", run: () => setPanel("version") });
  }, [state.version, say]);
  const toldNew = useRef("");
  useEffect(() => {
    const s = updateStatus(state.version, shellU);
    const next = s.kind === "ready" ? shellU.ready : s.kind === "pending" ? state.version.pending.version : "";
    if (!next || toldNew.current === next) return;
    toldNew.current = next;
    say(s.kind === "ready" ? "새 판을 받아 뒀어요. 다시 켜면 바뀌어요." : `새 판이 GitHub에 있어요 (바뀐 것 ${state.version.pending.count}개).`,
      { label: "판 보기", run: () => setPanel("version") });
  }, [state.version, shellU, say]);
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
    const name = state.title ? `${state.title} · RobinCode` : `RobinCode · ${state.info.chat ? "일반 대화" : state.info.folder}`;
    document.title = waiting ? `허락을 기다려요 · ${name}` : state.busy ? `도는 중 · ${name}` : name;
  }, [state.title, state.info.folder, state.info.chat, state.busy, waiting]);
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
  const busyNow = useRef(false);
  busyNow.current = state.busy;
  // what is on its way, shown in its conversation until the server takes it
  const [outbox, setOutbox] = useState([]);
  const outboxHere = useMemo(() => outbox.filter((o) => o.key === convKey), [outbox, convKey]);
  // the server took it (its line is in the thread): not shown twice
  const lastUser = state.items.findLast((x) => x.kind === "user")?.text;
  useEffect(() => { if (lastUser) setOutbox((list) => (list.some((o) => o.text === lastUser) ? list.filter((o) => o.text !== lastUser) : list)); }, [lastUser]);
  const send = useCallback((text, pictures = [], when = "now") => {
    const t = text.trim();
    if ((!t && !pictures.length) || (inFlight.current && inFlight.current.text === t && !pictures.length)) return Promise.resolve(false);
    setDraft("");
    if (t) keepSent(t);
    const before = inFlight.current?.done;
    // the conversation it was typed in: the server puts it there even if
    // another is open by the time it goes (a second message waits for the first)
    const from = here.current;
    const stopsThen = stops.current;
    const mine = { id: `o${Date.now()}${Math.random()}`, key: from.key, text: t || "(그림)" };
    // while a turn runs it goes into the queue (shown there), not here
    if (!busyNow.current) setOutbox((list) => [...list, mine]);
    const done = (async () => {
      if (before) await before;
      if (before && stops.current !== stopsThen) {
        // the words here, the pictures by the box (a false answer)
        giveBackTo(from.key, t);
        say("멈춰서 보내지 않았어요. 쓴 말은 입력 칸에 다시 넣어 뒀어요.");
        return false;
      }
      sending.current = true;
      try {
        await api("/api/prompt", { text: t, when, conv: from.file, images: pictures.map(({ mimeType, data }) => ({ mimeType, data })) });
        return true;
      } catch (e) {
        if (e.moved) say("그 대화가 닫혀서 보내지 않았어요. 쓴 말은 그 대화의 입력 칸에 남겨 뒀어요.");
        else if (e.stopped) say("멈춰서 보내지 않았어요. 쓴 말은 입력 칸에 다시 넣어 뒀어요.");
        else dispatch({ type: "local-error", message: `보내지 못했어요: ${e.message}`, gpu: e.gpuOff });
        giveBackTo(from.key, t);
        return false;
      } finally {
        sending.current = false;
      }
    })();
    const me = { text: t, done };
    inFlight.current = me;
    done.finally(() => {
      if (inFlight.current === me) inFlight.current = null;
      // the server's "user" line comes with the answer to this request
      setTimeout(() => setOutbox((list) => list.filter((o) => o !== mine)), 120);
    });
    return done;
  }, []);
  // a stop also holds back what is still on its way in the window (it waits
  // for the message before it): it comes back to its box
  const stops = useRef(0);
  const stop = useCallback(() => { stops.current += 1; api("/api/abort").catch(() => {}); }, []);
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
  const decide = useCallback((id, decision, note) => {
    const tool = askingRef.current;
    // "늘 허용" for a call that has no rule (a chained command, an interpreter): nothing to answer
    if (decision === "rule" && !(tool?.id === id && tool.rule)) return;
    // a risky one has no "모두 허용" (the key 2 does nothing there)
    if (decision === "always" && tool?.id === id && tool.risk) return;
    dispatch({ type: "decided", id, decision, rule: tool?.id === id ? tool.rule : null });
    api("/api/approve", { id, decision, ...(note?.trim() ? { note: note.trim() } : {}) }).catch((e) => dispatch({ type: "undecided", id, message: e.message }));
    focusBox();
  }, []);
  const once = (call) => {
    if (opening.current) return;
    opening.current = true;
    call().then(() => { closeSide(false); focusBox(); }).catch(fail).finally(() => { opening.current = false; });
  };
  const newChat = () => once(() => api("/api/new"));
  // the empty conversation's place: a plain conversation or a folder (what was typed stays)
  const place = (where) => new Promise((done) => {
    if (opening.current) { done(); return; }
    opening.current = true;
    api("/api/new", { place: where }).then(() => focusBox()).catch(fail).finally(() => { opening.current = false; done(); });
  });
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
        say(ran ? "이 말 앞으로 돌아왔어요. 명령이 한 일은 그대로예요." : "이 말 앞으로 돌아왔어요. 고쳐서 보내 주세요.", undo);
        return;
      }
      // undoing both: the conversation back where it was, then its files
      const undoBoth = {
        label: "되돌리기",
        run: () => back().then(() => api("/api/files-sync")).then((u) => say(syncWords(u, "원래대로 돌렸어요"))).catch(fail),
      };
      const putBack = () => api("/api/files-sync").then((s) => say(`${syncWords(s, "되돌렸어요")}${commands}`, s.done.length ? undoBoth : undo)).catch(fail);
      say(`이 말 앞으로 돌아왔어요. 그 뒤에 바꾼 ${filesWord(r.files)}는 그대로예요.`, [{ label: "파일도 되돌리기", run: putBack }, undo]);
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
  const chatNow = useRef(false);
  chatNow.current = !!state.info.chat;
  const cycleMode = useStable(() => { if (!chatNow.current) setMode(nextMode(modeNow.current || "ask")); });
  // the `/` commands the window does itself (commands.js)
  const runCommand = (name, arg) => {
    focusBox();
    if (name === "new" || name === "clear") { newChat(); return; }
    if (chatNow.current && FOLDER_ONLY.has(name)) { say(`/${name} 명령은 폴더가 있는 대화에서 써요. 새 대화에서 폴더를 골라 주세요.`); return; }
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
    if (name === "changes" || name === "diff") { setPanel("changes"); return; }
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
    if (name === "version") setPanel("version");
  };
  // robin's own `!명령` (true once it started)
  const shell = (command, raw) => {
    keepSent(raw);
    setDraft("");
    const from = here.current;
    return api("/api/shell", { command, conv: from.file }).then(() => true).catch((e) => {
      giveBackTo(from.key, raw);
      if (e.moved) say("그 대화가 닫혀서 실행하지 않았어요. 명령은 그 대화의 입력 칸에 남겨 뒀어요."); else fail(e);
      return false;
    });
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
  // the parts the list uses: a new state every token drew the whole list (all
  // its rows) again while an answer came (2026-11-19 web-design-guidelines)
  const sideState = useMemo(() => ({
    fake: state.fake, git: state.git, gpu: state.gpu, gpuFake: state.gpuFake, gpuJob: state.gpuJob,
    info: state.info, running: state.running, sessionFile: state.sessionFile, sessions: state.sessions, version: state.version,
  }), [state.fake, state.git, state.gpu, state.gpuFake, state.gpuJob, state.info, state.running, state.sessionFile, state.sessions, state.version]);

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
  // when robin last typed in the message box (a digit right after is not an answer)
  const typedAt = useRef(0);
  useEffect(() => {
    const onInput = (e) => { if (e.target === box.current) typedAt.current = Date.now(); };
    document.addEventListener("input", onInput, true);
    return () => document.removeEventListener("input", onInput, true);
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing) return;
      // a sheet or the GPU window is open: its keys are its own
      if (document.querySelector("[aria-modal='true']")) return;
      // Ctrl+K: find a past conversation (the drawer opens on a narrow window)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isNarrow()) setSide(true);
        requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); });
        return;
      }
      // Ctrl+N: a new conversation in the same place (RobinCode.exe has no menu to take it)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newChat();
        return;
      }
      // Ctrl+F: words in this conversation
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setPanel((p) => (p === "settings" ? null : p));
        setFinding(true);
        requestAnimationFrame(() => { const el = document.querySelector(".find-bar input"); el?.focus(); el?.select(); });
        return;
      }
      // Shift+Tab in the message box (or nowhere): the next mode, as in Claude Code
      if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
        && (e.target === box.current || e.target === document.body) && !panel && !gpuOpen && !chatNow.current) {
        e.preventDefault();
        cycleMode();
        return;
      }
      if (e.key === "Escape") {
        if (side && isNarrow()) { e.preventDefault(); closeSide(true); }
        else if (state.busy || shellRunning || state.queued.some((q) => q.slot)) { e.preventDefault(); stop(); }
        return;
      }
      // 1 / 2 / 3 answer the question on screen, unless something is being
      // typed (anything in the message box, or any other field at all)
      const answer = ANSWER_KEYS[e.key];
      if (!asking || !answer || e.ctrlKey || e.altKey || e.metaKey) return;
      // a key held down repeats: its repeats do not answer the next question
      // that comes up before robin has read it
      if (e.repeat) { e.preventDefault(); return; }
      // a sheet over the conversation (its buttons have the focus) is not the card
      if (document.querySelector("[aria-modal='true']")) return;
      const field = e.target.closest?.("textarea, input");
      if (field && (field !== box.current || field.value)) return;
      // robin was typing a moment ago (the box just emptied by a send or a
      // cut): the digit is part of that, not an answer
      if (field === box.current && Date.now() - typedAt.current < 1000) return;
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
    ping("GPU가 곧 꺼져요", `${state.gpu.idle}분째 안 써서 약 ${soon}분 뒤 서버가 꺼요. 계속 쓰려면 RobinCode에서 "계속 켜 두기"를 눌러 주세요.`);
  }, [soon, notify]); // eslint-disable-line react-hooks/exhaustive-deps

  // for the memo'd conversation and list: the same functions while robin types
  const on = {
    unqueue: useStable(unqueue),
    unqueueLast: useStable(() => { const last = state.queued.at(-1); if (last) unqueue(last.id); }),
    planGo: useStable(planGo),
    command: useStable(runCommand),
    shell: useStable(shell),
    say: useStable(say),
    closePanel: useStable(() => { const back = backTo.current; backTo.current = null; setPanel(back); if (!back) focusBox(); }),
    settings: useStable(() => { closeSide(false); setPanel((p) => (p === "settings" ? null : "settings")); }),
    closeSettings: useStable(() => { setPanel(null); focusBox(); }),
    sheet: useStable((name) => { backTo.current = "settings"; setPanel(name); }),
    mode: useStable((m) => setMode(m)),
    think: useStable(() => api("/api/thinking", { on: !state.thinking }).catch(fail)),
    find: useStable(() => { setFinding(true); requestAnimationFrame(() => { const el = document.querySelector(".find-bar input"); el?.focus(); el?.select(); }); }),
    closeFind: useStable(() => { setFinding(false); focusBox(); }),
    pick: useStable((s) => send(s)),
    rewind: useStable(rewind),
    retry: useStable(retry),
    branch: useStable(branchTo),
    gpu: useStable(() => setGpuOpen(true)),
    notify: useStable(toggleNotify),
    close: useStable(() => closeSide(true)),
    new: useStable(() => { setPanel((x) => (x === "settings" ? null : x)); newChat(); }),
    place: useStable(place),
    open: useStable((path) => { setPanel((x) => (x === "settings" ? null : x)); return open(path); }),
    remove: useStable(remove),
    rename: useStable(rename),
    leaveSearch: useStable(() => { if (isNarrow()) closeSide(true); else focusBox(); }),
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
  // the settings page, also under a sheet opened from it
  const settingsOn = panel === "settings" || (!!panel && backTo.current === "settings");
  // the folder a sheet is about (its head says "· name"); a plain conversation has none
  const folderName = state.info.chat ? undefined : state.info.folder || undefined;
  return (
    <div className="app" data-side={side ? "open" : undefined}>
      <Sidebar state={sideState} closeRef={closeRef} searchRef={searchRef} onClose={on.close} onNew={on.new} onOpen={on.open}
        onDelete={on.remove} onRename={on.rename} onLeaveSearch={on.leaveSearch} shellU={shellU} settings={settingsOn} onSettings={on.settings} />
      <div className="scrim" onClick={() => closeSide(true)} aria-hidden="true" />
      <main className="main" {...dropProps}>
        {/* the top bar (docs/brand.md 뼈대): 55 + its rule, outline buttons for
            what this conversation has, find at the far end */}
        <header className="main-head">
          <button ref={menuRef} type="button" className="icon-btn menu-btn" aria-label="대화 목록 열기" aria-controls="side"
            aria-expanded={side} onClick={openSide}><Icon name="menu" /></button>
          <h1 className="main-title">{settingsOn ? "설정" : state.title || "새 대화"}</h1>
          {/* where this one works (the list holds every folder's): pressed, the settings */}
          {!settingsOn && (state.info.chat || state.info.folder) && (
            <button type="button" className={`head-btn head-place${state.info.chat ? " chat" : ""}`} onClick={on.settings}
              title={`${state.info.chat ? "일반 대화: 폴더 없이 이야기만 해요" : state.info.cwd}${state.git && !state.info.chat ? `\ngit 브랜치 ${state.git.branch}${state.git.changed ? `, 바뀌었거나 새로 생긴 파일 ${state.git.changed}개` : ", 바뀐 파일 없음"}${state.git.ahead ? `, 올리지 않은 커밋 ${state.git.ahead}개` : ""}${state.git.behind ? `, 받지 않은 커밋 ${state.git.behind}개` : ""}` : ""}\n누르면 설정을 열어요`}>
              <span className="hp-ico"><Icon name={state.info.chat ? "chat" : "folder"} /></span>
              <span className="hp-name">{state.info.chat ? "일반 대화" : state.info.folder}</span>
              {state.git && !state.info.chat && (
                <span className="git-row mono">{state.git.branch}
                  {state.git.changed > 0 && <span className="git-changed"><span className="sr"> · 바뀐 파일</span> ±{state.git.changed}</span>}
                  {state.git.ahead > 0 && <span className="git-ahead"> ↑{state.git.ahead}</span>}
                  {state.git.behind > 0 && <span className="git-ahead"> ↓{state.git.behind}</span>}
                </span>
              )}
            </button>
          )}
          {!settingsOn && changed > 0 && (
            <button type="button" className="head-btn head-changes" onClick={() => setPanel("changes")} title="이 대화가 바꾼 파일 보기·되돌리기 (/changes)" aria-label={`이 대화가 바꾼 파일 ${changed}개 보기`}>
              <Icon name="file" /><span><span className="hc-word">바꾼 파일 </span>{changed}</span>
            </button>
          )}
          <span className="head-gap" />
          <HeadGpu gpu={state.gpu} fake={state.fake} gpuFake={state.gpuFake} job={state.gpuJob} onOpen={() => setGpuOpen(true)} />
          {settingsOn
            ? <button type="button" className="head-btn head-icon" aria-label="설정 닫기" title="설정 닫기 (Esc)" onClick={on.closeSettings}><Icon name="close" /></button>
            : <button type="button" className="head-btn head-icon" aria-label="이 대화에서 찾기" title="이 대화에서 찾기 (Ctrl+F)" onClick={on.find}><Icon name="search" /></button>}
        </header>
        {offline && <div className="lost" role="alert">{lostLong ? "RobinCode 서버와 연결이 끊겼어요. 창을 닫고 다시 열어 주세요." : "RobinCode 서버와 다시 연결하는 중이에요."}</div>}
        {soon != null && (
          <div className="gpu-soon" role="status">
            <span>GPU를 {state.gpu.idle}분째 안 써서 {soon ? `약 ${soon}분 뒤` : "곧"} 서버가 꺼요. 다시 켜려면 6~10분 걸려요.</span>
            <button type="button" className="mini-btn" onClick={keepGpu} disabled={keeping}>{keeping ? "알리는 중…" : "계속 켜 두기"}</button>
          </div>
        )}
        {finding && <FindBar items={state.items} onClose={on.closeFind} />}
        <Conversation state={state} outbox={outboxHere} asking={asking} onDecide={decide} onPick={on.pick} onPlace={on.place} onRewind={on.rewind} onRetry={on.retry} onBranch={on.branch} onGpu={on.gpu}
          onUnqueue={on.unqueue} onPlanGo={on.planGo} />
        <TodoPanel todo={todo} busy={state.busy} />
        <Composer state={state} convKey={convKey} meter={<ContextMeter context={state.context} busy={state.busy} onCompact={compact} />} box={box} draft={draft}
          setDraft={setDraft} pastRef={pastRef} attachRef={attachRef} picturesRef={picturesRef} addPicturesRef={addPicturesRef} commands={commands}
          onSend={send} onStop={stop} onError={say} onCommand={on.command} onShell={on.shell} onMode={cycleMode} onUnqueueLast={on.unqueueLast}
          notice={toast && <Toast key={toast.id} toast={toast} onDone={dropToast} onHold={holdToast} />} />
        {settingsOn && <Settings state={state} notify={notify} shellU={shellU} onNotify={on.notify} onMode={on.mode} onThink={on.think}
          onGpu={() => setGpuOpen(true)} onPanel={on.sheet} onClose={on.closeSettings} />}
        {panel === "memory" && <MemoryPanel name={folderName} onClose={on.closePanel} onError={on.say} />}
        {panel === "help" && <HelpPanel commands={commands} onClose={on.closePanel} />}
        {panel === "rules" && <RulesPanel name={folderName} onClose={on.closePanel} onError={on.say} />}
        {panel === "version" && <VersionPanel version={state.version} shellU={shellU} running={state.running} onClose={on.closePanel} onError={on.say} />}
        {panel === "changes" && <ChangesPanel busy={state.busy} conv={state.sessionFile || null} name={state.title || undefined} onClose={on.closePanel} onError={on.say} />}
        {gpuOpen &&<GpuPanel gpu={state.gpu} job={state.gpuJob} onKeep={keepGpu} keeping={keeping} onClose={() => { setGpuOpen(false); if (panel !== "settings") focusBox(); }} />}
        {drag && (
          <div className="drop" aria-hidden="true">
            <p><Icon name="image" />여기에 놓으면 그림을 붙여요 <span className="drop-note">{PICTURE_TYPES.map((t) => t.slice(6).toUpperCase()).join("·")} · 4장까지</span></p>
          </div>
        )}
      </main>
    </div>
  );
}
