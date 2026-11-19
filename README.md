# RobinCode

robin이 쓰는 코딩 에이전트 앱이에요. [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 에이전트 엔진 위에 RobinX 디자인의 React 창을 올렸고, 모델은 RobinAI GPU(llama-server)에서 돌아요.

> 이 저장소는 사본이에요. 원본은 비공개 저장소 `yoonrobin.xyz`의 `robincode/` 폴더이고, 거기서 커밋 기록째 옮겨 와요. 이슈·PR은 받지 않아요.

## 무엇을 하나

- 폴더에서 일하는 대화: 파일 읽기·쓰기, 명령 실행, 웹 페이지 읽기. 파일을 고치거나 명령을 돌리기 전에 허락을 물어요(`guard.mjs`가 위험한 명령·비밀 파일을 따로 막음).
- 폴더 없는 일반 대화: 도구는 웹 페이지 읽기만.
- 한 창에서 여러 대화. 떠난 대화도 뒤에서 계속 돌고, GPU 자리가 없으면 기다렸다 보내요.
- Windows 앱(`desktop/`, Electron) — 설치판과 자동 업데이트.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `server.mjs` | Pi 세션들을 들고 HTTP + SSE로 창과 이야기하는 서버 |
| `guard.mjs` | 도구 호출 검사(지우기·비밀 파일·git 강제 푸시 등) |
| `folders.mjs` | 최근 폴더 목록 |
| `web/` | 대화 창(React, Vite) |
| `desktop/` | Windows 앱 껍데기(Electron) |
| `fake-model.mjs`, `fake-gpu.mjs` | 시험용 가짜 모델·GPU |

## 돌려 보기

```bash
npm ci
npm run build
node server.mjs --fake
```

`--fake`는 진짜 모델 대신 가짜 모델로 화면만 띄워요. 진짜 모델 연결(ssh 터널, GPU 서버)은 robin의 서버 구성에 묶여 있어서 이 사본만으로는 안 돼요. 글꼴과 폴더 고르는 화면도 원본 저장소의 다른 폴더에 있어서 여기선 기본 글꼴로 보여요.

## 라이선스

따로 정하지 않았어요(모든 권리 보유).
