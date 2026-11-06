// A line diff of one edit (oldText -> newText), for the approval card and the
// finished edit step. Small texts get a real LCS diff so unchanged lines show
// as context; very large ones fall back to all-removed / all-added.

export function lineDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
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

export function DiffLines({ rows }) {
  return (
    <div className="diff" role="table">
      {rows.map(([sign, text], k) => (
        <div key={k} className={`diff-row ${KIND[sign]}`} role="row">
          <span className="diff-sign" aria-hidden="true">{sign}</span>
          <span className="diff-text">{text || " "}</span>
        </div>
      ))}
    </div>
  );
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

export function writeRows(args, limit = 120) {
  const lines = String(args?.content ?? "").split("\n");
  const rows = lines.slice(0, limit).map((l) => ["+", l]);
  if (lines.length > limit) rows.push([" ", `… ${lines.length - limit}줄 더`]);
  return rows;
}
