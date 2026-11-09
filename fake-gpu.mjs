// A fake `robinai-gpu` for testing the window's GPU panel: nothing is rented,
// nothing leaves this PC. server.mjs runs it instead of ssh when
// ROBINCODE_FAKE_GPU names a JSON file, which keeps the fake state.
//   node fake-gpu.mjs [follow] status | offers | rent <offer id> | start | keep | destroy
// rent goes through robinai-gpu's "진행:" lines, one every ROBINCODE_FAKE_GPU_STEP
// ms (default 400), and stops when a destroy came meanwhile, as the real one does.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.ROBINCODE_FAKE_GPU;
let args = process.argv.slice(2);
if (args[0] === "follow") args = args.slice(1); // the server runs it on its own; here it just runs
const [cmd, arg] = args;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP = Number(process.env.ROBINCODE_FAKE_GPU_STEP) || 400;
let st = { state: "none", credit: 3.2, idle: 4 };
try { st = { ...st, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { /* first call */ }
const save = () => writeFileSync(file, JSON.stringify(st));
// tests: the server cannot be reached (ssh fails), for every command
if (st.down) { console.error("ssh: connect to host contabo port 22: Connection timed out"); process.exit(255); }
const OFFERS = [
  [50001, "South Korea, KR", "데이터센터", 0.51, 22, 99.9, 4, 632, 0.1],
  [50002, "South Korea, KR", "데이터센터", 0.51, 22, 99.8, 5, 488, 0.1],
  [50003, "South Korea, KR", "개인 호스트", 0.54, 52, 99.8, 6, 443, 0.05],
];

switch (cmd) {
  case "status":
    if (st.state === "running") console.log("GPU 서버: 켜져 있어요. RobinAI가 답할 수 있어요.\n요금: 켜 둔 동안 시간당 $0.51");
    else if (st.state === "starting") {
      const name = (st.progress || "").match(/^진행: 단계 \d+\/\d+ ([^·]+?) ·/)?.[1];
      console.log(`GPU 서버: 켜는 중이에요${name ? ` — ${name}` : "."}`);
      if (st.progress) console.log(st.progress);
      console.log("요금: 켜 둔 동안 시간당 $0.51");
    }
    else console.log('GPU 서버: 꺼져 있어요(빌린 GPU 없음, 요금 0). RobinAI 화면은 "꺼짐"이에요.');
    console.log(`남은 크레딧: $${st.credit.toFixed(2)}${st.state === "running" ? ` → 지금 상태로 약 ${Math.floor(st.credit / 0.51)}시간` : " (빌리면 RTX 5090은 시간당 약 $0.5)"}`);
    if (st.state === "running") console.log(`자동 끄기: 안 쓴 지 ${st.idle}분 — 20분이 되면 꺼요`);
    else if (st.state === "none") console.log("자동 끄기: 켜면 20분 동안 아무도 안 쓸 때 알아서 꺼요");
    break;
  case "offers":
    await sleep(300);
    st.offersAsked = (st.offersAsked || 0) + 1; // tests count how often the window asks
    save();
    if (st.noOffers) { console.error("지금 빌릴 수 있는 RTX 5090이 없어요."); process.exit(1); }
    OFFERS.forEach(([id, geo, host, hour, days, rel, mins, mbps, dl], i) => {
      console.log(`${i + 1}) ${geo} ${host} · 시간당 $${hour.toFixed(2)} · 최장 ${days}일 · 신뢰도 ${rel}% · 모델 받기 약 ${mins}분(${mbps}Mbps, $${dl.toFixed(2)})  [offer ${id}]`);
    });
    break;
  case "rent":
    if (st.state !== "none") { console.error("이미 빌린 인스턴스가 있어요. 먼저 지우세요."); process.exit(3); }
    st.state = "starting";
    save();
    console.log(`빌렸어요(인스턴스 90001, offer ${arg}). 이미지와 모델(18.9GB)을 받는 중이라 보통 약 7분 걸려요(최대 25분 기다려요).`);
    for (const line of [
      "진행: 단계 2/5 이미지 받기 · 0분 05초 지남 · 약 7분 남음 · Vast: loading (Pulling image layer 3/9)",
      "진행: 단계 2/5 이미지 받기 · 1분 05초 지남 · 약 6분 남음 · 컨테이너를 켜는 중이에요",
      "진행: 단계 3/5 모델 받기 · 4.2/18.9GB · 620Mbps · 2분 15초 지남 · 약 4분 남음",
      "진행: 단계 3/5 모델 받기 · 12.6/18.9GB · 640Mbps · 3분 50초 지남 · 약 3분 남음",
      "진행: 단계 4/5 GPU에 올리기 · 18.9/18.9GB · 5분 10초 지남 · 약 1분 남음",
    ]) {
      await sleep(STEP);
      try { st = { ...st, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { }
      if (st.state === "none") { console.log("빌린 GPU(인스턴스 90001)가 지워져서 그만 기다려요. 요금은 안 나가요."); process.exit(1); }
      st.progress = line;
      save();
      console.log(line);
    }
    await sleep(STEP);
    st.state = "running";
    st.progress = null;
    save();
    console.log("켜졌어요. RobinAI가 답할 수 있어요. (5분 58초 걸림)");
    break;
  case "start":
    st.state = "running";
    save();
    console.log("켜는 중이에요. 보통 1~3분 걸려요(최대 15분 기다려요).");
    break;
  case "keep":
    st.idle = 0;
    save();
    console.log("20분 더 켜 둬요.");
    break;
  case "destroy":
    await sleep(300);
    st.state = "none";
    st.idle = 4;
    st.progress = null;
    save();
    console.log("지웠어요(인스턴스 90001). 이제 요금이 안 나가요. 다음에 켜면 새로 빌려요.");
    break;
  default:
    console.error("쓰는 법: [follow] status|offers|rent N|start|keep|destroy");
    process.exit(2);
}
