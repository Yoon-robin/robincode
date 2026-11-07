// Tool steps: one terminal line each ([ .. ] -> [ OK ] / [FAIL] / [SKIP]) on a
// rail, a running command's last lines underneath, the output folding out
// when opened, and the approval question for powershell / edit / write
// folding out right under the step it is about. With thinking on, what the
// model thinks is a step too ("생각"), its newest lines showing while it
// thinks. A long finished run of steps folds into one summary line.
import { useEffect, useRef, useState } from "react";
import { DiffLines, editRows, writeRows } from "./Diff.jsx";
import { CopyButton } from "./Markdown.jsx";
import { useNow, seconds } from "./time.js";

const TAG = { run: "[ .. ]", ok: "[ OK ]", fail: "[FAIL]", skip: "[SKIP]" };
const ASKS = new Set(["powershell", "bash", "edit", "write"]);
const LIVE_LINES = 8;
const THINK_LINES = 4;
const THINK_CHARS = 360; // a thought can be one long line
const FOLD_AT = 5; // steps in one run before a finished run folds into a summary
// the keys that answer a question, in the order of its buttons
export const ANSWER_KEYS = { 1: "yes", 2: "always", 3: "no" };

export function describe(name, args = {}) {
  switch (name) {
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
const thoughtTail = (text) => {
  const t = lastLines(text, THINK_LINES).replace(/^\s+/, "");
  return t.length > THINK_CHARS ? `…${t.slice(-THINK_CHARS)}` : t;
};
const firstLine = (text) => (text || "").trim().split("\n")[0];

function Approval({ tool, onDecide }) {
  const yes = useRef(null);
  const { name, args } = tool;
  const isFile = name === "edit" || name === "write";
  const title = name === "edit" ? "이 파일을 고칠까요?" : name === "write" ? "이 파일을 쓸까요?" : "이 명령을 실행할까요?";
  const yesLabel = name === "edit" ? "고치기" : name === "write" ? "쓰기" : "실행";
  // once the fold has opened, bring the buttons into view if they are not
  useEffect(() => {
    const id = setTimeout(() => yes.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 230);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className="ask" role="group" aria-label={title}>
      <p className="ask-title"><span className="prompt">&gt;</span> {title}</p>
      {isFile ? (
        <div className="ask-file">
          <div className="ask-path">{args.path}</div>
          <DiffLines rows={name === "edit" ? editRows(args) : writeRows(args)} />
        </div>
      ) : (
        <pre className="ask-cmd"><span className="ps">PS&gt;</span> {String(args.command ?? JSON.stringify(args))}</pre>
      )}
      <div className="ask-buttons">
        <button ref={yes} type="button" className="btn btn-primary" onClick={() => onDecide(tool.id, "yes")}>
          <kbd className="key">1</kbd>{yesLabel}
        </button>
        <button type="button" className="btn" onClick={() => onDecide(tool.id, "always")}>
          <kbd className="key">2</kbd>이번 대화는 모두 허용
        </button>
        <button type="button" className="btn" onClick={() => onDecide(tool.id, "no")}>
          <kbd className="key">3</kbd>안 돼요
        </button>
      </div>
    </div>
  );
}

function Step({ tool, onDecide }) {
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
  const canOpen = !running && (!!tool.output || showDiff);
  const live = running && !tool.ask && !!tool.output;
  return (
    <li className={`step ${status}${think ? " think" : ""}`}>
      <button type="button" className="step-head" aria-expanded={canOpen ? open : undefined} disabled={!canOpen}
        onClick={toggle}>
        <span className="step-tag">{tool.ask ? "[ ?? ]" : TAG[tool.status]}</span>
        <span className="step-name">{tool.name}</span>
        <span className="step-what">{think ? (running ? "" : firstLine(tool.output)) : describe(tool.name, tool.args)}</span>
        {running && !tool.ask && tool.startedAt ? <Elapsed from={tool.startedAt} />
          : tool.ms != null ? <span className="step-ms">{tool.ms < 1000 ? `${tool.ms}ms` : `${(tool.ms / 1000).toFixed(1)}초`}</span> : null}
        {canOpen && <span className="chev" aria-hidden="true" />}
      </button>
      {/* a command's last lines while it runs (or the newest of a thought);
          it folds away when it ends */}
      {(ASKS.has(tool.name) || think) && (
        <Fold open={live}>
          {think
            ? <p className="step-live think-live" aria-live="off">{tool.output ? thoughtTail(tool.output) : ""}</p>
            : <pre className="step-live" aria-live="off">{tool.output ? lastLines(tool.output, LIVE_LINES) : ""}</pre>}
        </Fold>
      )}
      {canOpen && (
        <Fold open={open}>
          {made && (
            <div ref={body} className="step-body">
              {showDiff && <DiffLines rows={editRows(tool.args)} />}
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
}

// `settled`: nothing more will join this run (the answer moved on, or it ended)
export function ToolGroup({ tools, onDecide, settled }) {
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
        </ol>
      </Fold>
    </div>
  );
}
