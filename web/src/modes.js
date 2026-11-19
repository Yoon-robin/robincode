// How much the agent does without asking (Claude Code's permission modes),
// in the order Shift+Tab goes through them
export const MODES = ["ask", "edits", "auto", "plan"];
export const MODE_NAMES = { ask: "묻고 실행", edits: "수정은 바로", auto: "바로 실행", plan: "계획만" };
export const MODE_TIPS = {
  ask: "명령 실행, 파일 수정, 웹 페이지 읽기 전에 물어요.",
  edits: "파일 수정은 묻지 않고 바로 해요. 명령과 웹 페이지는 물어요.",
  auto: "아무것도 묻지 않고 바로 해요. 지우기, 강제 push처럼 되돌릴 수 없는 것도요.",
  plan: "읽고 찾아보기만 하고 계획을 써요. 아무것도 고치거나 실행하지 않아요.",
};
export const LAMPS = { ask: "idle", edits: "on", auto: "warn", plan: "plan" };
export const nextMode = (mode) => MODES[(MODES.indexOf(mode) + 1) % MODES.length];
