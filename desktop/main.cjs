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

// the first screen while the server starts: the window's glass (the sidebar's
// colour, see-through) with the mark and a turning ring, as the app
const LOADING = `<!doctype html><meta charset="utf-8"><title>RobinCode</title>
<style>
  html,body{margin:0;height:100%;background:rgb(5 8 15 / 87.5%);color:#d6d6db;font:400 15px/1.6 "Pretendard Variable",Pretendard,"Segoe UI","Malgun Gothic",sans-serif}
  body{display:grid;place-items:center}
  .box{display:flex;align-items:center;gap:11px}
  .m{display:grid;place-items:center;width:35px;height:35px;border-radius:7px;background:#11131b;box-shadow:inset 0 0 0 1px #2e3040}
  .m svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
  .n{font-weight:700;font-size:14px;color:#fff}
  .t{display:flex;align-items:center;gap:8px;font-size:13px;color:#a3a3a8}
  .r{width:11px;height:11px;border:1.5px solid rgb(79 125 255 / 25%);border-top-color:#4f7dff;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.r{animation:none}}
</style>
<div class="box"><span class="m"><svg viewBox="0 0 24 24"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/></svg></span><div><div class="n">RobinCode</div><div class="t"><span class="r"></span><span id="t">켜는 중이에요</span></div></div></div>`;

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
  // a downloaded version counts as working once its page has drawn itself and
  // the server is still there a little later; till then a failure (the server
  // ending, the page not drawing, its renderer dying) sends it back to the
  // version before (it printed its address and died, or drew nothing, and was
  // started again and again)
  let healthy = !mine || !dir.startsWith(join(home, "versions"));
  let quitting = false;
  let said = "";

  // the server's output, kept in a small log (cut back past 1 MB); the
  // window's token (in its address) is not written down
  const log = (text) => {
    try {
      if (statSync(logFile, { throwIfNoEntry: false })?.size > 1e6) writeFileSync(logFile, "");
      appendFileSync(logFile, text.replace(/([#?&]t=)[\w-]+/g, "$1…"));
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
      // a downloaded version that does not start: back to the one before
      if (code && goBack(`서버가 코드 ${code}로 끝남`)) return;
      // the server ended by itself: its window went (it waits 10 s), or it failed
      if (code && !TEST) dialog.showErrorBox("RobinCode", `RobinCode가 멈췄어요(코드 ${code}).\n\n${said.trim().split(/\r?\n/).slice(-8).join("\n")}\n\n기록: ${logFile}`);
      app.quit();
    });
  }
  // a new version that failed before it worked: marked bad (loader.cjs skips
  // it) and RobinCode starts again on the one before. False when it is not one
  function goBack(why) {
    if (healthy || !downloaded || TEST || quitting) return false;
    const { markBad } = require("./update.cjs");
    if (!markBad(dir, why)) return false;
    log(`[창] 새 판 ${mine.version}이 제대로 켜지지 않아서(${why}) 전 판으로 다시 켜요.\n`);
    quitting = true;
    stopServer();
    app.relaunch();
    app.quit();
    return true;
  }
  // the page drew something (React put its root in) and the server stayed: it works
  let checking = null;
  function checkDrawn(tries = 6) {
    if (healthy || checking || !win) return;
    checking = setTimeout(async () => {
      checking = null;
      if (!win || healthy) return;
      const drawn = await win.webContents.executeJavaScript(`(document.getElementById("root")?.childElementCount || 0) > 0`).catch(() => false);
      if (drawn && server) { healthy = true; log(`[창] 새 판 ${mine.version}이 잘 켜졌어요.\n`); return; }
      if (tries > 1) checkDrawn(tries - 1);
      else goBack("화면이 그려지지 않음");
    }, 3000);
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
  ipcMain.handle("robincode:update-check", async (e) => (updates && ours(e.senderFrame?.url || "") ? updates.check() : updateState));
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
    // maximized, and the size of the letters (Ctrl + / - / 0), as robin left them
    let maximized = false;
    let zoom = 0;
    try {
      const b = JSON.parse(readFileSync(boundsFile, "utf8"));
      maximized = b.maximized === true;
      if (Number.isFinite(b.zoom)) zoom = Math.max(-3, Math.min(4, b.zoom));
      const on = screen.getAllDisplays().some(({ workArea: a }) => b.x >= a.x - 20 && b.y >= a.y - 20 && b.x + b.width <= a.x + a.width + 20 && b.y + b.height <= a.y + a.height + 20);
      if (on && b.width >= 420 && b.height >= 480) bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch { /* first time */ }
    win = new BrowserWindow({
      // Windows 11's acrylic: the window is blurred glass and the page
      // paints over it (the sidebar see-through, the conversation a dark
      // panel), as the Neverlose footage robin pointed at ("이거 투명블러
      // 창이야"). The colour under it has to be clear for the glass to show;
      // where Windows has no acrylic (10, transparency effects off) the
      // see-through sidebar has nothing under it and shows darker.
      ...bounds, minWidth: 420, minHeight: 480, show: false, title: "RobinCode",
      backgroundColor: "#00000000", backgroundMaterial: "acrylic",
      icon: existsSync(join(dir, "robincode.ico")) ? join(dir, "robincode.ico") : join(dir, "..", "ops", "windows", "robincode.ico"), autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: join(__dirname, "preload.cjs") },
    });
    // (maximize() shows the window: not in a test, whose window stays hidden)
    win.once("ready-to-show", () => { if (!TEST) { if (maximized) win.maximize(); win.show(); } });
    // The size of the letters. With no menu (above) Chromium's own Ctrl + / -
    // do nothing, so they are taken here: Ctrl and + or =, -, 0 (back to
    // 100%), and Ctrl with the wheel. Half a step at a time, kept in
    // window.json and put back on every page (a new address starts at 100%).
    const setZoom = (level) => {
      zoom = Math.max(-3, Math.min(4, Math.round(level * 2) / 2));
      win?.webContents.setZoomLevel(zoom);
    };
    win.webContents.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
      if (input.key === "=" || input.key === "+") setZoom(zoom + 0.5);
      else if (input.key === "-" || input.key === "_") setZoom(zoom - 0.5);
      else if (input.key === "0") setZoom(0);
      else return;
      e.preventDefault();
    });
    win.webContents.on("zoom-changed", (e, direction) => setZoom(zoom + (direction === "in" ? 0.5 : -0.5)));
    win.webContents.on("did-finish-load", () => { if (zoom) win?.webContents.setZoomLevel(zoom); });
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
    let crashes = 0;
    win.webContents.on("render-process-gone", (e, d) => {
      log(`[창] 화면 프로세스가 끝남: ${d.reason} (${d.exitCode})\n`);
      if (d.reason !== "clean-exit" && ++crashes >= 3 && goBack("화면 프로세스가 거듭 끝남")) return;
      if (d.reason !== "clean-exit" && win && !quitting) setTimeout(() => win?.webContents.reload(), 500);
    });
    // a new version's page: does it draw?
    win.webContents.on("did-finish-load", () => { if (ours(win?.webContents.getURL() || "") && loaded) checkDrawn(); });
    // Tests drive the hidden window through its console: a key sent over the
    // debugging port does not pass before-input-event, and window.close() from
    // the page does not pass "close". "robincode-test:key =" presses Ctrl and
    // that key the way the keyboard does, "robincode-test:close" is the X.
    if (TEST) win.webContents.on("console-message", (e) => {
      log(`[창 콘솔] ${e.message}\n`);
      const m = /^robincode-test:(key|close)\s*(.*)$/.exec(e.message || "");
      if (m?.[1] === "key") for (const type of ["keyDown", "keyUp"]) win?.webContents.sendInputEvent({ type, keyCode: m[2], modifiers: ["control"] });
      else if (m?.[1] === "close") win?.close();
    });
    // the page says the window size itself on a small screen (fit.js); keep it here
    win.on("close", () => {
      // maximized or minimized: the size it goes back to (getNormalBounds), not the screen's
      try { writeFileSync(boundsFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized(), zoom })); }
      catch (err) { log(`[창] 창 크기를 남기지 못했어요: ${err.message}\n`); }
    });
    win.on("closed", () => { win = null; app.quit(); });
    startServer();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", stopServer);
};
