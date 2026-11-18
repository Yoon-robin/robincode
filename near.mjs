// When an edit's oldText is not in the file: the lines of the file most like
// it, as they are. A small model's most common miss is a line it remembers
// a little wrong (indentation, a word changed since it read, a line left
// out); Pi already forgives trailing spaces and smart quotes, so what is left
// is shown back to it instead of a bare "Could not find" it tries again
// blindly (Aider's "Did you mean", OpenCode's replacers).

// how alike two lines are, 0..1: shared pairs of letters (Dice), spaces aside
const pairs = (s) => {
  const t = s.replace(/\s+/g, " ").trim();
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const p = t.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); }
  return { m, n: Math.max(0, t.length - 1), t };
};
function alike(a, b) {
  if (a.t === b.t) return 1;
  if (!a.n || !b.n) return a.t === b.t ? 1 : 0;
  let both = 0;
  for (const [p, k] of a.m) both += Math.min(k, b.m.get(p) || 0);
  return (2 * both) / (a.n + b.n);
}

// the best sum of likeness pairing want's lines with the window's in order
function align(W, L, at, len) {
  let prev = new Array(len + 1).fill(0);
  for (let j = 1; j <= W.length; j++) {
    const row = new Array(len + 1).fill(0);
    for (let k = 1; k <= len; k++) row[k] = Math.max(prev[k], row[k - 1], prev[k - 1] + alike(W[j - 1], L[at + k - 1]));
    prev = row;
  }
  return prev[len];
}

// { from, to (1-based lines), text, score } or null when nothing is close
export function nearest(content, oldText, { min = 0.6, maxFile = 2_000_000, maxLines = 80 } = {}) {
  if (typeof content !== "string" || typeof oldText !== "string" || content.length > maxFile) return null;
  const want = oldText.replace(/\r\n/g, "\n").split("\n");
  while (want.length && !want[0].trim()) want.shift();
  while (want.length && !want.at(-1).trim()) want.pop();
  if (!want.length || want.length > maxLines) return null;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const W = want.map(pairs);
  const L = lines.map(pairs);
  // a window as long as oldText, and one line shorter or longer (a line left out, one added)
  let best = null;
  for (const len of new Set([want.length, want.length - 1, want.length + 1].filter((n) => n > 0))) {
    for (let i = 0; i + len <= lines.length; i++) {
      // the first line has to be somewhat like one of the first two wanted: most windows end here
      if (alike(L[i], W[0]) < 0.3 && (W.length < 2 || alike(L[i], W[1]) < 0.3)) continue;
      // lines paired in order, one left out on either side allowed (a small alignment)
      const s = align(W, L, i, len);
      const score = s / Math.max(want.length, len);
      if (!best || score > best.score) best = { from: i + 1, to: i + len, score };
    }
  }
  if (!best || best.score < min || best.score === 1) return null;
  return { ...best, text: lines.slice(best.from - 1, best.to).join("\n"), score: Math.round(best.score * 100) / 100 };
}

export function hint(found, maxChars = 3000) {
  if (!found) return "";
  const text = found.text.length > maxChars ? `${found.text.slice(0, maxChars)}\n…` : found.text;
  return `(RobinCode 알림) oldText와 가장 비슷한 실제 줄은 ${found.from}~${found.to}행(${Math.round(found.score * 100)}% 같음)이에요. 고치려던 곳이 여기라면 아래 글자를 들여쓰기까지 그대로 oldText에 쓰세요. 아니라면 read로 다시 보세요.\n\`\`\`\n${text}\n\`\`\``;
}
