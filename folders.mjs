// Where RobinCode opens: the folder list behind the folder screen (web/picker),
// the same list ops/windows/robincode-ui.ps1 makes for robincode.cmd, sharing
// its file. Folders RobinCode opened (recent.json: when each was last opened,
// and the ones taken off the list with Del) and the folders Claude Code knows
// (the project keys of ~/.claude.json, with the time of their newest
// conversation file in ~/.claude/projects), newest first. Folders that are gone
// and Claude Code's ones under %TEMP% (test runs) are left out. Typing narrows
// it down; a typed C:\, ~\ or \\ is a path, its folders listed under it.
// ROBINCODE_RECENT and ROBINCODE_CLAUDE_HOME point elsewhere for tests.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const recentFile = process.env.ROBINCODE_RECENT || join(local, "RobinCode", "recent.json");
const claudeHome = process.env.ROBINCODE_CLAUDE_HOME || homedir();
const userHome = (process.env.USERPROFILE || homedir()).replace(/\\+$/, "");
const tempRoot = `${resolve(process.env.TEMP || join(local, "Temp")).replace(/\\+$/, "")}\\`.toLowerCase();
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// C:\a\b\ -> C:\a\b, C: -> C:\
// (elsewhere, as on the Linux server where the tests also run, "\" is not a
// separator: /a/b/ -> /a/b, and the path is left as it is)
export function cleanPath(p) {
  if (process.platform !== "win32") { const s = resolve(String(p)); return s.length > 1 ? s.replace(/\/+$/, "") : s; }
  let s = resolve(String(p).replace(/\//g, "\\"));
  if (s.length > 3) s = s.replace(/\\+$/, "");
  return s;
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function readRecent() {
  const r = { used: new Map(), hidden: new Set() };
  try {
    const j = JSON.parse(readFileSync(recentFile, "utf8").replace(/^\uFEFF/, ""));
    for (const p of [].concat(j.used || [])) if (p?.path) r.used.set(String(p.path), Number(p.at) || 0);
    for (const h of [].concat(j.hidden || [])) if (h) r.hidden.add(String(h));
  } catch { /* none yet */ }
  return r;
}
function saveRecent(r) {
  const used = [...r.used].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([path, at]) => ({ path, at }));
  mkdirSync(dirname(recentFile), { recursive: true });
  const fresh = `${recentFile}.${process.pid}.new`;
  writeFileSync(fresh, JSON.stringify({ used, hidden: [...r.hidden] }, null, 2));
  renameSync(fresh, recentFile);
}
// a folder just opened goes to the top (and back on the list after a Del)
export function addRecent(path) {
  try {
    const r = readRecent();
    const p = cleanPath(path);
    for (const k of [...r.used.keys()]) if (same(k, p)) r.used.delete(k);
    r.used.set(p, Date.now());
    for (const h of [...r.hidden]) if (same(h, p)) r.hidden.delete(h);
    saveRecent(r);
  } catch { /* the list is only a help */ }
}
export function hideRecent(path) {
  try { const r = readRecent(); r.hidden.add(String(path)); saveRecent(r); } catch { /* as above */ }
}
export function unhideRecent(path) {
  try {
    const r = readRecent();
    for (const h of [...r.hidden]) if (same(h, String(path))) r.hidden.delete(h);
    saveRecent(r);
  } catch { /* as above */ }
}

export function branchOf(dir) {
  try {
    let g = join(dir, ".git");
    const st = statSync(g, { throwIfNoEntry: false });
    if (!st) return "";
    if (st.isFile()) {
      // a worktree or submodule: .git is a file pointing at the real one
      const m = readFileSync(g, "utf8").trim().match(/^gitdir: (.+)$/);
      if (!m) return "";
      g = isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
    }
    const head = readFileSync(join(g, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    if (m) return m[1];
    if (/^[0-9a-f]{7}/.test(head)) return head.slice(0, 7);
  } catch { /* not a repository */ }
  return "";
}

export function ago(ms) {
  if (!ms || ms <= 0) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "어제";
  if (d < 14) return `${d}일 전`;
  if (d < 60) return `${Math.floor(d / 7)}주 전`;
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// every folder for the list, newest first; `def` (this repository) always on it
export function allFolders(def) {
  const r = readRecent();
  const at = new Map(r.used);
  const put = (p, t) => {
    const k = [...at.keys()].find((x) => same(x, p)) ?? p;
    if (!at.has(k) || at.get(k) < t) at.set(k, t);
  };
  try {
    const text = readFileSync(join(claudeHome, ".claude.json"), "utf8");
    const projects = join(claudeHome, ".claude", "projects");
    for (const m of text.matchAll(/"([A-Za-z]:[/\\][^"]*)"\s*:\s*\{/g)) {
      const p = cleanPath(m[1].replace(/\\\\/g, "\\"));
      if (`${p}\\`.toLowerCase().startsWith(tempRoot)) continue;
      // Claude Code's folder for the project: each character but a-z 0-9 as -
      const conv = join(projects, p.replace(/[^A-Za-z0-9]/g, "-"));
      let t = 0;
      try {
        for (const f of readdirSync(conv)) if (f.endsWith(".jsonl")) t = Math.max(t, statSync(join(conv, f)).mtimeMs);
      } catch { /* no conversations */ }
      put(p, Math.round(t));
    }
  } catch { /* no Claude Code */ }
  if (def && ![...at.keys()].some((k) => same(k, def))) at.set(def, 0);
  const hidden = [...r.hidden].map((h) => h.toLowerCase());
  const list = [];
  for (const [path, t] of at) {
    if (hidden.includes(path.toLowerCase()) || !isDir(path)) continue;
    list.push({ kind: "folder", path, name: basename(path) || path, at: t });
  }
  return list.sort((a, b) => b.at - a.at || (same(a.path, def || "") ? -1 : same(b.path, def || "") ? 1 : a.name.localeCompare(b.name)));
}

export function shortPath(p) {
  if (same(p, userHome)) return "~";
  if (p.toLowerCase().startsWith(`${userHome.toLowerCase()}\\`)) return `~${p.slice(userHome.length)}`;
  return p;
}
// a long path cut in the middle, both ends kept
function cutPath(p, max = 72) {
  if (p.length <= max) return p;
  const head = Math.floor((max - 1) * 0.4);
  return `${p.slice(0, head)}…${p.slice(p.length - (max - 1 - head))}`;
}
const bare = (q) => q.trim().replace(/^"|"$/g, "");
export const pathLike = (q) => /^([A-Za-z]:|\\\\|~([\\/]|$)|[\\/])/.test(bare(q));
function resolveTyped(q) {
  let t = bare(q).replace(/\//g, "\\");
  if (t.startsWith("~")) t = userHome + t.slice(1);
  if (/^[A-Za-z]:$/.test(t)) t += "\\";
  return t;
}
// Windows' own hidden folders and old junctions (AppData, Application Data…)
const SKIP = new Set(["appdata", "programdata", "system volume information", "recovery", "config.msi", "msocache", "documents and settings"]);
// the folders under what was typed whose names start with its last part
function completions(q) {
  const t = resolveTyped(q);
  let parent;
  let part;
  if (t.endsWith("\\")) { parent = t; part = ""; } else { parent = dirname(t); part = basename(t); }
  if (!parent || !isDir(parent)) return [];
  parent = `${parent.replace(/\\+$/, "")}\\`;
  let entries;
  try { entries = readdirSync(parent, { withFileTypes: true }); } catch { return []; }
  const low = part.toLowerCase();
  return entries
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && d.name.toLowerCase().startsWith(low)
      && !SKIP.has(d.name.toLowerCase()) && !d.name.startsWith("$")
      // .git, .vscode… only when the typed part starts with a dot
      && (part.startsWith(".") || !d.name.startsWith(".")))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `${parent}${name}`);
}
const rowOut = (row) => ({
  kind: row.kind, path: row.path, ok: row.kind === "path" ? !!row.ok : true,
  name: row.name || "", short: cutPath(shortPath(row.path)),
  branch: row.kind === "path" ? "" : branchOf(row.path), ago: ago(row.at),
});

// what the list shows for the search box, at most `max` rows: for a typed path,
// that folder and the folders in it (the path row only says "not there" when
// nothing matches either), else the folders matching every word
export function rows(all, q, max = 60) {
  const out = [];
  let mode = "recent";
  if (pathLike(q)) {
    mode = "path";
    const t = resolveTyped(q);
    const ok = isDir(t);
    const kids = completions(q).map((p) => ({ kind: "child", path: p, name: basename(p), at: 0 }));
    if (ok || !kids.length) out.push({ kind: "path", path: t.length > 3 ? t.replace(/\\+$/, "") : t, ok });
    out.push(...kids.slice(0, max - out.length));
  } else if (q.trim()) {
    mode = "search";
    const words = q.trim().toLowerCase().split(/\s+/);
    const found = all.filter((f) => words.every((w) => f.path.toLowerCase().includes(w)));
    // the ones whose own name starts with it first
    found.sort((a, b) => (a.name.toLowerCase().startsWith(words[0]) ? 0 : 1) - (b.name.toLowerCase().startsWith(words[0]) ? 0 : 1) || b.at - a.at);
    out.push(...found.slice(0, max));
  } else out.push(...all.slice(0, max));
  return { mode, total: all.length, rows: out.map(rowOut) };
}

export const folderExists = (p) => !!p && existsSync(p) && isDir(p);
