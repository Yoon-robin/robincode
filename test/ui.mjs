// RobinCode's window with the fake model, in a headless browser: queueing, /
// commands, !shell, modes, plan, todo, webfetch, Ctrl+F, git row, export.
// It starts its own server (--fake) on a free port with its own home and work
// folder in a temp folder (never robin's RobinCode data) and removes them.
//
//   cd robincode && npm run build && npm i --no-save playwright && npm run test:ui
//   (a browser: `npx playwright install chromium`, or PLAYWRIGHT_BROWSERS_PATH;
//   on the server: PLAYWRIGHT_BROWSERS_PATH=~/.hermes/tools npm run test:ui)
// `!명령` runs PowerShell, so that part is only checked on Windows.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// the repository's `npm test` (node --test) finds this file too: it needs a
// browser and takes minutes, so it is run on its own, as above
if (process.env.NODE_TEST_CONTEXT) { console.log("[SKIP] robincode/test/ui.mjs runs on its own: cd robincode && npm run test:ui"); process.exit(0); }
// what is missing, said in one line instead of a stack of the importer's
const { chromium } = await import("playwright").catch(() => {
  console.error("[FAIL] playwright가 없어요: cd robincode && npm i --no-save playwright");
  process.exit(2);
});
if (!existsSync(fileURLToPath(new URL("../web/dist/index.html", import.meta.url)))) {
  console.error("[FAIL] 창이 빌드되지 않았어요: cd robincode && npm run build");
  process.exit(2);
}
const here = fileURLToPath(new URL("..", import.meta.url));
const win = process.platform === "win32";
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const root = mkdtempSync(join(tmpdir(), "robincode-ui-"));
const work = join(root, "work");
mkdirSync(join(work, "src"), { recursive: true });
writeFileSync(join(work, "README.md"), "# rc-test\n");
writeFileSync(join(work, "package.json"), '{ "name": "rc-test", "version": "1.0.0" }\n');
writeFileSync(join(work, "src", "index.js"), 'console.log("hi");\n');
writeFileSync(join(work, "a.txt"), "a\n");
// a name only a folded tool result shows (Ctrl+F there)
writeFileSync(join(work, "folded-only.txt"), "f\n");
const git = (...a) => execFileSync("git", ["-C", work, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main"); git("add", "-A"); git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init");
const [port, fakePort] = [await freePort(), await freePort()];
const server = spawn(process.execPath, [join(here, "server.mjs"), work, "--fake", "--no-window", "--port", String(port)], {
  // its own process group off Windows, so the fake model it starts goes with it
  // (SIGKILL to the server alone left one fake-model.mjs behind per run)
  stdio: "ignore", windowsHide: true, detached: !win,
  env: { ...process.env, ROBINCODE_HOME: join(root, "home"), ROBINCODE_URLFILE: join(root, "url.txt"), ROBINCODE_NO_UPDATE: "1", ROBINCODE_FAKE_PORT: String(fakePort), ROBINCODE_FAKE_GPU: join(root, "gpu.json") },
});
const stopServer = () => {
  try { if (win) execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); else process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ }
};
process.on("exit", stopServer);
for (let i = 0; i < 300 && !existsSync(join(root, "url.txt")); i++) await new Promise((r) => setTimeout(r, 100));
const url = readFileSync(join(root, "url.txt"), "utf8").trim();
const browser = await chromium.launch({ args: ["--mute-audio"] }).catch((e) => {
  console.error(`[FAIL] 브라우저를 못 띄웠어요(${String(e.message).split("\n")[0]}) — npx playwright install --only-shell chromium, 또는 PLAYWRIGHT_BROWSERS_PATH`);
  stopServer();
  process.exit(2);
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push(e.message));
let fails = 0; const ok = (c, w) => { console.log(`${c ? "[ OK ]" : "[FAIL]"} ${w}`); if (!c) fails++; };
await page.goto(url);
await page.waitForSelector("[aria-label='메시지']", { timeout: 30000 });
await page.waitForTimeout(1000);
const box = page.getByLabel("메시지");
// the taskbar title says a turn is running or waiting (brand V3: words, no [ .. ])
const idle = (t = 30000) => page.waitForFunction(() => !/^(도는 중|허락을 기다려요) · /.test(document.title), null, { timeout: t });
const asks = (t = 20000) => page.waitForFunction(() => document.title.startsWith("허락을 기다려요 · "), null, { timeout: t });
const say = async (text, key = "Enter") => { await box.click(); await box.fill(text); await box.press(key); };
const modeText = () => page.locator(".composer-foot .mode").first().innerText();
await page.locator(".side").getByRole("button", { name: "새 대화" }).first().click();
await page.waitForTimeout(1000);

// ---- /permissions: what an earlier run allowed goes first
await say("/permissions");
await page.waitForSelector(".sheet", { timeout: 5000 });
await page.waitForTimeout(400);
while (await page.locator(".rule:not(.rule-gone) button").count()) { await page.locator(".rule:not(.rule-gone) button").first().click(); await page.waitForTimeout(250); }
ok(await page.locator(".rule:not(.rule-gone)").count() === 0, "/permissions: 다 지움");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---- / commands
await box.click(); await box.fill("/");
await page.waitForTimeout(200);
ok(await page.locator(".commands .mention").count() >= 10, `/ 목록 ${await page.locator(".commands .mention").count()}개`);
await box.fill("/he");
await page.waitForTimeout(150);
ok((await page.locator(".commands .mention.on").innerText()).startsWith("/help"), "/he → help가 첫째");
await box.press("Enter");
await page.waitForTimeout(300);
ok(await page.locator(".sheet", { hasText: "명령과 단축키" }).count() === 1, "/help 창");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
ok(await page.locator(".sheet").count() === 0 && (await box.inputValue()) === "", "Esc로 닫힘, 칸은 빔");
await box.fill("/comp"); await page.waitForTimeout(100); await box.press("Tab");
ok((await box.inputValue()) === "/compact ", `Tab은 채우기: "${await box.inputValue()}"`);
await box.fill("");

// ---- /memory
await say("/memory 커밋 메시지는 한국어로");
await page.waitForTimeout(1200);
ok(existsSync(join(work, "AGENTS.md")) && readFileSync(join(work, "AGENTS.md"), "utf8").includes("- 커밋 메시지는 한국어로"), "/memory 한 줄 → AGENTS.md");
await say("/memory");
await page.waitForSelector(".mem-file", { timeout: 5000 }).catch(() => {});
ok(await page.locator(".mem-file", { hasText: "커밋 메시지는 한국어로" }).count() === 1, "/memory 창에 그 파일");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---- ! shell
await box.click(); await box.fill("!Get-ChildItem -Name");
ok(await page.locator(".shell-tag").count() === 1 && (await page.locator(".composer .send").innerText()) === "실행", "! 쓰면 PowerShell 표시, 버튼은 실행");
if (win) {
  await box.press("Enter");
  await page.waitForSelector(".shell-run:not(.run)", { timeout: 20000 });
  const sh = await page.locator(".shell-run").last().innerText();
  ok((await page.locator(".shell-run").last().locator(".tag-ok").count()) === 1 && /package\.json/.test(sh), "! 명령 결과가 대화에");
  ok((await box.inputValue()) === "", "실행 뒤 칸 빔");
} else {
  await box.fill("");
  console.log("[SKIP] ! 명령 실행 (PowerShell은 Windows에서만)");
}

// ---- git row
await page.waitForTimeout(500);
const git1 = await page.locator(".git-row").innerText().catch(() => "");
ok(/main/.test(git1) && /바뀐 파일/.test(git1), `git 줄: ${git1.replace(/\s+/g, " ")}`);

// ---- modes: button, Shift+Tab
const m0 = await modeText();
await page.locator(".composer-foot .mode").first().click();
await page.waitForTimeout(400);
const m1 = await modeText();
await box.click();
await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(400);
const m2 = await modeText();
await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(400);
const m3 = await modeText();
ok(m0.includes("묻고 실행") && m1.includes("수정은 바로") && m2.includes("바로 실행") && m3.includes("계획만"), `모드 ${m0} → ${m1} → ${m2} → ${m3}`);
ok(await page.getByRole("button", { name: "이 계획대로 하기" }).count() === 0, "계획 모드로 바꾸기만 해서는 버튼 없음");
// four quick presses come round to the same mode
await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(800);
ok((await modeText()).includes("계획만"), `빠르게 네 번: ${await modeText()}`);

// ---- plan mode, then go
await say("README 고쳐 줘");
await page.waitForFunction(() => /^(도는 중|허락을 기다려요) · /.test(document.title), null, { timeout: 5000 }).catch(() => {});
await idle();
await page.waitForTimeout(300);
const planText = await page.locator(".msg-ai").last().innerText();
ok(/## ?계획|계획/.test(planText) && /README/.test(planText), "계획 모드: 계획을 씀");
ok(!readFileSync(join(work, "README.md"), "utf8").includes("계획대로"), "계획 모드에서는 안 고침");
let go = page.getByRole("button", { name: "이 계획대로 하기" });
ok(await go.count() === 1, "이 계획대로 하기 버튼");
await page.reload();
await page.waitForSelector(".msg-ai", { timeout: 20000 });
await page.waitForTimeout(800);
go = page.getByRole("button", { name: "이 계획대로 하기" });
ok(await go.count() === 1, "창을 다시 열어도 그 버튼");
await go.click();
await page.waitForTimeout(600);
// back to the mode before plan (바로 실행): the edit goes without asking
await idle();
ok((await modeText()).includes("바로 실행"), `계획 전 모드로: ${await modeText()}`);
ok(readFileSync(join(work, "README.md"), "utf8").includes("계획대로 고쳤어요"), "계획대로 README 고침");

// ---- the review sheet: header button, the diff, put back with two presses, back again
const headBtn = page.locator(".head-changes");
ok(/바꾼 파일 1/.test(await headBtn.innerText().catch(() => "")), `머리줄 '바꾼 파일 1' (${await headBtn.innerText().catch(() => "없음")})`);
await headBtn.click();
await page.waitForSelector(".chg-file", { timeout: 5000 }).catch(() => {});
const sheet = page.locator(".chg-file", { hasText: "README.md" });
ok(/계획대로 고쳤어요/.test(await sheet.locator(".chg-row.add").allInnerTexts().then((t) => t.join(" "))), "검토 창: README의 더한 줄");
const fixed = readFileSync(join(work, "README.md"), "utf8");
await sheet.getByRole("button", { name: "되돌리기", exact: true }).click();
ok(readFileSync(join(work, "README.md"), "utf8") === fixed, "한 번 눌러서는 안 되돌림");
await sheet.getByRole("button", { name: /정말/ }).click();
await page.waitForTimeout(500);
ok(!readFileSync(join(work, "README.md"), "utf8").includes("계획대로"), "두 번 눌러 되돌림");
await sheet.getByRole("button", { name: "다시 살리기" }).click();
await page.waitForTimeout(500);
ok(readFileSync(join(work, "README.md"), "utf8") === fixed, "다시 살리기");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await say("/mode ask");
await page.waitForTimeout(500);
ok((await modeText()).includes("묻고 실행"), "/mode ask");

// ---- todo + queue (steer, end, ↑ takes back)
await say("할 일 해 줘");
await page.waitForSelector(".todo", { timeout: 10000 }).catch(() => {});
ok(await page.locator(".todo").count() === 1, `할 일 판: ${(await page.locator(".todo").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80)}`);
await say("목록도 봐 줘");
await say("끝나고 이것도", "Control+Enter");
await page.waitForTimeout(250);
const qs = await page.locator(".queued-bubble").allInnerTexts();
// a quick model can take the steer at its next step before this looks (B-417):
// then it is already in the conversation instead of waiting
const steerTaken = (await page.locator(".msg-user", { hasText: "목록도 봐 줘" }).count()) === 1;
const steerOk = steerTaken ? qs.length === 1 : qs.length === 2 && qs[0].includes("다음 단계 전에");
ok(steerOk && qs.at(-1)?.includes("끝나면"), `기다리는 말${steerTaken ? "(끼어든 말은 이미 들어감)" : ""}: ${JSON.stringify(qs.map((x) => x.replace(/\s+/g, " ")))}`);
await box.click();
await box.press("ArrowUp");
await page.waitForTimeout(600);
ok((await box.inputValue()) === "끝나고 이것도" && (await page.locator(".queued-bubble").count()) <= 1, `↑로 마지막 것 꺼냄: "${await box.inputValue()}"`);
await box.fill("");
await idle(40000);
const users = await page.locator(".msg-user").allInnerTexts();
ok(users.some((t) => t.includes("목록도 봐 줘")), "다음 단계 전에 전한 말이 대화에");
ok(!users.some((t) => t.includes("끝나고 이것도")), "꺼낸 말은 안 보냄");

// ---- webfetch: asks, 4 = always for this site
await say("웹 읽기 해 줘");
await asks();
await page.waitForTimeout(300);
ok(await page.locator(".ask", { hasText: "이 웹 페이지를 읽을까요?" }).count() >= 1, "webfetch 묻기");
ok(await page.locator(".ask button", { hasText: "늘 허용" }).count() >= 1, "늘 허용 버튼");
// a digit within a second of typing in the box is typing, not an answer
await page.waitForTimeout(1100);
await box.click();
await page.keyboard.press("4");
await idle();
const webStep = await page.locator(".step", { hasText: "webfetch" }).last().innerText();
ok(!/alert|color:red/.test(webStep), "스크립트·스타일은 뺌");
let asked = false;
const watch = setInterval(async () => { if ((await page.title().catch(() => "")).startsWith("허락을 기다려요 · ")) asked = true; }, 100);
await say("웹 읽기 다시");
await page.waitForTimeout(800);
await idle();
clearInterval(watch);
ok(!asked, "같은 사이트는 다시 묻지 않음");
await page.locator(".step .step-head", { hasText: "webfetch" }).last().click().catch(() => {});
await page.waitForTimeout(300);
ok(/시험 페이지/.test(await page.locator(".msgs").innerText()), "페이지 글을 읽음");
await say("/permissions");
await page.waitForSelector(".rule", { timeout: 5000 }).catch(() => {});
ok((await page.locator(".rule").allInnerTexts()).some((t) => t.includes("127.0.0.1")), "/permissions에 그 사이트");
await page.locator(".rule button").first().click();
await page.waitForTimeout(300);
ok(await page.locator(".rule:not(.rule-gone)").count() === 0, "지우기");
// the one just removed stays as a struck-out line that puts it back (B-440)
ok(/127\.0\.0\.1/.test(await page.locator(".rule-gone").innerText()), "지운 것이 되돌리기 줄로 남음");
await page.locator(".rule-gone button").click();
await page.waitForTimeout(300);
ok(await page.locator(".rule-gone").count() === 0 && (await page.locator(".rule").allInnerTexts()).some((t) => t.includes("127.0.0.1")), "되돌리기");
await page.locator(".rule button").first().click();
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await say("/permissions");
await page.waitForSelector(".sheet", { timeout: 5000 });
await page.waitForTimeout(400);
ok(await page.locator(".sheet", { hasText: "아직 없어요" }).count() === 1, "다시 열면 비어 있음");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---- ↑ ↓ history
await box.click(); await box.fill("");
await box.press("ArrowUp");
const h1 = await box.inputValue();
await box.press("ArrowUp");
const h2 = await box.inputValue();
await box.press("ArrowDown");
await box.press("ArrowDown");
const h3 = await box.inputValue();
ok(h1 === "웹 읽기 다시" && h2 === "웹 읽기 해 줘" && h3 === "", `보낸 말 ↑↑↓↓: "${h1}" "${h2}" "${h3}"`);

// ---- Ctrl+F
await page.keyboard.press("Control+f");
await page.waitForTimeout(200);
await page.keyboard.type("확인했어요");
await page.waitForTimeout(400);
const fc = await page.locator(".find-count").innerText();
ok(/^1\/\d+$/.test(fc), `찾기 ${fc}`);
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
ok(/^2\//.test(await page.locator(".find-count").innerText()) || fc === "1/1", "Enter로 다음 것");
const marked = await page.evaluate(() => CSS.highlights?.get("find")?.size || 0);
ok(marked > 0, `표시 ${marked}개`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
ok(await page.locator(".find-bar").count() === 0 && (await page.evaluate(() => !CSS.highlights?.has("find"))), "Esc로 찾기 닫힘");
// words only in a folded result: counted as such, Enter opens it and goes there
await page.keyboard.press("Control+f");
await page.waitForTimeout(200);
await page.keyboard.type("folded-only");
await page.waitForTimeout(400);
const hc = await page.locator(".find-count").innerText();
ok(/접힌 곳 [1-9]/.test(hc), `접힌 결과도 셈: ${hc}`);
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const hc2 = await page.locator(".find-count").innerText();
// on Windows the `!Get-ChildItem` output above shows the name too: then the
// opened one is the second, after the one already in view
const nowInOpened = await page.evaluate(() => {
  const r = [...(CSS.highlights?.get("find-now") || [])][0];
  return !!r?.startContainer.parentElement?.closest(".step-out");
});
const seen = Number(hc.match(/^(\d+)\//)?.[1] || 0);
ok(new RegExp(`^${seen + 1}/\\d+`).test(hc2) && nowInOpened && await page.locator(".step-out", { hasText: "folded-only" }).first().isVisible(), `Enter로 펼쳐 그곳으로: ${hc} → ${hc2}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---- /export
const dl = page.waitForEvent("download", { timeout: 8000 });
await say("/export");
const file = await dl;
const saved = join(root, "export.md");
await file.saveAs(saved);
const md = readFileSync(saved, "utf8");
ok(file.suggestedFilename().endsWith(".md") && md.includes("웹 읽기 해 줘") && (!win || md.includes("Get-ChildItem")), `/export ${file.suggestedFilename()} ${md.length}자`);

// ---- held while compacting
await box.click();
await box.evaluate((el, t) => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(el, t); el.dispatchEvent(new Event("input", { bubbles: true })); }, `긴 글이에요. ${"가나다라마바사 아자차카타파하 ".repeat(7000)}`);
await box.press("Enter");
await page.waitForTimeout(800);
await idle(40000);
await say("/compact");
await page.waitForFunction(() => /요약하는 중/.test(document.querySelector("[aria-label='메시지']")?.placeholder || ""), null, { timeout: 5000 }).catch(() => {});
await say("요약 중 보낸 말");
await page.waitForTimeout(150);
const held = await page.locator(".queued-bubble.held").count();
ok(held === 1 && /요약이 끝나면/.test(await page.locator(".queued-bubble.held").innerText().catch(() => "")), `요약 중 보낸 말이 기다림으로 보임 (${held})`);
await idle(40000);
await page.waitForTimeout(800);
await idle(40000);
const last = await page.locator(".msg-user").last().innerText();
ok(last.includes("요약 중 보낸 말"), `요약 중 보낸 말 (기다림 표시 ${held}) → 요약 뒤에 보냄`);

// ---- the window made narrower and wider again: the view stays at the bottom
// (the text wraps again; 2026-11-19 it was left above, "아래로" showing)
const atEnd = () => page.evaluate(() => { const el = document.querySelector(".thread"); return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1; });
for (const [w, h] of [[700, 800], [420, 760], [1280, 900]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(450);
  const gap = await atEnd();
  ok(gap >= 0 && gap < 60 && (await page.locator(".to-bottom").count()) === 0, `${w}px로 바꿔도 맨 아래 (남은 ${Math.round(gap)}px)`);
}

// ---- /new
const before = await page.locator(".msg-user").count();
await say("/new");
await page.waitForTimeout(1000);
ok(before > 0 && (await page.locator(".msg-user").count()) === 0, "/new 새 대화");

// ---- a turn that ends while robin is in another conversation is marked; a pin stays on top
await say("할 일 해 줘");
await page.waitForFunction(() => /^(도는 중|허락을 기다려요) · /.test(document.title), null, { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(800);
const other = page.locator(".conv-open").filter({ hasNotText: "할 일 해 줘" }).first();
const otherTitle = (await other.locator(".conv-title").innerText()).trim();
await other.click();
await page.waitForFunction(() => document.querySelectorAll(".conv-done").length === 1, null, { timeout: 40000 }).catch(() => {});
ok((await page.locator(".conv", { hasText: "할 일 해 줘" }).locator(".conv-done").count()) === 1, "다른 대화에 있는 동안 끝난 대화: 끝났어요 표시");
const row = page.locator(".conv", { hasText: otherTitle }).first();
await row.hover();
await row.getByRole("button", { name: /위에 고정/ }).click();
await page.waitForTimeout(300);
const firstDay = await page.locator(".conv-day").first().getAttribute("aria-label");
const firstTitle = (await page.locator(".conv-day").first().locator(".conv-title").first().innerText()).trim();
await page.locator(".conv-open", { hasText: "할 일 해 줘" }).first().click();
await page.waitForTimeout(600);
ok(firstDay === "고정" && firstTitle === otherTitle && (await page.locator(".conv-done").count()) === 0, `고정은 맨 위(${firstDay}: ${firstTitle}), 열면 끝났어요 표시가 사라짐`);

// ---- checks (B-420): a look at a changed file, and the folder's test before the turn ends
await page.locator(".side").getByRole("button", { name: "새 대화" }).first().click();
await page.waitForTimeout(1000);
// says yes to every question until the turn is over (a write asks; the test's round asks again)
const through = async (t = 90000) => {
  await page.waitForFunction(() => /^(도는 중|허락을 기다려요) · /.test(document.title), null, { timeout: 8000 }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    const now = await Promise.race([asks(t).then(() => "ask", () => "late"), idle(t).then(() => "idle", () => "late")]);
    if (now !== "ask") return now;
    await page.waitForTimeout(1100);
    await box.click();
    await page.keyboard.press("1");
    await page.waitForFunction(() => !document.title.startsWith("허락을 기다려요 · "), null, { timeout: 8000 }).catch(() => {});
  }
  return "many";
};
const call = (path, body) => page.evaluate(async ([at, what]) => {
  const res = await fetch(at, { method: "POST", headers: { "content-type": "application/json", "x-robincode-token": sessionStorage.getItem("robincode-token") || "" }, body: JSON.stringify(what) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}, [path, body]);
await say("문법 깨는 수정 해 줘");
ok(await through() === "idle", "문법 깨: 차례가 끝남");
ok(readFileSync(join(work, "src", "broken.js"), "utf8").trim() === 'console.log("hi");', "고친 뒤 검사: 문법 오류를 알려 모델이 다시 고침");
ok(await page.locator(".msg", { hasText: "문법 오류를 고쳤어요" }).count() >= 1, "고친 뒤 검사: 모델의 마지막 말");
// off: the same broken write is not told about
ok((await call("/api/checks", { after: false })).data.after === false, "검사 끄기");
await say("문법 깨는 수정 다시 해 줘");
ok(await through() === "idle", "검사 끔: 차례가 끝남");
ok(readFileSync(join(work, "src", "broken.js"), "utf8").trim() === 'console.log("hi"', "검사 끔: 깨진 채로 둠(알리지 않음)");
ok((await call("/api/checks", { after: true })).data.after === true, "검사 다시 켜기");
// the folder's test: fails on state.txt "broken", the model gets one more go, then it passes
writeFileSync(join(work, "check.mjs"), 'import { readFileSync } from "node:fs";\nlet s = ""; try { s = readFileSync("state.txt", "utf8").trim(); } catch {}\nif (s === "broken") { console.error("state.txt is broken"); process.exit(1); }\n');
const errsBefore = errs.length;
ok((await call("/api/checks", { test: "node check.mjs\nrm x" })).status === 400, "시험 명령은 한 줄만");
await page.waitForTimeout(100);
errs.splice(errsBefore); // the browser logs that 400 as an error: it is the answer this asks for
ok((await call("/api/checks", { test: "node check.mjs" })).data.test === "node check.mjs", "시험 명령 저장");
await say("시험 깨는 수정 해 줘");
ok(await through(120000) === "idle", "시험 깨: 차례가 끝남");
const lines = await page.locator(".line").allInnerTexts();
ok(lines.some((t) => t.includes("시험 실패")) && lines.some((t) => t.includes("시험 통과")), `끝내기 전 시험: 실패 → 다시 → 통과 (${lines.filter((t) => t.includes("시험")).map((t) => t.replace(/\s+/g, " ").trim()).join(" / ")})`);
ok(readFileSync(join(work, "state.txt"), "utf8").trim() === "fixed", "끝내기 전 시험: 모델이 고침");
// a turn that changed nothing does not run it
const testsBefore = (await page.locator(".line").allInnerTexts()).filter((t) => t.includes("끝내기 전 시험")).length;
await say("목록 보여 줘");
await through();
ok((await page.locator(".line").allInnerTexts()).filter((t) => t.includes("끝내기 전 시험")).length === testsBefore, "고친 것이 없는 차례엔 시험을 안 돌림");
// the settings page shows both
await say("/help"); await page.waitForTimeout(300); await page.keyboard.press("Escape"); await page.waitForTimeout(200);
ok((await call("/api/checks", { test: "" })).data.test === "", "시험 명령 지움");

// ---- the review sheet's parts (B-423, B-435): one part put back, words about a part into the message box
{
  const list = await call("/api/changes", {});
  const f = (list.data.files || []).find((x) => x.state === "changed" || x.state === "added");
  ok(!!f, `이 대화가 바꾼 파일이 있음 (${(list.data.files || []).map((x) => x.path).join(", ")})`);
  if (f) {
    const full = join(work, f.path);
    const disk = readFileSync(full, "utf8");
    const lines = disk.replace(/\r\n/g, "\n").split("\n");
    const errsBefore = errs.length;   // the refused call below is meant
    const stale = await call("/api/changes", { hunk: f.path, find: ["이런 줄은 없어요"], put: [], at: 1 });
    await page.waitForTimeout(200);
    errs.splice(errsBefore);
    ok(stale.status === 409 && readFileSync(full, "utf8") === disk, `한 부분 되돌리기: 파일이 다르면 안 건드림 (${stale.status})`);
    const part = await call("/api/changes", { hunk: f.path, find: [lines[0]], put: ["// 되돌린 줄", lines[0]], at: 1 });
    ok(part.status === 200 && readFileSync(full, "utf8").replace(/\r\n/g, "\n") === ["// 되돌린 줄", ...lines].join("\n"), `한 부분 되돌리기: 그 줄들만 바뀜 (${part.status})`);
    writeFileSync(full, disk);
    // words about a part: under the part's head, then into the message box
    await say("/changes");
    await page.waitForSelector(".chg-file", { timeout: 5000 }).catch(() => {});
    const first = page.locator(".chg-file").first();
    if (!(await first.locator(".chg-diff").count())) await first.locator(".chg-toggle").click();
    await first.getByRole("button", { name: "이 부분에 말하기" }).first().click();
    await page.locator(".chg-say-box").fill("이름을 더 알기 쉽게");
    await page.keyboard.press("Enter");
    ok(await page.locator(".chg-notes li").count() === 1, "말한 것이 아래 목록에");
    await first.locator(".chg-no-btn").first().click();
    await page.locator(".chg-say-box").fill("이 줄은 빼 줘");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /입력 칸에 넣기 \(2\)/ }).click();
    await page.waitForTimeout(300);
    const draft = await box.inputValue();
    ok(/^\S+:\d+(-\d+)? — 이름을 더 알기 쉽게\n\S+:\d+ — 이 줄은 빼 줘\n$/.test(draft), `입력 칸에 경로·줄과 함께 들어감 (${JSON.stringify(draft).slice(0, 90)})`);
    ok(await page.locator(".sheet").count() === 0, "검토 창은 닫힘");
    await box.fill("");
  }
}

// ---- /review (B-429): a new conversation that reads the uncommitted changes and only looks
{
  const titleBefore = await page.title();
  writeFileSync(join(work, "review-me.js"), "export const added = 1;\n");
  const tracked = readFileSync(join(work, "README.md"), "utf8");
  writeFileSync(join(work, "README.md"), `${tracked}\n검토할 줄\n`);
  await say("/review 숫자 계산");
  await page.waitForFunction(() => /검토 쪽지/.test(document.querySelector(".msgs")?.innerText || ""), null, { timeout: 30000 }).catch(() => {});
  await idle();
  const talk = await page.locator(".msgs").innerText();
  ok(/바뀐 것을 검토해 줘 \(파일 \d+개\)/.test(talk) && /특히: 숫자 계산/.test(talk), "/review: 새 대화에 검토 부탁 한 줄");
  ok(/검토 쪽지 받음/.test(talk) && /diff [^·]*README\.md/.test(talk) && /새 파일 있음/.test(talk), `/review: 바뀐 것이 모델에 감 (${(talk.match(/검토 쪽지[^\n]*/) || [""])[0].slice(0, 90)})`);
  ok(/도구 보기만/.test(talk), "/review: 고치는 도구 없이");
  ok(!/diff --git/.test(talk), "/review: diff는 창에 안 보임");
  ok(/계획만/.test(await modeText()), `/review: 읽기만 하는 모드 (${await modeText()})`);
  ok(await page.title() !== titleBefore, "/review: 새 대화");
  // nothing changed: said so, no conversation opened
  writeFileSync(join(work, "README.md"), tracked);
  rmSync(join(work, "review-me.js"));
  const clean = execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" }).trim();
  if (!clean) {
    const errsBefore = errs.length;   // the refused call below is meant
    const none = await call("/api/review", {});
    await page.waitForTimeout(200);
    errs.splice(errsBefore);
    ok(none.status === 400 && /바뀐 것이 없어요/.test(none.data.error || ""), `/review: 바뀐 것이 없으면 그렇게 말함 (${none.status})`);
  }
  // back to an ordinary conversation for what follows
  await say("/new");
  await page.waitForTimeout(800);
}

// ---- a sent picture: the list of messages carries its address, not its base64 (B-382)
{
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const sent = await call("/api/prompt", { text: "이 그림 봐 줘", images: [{ mimeType: "image/png", data: png }] });
  ok(sent.status === 200, `그림과 함께 보냄 (${sent.status})`);
  await through();
  const pic = () => page.evaluate(async () => {
    const img = [...document.querySelectorAll(".bubble-pic img")].at(-1);
    if (!img) return null;
    if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; });
    return { src: img.getAttribute("src"), w: img.naturalWidth };
  });
  const live = await pic();
  ok(!!live && live.src.startsWith("/api/pic/") && live.w === 1, `보낸 그림이 주소로 옴 (${live?.src?.slice(0, 22)} ${live?.w}px)`);
  // a redraw: the page asks for everything again
  await page.reload();
  await page.waitForSelector(".bubble-pic img", { timeout: 15000 });
  const again = await pic();
  ok(!!again && again.src === live?.src && again.w === 1, "다시 그려도 같은 주소의 그림");
  const errsBefore = errs.length;   // the refused call below is meant
  const noToken = await page.evaluate(async (src) => (await fetch(src.split("?")[0])).status, again?.src || "/api/pic/x");
  await page.waitForTimeout(200);
  errs.splice(errsBefore);
  ok(noToken === 401, `토큰 없이는 그림을 안 줌 (${noToken})`);
}

// ---- the model's own question (B-426): choices by number, or robin's own words
{
  await say("/mode auto");
  await page.waitForTimeout(400);
  await say("하나 물어봐");
  await asks();
  const card = page.locator(".ask").last();
  ok(/어느 쪽으로 할까요\?/.test(await card.innerText()) && (await card.locator(".ask-buttons .btn").count()) === 3, `바로 실행 모드에서도 물음 (${(await card.innerText()).replace(/\s+/g, " ").slice(0, 60)})`);
  await page.waitForTimeout(1100);
  await box.click();
  await page.keyboard.press("4");                 // no fourth choice: nothing happens
  await page.waitForTimeout(300);
  ok((await page.title()).startsWith("허락을 기다려요"), "없는 번호는 답이 아님");
  await page.keyboard.press("2");
  await idle();
  ok(/받은 답: robin의 답: 꼼꼼하게/.test(await page.locator(".msgs").innerText()), "2를 누르면 둘째 선택지가 모델에 감");
  await say("다시 물어봐");
  await asks();
  await page.locator(".ask").last().locator(".ask-note").fill("셋 다 말고 문서만");
  await page.keyboard.press("Enter");
  await idle();
  ok(/받은 답: robin의 답: 셋 다 말고 문서만/.test(await page.locator(".msgs").innerText()), "직접 쓴 말이 답으로 감");
  await say("/mode ask");
  await page.waitForTimeout(400);
}

// ---- /usage (B-428): how long the model worked, this conversation / today / this month
{
  const before = (await call("/api/usage", {})).data;
  await say("목록 보여 줘");
  await through();
  const after = (await call("/api/usage", {})).data;
  ok(after.conv.turns === before.conv.turns + 1 && after.conv.ms > before.conv.ms, `한 차례가 이 대화에 더해짐 (${before.conv.turns} → ${after.conv.turns}차례, ${after.conv.ms}ms)`);
  ok(after.today.turns >= after.conv.turns && after.month.ms >= after.today.ms, `오늘·이번 달이 그 이상 (${after.today.turns}차례 / ${after.month.turns}차례)`);
  await say("/usage");
  await page.waitForSelector(".use", { timeout: 5000 }).catch(() => {});
  const rows = await page.locator(".use tbody tr").allInnerTexts();
  ok(rows.length === 3 && /^이 대화/.test(rows[0]) && /(초|분)/.test(rows[0]) && /^오늘/.test(rows[1]) && /^이번 달/.test(rows[2]), `/usage 창 (${rows.map((r) => r.replace(/\s+/g, " ")).join(" | ")})`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

// ---- the foot's keys between 420 and 860: one stays (it was gone whole, B-440)
{
  const size = page.viewportSize();
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(300);
  const shown = await page.evaluate(() => [...document.querySelectorAll(".keys .key")].filter((k) => k.getClientRects().length).map((k) => k.textContent));
  ok(shown.length === 1 && /Enter/.test(shown[0]), `700px: 안내 한 줄 (${shown.join(" / ")})`);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => getComputedStyle(document.querySelector(".keys")).display) === "none", "400px: 안내 없음");
  await page.setViewportSize(size);
  await page.waitForTimeout(300);
}

ok(errs.length === 0, `콘솔 오류 ${errs.length}개 ${errs.slice(0, 3).join(" | ")}`);
if (process.env.ROBINCODE_UI_SHOT) await page.screenshot({ path: process.env.ROBINCODE_UI_SHOT });
await browser.close();
stopServer();
await new Promise((r) => setTimeout(r, 500));
rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
console.log(fails ? `실패 ${fails}개` : "모두 통과");
process.exit(fails ? 1 : 0);
