# 릴리스 준비 체크리스트 — 0.1.30 후보 (2026-10-21 작성)

> 아래는 최신 절차다. 이 문서의 나머지(v0.1.0)는 역사 기록이다.
> 이 배치는 **릴리스 준비 상태까지만** 만들었다. 버전 bump·태그·`npm publish`는 하지 않았고, 이 환경에는 npm 자격증명이 없다.

## A. 가격표 재검증 (릴리스 전 필수)

`src/pricing.ts` 의 숫자는 이번 배치에서 바꾸지 않았다.

| 대상 | 상태 (2026-10-21) | 할 일 |
|---|---|---|
| Anthropic 17개 모델 (`claude-*`, `claude-haiku-4` 제외) | 공식 페이지 `https://platform.claude.com/docs/en/about-claude/pricing.md` 를 받아 `npm run check:pricing -- --only anthropic --anthropic <저장본>` 로 대조: **차이 0** | 릴리스 직전 한 번 더 (`npm run check:pricing -- --only anthropic`) |
| OpenAI 행 (`gpt-*`, 12개) | **미검증** — 빌드 샌드박스가 `developers.openai.com` 에 접속 불가 | 인터넷 되는 머신에서 `npm run check:pricing` (또는 `-- --only openai`) 실행, 차이 0 확인 |
| `claude-haiku-4` | 공식 표에 대응 행 없음 (대조 제외) | 공식 표에서 폐지됐는지 확인, 필요 시 행 제거 여부 결정 |
| `gpt-5.3-codex-spark` | 공식 가격 미공개로 gpt-5 값을 임시 사용 (코드 TODO) | 공개됐는지 확인 후 교체 |
| `gpt-5.6-sol` | 프로모션가 ($4/$20, 2026-11-21 이후 변동 가능) | 11-21 이후 릴리스면 재확인 |
| 캘린더 페이지 | `infra/site/calculator.html` 은 Haiku 5.5 장문 프롬프트 구간 표현 불가 (알려진 한계) | `test/calculator-pricing-sync.test.ts` 통과 확인 |

종료 코드: 0 차이 없음 / 1 차이 있음 / 2 가져오기·파싱 실패 (조용한 통과 없음).
차이가 나오면 근거(페이지 URL, 확인 날짜)를 `src/pricing.ts` 주석과 CHANGELOG 에 남기고 `src/pricing.ts` → `infra/site/calculator.html` 순으로 맞춘다.

## B. 릴리스 직전 점검 (모두 통과해야 진행)

```sh
npm ci
npm run typecheck && npm test && npm run build
TOKENPULSE_DB=<시험용 DB> npm run audit       # 데이터 품질 불변식
npm pack --dry-run                             # public/vendor/chart.umd.js, public/i18n.js 포함 확인 (~230 kB)
node scripts/test-mcp-built.cjs                # 빌드본 MCP 동작
```

- CHANGELOG `[Unreleased]` 를 새 버전 제목으로 바꾸고 날짜 기입 (Known gaps 항목은 해결 여부 재확인).
- `package.json` / `server.json` / `glama.json` 버전 일치 확인 후 bump (사용자 몫).
- 브라우저에서 대시보드 수동 확인 1회: 영어/한국어 토글, 탭 키보드 이동, 모바일 폭(≈375px), 오프라인에서 차트 표시(CDN 제거 확인).
- 태그·`npm publish` 는 사용자 실행 (2FA OTP 필요).

---

> 이 문서는 v0.1.0 출시 당시의 기록이다. 현재 릴리스 절차와 다를 수 있다.

# 배포 런북 — v0.1.0 (오늘 20:00)

순서대로 실행. 각 단계 실패 시 STOP하고 원인 파악 후 진행.

---

## T-30분 (19:30) — 사전 점검

```sh
cd <repo>

# 1. 최종 회귀 4종
npm run typecheck
npm test
npm run audit
npm run build

# 2. dist 빌드 본 MCP 동작
node scripts/test-mcp-built.cjs

# 3. pack 미리보기
npm pack --dry-run
```

전부 ✅ 나오면 진행. 하나라도 빨간 줄이면 발견·수정 후 재시작.

---

## T-15분 (19:45) — 이름·계정·도메인

### 1. npm 패키지명 충돌 확인 (3초)
```sh
npm view token-meter
```
- **404** = OK, 진행
- 정보 출력 = 누가 선점함 → `token-meter-cli` / `tokenmeter` 등 대체. STRATEGY.md 백업 후보 사용

### 2. npm 로그인 (필요 시)
```sh
npm whoami            # 로그인 상태 확인
npm login             # 미로그인 시
```
2FA 활성 권장 (publish OTP 입력 필요).

### 3. GitHub `<owner>` 확정
- 개인 username 그대로? Organization 생성?
- 결정 즉시 다음 명령에서 `<OWNER>` 치환

### 4. (선택) 도메인 등록 — 5분, $12/yr
```
Cloudflare Registrar → tokenmeter.dev 검색 → 등록
```
없어도 publish 가능. 도메인 없으면 package.json `homepage`만 placeholder 유지.

---

## T-0 (20:00) — 본배포

### 1. package.json 자리표시자 교체
[package.json](package.json) 안의 `REPLACE_OWNER` 2개를 실제 GitHub `<owner>`로 교체:
```diff
- "url": "git+https://github.com/REPLACE_OWNER/token-meter.git"
+ "url": "git+https://github.com/<OWNER>/token-meter.git"
- "url": "https://github.com/REPLACE_OWNER/token-meter/issues"
+ "url": "https://github.com/<OWNER>/token-meter/issues"
```

### 2. Git 초기화 + 첫 커밋
```sh
cd <repo>
git init
git branch -m main
git add .
git status                # 의도치 않은 파일 없는지 확인
git commit -m "feat: Token Meter v0.1.0 — Claude Code + Codex usage observability"
```

### 3. GitHub 리포 생성 + push
```sh
gh repo create <OWNER>/token-meter --public \
  --description "Local-first dashboard + MCP server for Claude Code and Codex token usage." \
  --license mit \
  --source . \
  --push
```
`gh` CLI 없으면: github.com 웹에서 빈 리포 생성 → `git remote add origin ...` → `git push -u origin main`

### 4. NPM_TOKEN 등록 (자동 publish용 — 1번만)
1. npmjs.com → Account → Access Tokens → Generate New Token → **Granular**, **Publish** scope, **@whdrnr2583/token-meter** 패키지로 제한
2. GitHub `<OWNER>/token-meter` → Settings → Secrets → Actions → New: `NPM_TOKEN` = 토큰값

### 5. 첫 publish (수동, 검증용)
```sh
npm publish --access public --provenance
# prepublishOnly 훅 자동 실행: typecheck + test + build
# 2FA OTP 입력 메시지 나오면 입력
```
실패 시:
- `403 Forbidden` → 이름 충돌. 다른 이름으로 재시도
- `prepublishOnly` 실패 → 사전 점검 다시
- 2FA 오류 → npm 사이트에서 OTP 재확인

성공 시 npmjs.com/package/@whdrnr2583/token-meter 페이지 자동 생성.

### 6. Git 태그 + 자동 release 검증
```sh
git tag v0.1.0
git push origin v0.1.0
```
→ `.github/workflows/release.yml` 자동 실행.
- **멱등 가드**: 이미 npm에 같은 버전 있으면 publish 단계 자동 skip ("Version token-meter@0.1.0 already on npm — skipping publish").
- v0.1.1 이후부턴 package.json version bump + tag push만 하면 CI가 publish 처리.

---

## T+5분 (20:05) — 배포 검증

### 1. 깨끗한 환경에서 npx 동작 확인
```sh
# 별도 디렉토리에서
cd <임시 작업 폴더>
npx -y @whdrnr2583/token-meter@0.1.0 stats 7
# → "Last 7 days" 요약 출력
```

### 2. MCP 등록 + 호출 확인
```sh
claude mcp add token-meter -- npx -y @whdrnr2583/token-meter mcp
# Claude Code에서 "token-meter usage_summary로 이번주 보여줘" 요청
```

### 3. npmjs.com 페이지 확인
- README가 영문 (당신이 보고 있는 ./README.md)로 표시되는지
- Pricing·사업 내용 없는지 (있으면 STRATEGY.md가 잘못 포함된 것 — 즉시 unpublish + 0.1.1 재배포)

---

## T+10분 (20:10) — 1차 알림 (소규모)

조용한 첫 공개. 대규모 launch는 1주 사용·피드백 후.

### 카톡 AI 오픈채팅방 (한국어 소규모)
```
Token Meter v0.1.0 공개했습니다.
Claude Code + Codex 토큰 사용량 로컬 대시보드 + MCP 서버 (무료, MIT).
npx @whdrnr2583/token-meter mcp 로 등록하면 Claude Code 안에서 "최근 세션 보여줘" 가능.
https://www.npmjs.com/package/@whdrnr2583/token-meter
피드백 환영합니다.
```

### 본인 X (선택)
간결한 한 줄 + npm 링크 + 스크린샷 1장.

**의도적으로 안 함**:
- HN Show — 더 다듬어서 1~2주 후
- r/ClaudeAI — 동일
- 카톡 외 영문 커뮤니티 — 동일

이유: 첫 24시간에 버그 발견·피드백 흡수 → v0.1.1 / v0.1.2 빠른 사이클 후 본격 마케팅.

---

## T+24h (다음날) — 회고

체크리스트:
- [ ] npm 다운로드 카운트 확인
- [ ] GitHub Star·Issues 확인
- [ ] 본인 데이터 갱신 (`npm run audit`) 정상
- [ ] 피드백 1건이라도 받았으면 응대 (Gemini 자동 답변 아직 미셋업이므로 본인 처리)
- [ ] 발견된 버그 0건이면 다음 작업 진행, 1+건이면 v0.1.1 패치 우선

---

## 비상 — 배포 후 문제 발생 시

### Critical 버그 발견 (24h 이내)
```sh
npm unpublish @whdrnr2583/token-meter@0.1.0
# 패치 후 0.1.1로 재배포
```
24h 지나면 unpublish 불가 → deprecate + 0.1.1 publish:
```sh
npm deprecate @whdrnr2583/token-meter@0.1.0 "Critical bug, use 0.1.1+"
npm publish --access public
```

### 패키지명 분쟁
- 우리가 등록 → 누가 동일명 등록 시도 차단됨
- 누가 먼저 등록한 상태 → 대체명 사용 (token-meter-cli / tm-meter / aimeter 등)
- README의 npm 명령들 일괄 치환 후 publish

### Claude Code MCP 등록 실패
- `claude mcp list` 로 현재 목록 확인
- `claude mcp remove token-meter` 후 재등록
- npx 캐시 문제: `npm cache clean --force` 후 재시도

---

## 배포 후 즉시 백로그 (24h~1주)

D-021 stop-loss 기준 그대로 적용:
- M2 종료(4주) DAU 30 미만 → 콘텐츠 가속 1회
- 본업·v18 침범 0 유지
- 8주 안 알파 안 띄움 = 일시 중단

추가 작업 후보 (우선순위):
1. 비용 예측·페이스 알림 (Pro 강화)
2. CSV·JSON export (Pro 강화)
3. 한국어 응대 자동화 (Gemini 메일 받기)
4. 카톡 5명 응답 받기
5. v0.2.0 = 위 1+2 묶음

---

## 박제 후 메모리 업데이트

배포 성공 시 운영자 개인 메모리(이 저장소 밖)의 token-meter 프로젝트 기록 갱신:
- v0.1.0 출시 날짜
- npm 패키지명 확정
- GitHub URL 확정
- 도메인 등록 여부

---

## 한 줄 요약

**T-30 사전 점검 → T-15 계정·이름 → T-0 publish → T+5 검증 → T+10 카톡 1차 알림 → T+24h 회고.**
**총 1시간 안에 끝남. 실패 시 비상 섹션 참조.**
