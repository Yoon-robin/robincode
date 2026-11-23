// What the model is given beyond the conversation itself, kept apart from
// server.mjs so the tests can run it:
//   maskOld     old, long tool results are replaced by a line (B-421)
//   recallText  what a summary may have dropped: the task list, the last plan,
//               the files changed lately (B-422)

// Tools whose results can be had again by calling them again.
const AGAIN = new Set(["read", "grep", "find", "ls", "webfetch", "powershell", "bash"]);
const textLength = (m) => (Array.isArray(m.content) ? m.content : []).reduce((n, p) => n + (p.type === "text" ? (p.text || "").length : 0), 0);
export const maskedLine = (tool, chars) => `[가림] 오래된 ${tool} 결과라 지웠어요(${chars}자). 지금도 필요하면 같은 도구로 다시 보세요.`;

// messages: Pi's list for one model call (the "context" event). masked: the
// ids already replaced (kept by the caller for the conversation). When the
// context is past `at` percent and the results older than the newest `keep`
// hold at least `worth` characters, all of those are added to `masked` at once
// — one break of the model's prompt cache, not one per call (a changed early
// message makes llama.cpp read everything after it again). Returns the list
// with every masked result replaced, or null when nothing is masked.
export function maskOld(messages, masked, { percent = 0, at = 50, keep = 8, min = 1500, worth = 20000 } = {}) {
  const results = messages.filter((m) => m.role === "toolResult");
  if (percent >= at) {
    const old = results.slice(0, Math.max(0, results.length - keep))
      .filter((m) => !m.isError && AGAIN.has(m.toolName) && !masked.has(m.toolCallId) && textLength(m) >= min);
    if (old.reduce((n, m) => n + textLength(m), 0) >= worth) for (const m of old) masked.add(m.toolCallId);
  }
  if (!results.some((m) => masked.has(m.toolCallId))) return null;
  return messages.map((m) => (m.role === "toolResult" && masked.has(m.toolCallId)
    ? { ...m, content: [{ type: "text", text: maskedLine(m.toolName, textLength(m)) }] } : m));
}

const MARK = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };
// todo: [{ text, status }] of the newest task list; plan: the last plan written
// in plan mode; files: the paths changed lately, newest last. "" when there is
// nothing to say.
export function recallText({ todo, plan, files } = {}) {
  const parts = [];
  const open = (todo || []).filter((x) => x && x.text);
  if (open.length && open.some((x) => x.status !== "completed")) {
    parts.push(`할 일 판(지금 그대로):\n${open.map((x) => `${MARK[x.status] || "[ ]"} ${x.text}`).join("\n")}`);
  }
  if (plan && plan.trim()) parts.push(`계획 모드에서 쓴 마지막 계획:\n${plan.trim().slice(0, 4000)}`);
  const recent = [...new Set((files || []).filter(Boolean))].slice(-5);
  if (recent.length) parts.push(`최근에 고친 파일: ${recent.join(", ")}\n다시 고치기 전에 read로 지금 내용을 확인하세요.`);
  return parts.length ? `(RobinCode 알림) 앞부분을 요약했어요. 요약에서 빠졌을 수 있는 것을 다시 적어요.\n\n${parts.join("\n\n")}` : "";
}
