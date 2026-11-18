// RobinCode's window with the fake model, in a headless browser: queueing, /
// commands, !shell, modes, plan, todo, webfetch, Ctrl+F, git row, export.
// It starts its own server (--fake) on a free port with its own home and work
// folder in a temp folder (never robin's RobinCode data) and removes them.
//
//   cd robincode && npm run build && npm i --no-save playwright && node test/ui.mjs
//   (a browser: `npx playwright install chromium`, or PLAYWRIGHT_BROWSERS_PATH)
// `!명령` runs PowerShell, so that part is only checked on Windows.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// the repository's `npm test` (node --test) finds this file too: it needs a
// browser and takes minutes, so it is run on its own, as above
if (process.env.NODE_TEST_CONTEXT) { console.log("[SKIP] robincode/test/ui.mjs runs on its own: cd robincode && node test/ui.mjs"); process.exit(0); }
const { chromium } = await import("playwright");
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
const git = (...a) => execFileSync("git", ["-C", work, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main"); git("add", "-A"); git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init");
const [port, fakePort] = [await freePort(), await freePort()];
const server = spawn(process.execPath, [join(here, "server.mjs"), work, "--fake", "--no-window", "--port", String(port)], {
  stdio: "ignore", windowsHide: true,
  env: { ...process.env, ROBINCODE_HOME: join(root, "home"), ROBINCODE_URLFILE: join(root, "url.txt"), ROBINCODE_NO_UPDATE: "1", ROBINCODE_FAKE_PORT: String(fakePort), ROBINCODE_FAKE_GPU: join(root, "gpu.json") },
});
const stopServer = () => {
  try { if (win) execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); else server.kill("SIGKILL"); } catch { /* gone */ }
};
process.on("exit", stopServer);
for (let i = 0; i < 300 && !existsSync(join(root, "url.txt")); i++) await new Promise((r) => setTimeout(r, 100));
const url = readFileSync(join(root, "url.txt"), "utf8").trim();
const browser = await chromium.launch({ args: ["--mute-audio"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push(e.message));
let fails = 0; const ok = (c, w) => { console.log(`${c ? "[ OK ]" : "[FAIL]"} ${w}`); if (!c) fails++; };
await page.goto(url);
await page.waitForSelector("[aria-label='메시지']", { timeout: 30000 });
await page.waitForTimeout(1000);
const box = page.getByLabel("메시지");
const idle = (t = 30000) => page.waitForFunction(() => !document.title.startsWith("["), null, { timeout: t });
const asks = (t = 20000) => page.waitForFunction(() => document.title.startsWith("[ ?? ]"), null, { timeout: t });
const say = async (text, key = "Enter") => { await box.click(); await box.fill(text); await box.press(key); };
const modeText = () => page.locator(".composer-foot .mode").first().innerText();
await page.locator(".side").getByRole("button", { name: "새 대화" }).first().click();
await page.waitForTimeout(1000);

// ---- /permissions: what an earlier run allowed goes first
await say("/permissions");
await page.waitForSelector(".sheet", { timeout: 5000 });
await page.waitForTimeout(400);
while (await page.locator(".rule button").count()) { await page.locator(".rule button").first().click(); await page.waitForTimeout(250); }
ok(await page.locator(".sheet", { hasText: "아직 없어요" }).count() === 1, "/permissions: 다 지움");
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
  ok(/\[ OK \]/.test(sh) && /package\.json/.test(sh), "! 명령 결과가 대화에");
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
await page.waitForFunction(() => document.title.startsWith("["), null, { timeout: 5000 }).catch(() => {});
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
ok(qs.length === 2 && qs[0].includes("다음 단계 전에") && qs[1].includes("끝나면"), `기다리는 말: ${JSON.stringify(qs.map((x) => x.replace(/\s+/g, " ")))}`);
await box.click();
await box.press("ArrowUp");
await page.waitForTimeout(600);
ok((await box.inputValue()) === "끝나고 이것도" && (await page.locator(".queued-bubble").count()) <= 1, `↑로 마지막 것 꺼냄: "${await box.inputValue()}"`);
await box.fill("");
await idle(40000);
const users = await page.locator(".msg-user").allInnerTexts();
ok(users.some((t) => t.includes("목록도 봐 줘")), "지금 단계 다음에 전한 말이 대화에");
ok(!users.some((t) => t.includes("끝나고 이것도")), "꺼낸 말은 안 보냄");

// ---- webfetch: asks, 4 = always for this site
await say("웹 읽기 해 줘");
await asks();
await page.waitForTimeout(300);
ok(await page.locator(".ask", { hasText: "이 웹 페이지를 읽을까요?" }).count() >= 1, "webfetch 묻기");
ok(await page.locator(".ask button", { hasText: "늘 허용" }).count() >= 1, "늘 허용 버튼");
await box.click();
await page.keyboard.press("4");
await idle();
const webStep = await page.locator(".step", { hasText: "webfetch" }).last().innerText();
ok(!/alert|color:red/.test(webStep), "스크립트·스타일은 뺌");
let asked = false;
const watch = setInterval(async () => { if ((await page.title().catch(() => "")).startsWith("[ ?? ]")) asked = true; }, 100);
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
ok(await page.locator(".rule").count() === 0, "지우기");
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

// ---- /new
const before = await page.locator(".msg-user").count();
await say("/new");
await page.waitForTimeout(1000);
ok(before > 0 && (await page.locator(".msg-user").count()) === 0, "/new 새 대화");

ok(errs.length === 0, `콘솔 오류 ${errs.length}개 ${errs.slice(0, 3).join(" | ")}`);
if (process.env.ROBINCODE_UI_SHOT) await page.screenshot({ path: process.env.ROBINCODE_UI_SHOT });
await browser.close();
stopServer();
await new Promise((r) => setTimeout(r, 500));
rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
console.log(fails ? `실패 ${fails}개` : "모두 통과");
process.exit(fails ? 1 : 0);
