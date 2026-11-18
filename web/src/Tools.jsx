// Tool steps: one terminal line each ([ .. ] -> [ OK ] / [FAIL] / [SKIP]) on a
// rail, a running command's last lines underneath, the output folding out
// when opened, and the approval question for powershell / edit / write
// folding out right under the step it is about. With thinking on, what the
// model thinks is a step too ("생각"), its newest lines showing while it
// thinks. A long finished run of steps folds into one summary line.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DiffLines, editRows, writeRows } from "./Diff.jsx";
import { CopyButton } from "./Markdown.jsx";
import { Icon } from "./icons.jsx";
import { useNow, seconds } from "./time.js";

const TAG = { run: "[ .. ]", ok: "[ OK ]", fail: "[FAIL]", skip: "[SKIP]" };
const ASKS = new Set(["powershell", "bash", "edit", "write", "webfetch"]);
const LIVE_LINES = 8;
const THINK_CHARS = 1600; // more than the box's four lines hold, even one long line
const FOLD_AT = 5; // steps in one run before a finished run folds into a summary
// the keys that answer a question, in the order of its buttons
// (4: "늘 허용" for this command or site, when the question has one)
export const ANSWER_KEYS = { 1: "yes", 2: "always", 3: "no", 4: "rule" };

export function describe(name, args = {}) {
  switch (name) {
    case "todo": {
      const items = Array.isArray(args.items) ? args.items : [];
      const now = items.find((x) => x.status === "in_progress");
      return `${items.filter((x) => x.status === "completed").length}/${items.length}${now ? ` · ${now.text}` : ""}`;
    }
    case "webfetch": return args.url ?? "";
    case "read": return `${args.path ?? ""}${args.offset ? ` · ${args.offset}줄부터` : ""}`;
    case "ls": return args.path || ".";
    case "find": case "grep": return [args.pattern, args.path].filter(Boolean).join("  ·  ");
    case "powershell": case "bash": return String(args.command ?? "").split("\n")[0];
    case "edit": case "write": return args.path ?? "";
    default: return Object.keys(args).length ? JSON.stringify(args) : "";
  }
}

// opens and closes its content by height (grid rows 0fr <-> 1fr); closed, it
// is inert so nothing inside can be reached. `grow`: also unfold when it is
// open from its first frame (a question that came together with its step)
export function Fold({ open, grow, children }) {
  return (
    <div className={`fold${open ? " open" : ""}${grow ? " grow" : ""}`} inert={!open}>
      <div className="fold-in">{children}</div>
    </div>
  );
}

function Elapsed({ from }) {
  const now = useNow(1000);
  return <span className="step-ms">{seconds(now - from)}</span>;
}

const lastLines = (text, n) => text.replace(/\s+$/, "").split("\n").slice(-n).join("\n");
// the newest of a thought: more than its box holds, so the box only fills up
// and then stays the same height (cutting by lines made it jump as lines came
// and went); the box keeps the bottom and fades out the top
const thoughtTail = (text) => {
  let t = text.replace(/\s+$/, "").replace(/\n\s*\n/g, "\n");
  if (t.length > THINK_CHARS) {
    t = t.slice(-THINK_CHARS);
    const cut = t.indexOf("\n");
    if (cut >= 0 && cut < THINK_CHARS / 2) t = t.slice(cut + 1);
  }
  return t.replace(/^\s+/, "");
};

// the newest thought of a run of steps, in one box under the run: it grows up
// four lines (.think-clip) and never shrinks back (a shorter next thought sits at
// its bottom), old lines slide out of the top under a fade. One box for the
// whole run, so it does not fold shut and open again at every tool call.
function ThoughtLive({ text, idle }) {
  const box = useRef(null);
  const [least, setLeast] = useState(0);
  const [full, setFull] = useState(false);
  const tail = text ? thoughtTail(text) : "";
  useLayoutEffect(() => {
    const el = box.current;
    const p = el?.firstChild;
    if (!p) return;
    const cap = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    if (!full && p.offsetHeight > cap + 1) setFull(true);
    const h = Math.min(p.offsetHeight, cap);
    if (h > least + 0.5) setLeast(h);
  }, [tail, least, full]);
  return (
    <div className={`step-live think-live${idle ? " idle" : ""}`} aria-live="off">
      <div ref={box} className={`think-clip${full ? " full" : ""}`} style={least ? { minHeight: `${least}px` } : undefined}><p>{tail}</p></div>
    </div>
  );
}
const firstLine = (text) => (text || "").trim().split("\n")[0];

function Approval({ tool, onDecide }) {
  const yes = useRef(null);
  const { name, args } = tool;
  const isFile = name === "edit" || name === "write";
  const web = name === "webfetch";
  const title = name === "edit" ? "이 파일을 고칠까요?" : name === "write" ? "이 파일을 쓸까요?" : web ? "이 웹 페이지를 읽을까요?" : name === "read" ? "이 파일을 읽을까요?" : "이 명령을 실행할까요?";
  const yesLabel = name === "edit" ? "고치기" : name === "write" ? "쓰기" : web ? "읽기" : name === "read" ? "읽기" : "실행";
  const risk = tool.risk;
  const [note, setNote] = useState("");
  const rule = tool.rule;
  // the card stays (hidden) once answered: its diff is made once, not at every drawing
  const rows = useMemo(() => (name === "edit" ? editRows(args) : name === "write" ? writeRows(args) : null), [name, args]);
  // once the fold has opened, bring the buttons into view if they are not
  useEffect(() => {
    const id = setTimeout(() => yes.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 230);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className={`ask${risk ? " risky" : ""}`} role="group" aria-label={title}>
      <p className="ask-title"><span className="prompt">&gt;</span> {title}</p>
      {/* asked in every mode: what cannot be put back (guard.mjs) */}
      {risk && <p className="ask-risk"><Icon name="alert" /> {risk} — 되돌릴 수 없어서 어느 모드에서나 물어요.</p>}
      {name === "read" ? (
        <pre className="ask-cmd">{String(args.path ?? "")}</pre>
      ) : isFile ? (
        <div className="ask-file">
          <div className="ask-path">{args.path}</div>
          <DiffLines rows={rows} />
        </div>
      ) : web ? (
        <pre className="ask-cmd">{String(args.url ?? "")}</pre>
      ) : (
        <pre className="ask-cmd"><span className="ps">PS&gt;</span> {String(args.command ?? JSON.stringify(args))}</pre>
      )}
      <div className="ask-buttons">
        <button ref={yes} type="button" className="btn btn-primary" onClick={() => onDecide(tool.id, "yes")}>
          <kbd className="key">1</kbd>{yesLabel}
        </button>
        {!risk && (
          <button type="button" className="btn" onClick={() => onDecide(tool.id, "always")}>
            <kbd className="key">2</kbd>이번 대화는 모두 허용
          </button>
        )}
        <button type="button" className="btn" onClick={() => onDecide(tool.id, "no", note)}>
          <kbd className="key">3</kbd>안 돼요
        </button>
        {/* Claude Code's "don't ask again for …": this command's start, or this site, in this folder */}
        {rule && (
          <button type="button" className="btn" onClick={() => onDecide(tool.id, "rule")}
            title={web ? "이 사이트의 페이지는 이 폴더에서 묻지 않고 읽어요." : rule.key.startsWith("exact:") ? "똑같은 이 명령은 이 폴더에서 묻지 않고 실행해요." : `"${rule.label}"로 시작하는 명령은 이 폴더에서 묻지 않고 실행해요. ; | > 같은 것으로 이어 붙인 명령은 그래도 물어요.`}>
            <kbd className="key">4</kbd>{web ? <><span className="mono">{rule.label}</span>은 늘 허용</> : <><span className="mono">{rule.label}</span> 늘 허용</>}
          </button>
        )}
      </div>
      {/* a no with words: why, or what to do instead — the model gets them */}
      <input className="ask-note" value={note} spellCheck={false} maxLength={500}
        placeholder="안 되면 이유나 대신 할 것 (Enter로 안 돼요)" aria-label="안 되는 이유나 대신 할 것"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && note.trim()) { e.preventDefault(); onDecide(tool.id, "no", note); }
        }} />
    </div>
  );
}

// Ctrl+F asks a folded step (and its folded run) to open: the step's id
export const REVEAL = "robincode:reveal-step";

// memo: a step is drawn again only when it changes, not at every token of an
// answer elsewhere in the conversation
const Step = memo(function Step({ tool, onDecide }) {
  const [open, setOpen] = useState(false);
  // the body is made the first time it opens (a diff is not free), then kept
  // so it can fold shut again
  const [made, setMade] = useState(false);
  const asked = useRef(false);
  const body = useRef(null);
  const reveal = useRef(0);
  if (tool.ask) asked.current = true;
  useEffect(() => {
    if (tool.status === "fail") { setMade(true); setOpen(true); }
  }, [tool.status]);
  useEffect(() => () => clearTimeout(reveal.current), []);
  // Ctrl+F found the words in this step's folded result: it opens (B-415)
  useEffect(() => {
    const on = (e) => { if (e.detail === tool.id) { setMade(true); setOpen(true); } };
    window.addEventListener(REVEAL, on);
    return () => window.removeEventListener(REVEAL, on);
  }, [tool.id]);
  const toggle = () => {
    setMade(true);
    setOpen((v) => !v);
    clearTimeout(reveal.current);
    // opened near the bottom: once it has unfolded, scroll it into view
    if (!open) reveal.current = setTimeout(() => body.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 210);
  };
  const status = tool.ask ? "asking" : tool.status;
  const running = tool.status === "run";
  const think = !!tool.think;
  const showDiff = tool.name === "edit" && tool.status === "ok";
  const diff = useMemo(() => (showDiff && made ? editRows(tool.args) : null), [showDiff, made, tool.args]);
  const canOpen = !running && (!!tool.output || showDiff);
  const live = running && !tool.ask && !!tool.output;
  // how much a done edit/write changed, on its line: +3 −1 (seen without opening)
  const delta = useMemo(() => {
    if (tool.status !== "ok" || (tool.name !== "edit" && tool.name !== "write")) return null;
    if (tool.name === "write") return { add: String(tool.args?.content ?? "").replace(/\n$/, "").split("\n").length, del: 0 };
    const rows = editRows(tool.args);
    return { add: rows.filter((r) => r[0] === "+").length, del: rows.filter((r) => r[0] === "-").length };
  }, [tool.status, tool.name, tool.args]);
  return (
    <li className={`step ${status}${think ? " think" : ""}`} data-step={tool.id}>
      <button type="button" className="step-head" aria-expanded={canOpen ? open : undefined} disabled={!canOpen}
        onClick={toggle}>
        <span className="step-tag">{tool.ask ? "[ ?? ]" : TAG[tool.status]}</span>
        <span className="step-name">{tool.name}</span>
        <span className="step-what">{think ? (running ? "" : firstLine(tool.output)) : describe(tool.name, tool.args)}</span>
        {delta && <span className="step-delta" aria-label={`${delta.add}줄 더함, ${delta.del}줄 뺌`}><span className="add">+{delta.add}</span>{delta.del > 0 && <span className="del">−{delta.del}</span>}</span>}
        {running && !tool.ask && tool.startedAt ? <Elapsed from={tool.startedAt} />
          : tool.ms != null ? <span className="step-ms">{tool.ms < 1000 ? `${tool.ms}ms` : `${(tool.ms / 1000).toFixed(1)}초`}</span> : null}
        {canOpen && <span className="chev" aria-hidden="true" />}
      </button>
      {/* a command's last lines while it runs; it folds away when it ends
          (a thought shows in its run's box instead, see ToolGroup) */}
      {ASKS.has(tool.name) && (
        <Fold open={live}>
          <pre className="step-live" aria-live="off">{tool.output ? lastLines(tool.output, LIVE_LINES) : ""}</pre>
        </Fold>
      )}
      {canOpen && (
        <Fold open={open}>
          {made && (
            <div ref={body} className="step-body">
              {diff && <DiffLines rows={diff} />}
              {think && <p className="think-out">{tool.output}</p>}
              {!think && tool.output && (
                <div className="out">
                  <pre className="step-out">{tool.output}</pre>
                  <CopyButton text={tool.output} className="mini-btn out-copy" />
                </div>
              )}
            </div>
          )}
        </Fold>
      )}
      {ASKS.has(tool.name) && <Fold open={!!tool.ask} grow>{asked.current && <Approval tool={tool} onDecide={onDecide} />}</Fold>}
    </li>
  );
});

// `settled`: nothing more will join this run (the answer moved on, or it ended)
export const ToolGroup = memo(function ToolGroup({ tools, onDecide, settled }) {
  const [open, setOpen] = useState(false);
  const done = tools.every((t) => t.status !== "run" && !t.ask);
  const folds = settled && done && tools.length >= FOLD_AT;
  const failed = tools.filter((t) => t.status === "fail").length;
  const skipped = tools.filter((t) => t.status === "skip").length;
  const real = tools.filter((t) => !t.think).length;
  const counts = new Map();
  // the tools first, the thoughts after them
  for (const t of [...tools.filter((x) => !x.think), ...tools.filter((x) => x.think)]) counts.set(t.name, (counts.get(t.name) || 0) + 1);
  const names = [...counts].map(([n, c]) => `${n} ${c}`);
  if (failed) names.push(`실패 ${failed}`);
  if (skipped) names.push(`건너뜀 ${skipped}`);
  // the newest thought shows under the run until the run settles (the answer
  // comes, or the turn ends), dimmed while a tool runs between two thoughts
  const thought = tools.findLast((t) => t.think);
  const pane = !settled && !!thought?.output;
  // made once it has shown (so it can fold shut), not for runs read back
  const shown = useRef(false);
  if (pane) shown.current = true;
  // a folded run opens when Ctrl+F goes to a step in it
  useEffect(() => {
    const on = (e) => { if (tools.some((t) => t.id === e.detail)) setOpen(true); };
    window.addEventListener(REVEAL, on);
    return () => window.removeEventListener(REVEAL, on);
  }, [tools]);
  return (
    <div className="group">
      {folds && (
        <button type="button" className={`group-head${failed ? " fail" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="step-tag">{failed ? "[FAIL]" : "[ OK ]"}</span>
          <span className="group-count">{real ? `도구 ${real}번` : `생각 ${tools.length}번`}</span>
          <span className="group-names">{names.join(" · ")}</span>
          <span className="chev" aria-hidden="true" />
        </button>
      )}
      <Fold open={!folds || open}>
        <ol className="steps">
          {tools.map((t) => <Step key={t.id} tool={t} onDecide={onDecide} />)}
          {shown.current && (
            <li className="think-pane">
              <Fold open={pane}><ThoughtLive text={thought?.output} idle={thought?.status !== "run"} /></Fold>
            </li>
          )}
        </ol>
      </Fold>
    </div>
  );
});

// robin's own `!명령`: the command, its output as it comes, how it ended
export const ShellRun = memo(function ShellRun({ item }) {
  const running = item.status === "run";
  const failed = !running && (item.cancelled || (item.exitCode != null && item.exitCode !== 0));
  const tag = running ? "[ .. ]" : item.cancelled ? "[SKIP]" : failed ? "[FAIL]" : "[ OK ]";
  return (
    <div className={`shell-run${running ? " run" : failed ? " fail" : ""}`}>
      <div className="shell-head">
        <span className="step-tag">{tag}</span>
        <span className="shell-cmd"><span className="ps">!</span> {item.command}</span>
        {running && item.startedAt ? <Elapsed from={item.startedAt} />
          : item.exitCode != null && item.exitCode !== 0 ? <span className="step-ms">끝 코드 {item.exitCode}</span> : null}
      </div>
      {item.output ? (
        <div className="out">
          <pre className="step-out">{running ? lastLines(item.output, 40) : item.output}</pre>
          {!running && <CopyButton text={item.output} className="mini-btn out-copy" />}
        </div>
      ) : !running && <p className="shell-none">출력이 없어요.</p>}
    </div>
  );
});

// the model's task list (its newest todo call), pinned above the message box
export function latestTodo(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    // a list from an earlier request is over (a word sent while it ran is not one)
    if (x.kind === "user") { if (x.midway) continue; return null; }
    if (x.kind !== "tools") continue;
    const t = x.tools.findLast((s) => s.name === "todo" && Array.isArray(s.args?.items));
    if (t) return t.args.items;
  }
  return null;
}
const TODO_MARK = { pending: "[  ]", in_progress: "[..]", completed: "[OK]" };
export function TodoPanel({ todo, busy }) {
  const [open, setOpen] = useState(true);
  if (!todo?.length) return null;
  const done = todo.filter((x) => x.status === "completed").length;
  if (!busy && done === todo.length) return null;
  return (
    <section className={`todo${open ? " open" : ""}`} aria-label="할 일">
      <button type="button" className="todo-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="todo-title">할 일</span>
        <span className="todo-count">{done}/{todo.length}</span>
        <span className="todo-now">{todo.find((x) => x.status === "in_progress")?.text || ""}</span>
        <span className="chev" aria-hidden="true" />
      </button>
      {open && (
        <ol className="todo-list">
          {todo.map((x, k) => (
            <li key={k} className={`todo-item ${x.status}`}>
              <span className="todo-mark" aria-hidden="true">{TODO_MARK[x.status] || TODO_MARK.pending}</span>
              <span className="todo-text">{x.text}</span>
              <span className="sr">{x.status === "completed" ? "끝" : x.status === "in_progress" ? "하는 중" : "할 것"}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
