// What asks robin in every mode — "바로 실행" too — and never becomes "늘 허용":
// what cannot be put back. RobinCode's checkpoints keep only what edit and
// write changed, so a command that deletes a folder, throws away uncommitted
// work or force-pushes is gone for good; a file changed outside the folder or
// inside .git is not the project's; a secret read goes into the model's
// context (and from there anywhere). Claude Code's deny rules and protected
// paths, Crush's dangerous commands (yolo too), Codex's execpolicy.
// A guard against a model's mistake, not a sandbox: a command written to get
// round it (a script file, an alias) still can.
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

// one command of a chain: what follows up to ; | & or a new line
const ARGS = "[^;|&\\n]*";
const COMMANDS = [
  // Remove-Item -Recurse, rm -rf, del /s, rd /s (not docker's --rm)
  [new RegExp(`(?<![-\\w])(remove-item|rm|ri|del|erase|rmdir|rd)\\b${ARGS}\\s(-r[a-z]*|/s)\\b`, "i"), "폴더째 지우기"],
  // what a pipe hands over (`gci -r *.log | Remove-Item`, `ls | % { rm $_ }`),
  // a wildcard (`Remove-Item *`, `del *.*`), .NET's own, the recycle bin
  [/\|\s*((foreach-object|%)\s*\{\s*)?(remove-item|rm|ri|del|erase|rmdir|rd)\b(?!-)/i, "넘겨받은 것 모두 지우기"],
  [new RegExp(`(?<![-\\w])(remove-item|rm|ri|del|erase)\\b${ARGS}\\*`, "i"), "여러 파일 지우기(*)"],
  [/\[(system\.)?io\.(directory|file)\]::delete\b/i, "지우기(.NET)"],
  [/\bclear-recyclebin\b/i, "휴지통 비우기"],
  [new RegExp(`\\bgit\\b${ARGS}\\bpush\\b${ARGS}(\\s--force(-with-lease)?\\b|\\s-f\\b|\\s\\+[\\w/])`, "i"), "강제 push"],
  [new RegExp(`\\bgit\\b${ARGS}\\breset\\b${ARGS}\\s--hard\\b`, "i"), "커밋 안 한 것 버리기(reset --hard)"],
  [new RegExp(`\\bgit\\b${ARGS}\\bclean\\b${ARGS}\\s-[a-z]*f`, "i"), "git이 모르는 파일 지우기(clean)"],
  [new RegExp(`\\bgit\\b${ARGS}\\b(checkout|restore)\\b${ARGS}\\s(--\\s+)?\\.(?=\\s|$)`, "i"), "고친 것 모두 버리기"],
  [new RegExp(`\\bgit\\b${ARGS}\\bbranch\\b${ARGS}\\s(-D|--delete\\s+--force|-d\\s+-f)\\b`), "브랜치 지우기"],
  [new RegExp(`\\bgit\\b${ARGS}\\bstash\\s+(drop|clear)\\b`, "i"), "stash 버리기"],
  [/\b(format-volume|clear-disk|initialize-disk|remove-partition|diskpart|stop-computer|restart-computer|shutdown)\b/i, "디스크·컴퓨터 다루기"],
  [/\bformat(\.com)?\s+[a-z]:/i, "디스크 포맷"],
  [new RegExp(`\\breg(\\.exe)?\\s+delete\\b|\\bremove-item(property)?\\b${ARGS}\\bhk(lm|cu|cr|u|cc):`, "i"), "레지스트리 지우기"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b/i, "패키지 공개"],
  [/\bset-executionpolicy\b/i, "실행 정책 바꾸기"],
];

// secrets by name: .env (not .env.example), private keys, tokens
const SECRET_NAME = /^(\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|credentials(\.json)?)$|\.(pem|key|pfx|p12|keystore|jks)$/i;
const SECRET_DIR = /(^|[\\/])\.(ssh|gnupg|aws|azure|docker|kube)([\\/]|$)/i;
// the same named in a command (`type .env`, `cat ~/.ssh/id_rsa`, `Get-Content x.pem`)
const SECRET_WORD = /(^|[\s'"\\/=(])(\.env(\.(?!example\b|sample\b|template\b)[\w-]+)?|id_(rsa|dsa|ecdsa|ed25519)|\.git-credentials|\.npmrc|[\w-]+\.(pem|pfx|p12))(?=$|[\s'")\\/;|])|(^|[\s'"=(])[^\s'"]*[\\/]\.ssh[\\/]/i;

export const secretPath = (p) => !!p && (SECRET_NAME.test(basename(String(p))) || SECRET_DIR.test(String(p)));

// outside the folder (another drive is an absolute relative path on Windows)
export function outside(cwd, p) {
  const r = relative(resolve(cwd), resolve(cwd, String(p)));
  return r === ".." || r.startsWith(`..${sep}`) || r.startsWith("../") || isAbsolute(r);
}
// Windows (and a Mac's disk) does not tell .GIT from .git
const inGit = (cwd, p) => relative(resolve(cwd), resolve(cwd, String(p))).split(/[\\/]/).some((part) => part.toLowerCase() === ".git");

// why this call asks whatever the mode, or null
export function danger(cwd, name, input) {
  if (name === "powershell" || name === "bash") {
    const c = String(input?.command || "");
    for (const [re, why] of COMMANDS) if (re.test(c)) return why;
    if (SECRET_WORD.test(c)) return "비밀 파일 열기";
    return null;
  }
  const p = input?.path;
  if (!p) return null;
  if (name === "read") return secretPath(p) ? "비밀 파일 읽기" : null;
  if (name === "edit" || name === "write") {
    if (outside(cwd, p)) return "폴더 밖 파일 고치기";
    if (inGit(cwd, p)) return ".git 안 고치기";
    if (secretPath(p)) return "비밀 파일 고치기";
  }
  return null;
}
