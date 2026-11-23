// The message box: it grows with the text, `@` opens a list of the folder's
// files and folders to point at, and pictures can be pasted, dropped on the
// window or picked (up to 4, sent with the message).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./icons.jsx";
import { BUILTIN, FOLDER_ONLY, ownCommand } from "./commands.js";
import { LAMPS, MODE_NAMES, MODE_TIPS, nextMode } from "./modes.js";

const MAX_PICTURES = 4;
const MAX_SIDE = 1600; // a longer side is scaled down before sending (fewer tokens)
const MAX_DATA = 8e6; // base64, as the server takes it
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// a picture as { mimeType, data (base64), url (for the thumbnail) }
async function readPicture(file) {
  const url = await new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => no(new Error("그림을 읽지 못했어요."));
    r.readAsDataURL(file);
  });
  const img = await new Promise((ok, no) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => no(new Error("그림을 읽지 못했어요."));
    i.src = url;
  });
  let out = url;
  let mimeType = file.type;
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale < 1 && file.type !== "image/gif") {
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    mimeType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    out = c.toDataURL(mimeType, 0.9);
  }
  const data = out.slice(out.indexOf(",") + 1);
  if (data.length > MAX_DATA) throw new Error("그림이 너무 커요(8MB까지).");
  return { id: `${Date.now()}-${Math.random()}`, mimeType, data, url: out };
}

// the @word the caret is in: { start, end, q }
function mentionAt(text, caret) {
  const m = text.slice(0, caret).match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start: caret - m[2].length - 1, end, q: m[2] };
}

// the part of a path that matched, in bold
function Hit({ text, q }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<b>{text.slice(at, at + q.length)}</b>{text.slice(at + q.length)}</>;
}

function Mentions({ list, q, pick, onPick, onHover }) {
  const box = useRef(null);
  useEffect(() => { box.current?.querySelector(".mention.on")?.scrollIntoView({ block: "nearest" }); }, [pick]);
  return (
    <div className="mentions" role="presentation">
      <ul ref={box} id="mention-list" role="listbox" aria-label="이 폴더의 파일">
        {list.length === 0 && <li className="mention-none">맞는 파일이 없어요.</li>}
        {list.map((path, k) => (
          <li key={path} id={`mention-${k}`} role="option" aria-selected={k === pick} className={`mention${k === pick ? " on" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(path); }} onMouseMove={() => onHover(k)}>
            <Icon name={path.endsWith("/") ? "folder" : "file"} />
            <span className="mention-path"><Hit text={path} q={q.replace(/\\/g, "/")} /></span>
          </li>
        ))}
      </ul>
      <p className="mention-keys"><kbd>↑</kbd><kbd>↓</kbd> 고르기 · <kbd>Enter</kbd> 넣기 · <kbd>Esc</kbd> 닫기</p>
    </div>
  );
}

// the `/` list: the window's own commands, then the folder's templates and skills
function Commands({ list, pick, onPick, onHover }) {
  const box = useRef(null);
  useEffect(() => { box.current?.querySelector(".mention.on")?.scrollIntoView({ block: "nearest" }); }, [pick]);
  return (
    <div className="mentions commands" role="presentation">
      <ul ref={box} id="command-list" role="listbox" aria-label="명령">
        {list.length === 0 && <li className="mention-none">맞는 명령이 없어요.</li>}
        {list.map((c, k) => (
          <li key={c.name} id={`command-${k}`} role="option" aria-selected={k === pick} className={`mention cmd${k === pick ? " on" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(c); }} onMouseMove={() => onHover(k)}>
            <span className="cmd-name mono">/{c.name}{c.arg ? <span className="cmd-arg"> {c.arg}</span> : null}</span>
            <span className="cmd-hint">{c.hint}</span>
            {c.kind !== "own" && <span className="cmd-kind">{c.kind === "skill" ? "스킬" : "템플릿"}</span>}
          </li>
        ))}
      </ul>
      <p className="mention-keys"><kbd>↑</kbd><kbd>↓</kbd> 고르기 · <kbd>Enter</kbd> 실행 · <kbd>Tab</kbd> 채우기 · <kbd>Esc</kbd> 닫기</p>
    </div>
  );
}

const toPicture = (im, k) => ({ id: `${Date.now()}-${k}-${Math.random()}`, mimeType: im.mimeType, data: im.data, url: `data:${im.mimeType};base64,${im.data}` });

export function Composer({ state, convKey, meter, notice, box, draft, setDraft, pastRef, attachRef, picturesRef, addPicturesRef, commands,
  onSend, onStop, onError, onCommand, onShell, onMode, onUnqueueLast }) {
  const [pictures, setPictures] = useState([]);
  const [mention, setMention] = useState(null);
  const [files, setFiles] = useState(null);
  // the words those files were found for: Enter right after typing more does
  // not put in a file found for the words before (2026-11-19 codex)
  const [filesQ, setFilesQ] = useState(null);
  const [pick, setPick] = useState(0);
  const dismissed = useRef(-1); // the @ robin closed with Esc stays closed
  const fileInput = useRef(null);

  // grow with the text; measured again when the width changes (the first
  // measure can come before the layout has a width)
  // Typing on (the text only grows) only reads the height: collapsing the box
  // to "auto" at every key made the browser lay the whole window out twice
  const was = useRef("");
  const fit = useCallback((again) => {
    const el = box.current;
    if (!el) return;
    const grew = again !== true && el.value.length >= was.current.length && el.value.startsWith(was.current.slice(0, -1));
    was.current = el.value;
    if (grew && el.scrollHeight <= el.clientHeight) return;
    if (!grew) el.style.height = "auto";
    const px = `${el.scrollHeight}px`;
    if (el.style.height !== px) el.style.height = px;
  }, [box]);
  useLayoutEffect(() => fit(), [draft, fit]);
  useEffect(() => {
    box.current?.focus();
    let width = 0;
    const watch = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - width) > 1) { width = entry.contentRect.width; fit(true); }
    });
    watch.observe(box.current);
    return () => watch.disconnect();
  }, [box, fit]);

  // ---- pictures
  const addFiles = useCallback(async (list) => {
    const wanted = [...list].filter((f) => PICTURE_TYPES.includes(f.type));
    if (!wanted.length) { if (list.length) onError("PNG·JPEG·WebP·GIF 그림만 붙일 수 있어요."); return; }
    const room = MAX_PICTURES - pictures.length;
    if (room <= 0) { onError(`그림은 ${MAX_PICTURES}장까지 붙일 수 있어요.`); return; }
    if (wanted.length > room) onError(`그림은 ${MAX_PICTURES}장까지라 ${room}장만 붙였어요.`);
    // read in the conversation it was put in, even if another is open by now
    const key = keyNow.current;
    const read = [];
    for (const f of wanted.slice(0, room)) {
      try { read.push(await readPicture(f)); } catch (e) { onError(e.message); }
    }
    if (giveTo(key, read)) box.current?.focus();
  }, [pictures.length, onError, box]);
  useEffect(() => { attachRef.current = addFiles; }, [attachRef, addFiles]);
  // pictures put back in the box (a message taken back to change)
  useEffect(() => {
    picturesRef.current = (list) => setPictures(list.slice(0, MAX_PICTURES).map(toPicture));
    // a waiting message taken back: its pictures join the ones already here
    addPicturesRef.current = (list) => setPictures((now) => [...now, ...list.map(toPicture)].slice(0, MAX_PICTURES));
  }, [picturesRef, addPicturesRef]);

  // pictures belong to their conversation, like the words (App keeps those):
  // opening another one carried them along into it. Kept here while the
  // window is open (the 10 most recent conversations).
  const kept = useRef(new Map());
  const keyNow = useRef(convKey);
  // pictures into a conversation's box: this one's, or kept for that one
  // (true when it is the one on screen); `first`: in front of what is there
  const giveTo = (key, list, first = false) => {
    if (!list.length) return keyNow.current === key;
    const join = (now) => (first ? [...list, ...now] : [...now, ...list]).slice(0, MAX_PICTURES);
    if (keyNow.current === key) { setPictures(join); return true; }
    kept.current.set(key, join(kept.current.get(key) || []));
    return false;
  };
  const picturesNow = useRef(pictures);
  picturesNow.current = pictures;
  useEffect(() => {
    if (keyNow.current === convKey) return;
    const map = kept.current;
    map.delete(keyNow.current);
    if (picturesNow.current.length) map.set(keyNow.current, picturesNow.current);
    while (map.size > 10) map.delete(map.keys().next().value);
    keyNow.current = convKey;
    setPictures(map.get(convKey) || []);
    map.delete(convKey);
  }, [convKey]);

  // ---- @ files
  const look = (el) => {
    // (a plain conversation has no folder to point into)
    const m = state.info.chat ? null : mentionAt(el.value, el.selectionStart);
    const next = m && m.start !== dismissed.current ? m : null;
    setMention((old) => (old?.start === next?.start && old?.q === next?.q && old?.end === next?.end ? old : next));
    if (!m) dismissed.current = -1;
  };
  const q = mention?.q;
  useEffect(() => {
    if (q == null) { setFiles(null); return undefined; }
    let live = true;
    const id = setTimeout(() => {
      api("/api/files", { q }).then((r) => {
        if (!live) return;
        setFiles(r.files.filter((f) => f !== q));
        setFilesQ(q);
        setPick(0);
      }).catch(() => live && setFiles([]));
    }, 60);
    return () => { live = false; clearTimeout(id); };
  }, [q]);
  const open = !!mention && files !== null;
  const insert = (path) => {
    const el = box.current;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(mention.end);
    // a folder stays open, so robin can go on into it
    const put = `@${path}${path.endsWith("/") ? "" : " "}`;
    const text = before + put + after.replace(/^ /, path.endsWith("/") ? " " : "");
    setDraft(text);
    const caret = before.length + put.length;
    requestAnimationFrame(() => { el.setSelectionRange(caret, caret); el.focus(); look(el); });
  };

  // ---- / commands: the list while only the command word is typed
  const slashWord = /^\/(\S*)$/.exec(draft)?.[1];
  const [cmdPick, setCmdPick] = useState(0);
  const [cmdClosed, setCmdClosed] = useState(false);
  const cmdList = useMemo(() => {
    if (slashWord == null) return [];
    const q = slashWord.toLowerCase();
    const all = [...BUILTIN.filter((c) => !state.info.chat || !FOLDER_ONLY.has(c.name)).map((c) => ({ ...c, kind: "own" })),
      ...(commands?.prompts || []).map((p) => ({ name: p.name, hint: p.description || "프롬프트 템플릿", kind: "template", arg: "" })),
      ...(commands?.skills || []).map((s) => ({ name: `skill:${s.name}`, hint: s.description || "스킬", kind: "skill", arg: "" }))];
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
    return [...starts, ...all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q))].slice(0, 30);
  }, [slashWord, commands, state.info.chat]);
  useEffect(() => { setCmdPick(0); }, [slashWord]);
  useEffect(() => { if (slashWord == null) setCmdClosed(false); }, [slashWord]);
  const cmdOpen = slashWord != null && !cmdClosed && !mention;
  const fillCommand = (c) => { setDraft(`/${c.name} `); requestAnimationFrame(() => box.current?.focus()); };
  // Enter: the window's own is done at once (what may follow it is not
  // needed); a click fills one that takes more words. Templates and skills
  // are filled, for robin to add to and send
  const pickCommand = (c, key) => {
    if (c.kind === "own" && (key || !c.arg)) { setDraft(""); onCommand(c.name, ""); return; }
    fillCommand(c);
  };

  // ---- ↑ ↓: what was sent before (Claude Code's history); `pastRef` gives
  // it, oldest first. `browse`: where robin is in it, and what was typed
  const browse = useRef(null); // { at, typed } | null
  useEffect(() => { browse.current = null; }, [convKey]);
  const back = (el) => {
    const past = pastRef.current?.() || [];
    if (!past.length) return false;
    const now = browse.current || { at: past.length, typed: draft };
    if (now.at === 0) return true;
    now.at -= 1;
    browse.current = now;
    setDraft(past[now.at]);
    requestAnimationFrame(() => { el.setSelectionRange(0, 0); });
    return true;
  };
  const forward = (el) => {
    const now = browse.current;
    if (!now) return false;
    const past = pastRef.current?.() || [];
    now.at += 1;
    const text = now.at >= past.length ? now.typed : past[now.at];
    if (now.at >= past.length) browse.current = null;
    setDraft(text);
    requestAnimationFrame(() => { el.setSelectionRange(text.length, text.length); });
    return true;
  };

  const offline = state.ready && !state.link;
  const empty = !draft.trim() && !pictures.length;
  const stop = state.busy && empty;
  // a plain conversation runs no commands: "!" is only a letter there
  const shell = !state.info.chat && /^!/.test(draft);
  const mode = state.mode || "ask";
  const think = state.thinking;
  // when: "now" (after the step it is on) or "end" (when the turn is over), while it runs
  // a double click on 보내기: the second lands on 멈추기 if the turn began
  // in between, and stopped what was just sent (2026-11-19 codex)
  const sentAt = useRef(0);
  const submit = (when = "now") => {
    if (stop) { if (Date.now() - sentAt.current > 700) onStop(); return; }
    if (empty) return;
    const text = draft.trim();
    const own = !pictures.length && ownCommand(text);
    if (own) { setDraft(""); browse.current = null; onCommand(own.name, own.arg); return; }
    if (shell && !pictures.length) {
      const command = text.slice(1).trim();
      if (!command) return;
      browse.current = null;
      sentAt.current = Date.now();
      onShell(command, draft);
      return;
    }
    const sent = pictures;
    const key = keyNow.current;
    setPictures([]);
    setMention(null);
    browse.current = null;
    sentAt.current = Date.now();
    onSend(draft, sent, when).then((ok) => { if (!ok) giveTo(key, sent, true); });
  };
  return (
    <footer className="composer">
      {notice}
      {open && <Mentions list={files} q={mention.q} pick={pick} onPick={insert} onHover={setPick} />}
      {cmdOpen && <Commands list={cmdList} pick={cmdPick} onPick={pickCommand} onHover={setCmdPick} />}
      <form className={`composer-box${shell ? " shell-mode" : ""}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {shell && <span className="shell-tag mono" title="! 뒤의 명령을 모델을 거치지 않고 이 폴더에서 PowerShell로 바로 실행해요. 결과는 대화에 남아 모델도 봐요.">PowerShell</span>}
        {pictures.length > 0 && (
          <ul className="pics" aria-label="붙인 그림">
            {pictures.map((p, k) => (
              <li key={p.id} className="pic">
                <img src={p.url} alt={`붙인 그림 ${k + 1}`} />
                <button type="button" className="pic-x" aria-label={`그림 ${k + 1} 빼기`} title="빼기"
                  onClick={() => { setPictures((now) => now.filter((x) => x.id !== p.id)); box.current?.focus(); }}>
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          rows={1}
          value={draft}
          disabled={offline}
          placeholder={offline ? "서버와 연결이 끊겼어요" : state.compacting ? "앞부분을 요약하는 중이에요. 보내면 요약이 끝난 뒤에 보내요"
            : state.busy ? "이어서 할 말 (Enter: 다음 단계 전에 · Ctrl+Enter: 다 끝나면)" : state.info.chat ? "무엇이든 물어보세요 (/ 명령 · 그림 붙여넣기)" : "무엇을 할까요? (@ 파일 · / 명령 · ! PowerShell · 그림 붙여넣기)"}
          aria-label="메시지"
          role="combobox"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-expanded={open || cmdOpen}
          aria-controls={open ? "mention-list" : cmdOpen ? "command-list" : undefined}
          aria-activedescendant={open && files.length ? `mention-${pick}` : cmdOpen && cmdList.length ? `command-${cmdPick}` : undefined}
          spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); look(e.target); }}
          onSelect={(e) => look(e.target)}
          onBlur={() => setMention(null)}
          onPaste={(e) => {
            const list = [...(e.clipboardData?.files || [])];
            if (list.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); addFiles(list); }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (open) {
              const n = files.length;
              if (e.key === "ArrowDown" && n) { e.preventDefault(); setPick((k) => (k + 1) % n); return; }
              if (e.key === "ArrowUp" && n) { e.preventDefault(); setPick((k) => (k - 1 + n) % n); return; }
              if ((e.key === "Enter" || e.key === "Tab") && n && !e.shiftKey) { e.preventDefault(); if (filesQ === mention.q) insert(files[pick]); return; }
              // Esc here only closes the list (it must not stop the agent)
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismissed.current = mention.start; setMention(null); return; }
            }
            if (cmdOpen) {
              const n = cmdList.length;
              if (e.key === "ArrowDown" && n) { e.preventDefault(); setCmdPick((k) => (k + 1) % n); return; }
              if (e.key === "ArrowUp" && n) { e.preventDefault(); setCmdPick((k) => (k - 1 + n) % n); return; }
              if (e.key === "Tab" && n && !e.shiftKey) { e.preventDefault(); fillCommand(cmdList[cmdPick]); return; }
              if (e.key === "Enter" && n && !e.shiftKey) { e.preventDefault(); pickCommand(cmdList[cmdPick], true); return; }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setCmdClosed(true); return; }
            }
            // Enter sends; on an empty box while it runs it does nothing (a
            // second Enter after sending stopped the turn): the button and Esc stop.
            // While it runs Enter goes in after the step it is on, Ctrl+Enter
            // when the whole turn is over
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!stop) submit(e.ctrlKey || e.metaKey ? "end" : "now");
              return;
            }
            const el = e.target;
            const flat = el.selectionStart === el.selectionEnd;
            if (e.key === "ArrowUp" && flat && !e.shiftKey && !e.altKey) {
              // the last waiting message comes back to change (Claude Code's ↑)
              if (!draft && state.queued?.length) { e.preventDefault(); onUnqueueLast(); return; }
              // what was sent before: on an empty box, or while going through it
              if ((!draft || browse.current) && !draft.slice(0, el.selectionStart).includes("\n") && back(el)) e.preventDefault();
            } else if (e.key === "ArrowDown" && flat && browse.current && !draft.slice(el.selectionEnd).includes("\n")) {
              if (forward(el)) e.preventDefault();
            }
          }}
        />
        <button type="button" className="icon-btn attach" aria-label="그림 붙이기" title="그림 붙이기 (붙여넣기·끌어 놓기도 돼요)"
          disabled={offline || pictures.length >= MAX_PICTURES} onClick={() => fileInput.current?.click()}>
          <Icon name="image" />
        </button>
        <input ref={fileInput} type="file" accept={PICTURE_TYPES.join(",")} multiple hidden
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button type="submit" className={`btn send ${stop ? "stop" : "btn-primary"}`} disabled={offline || (!stop && empty)}>
          {stop ? "멈추기" : shell ? "실행" : "보내기"}
        </button>
      </form>
      <div className="composer-foot">
        {/* a plain conversation has no modes: it has only the web, which asks */}
        {!state.info.chat && (
          <button type="button" className={`mode mode-${mode}`} aria-label={`모드: ${MODE_NAMES[mode]}. 누르면 다음 모드`}
            title={`${MODE_TIPS[mode]}\n누르거나 Shift+Tab: ${MODE_NAMES[nextMode(mode)]}`}
            onClick={() => onMode()}>
            <span className={`lamp ${LAMPS[mode]}`} aria-hidden="true" />{MODE_NAMES[mode]}
          </button>
        )}
        {/* Qwen thinks before it answers: slower, better on hard work */}
        <button type="button" className={`mode toggle${think ? " on" : ""}`} aria-pressed={think}
          title={think ? "모델이 답하기 전에 먼저 생각해요. 느리지만 어려운 일에 나아요. 누르면 바로 답해요." : "모델이 바로 답해요. 누르면 답하기 전에 먼저 생각해요(느리지만 어려운 일에 나아요)."}
          onClick={() => api("/api/thinking", { on: !think }).catch((e) => onError(`바꾸지 못했어요: ${e.message}`))}>
          <span className="switch" aria-hidden="true" />생각
        </button>
        {meter}
        {/* the most needed first: what does not fit drops whole (it wraps onto
            a hidden second line) instead of being cut mid-word as "Esc 멈…" */}
        <span className="keys">{(state.busy
          ? [<><kbd>Esc</kbd> 멈추기</>, <><kbd>Enter</kbd> 다음 단계 전에</>, <><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 끝난 뒤에</>, <><kbd>↑</kbd> 기다리는 말 고치기</>]
          : [<><kbd>Enter</kbd> 보내기</>, <><kbd>Shift</kbd>+<kbd>Enter</kbd> 줄 바꿈</>, ...(state.info.chat ? [] : [<><kbd>Shift</kbd>+<kbd>Tab</kbd> 모드</>]), <><kbd>↑</kbd> 보낸 말</>, <><kbd>/help</kbd> 단축키</>]
        ).map((k, i) => <span key={i} className="key">{k}</span>)}</span>
      </div>
    </footer>
  );
}
