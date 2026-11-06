// The message box: it grows with the text, `@` opens a list of the folder's
// files and folders to point at, and pictures can be pasted, dropped on the
// window or picked (up to 4, sent with the message).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./icons.jsx";

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

export function Composer({ state, meter, notice, box, draft, setDraft, lastSent, attachRef, onSend, onStop, onError }) {
  const [pictures, setPictures] = useState([]);
  const [mention, setMention] = useState(null);
  const [files, setFiles] = useState(null);
  const [pick, setPick] = useState(0);
  const dismissed = useRef(-1); // the @ robin closed with Esc stays closed
  const fileInput = useRef(null);

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

  // ---- pictures
  const addFiles = useCallback(async (list) => {
    const wanted = [...list].filter((f) => PICTURE_TYPES.includes(f.type));
    if (!wanted.length) { if (list.length) onError("PNG·JPEG·WebP·GIF 그림만 붙일 수 있어요."); return; }
    const room = MAX_PICTURES - pictures.length;
    if (room <= 0) { onError(`그림은 ${MAX_PICTURES}장까지 붙여요.`); return; }
    if (wanted.length > room) onError(`그림은 ${MAX_PICTURES}장까지라 ${room}장만 붙였어요.`);
    const read = [];
    for (const f of wanted.slice(0, room)) {
      try { read.push(await readPicture(f)); } catch (e) { onError(e.message); }
    }
    setPictures((now) => [...now, ...read].slice(0, MAX_PICTURES));
    box.current?.focus();
  }, [pictures.length, onError, box]);
  useEffect(() => { attachRef.current = addFiles; }, [attachRef, addFiles]);

  // ---- @ files
  const look = (el) => {
    const m = mentionAt(el.value, el.selectionStart);
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

  const offline = state.ready && !state.link;
  const empty = !draft.trim() && !pictures.length;
  const stop = state.busy && empty;
  const auto = state.mode === "auto";
  const submit = () => {
    if (stop) { onStop(); return; }
    if (empty) return;
    const sent = pictures;
    setPictures([]);
    setMention(null);
    onSend(draft, sent).then((ok) => { if (!ok) setPictures(sent); });
  };
  return (
    <footer className="composer">
      {notice}
      {open && <Mentions list={files} q={mention.q} pick={pick} onPick={insert} onHover={setPick} />}
      <form className="composer-box" onSubmit={(e) => { e.preventDefault(); submit(); }}>
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
          placeholder={offline ? "서버와 연결이 끊겼어요" : state.busy ? "이어서 할 말 (끝나면 이어서 처리해요)" : "무엇을 할까요? (@ 파일, 그림 붙여넣기)"}
          aria-label="메시지"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? "mention-list" : undefined}
          aria-activedescendant={open && files.length ? `mention-${pick}` : undefined}
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
              if ((e.key === "Enter" || e.key === "Tab") && n && !e.shiftKey) { e.preventDefault(); insert(files[pick]); return; }
              // Esc here only closes the list (it must not stop the agent)
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismissed.current = mention.start; setMention(null); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            // like a shell: the last thing sent comes back on an empty line
            else if (e.key === "ArrowUp" && !draft && lastSent) { e.preventDefault(); setDraft(lastSent); }
          }}
        />
        <button type="button" className="icon-btn attach" aria-label="그림 붙이기" title="그림 붙이기 (붙여넣기·끌어 놓기도 돼요)"
          disabled={offline || pictures.length >= MAX_PICTURES} onClick={() => fileInput.current?.click()}>
          <Icon name="image" />
        </button>
        <input ref={fileInput} type="file" accept={PICTURE_TYPES.join(",")} multiple hidden
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button type="submit" className={`btn send ${stop ? "stop" : "btn-primary"}`} disabled={offline || (!stop && empty)}>
          {stop ? "멈추기" : "보내기"}
        </button>
      </form>
      <div className="composer-foot">
        <button type="button" className={`mode${auto ? " auto" : ""}`} aria-pressed={auto}
          title={auto ? "명령과 파일 수정을 묻지 않고 실행해요. 누르면 다시 물어요." : "명령 실행과 파일 수정 전에 물어요. 누르면 묻지 않아요."}
          onClick={() => api("/api/mode", { mode: auto ? "ask" : "auto" }).catch(() => {})}>
          <span className={`lamp ${auto ? "warn" : "idle"}`} aria-hidden="true" />{auto ? "바로 실행" : "묻고 실행"}
        </button>
        {meter}
        <span className="keys"><kbd>Enter</kbd> 보내기 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄 바꿈 · <kbd>@</kbd> 파일 · <kbd>↑</kbd> 보낸 말 · <kbd>Esc</kbd> 멈추기</span>
      </div>
    </footer>
  );
}
