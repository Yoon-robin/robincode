// The one file built into RobinCode.exe. It only finds RobinCode's files and
// runs desktop/main.cjs from there, so the app changes without a new exe
// (only a new Electron needs one). Where, first found:
//   ROBINCODE_DIR            that robincode folder (tests, development)
//   the repository around    <repo>\robincode\desktop\out\RobinCode-win32-x64\RobinCode.exe:
//   the exe                  `git pull` changes it (robin's PCs with the repository)
//   installed (the zip from  the newest of what came in the zip (resources\robincode)
//   ai.yoonrobin.xyz)        and what main.cjs downloaded since
//                            (%LOCALAPPDATA%\RobinCode\versions\<version>), for this
//                            Electron; each has a version.json { version, build, electron }
const { app, dialog } = require("electron");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const runs = (dir) => existsSync(join(dir, "desktop", "main.cjs"));
const versionOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, "version.json"), "utf8")); } catch { return null; } };

function find() {
  if (process.env.ROBINCODE_DIR) return process.env.ROBINCODE_DIR;
  const repo = resolve(dirname(process.execPath), "..", "..", "..");
  if (runs(repo) && !versionOf(repo)) return repo;
  const home = process.env.ROBINCODE_HOME || join(process.env.LOCALAPPDATA || app.getPath("appData"), "RobinCode");
  const found = [join(process.resourcesPath, "robincode")];
  try { for (const v of readdirSync(join(home, "versions"))) found.push(join(home, "versions", v)); } catch { /* none downloaded yet */ }
  let best = null;
  for (const dir of found) {
    const v = versionOf(dir);
    // "bad": main.cjs saw that version fail to start (it goes back to the one before)
    if (!v || !runs(dir) || existsSync(join(dir, "bad")) || (v.electron && v.electron !== process.versions.electron)) continue;
    if (!best || Number(v.build) > Number(best.v.build)) best = { dir, v };
  }
  return best?.dir || repo;
}

const dir = find();
const main = join(dir, "desktop", "main.cjs");
if (runs(dir)) {
  require(main)(dir);
} else {
  app.whenReady().then(() => {
    dialog.showErrorBox("RobinCode", `RobinCode 파일을 찾지 못했어요.\n\n${main}\n\nai.yoonrobin.xyz에서 RobinCode를 다시 받아 주세요.`);
    app.quit();
  });
}
