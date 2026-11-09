// RobinCode.exe (Electron): its own window instead of an Edge --app window
// (which showed Edge's sign-in and sync dialogs on top, robin 2026-11-09
// "이런거말고 exe로만들라고"). loader.cjs, built into the exe, runs this file
// from the repository, so a `git pull` changes it without a new build.
//
// It starts `node server.mjs --pick --no-window` (the system Node, as before:
// npm and the agent need it), shows a starting screen until the server prints
// "창 주소: <url>", then loads that address. A new address later (the server
// took a new version from GitHub and started again under the same parent)
// is loaded the same way. Closing the window ends the server and what it
// started (ssh tunnels; a GPU rent goes on on the server by itself).
//   ROBINCODE_SHELL_ARGS  more arguments for server.mjs (tests: --fake)
//   ROBINCODE_SHELL_TEST  the window stays hidden and the sound off (tests);
//                         ROBINCODE_SHELL_DEBUG_PORT opens DevTools' port
//   ROBINCODE_HOME        settings and the log (default %LOCALAPPDATA%\RobinCode)
// An installed copy (the zip from ai.yoonrobin.xyz: version.json in `dir`)
// also updates itself (update.cjs) and puts its shortcuts on the desktop and
// the Start menu the first time.
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const LOADING = `<!doctype html><meta charset="utf-8"><title>RobinCode</title>
<style>
  html,body{margin:0;height:100%;background:#070707;color:#e8e8e8;font:400 15px/1.6 "Pretendard Variable",Pretendard,"Segoe UI","Malgun Gothic",sans-serif}
  body{display:grid;place-items:center}
  .box{display:grid;gap:10px;justify-items:start;min-width:260px}
  .k{font:700 12px/1 "Cascadia Code",Consolas,monospace;letter-spacing:.14em;color:#9e9e9e}
  .k b{color:#f2f2f2}
  #t{font:400 14px/1.6 "Cascadia Code",Consolas,"Malgun Gothic",monospace;color:#cfcfcf}
  .c{display:inline-block;width:.6em;height:1.1em;margin-left:4px;vertical-align:-2px;background:#f2f2f2;animation:b 1s steps(1) infinite}
  @keyframes b{50%{opacity:0}}
  @media (prefers-reduced-motion:reduce){.c{animation:none}}
</style>
<div class="box"><div class="k"><b>&gt;</b> ROBINCODE</div><div><span id="t">켜는 중이에요</span><span class="c"></span></div></div>`;

module.exports = function start(dir) {
  const TEST = !!process.env.ROBINCODE_SHELL_TEST;
  let mine = null; // { version, build, electron } of an installed copy
  try { mine = JSON.parse(readFileSync(join(dir, "version.json"), "utf8")); } catch { /* the repository */ }
  const extra = (process.env.ROBINCODE_SHELL_ARGS || "").split(" ").filter(Boolean);
  const home = process.env.ROBINCODE_HOME || join(process.env.LOCALAPPDATA || app.getPath("appData"), "RobinCode");
  mkdirSync(home, { recursive: true });
  const logFile = join(home, "robincode.log");
  const boundsFile = join(home, "window.json");

  app.setPath("userData", join(home, "shell")); // not next to the exe, not Roaming
  // a second double-click brings the open window to the front (the lock goes
  // with userData, so a test with its own ROBINCODE_HOME runs beside robin's)
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.setAppUserModelId("xyz.yoonrobin.robincode"); // notifications say RobinCode
  if (TEST) {
    app.commandLine.appendSwitch("mute-audio");
    if (process.env.ROBINCODE_SHELL_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.ROBINCODE_SHELL_DEBUG_PORT);
  }
  Menu.setApplicationMenu(null);

  let win = null;
  let server = null;
  let origin = null; // http://127.0.0.1:<port> once the server said it
  let loaded = false;
  let quitting = false;
  let said = "";

  // the server's output, kept in a small log (cut back past 1 MB)
  const log = (text) => {
    try {
      if (statSync(logFile, { throwIfNoEntry: false })?.size > 1e6) writeFileSync(logFile, "");
      appendFileSync(logFile, text);
    } catch { /* no log, no matter */ }
  };
  // ---- an installed copy: updates and shortcuts ----------------------------------
  let updates = null;
  let updateState = mine ? { version: mine.version } : null;
  if (mine) {
    const { updater } = require("./update.cjs");
    updates = updater({ mine, home, log, tell: (s) => { updateState = s; win?.webContents.send("robincode:update", s); } });
  }
  const downloaded = mine && dir.startsWith(join(home, "versions"));
  function shortcuts() {
    // where the zip was unpacked: robin double-clicks it there the first time
    const exe = process.execPath;
    const places = [join(app.getPath("desktop"), "RobinCode.lnk"),
      join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "RobinCode.lnk")];
    for (const lnk of places) {
      let target = null;
      try { target = shell.readShortcutLink(lnk).target; } catch { /* none yet */ }
      if (target && existsSync(target)) continue; // robin's own, or the repository's exe
      try {
        shell.writeShortcutLink(lnk, target ? "replace" : "create", { target: exe, cwd: dirname(exe), icon: exe, iconIndex: 0,
          appUserModelId: "xyz.yoonrobin.robincode", description: "RobinCode" });
      } catch (e) { log(`[창] 바로가기를 만들지 못했어요: ${e.message}
`); }
    }
  }

  const status = (text) => {
    if (!loaded && win) win.webContents.executeJavaScript(`document.getElementById("t") && (document.getElementById("t").textContent = ${JSON.stringify(text)})`).catch(() => {});
  };

  function startServer() {
    log(`\n==== ${new Date().toISOString()} RobinCode.exe\n`);
    server = spawn("node", [join(dir, "server.mjs"), "--pick", "--no-window", ...extra], {
      cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ROBINCODE_PARENT: String(process.pid) }, // the server ends when this does, even by a crash
    });
    let carry = "";
    const take = (b) => {
      const text = b.toString("utf8");
      log(text);
      said = (said + text).slice(-4000);
      const lines = (carry + text).split(/\r?\n/);
      carry = lines.pop();
      for (const line of lines) {
        const m = line.match(/창 주소: (http:\/\/127\.0\.0\.1:\d+)(\/\S*)/);
        if (m) {
          origin = m[1];
          loaded = true;
          win?.loadURL(m[1] + m[2]);
        } else if (!loaded) {
          // what it is doing before the window can show anything
          const words = line.replace(/^\d\d:\d\d:\d\d\s+/, "").trim();
          if (words && !/^\[|^RobinCode /.test(words)) status(words);
        }
      }
    };
    server.stdout.on("data", take);
    server.stderr.on("data", take);
    server.on("error", (e) => {
      if (quitting) return;
      const missing = e.code === "ENOENT";
      dialog.showErrorBox("RobinCode", missing ? "Node.js가 없어요. https://nodejs.org 에서 LTS를 설치한 뒤 다시 켜 주세요." : `RobinCode 서버를 켜지 못했어요.\n\n${e.message}`);
      app.quit();
    });
    server.on("exit", (code) => {
      server = null;
      if (quitting) return;
      // a downloaded version that does not even start: back to the one before
      if (code && !loaded && downloaded && !TEST) {
        const { markBad } = require("./update.cjs");
        if (markBad(dir, `서버가 코드 ${code}로 끝남`)) {
          log(`[창] 새 판 ${mine.version}이 켜지지 않아서 전 판으로 다시 켜요.
`);
          quitting = true;
          app.relaunch();
          app.quit();
          return;
        }
      }
      // the server ended by itself: its window went (it waits 10 s), or it failed
      if (code && !TEST) dialog.showErrorBox("RobinCode", `RobinCode가 멈췄어요(코드 ${code}).\n\n${said.trim().split(/\r?\n/).slice(-8).join("\n")}\n\n기록: ${logFile}`);
      app.quit();
    });
  }
  function stopServer() {
    quitting = true;
    if (!server) return;
    // the whole tree: node, and the ssh tunnels and jobs it started
    try { execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    server = null;
  }

  const ours = (to) => to === "about:blank" || (origin && (to === origin || to.startsWith(origin + "/")));

  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // "다른 폴더 찾기": the Windows folder dialog on this window (preload.cjs).
  // Only for the server's own pages
  ipcMain.handle("robincode:pick-folder", async (e, start) => {
    if (!win || !ours(e.senderFrame?.url || "")) return null;
    // tests (hidden window): the folder they name instead of a dialog on screen
    if (TEST && process.env.ROBINCODE_SHELL_TEST_PICK) return process.env.ROBINCODE_SHELL_TEST_PICK;
    const r = await dialog.showOpenDialog(win, {
      title: "RobinCode — 작업할 폴더 고르기", buttonLabel: "이 폴더에서 열기",
      defaultPath: start && existsSync(start) ? start : undefined, properties: ["openDirectory", "dontAddToRecent"],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle("robincode:update-state", () => updateState);
  ipcMain.handle("robincode:update-check", async () => (updates ? updates.check() : updateState));
  // "다시 켜기": the new version from the next start, now
  ipcMain.handle("robincode:relaunch", (e) => {
    if (!ours(e.senderFrame?.url || "")) return false;
    quitting = true;
    stopServer();
    app.relaunch();
    app.quit();
    return true;
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = "dark"; // a dark title bar
    if (mine && !TEST) shortcuts();
    // a look for a new version once the window is up, then every 6 hours
    if (updates && (!TEST || process.env.ROBINCODE_UPDATE_DIST)) {
      setTimeout(() => updates.check(), TEST ? 3000 : 20000);
      setInterval(() => updates.check(), 6 * 3600e3).unref?.();
    }
    // where it was last time, if that still fits on a screen
    const area = screen.getPrimaryDisplay().workArea;
    let bounds = { width: Math.min(1180, area.width), height: Math.min(860, area.height) };
    try {
      const b = JSON.parse(readFileSync(boundsFile, "utf8"));
      const on = screen.getAllDisplays().some(({ workArea: a }) => b.x >= a.x - 20 && b.y >= a.y - 20 && b.x + b.width <= a.x + a.width + 20 && b.y + b.height <= a.y + a.height + 20);
      if (on && b.width >= 420 && b.height >= 480) bounds = b;
    } catch { /* first time */ }
    win = new BrowserWindow({
      ...bounds, minWidth: 420, minHeight: 480, show: false, title: "RobinCode", backgroundColor: "#070707",
      icon: existsSync(join(dir, "robincode.ico")) ? join(dir, "robincode.ico") : join(dir, "..", "ops", "windows", "robincode.ico"), autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: join(__dirname, "preload.cjs") },
    });
    win.once("ready-to-show", () => { if (!TEST) win.show(); });
    // the starting screen is written into about:blank: a data: page here made
    // Electron 44 kill a renderer ("crashed", 143) on the way to the server's page
    win.loadURL("about:blank").then(() => {
      if (!loaded) return win?.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(LOADING)});document.close();true`);
    }).catch(() => { /* the server's page came first */ });
    // the app's pages stay here; any other link opens in the browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url) && !ours(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (ours(url)) return;
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    });
    // a page that died: say why in the log, and draw it again
    win.webContents.on("render-process-gone", (e, d) => {
      log(`[창] 화면 프로세스가 끝남: ${d.reason} (${d.exitCode})\n`);
      if (d.reason !== "clean-exit" && win && !quitting) setTimeout(() => win?.webContents.reload(), 500);
    });
    if (TEST) win.webContents.on("console-message", (e) => log(`[창 콘솔] ${e.message}\n`));
    // the page says the window size itself on a small screen (fit.js); keep it here
    win.on("close", () => {
      try { if (!win.isMinimized() && !win.isMaximized()) writeFileSync(boundsFile, JSON.stringify(win.getBounds())); } catch { }
    });
    win.on("closed", () => { win = null; app.quit(); });
    startServer();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", stopServer);
};
