// The one file built into RobinCode.exe. It only finds the repository and runs
// robincode/desktop/main.cjs from there, so a `git pull` changes the app
// without building the exe again (only a new Electron needs a new build).
// The exe sits at <repo>\robincode\desktop\out\RobinCode-win32-x64\RobinCode.exe;
// ROBINCODE_DIR (the robincode folder) overrides that.
const { app, dialog } = require("electron");
const { existsSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const dir = process.env.ROBINCODE_DIR || resolve(dirname(process.execPath), "..", "..", "..");
const main = join(dir, "desktop", "main.cjs");
if (existsSync(main)) {
  require(main)(dir);
} else {
  app.whenReady().then(() => {
    dialog.showErrorBox("RobinCode", `RobinCode 파일을 찾지 못했어요.\n\n${main}\n\n저장소 안의 robincode\\desktop\\out에서 RobinCode.exe를 켜 주세요.`);
    app.quit();
  });
}
