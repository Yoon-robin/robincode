// A whole file's diff for the review sheet: the lines both sides share at the
// start and the end are set aside first (an agent's change is small in a big
// file), the middle gets an LCS line diff, and unchanged runs fold into hunks
// with a few lines around each change, as `git diff` shows it. Line numbers on
// both sides. Plain JS (no JSX) so the tests can load it.

const CONTEXT = 3;
// past this many cells the middle shows as all removed then all added
const MAX_CELLS = 4_000_000;

const linesOf = (text) => {
  if (!text) return [];
  const all = text.replace(/\r\n/g, "\n").split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
};

// [[sign, text, oldNo, newNo]] for every line, sign " " / "-" / "+"
export function fileRows(before, after) {
  const a = linesOf(before);
  const b = linesOf(after);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const rows = [];
  for (let i = 0; i < s; i++) rows.push([" ", a[i], i + 1, i + 1]);
  const am = a.slice(s, a.length - e);
  const bm = b.slice(s, b.length - e);
  let i = 0;
  let j = 0;
  const n = am.length;
  const m = bm.length;
  if (n && m && n * m <= MAX_CELLS) {
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) dp[x * W + y] = am[x] === bm[y] ? dp[(x + 1) * W + y + 1] + 1 : Math.max(dp[(x + 1) * W + y], dp[x * W + y + 1]);
    }
    while (i < n && j < m) {
      if (am[i] === bm[j]) { rows.push([" ", am[i], s + i + 1, s + j + 1]); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { rows.push(["-", am[i], s + i + 1, null]); i++; }
      else { rows.push(["+", bm[j], null, s + j + 1]); j++; }
    }
  }
  for (; i < n; i++) rows.push(["-", am[i], s + i + 1, null]);
  for (; j < m; j++) rows.push(["+", bm[j], null, s + j + 1]);
  for (let k = 0; k < e; k++) rows.push([" ", a[a.length - e + k], a.length - e + k + 1, b.length - e + k + 1]);
  return rows;
}

// { add, del, hunks: [{ rows, oldStart, newStart }] } — unchanged lines beyond
// CONTEXT around a change are left out
export function fileHunks(before, after, context = CONTEXT) {
  const rows = fileRows(before, after);
  let add = 0;
  let del = 0;
  const near = new Uint8Array(rows.length);
  rows.forEach((r, k) => {
    if (r[0] === " ") return;
    if (r[0] === "+") add++; else del++;
    for (let x = Math.max(0, k - context); x <= Math.min(rows.length - 1, k + context); x++) near[x] = 1;
  });
  const hunks = [];
  let cur = null;
  rows.forEach((r, k) => {
    if (!near[k]) { cur = null; return; }
    if (!cur) { cur = { rows: [], oldStart: r[2] ?? null, newStart: r[3] ?? null }; hunks.push(cur); }
    cur.rows.push(r);
    cur.oldStart ??= r[2] ?? null;
    cur.newStart ??= r[3] ?? null;
  });
  return { add, del, hunks };
}
