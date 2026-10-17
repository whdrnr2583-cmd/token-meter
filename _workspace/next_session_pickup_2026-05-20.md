# Token Meter — 다음 세션 진입점 (as of 2026-05-20)

## 현재 상태
- **npm v0.1.15 publish + e2e 검증 완료.** GitHub main 푸시 + 태그 `v0.1.15`. 7 커밋.
- 0.1.15 = Codex/WSL 경로 정확성(`scanWindowsUserDirs` 듀얼환경 — Codex 데이터 처음 잡힘 실증: 43파일·gpt-5 stats 노출) + `usage_summary` 답-형태 재설계 + insights opt-in + CLI 컴팩트 표 + 첫실행 가드(`ensureFirstRunData`) + MCP 버전/startup 하드닝.
- 패키지명 `@whdrnr2583/token-meter` **유지 결정** (재브랜딩은 트래픽 생긴 후 — 지금은 미관 비용 < 작업·리스크).
- 실 유료 0건 / GitHub 별 0 / 실사용자 0. 첫 시장신호 = N=3 테스터 미온적.

## 레드팀 결론 → 전략 (다음 행동을 지배)
레드팀 5명 중 4명이 거의 그대로 섬. 핵심 진단: **"retention을 모른다."**
- 전략 = **계측 우선(instrument-first). 고도화·신규기능 금지** — 지금 불필요, PMF 게이트 위반, 검증 안 된 것 정교화 = 잘못된 대상 다듬을 위험.
- 살아남은 단 하나의 가설 = **MCP 안에서 0토큰 질의**가 habit이 되는가.

## 다음 행동 — Step 1 (새 코드 0줄)
1. 테스터 3명에게 **재확인 메시지**(아래 ①) — retention 질문이 핵심.
2. **카톡 1회 공유**(아래 ②) — kakao override 단발 박제 하에 OK. 테스터 답 먼저 권장. 스크린샷은 0.1.15 재시작 후 캡처.
3. **사전 판정 기준** (데이터 받기 전 박제 — 사후 합리화 금지):
   - 🟢 Signal A: 테스터 ≥1명이 부탁 없이 재사용 OR 카톡에서 돌아온 사용자/별 1+
   - 🔴 Signal B: "재미있다"만, 아무도 안 돌아옴
4. 분기: **A** → MCP 질의 wedge에 작게 베팅 / **B** → D-025 발동 (무료 OSS 안착 or 폐기 — 실패 아닌 정직한 결말).

## 준비된 문구

### ① 테스터 3명 재확인
```
[Token Meter 업데이트 — 한 번만 더 봐주실래요?]

지난번 "보기가 어렵다 / 뭘 봐야 할지 모르겠다" 주신 피드백,
그거 반영해서 새 버전(0.1.15) 냈습니다.

바뀐 점:
· 화면이 '숫자 나열' → '답' 형태로 (얼마 썼나 · 어디에 · 뭐가 느렸나)
· Codex 사용량도 이제 같이 잡힙니다

업데이트:
· Claude Code에서 쓰는 중이면 → Claude Code 재시작 (자동으로 새 버전)
· 또는 터미널에서: npx -y @whdrnr2583/token-meter@latest stats 7

두 가지만 답해주시면 큰 도움이 됩니다:
1. 새 화면, 좀 나아졌나요? 아직 어색한 데 있으면 그대로 알려주세요.
2. 솔직하게 — 처음 써본 뒤로 지금까지 한 번이라도 다시 켜본 적 있으세요?
   (없어도 괜찮습니다. 그게 진짜 궁금한 거예요.)
```

### ② 카톡 공유
```
[직접 만든 거 공유] 토큰미터(Token Meter) 만들었습니다 — 한번 확인해봐 주세요 🙏
Claude Code · Codex 토큰 사용량 보는 도구. 무료 · 오픈소스(MIT).

↑ 스크린샷: Claude Code 안에서 토큰미터 불러본 화면

내가 토큰을 어디에 얼마나 쓰는지 — 프로젝트 · 모델 · 시간대 · 도구별로
로컬에서 봅니다. 로그만 읽고 외부 전송 0, 계정 가입 0.

설치 (Node 18+):
· 대시보드: npx -y @whdrnr2583/token-meter serve  → localhost:8765
· Claude Code 안에서: npx -y @whdrnr2583/token-meter install-mcp claude-code

GitHub: github.com/whdrnr2583-cmd/token-meter

직접 만든 거라 거칠 수 있습니다. 써보고 안 맞는 점·버그 알려주시면 고칩니다.
```

## 주의
- **고도화·신규 기능 금지** (PMF 게이트 + 레드팀 결론). Signal A 확인 후에만, 그것도 작게.
- 카톡 응답 수 = D-039 WTP 라운드 지표.
- "build-more" 충동이 이번 라운드 내내 반복됨 — 다음 세션도 cross-check.
