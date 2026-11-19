// A line diff of one edit (oldText -> newText), for the approval card and the
// finished edit step. Small texts get a real LCS diff so unchanged lines show
// as context; very large ones fall back to all-removed / all-added.

export function lineDiff(before, after) {
  const all = { a: before.split("\n"), b: after.split("\n") };
  // the same lines at the start and the end are not compared (a write over a
  // big file that changes a few lines in the middle was all - then all +)
  let head = 0;
  while (head < all.a.length && head < all.b.length && all.a[head] === all.b[head]) head++;
  let tail = 0;
  while (tail < all.a.length - head && tail < all.b.length - head && all.a[all.a.length - 1 - tail] === all.b[all.b.length - 1 - tail]) tail++;
  const same = (lines) => lines.map((l) => [" ", l]);
  if (head || tail) return [...same(all.a.slice(0, head)), ...lineDiff1(all.a.slice(head, all.a.length - tail), all.b.slice(head, all.b.length - tail)), ...same(all.a.slice(all.a.length - tail))];
  return lineDiff1(all.a, all.b);
}
function lineDiff1(a, b) {
  if (!a.length) return b.map((l) => ["+", l]);
  if (!b.length) return a.map((l) => ["-", l]);
  if (a.length * b.length > 200000) return [...a.map((l) => ["-", l]), ...b.map((l) => ["+", l])];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([" ", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out;
}

const KIND = { "-": "del", "+": "add", " ": "same" };

// a screen reader hears what each line is (the sign and colour were all it
// had; codex B2 / B-432)
const SAID = { "-": "지움: ", "+": "더함: ", " ": "" };
export function DiffLines({ rows }) {
  return (
    <div className="diff" aria-label="바뀐 줄">
      {rows.map(([sign, text], k) => (
        <div key={k} className={`diff-row ${KIND[sign]}`}>
          <span className="diff-sign" aria-hidden="true">{sign}</span>
          <span className="diff-text">{SAID[sign] && <span className="sr">{SAID[sign]}</span>}{text || " "}</span>
        </div>
      ))}
    </div>
  );
}

// long runs of unchanged lines fold to a few on each side of a change
export function foldSame(rows, keep = 3) {
  const out = [];
  let run = [];
  const flush = (atEnd) => {
    const head = out.length ? keep : 0;
    const tail = atEnd ? 0 : keep;
    if (run.length > head + tail + 1) out.push(...run.slice(0, head), [" ", `⋯ 그대로인 ${run.length - head - tail}줄`], ...run.slice(run.length - tail));
    else out.push(...run);
    run = [];
  };
  for (const r of rows) { if (r[0] === " ") run.push(r); else { flush(false); out.push(r); } }
  flush(true);
  return out;
}

export function editRows(args) {
  const edits = Array.isArray(args?.edits) ? args.edits : args?.oldText != null ? [args] : [];
  const rows = [];
  edits.forEach((edit, k) => {
    if (k) rows.push([" ", "⋯"]);
    rows.push(...lineDiff(String(edit.oldText ?? ""), String(edit.newText ?? "")));
  });
  return rows;
}

// what a write does: against the file there now (`was`, from the server) when
// there is one, else all new; past `limit` rows the rest waits for "모두 보기"
export function writeRows(args, limit = 120, was) {
  const content = String(args?.content ?? "").replace(/\r\n/g, "\n");
  const rows = typeof was === "string" ? foldSame(lineDiff(was.replace(/\r\n/g, "\n"), content)) : content.split("\n").map((l) => ["+", l]);
  if (!limit || rows.length <= limit) return rows;
  return [...rows.slice(0, limit), [" ", `… ${rows.length - limit}줄 더`]];
}
