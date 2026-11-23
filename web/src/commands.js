// `/` commands of the message box (Claude Code's slash commands). The folder's
// prompt templates (`/이름`) and skills (`/skill:이름`) come from the server and
// go to the model as they are (Pi expands them); these are done by the window.
export const BUILTIN = [
  { name: "new", hint: "새 대화를 열어요" },
  { name: "clear", hint: "새 대화를 열어요 (/new와 같아요)" },
  { name: "compact", hint: "앞부분을 요약해서 줄여요. 뒤에 남길 것을 적어도 돼요", arg: "남길 것" },
  { name: "init", hint: "이 폴더를 살펴보고 AGENTS.md(모델이 읽는 지시 파일)를 만들어요" },
  { name: "memory", hint: "모델이 읽는 지시 파일을 봐요. 뒤에 한 줄을 적으면 AGENTS.md에 더해요", arg: "더할 한 줄" },
  { name: "mode", hint: "모드: ask(묻고 실행) · edits(수정은 바로) · auto(바로 실행) · plan(계획만)", arg: "모드" },
  { name: "plan", hint: "계획 모드: 읽고 찾아보기만 하고 계획을 써요" },
  { name: "permissions", hint: "이 폴더에서 \"늘 허용\"한 명령과 사이트를 보고 지워요" },
  { name: "think", hint: "모델이 답하기 전에 생각하기를 켜고 꺼요" },
  { name: "changes", hint: "이 대화가 바꾼 파일을 한곳에서 보고, 파일마다 되돌려요" },
  { name: "diff", hint: "이 대화가 바꾼 파일을 봐요 (/changes와 같아요)" },
  { name: "review", hint: "마지막 커밋 뒤에 바뀐 것을 새 대화에서 검토해요(읽기만). 뒤에 특히 볼 것을 적어도 돼요", arg: "특히 볼 것" },
  { name: "usage", hint: "모델이 일한 시간과 그 시간의 GPU 값을 봐요" },
  { name: "export", hint: "이 대화를 Markdown 파일로 저장해요" },
  { name: "version", hint: "RobinCode 판과 바뀐 것을 봐요. 새 판도 확인해요" },
  { name: "help", hint: "명령과 단축키를 봐요" },
];
const NAMES = new Set(BUILTIN.map((c) => c.name));
// what needs a folder: not in a plain conversation's list (it has no files,
// commands or modes)
export const FOLDER_ONLY = new Set(["init", "memory", "mode", "plan", "changes", "diff", "review"]);
// "/compact 무엇을" -> { name: "compact", arg: "무엇을" } for the window's own; null otherwise
export function ownCommand(text) {
  const m = text.match(/^\/([a-z]+)(?:\s+([^]*))?$/i);
  if (!m || !NAMES.has(m[1].toLowerCase())) return null;
  return { name: m[1].toLowerCase(), arg: (m[2] || "").trim() };
}
export const INIT_PROMPT = `이 폴더를 살펴보고 AGENTS.md를 만들어 줘(이미 있으면 빠진 것만 고쳐 줘). 앞으로 이 폴더에서 일할 때 네가 먼저 읽는 파일이야.
넣을 것:
- 이 프로젝트가 무엇인지 두세 줄
- 설치·빌드·실행·시험 명령 (package.json, Makefile, README 등에서 확인한 것만)
- 폴더 구조의 요점 (중요한 폴더와 파일)
- 코드 스타일, 지켜야 할 규칙, 함정
짧고 사실만 써 줘. 확인하지 못한 건 추측해서 넣지 마.`;
