// Tool steps: one terminal line each ([ .. ] -> [ OK ] / [FAIL] / [SKIP]) on a
// rail, the output folding out underneath, and the approval question for
// powershell / edit / write folding out right under the step it is about.
import { useEffect, useRef, useState } from "react";
import { DiffLines, editRows, writeRows } from "./Diff.jsx";
import { useNow, seconds } from "./time.js";

const TAG = { run: "[ .. ]", ok: "[ OK ]", fail: "[FAIL]", skip: "[SKIP]" };
const ASKS = new Set(["powershell", "bash", "edit", "write"]);
// the keys that answer a question, in the order of its buttons (App.jsx)
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
// is inert so nothing inside can be reached
export function Fold({ open, children }) {
  return (
    <div className={`fold${open ? " open" : ""}`} inert={!open}>
      <div className="fold-in">{children}</div>
    </div>
  );
}

function Elapsed({ from }) {
  const now = useNow(1000);
  return <span className="step-ms">{seconds(now - from)}</span>;
}

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
  if (tool.ask) asked.current = true;
  useEffect(() => {
    if (tool.status === "fail") { setMade(true); setOpen(true); }
  }, [tool.status]);
  const status = tool.ask ? "asking" : tool.status;
  const showDiff = tool.name === "edit" && tool.status === "ok";
  const canOpen = !!tool.output || showDiff;
  return (
    <li className={`step ${status}`}>
      <button type="button" className="step-head" aria-expanded={canOpen ? open : undefined} disabled={!canOpen}
        onClick={() => { setMade(true); setOpen((v) => !v); }}>
        <span className="step-tag">{tool.ask ? "[ ?? ]" : TAG[tool.status]}</span>
        <span className="step-name">{tool.name}</span>
        <span className="step-what">{describe(tool.name, tool.args)}</span>
        {tool.status === "run" && !tool.ask && tool.startedAt ? <Elapsed from={tool.startedAt} />
          : tool.ms != null ? <span className="step-ms">{tool.ms < 1000 ? `${tool.ms}ms` : `${(tool.ms / 1000).toFixed(1)}초`}</span> : null}
        {canOpen && <span className="chev" aria-hidden="true" />}
      </button>
      {canOpen && (
        <Fold open={open}>
          {made && (
            <div className="step-body">
              {showDiff && <DiffLines rows={editRows(tool.args)} />}
              {tool.output && <pre className="step-out">{tool.output}</pre>}
            </div>
          )}
        </Fold>
      )}
      {ASKS.has(tool.name) && <Fold open={!!tool.ask}>{asked.current && <Approval tool={tool} onDecide={onDecide} />}</Fold>}
    </li>
  );
}

export function ToolGroup({ tools, onDecide }) {
  return (
    <ol className="steps">
      {tools.map((t) => <Step key={t.id} tool={t} onDecide={onDecide} />)}
    </ol>
  );
}
