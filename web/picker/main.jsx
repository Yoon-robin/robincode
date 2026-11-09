// The folder screen: where RobinCode opens. Two servers show this page and
// answer its api/* calls (relative, so both work): robincode-ui.ps1 for
// robincode.cmd (at /, the window closes after a choice), and the RobinCode
// app's server.mjs (at /picker/, the same window then goes on to the
// conversation: its answers say where, `next`). The token comes from ?t=; the
// folders, Tab into a folder and the Explorer dialog all live on the server,
// this page only shows them.
// Built with shadcn/ui's parts (components/ui: cmdk's command menu, Button),
// lucide icons and motion.
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "motion/react";
import { CornerDownRight, Folder, FolderGit2, FolderOpen, FolderX, GitBranch } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command";
import { Button, Kbd } from "./components/ui/button";
import { cn } from "./lib/utils";
import { fitWindow } from "../src/fit.js";
import "./picker.css";

// Korean Pretendard: RobinMail's subset files, which the server hands out
// (not in this build, 3 MB); the browser fetches only the parts it shows
const fonts = document.createElement("link");
fonts.rel = "stylesheet";
fonts.href = "/fonts/pretendard/pretendardvariable-dynamic-subset.css";
document.head.append(fonts);

fitWindow();

const token = new URLSearchParams(location.search).get("t") || "";
async function api(path, body) {
  // relative: /api/… under robincode-ui.ps1, /picker/api/… under server.mjs
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-robincode": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status}`);
  return data;
}
// closed with its X: the server stops waiting (a reload says hello again)
function bye() {
  navigator.sendBeacon?.(`api/bye?t=${encodeURIComponent(token)}`);
}

const SECTION = { recent: "최근 연 폴더", search: "찾은 폴더", path: "이 경로" };
const spring = { type: "spring", stiffness: 700, damping: 48, mass: 0.7 };

function RowIcon({ row, on }) {
  const cls = cn("size-[18px] shrink-0 transition-colors", on ? "text-head" : "text-faint");
  if (row.kind === "path") return row.ok ? <CornerDownRight className={cls} strokeWidth={1.6} /> : <FolderX className={cn(cls, "text-amber")} strokeWidth={1.6} />;
  if (row.branch) return <FolderGit2 className={cls} strokeWidth={1.5} />;
  return on ? <FolderOpen className={cls} strokeWidth={1.5} /> : <Folder className={cls} strokeWidth={1.5} />;
}

function Row({ row, on }) {
  const missing = row.kind === "path" && !row.ok;
  const title = row.kind === "path" ? (row.ok ? "이 경로에서 열기" : "없는 폴더예요") : row.name;
  return (
    <>
      {on && (
        <motion.span layoutId="hl" transition={spring} className="absolute inset-0 rounded-box bg-press">
          <span className="absolute inset-y-3.5 left-0 w-[2px] rounded-full bg-head" />
        </motion.span>
      )}
      <span className="relative z-10 grid h-[60px] w-full grid-cols-[18px_1fr_auto] items-center gap-3.5 px-4">
        <RowIcon row={row} on={on} />
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-[15px] font-semibold", missing ? "text-amber" : on ? "text-white" : "text-text")}>{title}</span>
            {row.branch && (
              <span className="inline-flex max-w-40 shrink-0 items-center gap-1 rounded-[7px] border border-line-weak px-1.5 font-mono text-[11px] leading-[18px] text-soft">
                <GitBranch className="size-3 shrink-0" strokeWidth={1.6} />
                <span className="truncate">{row.branch}</span>
              </span>
            )}
          </span>
          <span className="truncate font-mono text-[12px] text-faint">{row.short}</span>
        </span>
        <span className="text-[12px] whitespace-nowrap text-faint">
          {on && !missing ? <span className="inline-flex items-center gap-1.5 text-soft"><Kbd>Tab</Kbd>안으로</span> : row.ago}
        </span>
      </span>
    </>
  );
}

// the folder chosen: "opening it here", and, while the app's server is still
// getting ready (packages, the model), what it is doing
function Opening({ path }) {
  const [phase, setPhase] = useState(null);
  useEffect(() => {
    let on = true;
    const tick = async () => {
      // robincode-ui.ps1 has no status: it answers at once anyway
      const v = await api("api/status").catch(() => null);
      if (on && v && !v.ready) setPhase(v.text);
    };
    const timer = setInterval(tick, 500);
    tick();
    return () => { on = false; clearInterval(timer); };
  }, []);
  return (
    <motion.main
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto flex h-full max-w-[860px] flex-col justify-center px-10"
    >
      <p className="font-mono text-[12px] font-bold tracking-[0.14em] text-head"><span className="tracking-normal text-soft">&gt;</span> ROBINCODE</p>
      <p className="mt-5 text-[24px] font-bold text-white">이 폴더에서 열어요<span className="ml-1 inline-block h-[0.9em] w-[0.5em] translate-y-[0.1em] animate-blink bg-head" /></p>
      <p className="mt-2 font-mono text-[13px] break-all text-soft">{path}</p>
      <AnimatePresence mode="wait">
        {phase && (
          <motion.p key={phase} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}
            className="mt-6 text-[13px] text-faint" aria-live="polite">{phase}</motion.p>
        )}
      </AnimatePresence>
    </motion.main>
  );
}

function Picker() {
  const [q, setQ] = useState("");
  const [view, setView] = useState({ mode: "recent", rows: [], total: 0, loaded: false });
  const [value, setValue] = useState("r0");
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const input = useRef(null);
  const asked = useRef(0);
  const click = useRef({ down: false, value: "", at: 0 });

  const load = useCallback(async (text) => {
    const n = ++asked.current;
    try {
      const v = await api(`api/rows?q=${encodeURIComponent(text)}`);
      if (n !== asked.current) return;
      setView({ ...v, loaded: true });
      setValue("r0");
    } catch (e) {
      if (n === asked.current) setNote({ text: `목록을 읽지 못했어요(${e.message}).`, tone: "warn" });
    }
  }, []);
  // a new search or path: the last line under the list no longer applies
  useEffect(() => { load(q); setNote(null); }, [q, load]);
  useEffect(() => {
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, []);

  const index = Number(value.slice(1));
  const row = view.rows[index];
  const canOpen = !!row && (row.kind !== "path" || row.ok) && !busy;

  // the window closes (robincode.cmd), or goes on to the conversation
  const finish = (path, next) => {
    setDone(path);
    if (next) setTimeout(() => location.replace(next), 420);
    else setTimeout(() => window.close(), 650);
  };
  const open = async (r = row) => {
    if (!r || busy) return;
    if (r.kind === "path" && !r.ok) { setNote({ text: `그 폴더가 없어요: ${r.short}`, tone: "warn" }); return; }
    // the app's server may still be getting ready (packages, the model): the
    // "opening" screen says what it is doing until it answers
    setBusy(true);
    setDone(r.path);
    try {
      const v = await api("api/open", { path: r.path });
      finish(v.path, v.next);
    } catch (e) {
      setDone(null);
      setNote({ text: e.message, tone: "warn" });
      setBusy(false);
    }
  };
  const into = (r = row) => {
    if (!r || (r.kind === "path" && !r.ok)) return;
    const typed = q.trim().replace(/^"|"$/g, "");
    setQ(`${/^([A-Za-z]:|\\\\)/.test(typed) ? r.path : r.short}`.replace(/\\$/, "") + "\\");
    input.current?.focus();
  };
  const browse = async () => {
    if (busy) return;
    setBusy(true);
    setNote({ text: "탐색기 창을 열었어요. 폴더를 고르고 \"이 폴더에서 열기\"를 눌러요.", tone: "info" });
    try {
      const v = await api("api/browse", { start: row && (row.kind !== "path" || row.ok) ? row.path : "" });
      // the app's server only names it (it is opened as any other); robincode-ui.ps1 took it already
      if (v.path && v.pick) { setBusy(false); open({ kind: "folder", path: v.path, ok: true }); return; }
      if (v.path) finish(v.path);
      else setNote(null);
    } catch (e) { setNote({ text: `탐색기 창을 열지 못했어요(${e.message}).`, tone: "warn" }); }
    setBusy(false);
    input.current?.focus();
  };
  const hide = async (r = row) => {
    if (!r || r.kind !== "folder") return;
    try {
      await api("api/hide", { path: r.path });
      setNote({ text: `목록에서 뺐어요: ${r.name}`, tone: "info", undo: r.path });
      load(q);
    } catch (e) { setNote({ text: e.message, tone: "warn" }); }
  };
  const unhide = async (path) => {
    await api("api/unhide", { path }).catch(() => {});
    setNote(null);
    load(q);
  };
  // Esc on an empty box: back to the conversation (the app, a folder open), or close
  const cancel = async () => {
    const v = await api("api/cancel", {}).catch(() => ({}));
    if (v.next) location.replace(v.next);
    else window.close();
  };

  // cmdk moves with the arrows and calls onSelect on Enter (and on a click:
  // here a click only picks the row, a second one opens it)
  const onSelect = (v) => {
    const c = click.current;
    if (c.down) {
      c.down = false;
      const again = c.value === v && Date.now() - c.at < 450;
      c.value = v;
      c.at = Date.now();
      if (!again) return;
    }
    open(view.rows[Number(v.slice(1))]);
  };
  const onKey = (e) => {
    if (done) return;
    if (e.key === "Tab") { e.preventDefault(); into(); }
    else if (e.key === "Escape") { e.preventDefault(); if (q) setQ(""); else cancel(); }
    else if (e.key === "Delete" && !q) { e.preventDefault(); hide(); }
    else if (e.key.toLowerCase() === "o" && e.ctrlKey) { e.preventDefault(); browse(); }
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {done ? (
        <Opening key="done" path={done} />
      ) : (
        <motion.main key="pick" exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="h-full">
          <Command shouldFilter={false} loop value={value} onValueChange={setValue} onKeyDown={onKey} label="작업 폴더 고르기" className="mx-auto max-w-[860px]">
            <header className="px-7 pt-6">
              <p className="font-mono text-[12px] font-bold tracking-[0.14em] text-head">
                <span className="tracking-normal text-soft">&gt;</span> ROBINCODE
                <span className="ml-3 font-sans font-normal tracking-normal text-faint">작업 폴더</span>
              </p>
              <h1 className="mt-4 text-[27px] leading-tight font-bold tracking-[-0.02em] text-white">어디서 열까요?</h1>
            </header>

            <div className="mx-7 mt-5 flex h-[52px] items-center gap-3 rounded-box border border-line bg-card pr-2.5 pl-4 transition-colors focus-within:border-white/35">
              <span className="font-mono text-[16px] font-bold text-soft">&gt;</span>
              <CommandInput
                ref={input}
                autoFocus
                spellCheck={false}
                value={q}
                onValueChange={(v) => { setQ(v); setNote(null); }}
                placeholder="폴더 이름으로 찾거나, C:\ ~\ 로 경로를 써요"
              />
              {q && <Button variant="ghost" size="sm" className="h-7 px-2 font-mono text-[11px]" onClick={() => { setQ(""); input.current?.focus(); }}>Esc</Button>}
            </div>

            <CommandList className="mt-5 px-4 pb-2">
              {view.loaded && (
                <CommandEmpty>
                  {view.mode === "search" ? "맞는 폴더가 없어요." : "아직 연 폴더가 없어요."}
                  <span className="text-dim"> 아래 "다른 폴더 찾기"로 골라도 돼요.</span>
                </CommandEmpty>
              )}
              {view.rows.length > 0 && (
                <CommandGroup
                  heading={
                    <>
                      <span>{SECTION[view.mode]}</span>
                      {view.mode !== "path" && (view.mode === "search" || view.total > view.rows.length) && (
                        <span className="font-mono text-[11px] text-dim">{view.rows.length} / {view.total}</span>
                      )}
                    </>
                  }
                >
                  {view.rows.map((r, i) => (
                    <CommandItem
                      key={`${r.kind}:${r.path}`}
                      value={`r${i}`}
                      onSelect={onSelect}
                      onPointerDown={() => { click.current.down = true; }}
                      className="hover:bg-hover"
                    >
                      <Row row={r} on={value === `r${i}`} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>

            <div className="min-h-[34px] px-7 pt-2.5 text-[12.5px]" aria-live="polite">
              <AnimatePresence mode="wait">
                {note && (
                  <motion.p
                    key={note.text}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className={cn("flex items-center gap-3", note.tone === "warn" ? "text-amber" : "text-soft")}
                  >
                    {note.text}
                    {note.undo && (
                      <button type="button" className="text-head underline decoration-white/40 underline-offset-[3px] hover:decoration-white" onClick={() => unhide(note.undo)}>
                        되돌리기
                      </button>
                    )}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-line-weak px-7 py-3.5">
              <div className="flex items-center gap-4 text-[11.5px] text-dim">
                <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> 고르기</span>
                <span className="inline-flex items-center gap-1"><Kbd>Del</Kbd> 목록에서 빼기</span>
                <span className="inline-flex items-center gap-1"><Kbd>Esc</Kbd> {view.back ? "돌아가기" : "닫기"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={browse} disabled={busy}>
                  다른 폴더 찾기 <Kbd className="border-line-weak text-faint">Ctrl O</Kbd>
                </Button>
                <Button onClick={() => open()} disabled={!canOpen}>
                  이 폴더에서 열기 <Kbd className="border-black/25 text-black/60">↵</Kbd>
                </Button>
              </div>
            </footer>
          </Command>
        </motion.main>
      )}
    </AnimatePresence>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><Picker /></StrictMode>);
