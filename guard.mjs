// What asks robin in every mode — "바로 실행" too — and never becomes "늘 허용":
// what cannot be put back. RobinCode's checkpoints keep only what edit and
// write changed, so a command that deletes a folder, throws away uncommitted
// work or force-pushes is gone for good; a file changed outside the folder or
// inside .git is not the project's; a secret read goes into the model's
// context (and from there anywhere). Claude Code's deny rules and protected
// paths, Crush's dangerous commands (yolo too), Codex's execpolicy.
// A guard against a model's mistake, not a sandbox: a command written to get
// round it (a script file, an alias) still can.
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// where a tool's path really goes — Pi's resolveToCwd (pi-coding-agent
// dist/utils/paths.js normalizePath), so the guard and RobinCode's backups
// look at the file Pi changes: odd spaces, a leading @, `/c/x` (Git Bash) on
// Windows, `~`, file:// (2026-11-19 codex: `@.env`, `~/x`, `file:///C:/…` got
// past the checks)
const ODD_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// the folder goes through the same (Pi's resolvePath: no @ or odd spaces there)
function normal(p, tool) {
  let s = String(p ?? "");
  if (tool) { s = s.replace(ODD_SPACES, " "); if (s.startsWith("@")) s = s.slice(1); }
  if (process.platform === "win32" && s.startsWith("/") && !s.startsWith("//") && !s.includes("\\")) {
    const m = s.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) s = `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (s === "~") s = homedir();
  else if (s.startsWith("~/") || (process.platform === "win32" && s.startsWith("~\\"))) s = join(homedir(), s.slice(2));
  else if (/^file:\/\//.test(s)) { try { s = fileURLToPath(s); } catch { /* left as it is */ } }
  return s;
}
const folderOf = (cwd) => resolve(normal(cwd, false));
export const toolPath = (cwd, p) => resolve(folderOf(cwd), normal(p, true));

// Windows drops a name's trailing dots and spaces (`.env.` opens .env) and
// reads `name:stream` as the file itself (`.git::$INDEX_ALLOCATION` is the .git
// folder): the checks look at the name Windows opens (2026-11-19 security review)
const DRIVE = /^[a-z]:$/i;
const cleanPart = (part, i) => (i === 0 && DRIVE.test(part) ? part : part.replace(/:.*$/s, "").replace(/(?<=[^.])[. ]+$/, ""));
// (only on Windows: elsewhere `a:b` and `x.` are names of their own — codex 2026-11-19)
export const cleanPath = (p) => process.platform !== "win32" ? String(p) : String(p).split(/([\\/])/).map((part, i) => (i % 2 ? part : cleanPart(part, i))).join("");
// an NTFS stream named in a path (`a.txt:hidden`) — nothing a project needs
const hasStream = (p) => process.platform === "win32" && String(p).split(/[\\/]/).some((part, i) => part.includes(":") && !(i === 0 && DRIVE.test(part)));

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
const SECRET_WORD = /(^|[\s'"\\/=(])(\.env(\.(?!example\b|sample\b|template\b)[\w-]+)?|id_(rsa|dsa|ecdsa|ed25519)|\.git-credentials|\.npmrc|[\w-]+\.(pem|pfx|p12))\.*(?=$|[\s'")\\/;|:])|(^|[\s'"=(])[^\s'"]*[\\/]\.ssh[\\/]/i;

// by its name and the folders it is in under the work folder (a work folder
// that is itself inside .ssh does not make every file a secret)
export const secretPath = (p, cwd = "") => {
  if (!p) return false;
  const full = cleanPath(cwd ? toolPath(cwd, p) : String(p));
  const shownPath = cwd ? relative(cleanPath(folderOf(cwd)), full) : full;
  return SECRET_NAME.test(basename(full)) || SECRET_DIR.test(shownPath.startsWith("..") || isAbsolute(shownPath) ? full : shownPath);
};

// outside the folder (another drive is an absolute relative path on Windows)
export function outside(cwd, p) {
  const r = relative(folderOf(cwd), toolPath(cwd, p));
  return r === ".." || r.startsWith(`..${sep}`) || r.startsWith("../") || isAbsolute(r);
}
// Windows (and a Mac's disk) does not tell .GIT from .git
const inGit = (cwd, p) => relative(cleanPath(folderOf(cwd)), cleanPath(toolPath(cwd, p))).split(/[\\/]/).some((part) => part.toLowerCase() === ".git");

// why this call asks whatever the mode, or null
export function danger(cwd, name, input) {
  if (name === "powershell" || name === "bash") {
    const c = String(input?.command || "");
    for (const [re, why] of COMMANDS) if (re.test(c)) return why;
    if (SECRET_WORD.test(c)) return "비밀 파일 열기";
    return null;
  }
  const p = input?.path;
  // grep gives the lines it matched back: a secret file (or a glob for one)
  // searched is a secret read (Pi's grep searches hidden files too)
  if (name === "grep") {
    if (p && secretPath(p, cwd)) return "비밀 파일 읽기(grep)";
    const g = String(input?.glob || "").replace(/^\*\*\//, "");
    if (g && (secretPath(g) || /(^|\/)\.env\b|\.(pem|key|pfx|p12)\b|id_(rsa|ed25519)/i.test(g)) && !/^!/.test(g)) return "비밀 파일 읽기(grep)";
    return null;
  }
  if (!p) return null;
  if ((name === "read" || name === "edit" || name === "write") && hasStream(toolPath(cwd, p))) return "파일 스트림(:) 다루기";
  if (name === "read") return secretPath(p, cwd) ? "비밀 파일 읽기" : null;
  if (name === "edit" || name === "write") {
    if (outside(cwd, p)) return "폴더 밖 파일 고치기";
    if (inGit(cwd, p)) return ".git 안 고치기";
    if (secretPath(p, cwd)) return "비밀 파일 고치기";
  }
  return null;
}

// a grep over a folder (Pi's searches hidden files too): the lines it found in
// secret files are taken out of what the model sees, unless robin said yes to
// that search (danger asked). Pi's lines: `path:12: text`, context `path-12- text`
// (2026-11-19 codex: `grep TOKEN .` handed .env's lines over)
const GREP_LINE = /^(.+?)(?::\d+:|-\d+-) /;
export function dropSecretLines(text) {
  let dropped = 0;
  const kept = String(text).split("\n").filter((line) => {
    const m = line.match(GREP_LINE);
    if (m && secretPath(m[1])) { dropped++; return false; }
    return true;
  });
  return { text: kept.join("\n"), dropped };
}
