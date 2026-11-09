// Updates for an installed RobinCode (the zip from ai.yoonrobin.xyz; robin
// 2026-11-09 "자동업데이트기능만들어줘": downloaded on its own, used from the
// next start). The releases are on the server in /opt/stack/robincode-dist
// (scripts/release-robincode.mjs puts them there, ai.yoonrobin.xyz offers the
// full zip from there to robin's account): latest.json says the newest, and
// robincode-app-<version>.zip is RobinCode without Electron (~40 MB). They come
// over `ssh contabo`, which RobinCode needs anyway (the model, the GPU), so
// there is no new key. A new version goes to <home>\versions\<version>, which
// loader.cjs starts next time; one that needs another Electron is only told
// (the whole zip has to come from ai.yoonrobin.xyz again).
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const DIST = process.env.ROBINCODE_UPDATE_DIST || "/opt/stack/robincode-dist"; // another folder: tests
const SSH = ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

const run = (cmd, args, timeout) => new Promise((done) => {
  execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 1e6 }, (err, out, errOut) => done({ ok: !err, out: String(out || ""), err: String(errOut || err?.message || "") }));
});
const sha256 = (file) => new Promise((done, fail) => {
  const h = createHash("sha256");
  createReadStream(file).on("data", (b) => h.update(b)).on("end", () => done(h.digest("hex"))).on("error", fail);
});
const safe = (v) => /^[\w.-]{1,80}$/.test(String(v || ""));

// mine: { version, build, electron } of the running copy; home: settings
// folder; log(text); tell(state) for the window. Returns { check, state }.
function updater({ mine, home, log, tell, host = process.env.ROBINCODE_UPDATE_HOST || "contabo" }) {
  const versions = join(home, "versions");
  let state = { version: mine.version, ready: null, shell: null, checking: false, error: null };
  const set = (change) => { state = { ...state, ...change }; tell(state); };
  let busy = false;

  async function check() {
    if (busy) return state;
    busy = true;
    set({ checking: true, error: null });
    try {
      const r = await run("ssh", [...SSH, host, `cat ${DIST}/latest.json`], 30000);
      if (!r.ok) throw new Error("서버에 닿지 않아요(ssh contabo)");
      const latest = JSON.parse(r.out);
      if (!safe(latest.version) || !safe(latest.app?.file) || !/^[0-9a-f]{64}$/.test(latest.app?.sha256 || "")) throw new Error("latest.json이 이상해요");
      if (!(Number(latest.build) > Number(mine.build))) { set({ checking: false }); return state; }
      // another Electron: this exe cannot run it, the whole zip has to come again
      if (latest.electron && latest.electron !== process.versions.electron) {
        set({ checking: false, shell: latest.version });
        log(`새 판 ${latest.version}은 Electron ${latest.electron}이 필요해서 ai.yoonrobin.xyz에서 다시 받아야 해요.\n`);
        return state;
      }
      const to = join(versions, latest.version);
      if (existsSync(join(to, "bad"))) {
        // it was downloaded and did not start: not again (a newer one will come)
        set({ checking: false, error: `새 판 ${latest.version}이 켜지지 않아서 쓰지 않아요` });
        return state;
      }
      if (!existsSync(join(to, "version.json"))) {
        mkdirSync(versions, { recursive: true });
        const zip = join(versions, `${latest.version}.zip.part`);
        const tmp = join(versions, `${latest.version}.tmp`);
        rmSync(tmp, { recursive: true, force: true });
        log(`새 판 ${latest.version}을 받는 중이에요.\n`);
        const got = await run("scp", ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${host}:${DIST}/${latest.app.file}`, zip], 15 * 60000);
        if (!got.ok) throw new Error(`새 판을 받지 못했어요: ${got.err.trim().slice(0, 160)}`);
        if ((await sha256(zip)) !== latest.app.sha256) { rmSync(zip, { force: true }); throw new Error("받은 파일이 깨졌어요(sha256이 달라요)"); }
        mkdirSync(tmp, { recursive: true });
        // tar.exe (Windows 10+) opens zip files
        const x = await run(join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", tmp], 5 * 60000);
        rmSync(zip, { force: true });
        if (!x.ok || !existsSync(join(tmp, "version.json")) || !existsSync(join(tmp, "desktop", "main.cjs"))) {
          rmSync(tmp, { recursive: true, force: true });
          throw new Error(`새 판을 풀지 못했어요: ${x.err.trim().slice(0, 160)}`);
        }
        rmSync(to, { recursive: true, force: true });
        renameSync(tmp, to);
        log(`새 판 ${latest.version}을 받아 뒀어요. 다음에 켤 때 바뀌어요.\n`);
      }
      set({ checking: false, ready: latest.version });
      tidy(latest.version);
    } catch (e) {
      log(`새 판 확인: ${e.message}\n`);
      set({ checking: false, error: e.message });
    } finally {
      busy = false;
    }
    return state;
  }

  // only the running one and the newest stay (each is ~150 MB unpacked)
  function tidy(newest) {
    try {
      for (const v of readdirSync(versions)) {
        if (v === newest || v === mine.version) continue;
        rmSync(join(versions, v), { recursive: true, force: true });
      }
    } catch { /* nothing to tidy */ }
  }

  return { check, state: () => state };
}

// a downloaded version that did not start: loader.cjs skips it from now on
function markBad(dir, why) {
  try { writeFileSync(join(dir, "bad"), `${new Date().toISOString()} ${why}\n`); return true; } catch { return false; }
}

module.exports = { updater, markBad };
