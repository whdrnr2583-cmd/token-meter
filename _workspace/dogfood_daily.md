# 본인 dogfood 일일 운영 (PMF 게이트 진행 매트릭스)

> RUNBOOK §T+24h 회고 자동화. 매일 1-3분.

---

## 매일 1회 (Claude Code 세션 끝날 때)

> ⚠️ **2026-05-17 정정**: 실사용은 WSL Claude Code(`/home/whdrnr/.claude`)에 있음.
> dogfood ingest는 **WSL(bash) 기준**으로 고정 — Windows `cmd.exe`로 돌리면
> 빈 Windows home(`C:\Users\whdrn\.claude`)만 스캔해 100배+ 과소집계됨.
> 두 home은 별도 DB(WSL `~/.tokenpulse` vs Windows `%USERPROFILE%\.tokenpulse`).

**기본 — WSL (bash, 실사용 대부분):**
```bash
npx -y @whdrnr2583/token-meter ingest    # /home/whdrnr/.claude → /home/whdrnr/.tokenpulse/usage.db
npx -y @whdrnr2583/token-meter stats 7
```

**보조 — Windows (token-meter 자체 개발분만, 선택):**
```bash
cd "/mnt/c/Users/whdrn/Desktop/money/token-pulse" && cmd.exe /c "npx -y @whdrnr2583/token-meter stats 7"
```

또는 Claude Code MCP 호출:
```
"token-meter usage_summary로 오늘 사용량 보여줘"
"token-meter recent_sessions로 최근 24시간 세션 보여줘"
```

---

## 매일 1회 체크 (1분)

- [ ] **npm 다운로드**: https://www.npmjs.com/package/@whdrnr2583/token-meter (페이지 하단 weekly downloads)
- [ ] **GitHub Star**: https://github.com/whdrnr2583-cmd/token-meter (상단 Star 카운트)
- [ ] **Tally 응답**: https://tally.so/forms/2E16vD/submissions
- [ ] **Gmail `hello@token-meter.dev`**: 라우팅 응답 1건이라도?
- [ ] **카톡 promo 전환 watch (5/22~)**: GitHub ★ delta + 실 install. 따봉≠전환 — ★가 0→1+ 오르면 그 사람이 첫 진짜 신호. 4회 누적 카톡 promo 실 전환 0 추적 중 (1개월 회고 input).

---

## 일별 박제 (간단)

| 날짜 | npm DL | GitHub ★ | Tally | Gmail | dogfood OK | 메모 |
|---|---|---|---|---|---|---|
| 5/13 | 0 | 0 | ? | ? | publish | v0.1.0→0.1.1 (MCP Registry mcpName) |
| 5/14 | 368* | 0 | ? | ? | ✓ | T+24h 회고 + v0.1.2 publish (serve subcommand fix + --version/--help). npx clean 검증 OK. *DL 368 = 5개 버전 균등 분포(88/112/135/98/100) → mirror·security scanner (Socket/Snyk 등) 자동 scan 추정, 실 install 0 |
| 5/15 | 0 | 0 | ? | ? | ✓ | v0.1.3 (license gating + Polar webhook + Resend) + v0.1.4 (setup) + v0.1.5 (install-mcp) 묶음 publish. D-031/D-032 박제. LEGACY 3종 archive (pmf_gate_progress / icp_interview_template / kakao_announcement_v1) |
| 5/16 | 0 | 0 | ? | ? | ✓ | dogfood 정상 — $0.7423 / 41 events / opus-4.7 위주. npm DL 0 (5/14·15 scanner burst 종료) |
| 5/17 | 183* | 0 | ? | ? | ✓ | 🔴 **dogfood 경로 버그 발견** — cmd.exe ingest는 Windows home(`C:\…\.claude`)만 스캔, 실사용은 WSL(`/home/whdrnr/.claude`)에 있음. 실제 5/17 = **$285.84 / 268 events (WSL DB)**, Windows-only는 $0.29/15뿐. WSL 7d 누적 $1924.64 (5/15 $410·5/16 $468·5/17 $285.84). 이전 메모 USD(5/16 $0.74 등)는 전부 Windows-only 과소집계 — 절차 버그(제품 버그 아님). 4-check: node_modules OS 불일치 → `npm ci` 후 40/40 통과, 배포본 npm 0.1.9 정상. *npm DL 183=5/16 final, ★0 |
| 5/18 | 19* | 0 | ? | ? | ✓ | dogfood 정상 — $177.36 / 186 events / opus-4.7 only / Codex 0. 7d 누적 $1837.44 / 2431 events. *npm DL 19 = 5/17 final(last-day API); 1주 누적 1088이나 단일일 19로 급락 = 5/14·15 scanner burst 완전 종료. ★0. W1 주간 회고 ↓섹션 |
| 5/19 | _ | _ | _ | _ | ✓ | v0.1.12→0.1.15 5건 publish (POSIX 경로 fix·"today"=calendar day·WSL dual-env·first-run guard·subagent JSONL scan). dogfood = primary. |
| 5/20 | _ | 0 | _ | _ | ✓ | 🚨 **v0.1.16 publish via secondary working dir** (`/mnt/c/Users/whdrn/token-meter`) — primary와 5일간 평행 분기. daily-by-model + `scope` 필터 신규기능 추가 = PMF "신규기능금지" 룰 우회 1회 (Claude 70 / user 30, 동기 = 카톡 N=2 [[feedback_tokenmeter_kakao_signal_override]]). Y 진단으로 0.1.13~0.1.15는 primary publish 확정 ("Oversized tool responses" 마커). X 진행: secondary src/test/scripts/CHANGELOG → primary sync (51 files), primary build === published 0.1.16 dist (byte-identical), commit c2e17ab + tag v0.1.16 push. Secondary `_workspace/legacy/secondary_20260520/` archive (86MB). dogfood 7d = $2556 / 4599 events (opus-4.7 위주). [[feedback_tokenmeter_two_working_dir_drift]] |
| 5/21 | _ | 0 | _ | _ | ✓ | dogfood $445.78 / 673 events (7d table 기준). |
| 5/22 | 2040wk* | 0 | ? | ? | ✓ | **npm deprecate 0.1.0–0.1.15 적용** (Windows whoami=whdrnr2583, OTP 인터랙티브, 사용자 직접 실행). 메시지 "Outdated. Update to latest: npm i -g @whdrnr2583/token-meter@latest". 0.1.16(latest) 경고 없음 확인. 구버전 install 시 경고 = pull-model 하 유일 능동 최신화 유도(배포 위생, 신규기능 아님 → PMF 게이트 무관). dogfood 7d $2735 / 4689 events, opus-4.7 99% ($2712). *주간 DL 2040 = scanner 패턴 지속, 실 install 신호 X. ★0. cmd.exe `<` redirect + WSL→cmd 따옴표 doubling 함정 → .bat 리터럴 우회로 해결. **카톡 promo 4차 게시(strangers, 초보용 문구) → 따봉 4~5개만, 텍스트 응답·문의·install 0 = passive ack(전환신호 아님). 24h 내 ★/실 install delta로 전환 여부 cross-check 예정.** 방문자확인: 랜딩 분석 비콘 미설치 + wrangler 토큰 analytics:read 없음 → 방문자 데이터 현재 측정 불가. |

| 5/23 | _ | 0 | ? | ? | ✓ | **첫 실제 방문자 데이터 (CF zone Traffic, 24h)** — 합 ≈1,487 req. 지리: Malaysia 969 · Netherlands 260 · US 175 · Brazil 48 · Japan 35. **한국 부재** = 5/22 카톡(한국 타겟) 클릭 ~0 확정 / NL·MY·US = 데이터센터·스캐너 봇 패턴. 판정 = **no real human entry** (raw 1,487은 봇 노이즈 false-positive). ★0 유지 → 따봉 4~5 전환 0 확정. 외부 실수요 신호 0이 5소스(★·DL·Gmail·따봉·방문자) 일관. 봇/사람 100% 분리는 비콘만 가능하나 한국 부재로 판정 충분. **CSV 4종 정밀(24h): total_requests 합 ~1,581(country top5 1,487과 일치) · unique_visitors 시간당 2-16 합~149(실 daily distinct ~50-100 IP) · percent_cached ≈0 · data_served 버스트. 봇 확정 근거: ①unique가 밤새 평탄(2-5AM 4-10)=분산IP 크롤러 시그니처(사람은 밤에 잠) ②cache≈0=매 요청 miss=스캐너 probing ③지리 MY969·NL260 지배·한국 부재 ④전환0. ~50-100/day는 스캐너·모니터 배경노이즈, 사람 0~극소수.** ⚠️정정: 5/23 1차 박제 "≈21,517 req"는 `data_cached`(바이트류) CSV 오독 — 실 requests는 ~1,581. cross-check 누락 사례([[feedback_agent_cross_check]]). 비콘 불필요. 질문 종료 — 외부 실수요 0 결론 확정. |
| 5/24 | _ | _ | _ | _ | ✓ | dogfood $148.12 / 228 events. 사이트 GEO/SEO 작업 2커밋 (JSON-LD SoftwareApplication+FAQPage · SEO files+keyword meta) — npm 발행 X. |
| 5/25 | _ | _ | _ | _ | ✓ | dogfood $183.88 / 460 events. **feat(pro) commit `d2dcdff`** — forecast·CSV/JSON export·weekly digest·trim suggestions, build+test 통과, **미발행**. PMF 게이트 위반 여지 (결제 0건 + 신규기능) — 5/27 처리 결정 예정. |
| 5/26 | _ | _ | _ | _ | ✓ | dogfood $114.02 / 302 events. 커밋 0. |
| 5/27 | _ | _ | _ | _ | ✓ | **v0.1.17 publish** (forecast·CSV/JSON export·weekly digest·trim suggestions). PMF 게이트 1회 우회 (결제 0건, 사용자 명시 결정). feat/pro-batch → main merge 완료. 7d $1,627.62 / 3,377 events (opus-4.7 98%). |
| 6/28 | _ | _ | _ | _ | ✓ | **v0.1.19 구현·커밋·push (미발행)** — sub-agent & cache 비용 귀속(`agent_id` 컬럼·`subagent_costs` MCP tool·`subagents` CLI). PMF 1회 우회(D-040). commit 7687724 push 완료. 빌드된 MCP boots·tools/list 노출 확인. **→ v0.1.20 (미발행)** — 로컬 LLM 프록시 foundation(`token-meter proxy`·`local` CLI·`ttft_ms` 컬럼·OpenAI-compat `/v1/chat/completions` TTFT/TPS 계측·Ollama default). PMF **2차** 우회(같은 세션, D-041, build-spree 경고 고지 후 사용자 명시). 4-check ✅ (81 test pass·audit ALL HOLD·build OK). npm publish는 web-auth E404로 사용자 측 막힘→legacy auth 안내. 발행 시 0.1.18→0.1.20(두 기능 합본). |
| 7/11 | _ | _ | _ | _ | ✓ | dogfood $73.84 / 878 events. **⚠️ 7/11~18 8행은 2026-07-18 일괄 backfill** (6/29~7/10 미기록 — OSS-maintain D-042 조용한 기간, daily ritual 중단). WSL bash ingest로 4일 갭(07-15~18) 채움. **모델 믹스 전환**: 기존 opus-4.7 단일 → opus-4.8 $333.6 · fable-5 $187.9 · sonnet-5 $185.3 3분할(7d). 직전 cmd.exe 집계 "$3.08"은 Windows/Codex subset 오독 — 실 WSL 7d = $711.22(5/17 절차 함정 재현, WSL home이 실사용). |
| 7/12 | _ | _ | _ | _ | ✓ | dogfood $187.80 / 1617 events. |
| 7/13 | _ | _ | _ | _ | ✓ | dogfood $61.76 / 372 events. |
| 7/14 | _ | _ | _ | _ | ✓ | dogfood $30.41 / 647 events. |
| 7/15 | _ | _ | _ | _ | ✓ | dogfood $165.81 / 1405 events. |
| 7/16 | _ | _ | _ | _ | ✓ | dogfood $63.32 / 485 events. **v0.1.27·v0.1.28 publish** (CHANGELOG 07-16) — `token-meter audit` 명령 추가 + gating default-ON 수정(미인증 caller가 Pro+로 새던 버그, unlicensed→Free breaking). 이후 test 커밋 2건(7caea68·ea203a5). OSS-maintain 하 버그/보안 픽스. |
| 7/17 | _ | _ | _ | _ | ✓ | dogfood $114.32 / 1150 events. (메모리: 07-17~18 3트랙 종료 시 0.1.28 배포 확정.) |
| 7/18 | _ | _ | _ | _ | ✓ | dogfood $13.95 / 49 events (진행중, 오늘). **7d 누적 $711.22** / cache_r 895.4M · write 44.0M. 비싼/느린 도구: Read 2.95M resp_tok · Bash avg 5.6s · exec avg 51s. |

---

## 주간 회고 (월요일, 5분)

- [ ] 1주 dogfood로 발견한 본인 사용 패턴 (어느 MCP / 도구 / 시간대 비쌌나)
- [ ] 1주 동안 본인이 사용하지 않은 기능 (가치 낮음 → backlog 또는 제거)
- [ ] 새로 발견한 버그 0건? 1+ 건이면 v0.1.x 패치 우선
- [ ] **PMF 게이트 진행** (`pmf_gate_progress.md` 갱신)

---

## W1 주간 회고 — 2026-05-18 (월)

> dogfood 7일차 (5/11~5/18 ingest 기준). 첫 주간 회고.

### 1. 본인 사용 패턴 (7d · $1837.44 / 2431 events)
- **모델**: 100% claude-opus-4-7. Codex 0건 — Codex 파서 코드는 있으나 본인은 Codex 미사용.
- **비용 곡선**: 5/15 $410 · 5/16 $468 피크 → 5/17 $296 · 5/18 $177(부분). 주중 후반 급증.
- **토큰 최대 소비 도구** (resp tokens): Read 392.9k · Agent 219.3k · Bash 212.6k. 파일 읽기가 컨텍스트 최대 소비원.
- **최고 지연 도구**: Agent avg 91.6s (251회) — 서브에이전트 호출이 압도적으로 느림. (AskUserQuestion 174s는 사용자 대기시간이라 비용 아님.)
- **cache**: read 660.7M / write 22.3M — 캐시 의존도 매우 높음. opus 비용의 상당 부분이 cache read.

### 2. 본인이 거의 안 쓴 기능 (가치 낮음 신호)
- **token-meter MCP 도구**: 7d 동안 usage_summary 1회 · refresh_data 1회 · recent_sessions 0 · session_tools 0.
- dogfood라면서 정작 제품 MCP를 거의 안 쓰고 CLI `stats`로만 확인 중.
- → backlog 관찰 항목 (제거 아닌 관찰): "MCP 도구 4종 중 실제 가치 있는 건 무엇인가" — 1개월 회고까지 데이터 더 누적.

### 3. 새 버그
- 제품 버그 **0건**. v0.1.x 패치 불요.
- (5/17 dogfood 경로 버그는 절차 버그 — cmd.exe→WSL home 불일치. 박제 완료, 제품 무관.)

### 4. PMF 게이트 진행
- 알파 0 / ICP 인터뷰 0 / 카톡 0 / dogfood day 6/30 진행 / Y1 ARR $0 — **모두 정체**.
- 구조적 원인: 알파·카톡·인터뷰는 outbound 필요 → D-031 outbound 차단으로 채널 자체가 비활성. dogfood만 유일하게 움직이는 지표.
- W1 사실 박제: 게이트 5조건 중 4개가 outbound에 묶여 진행 불가. W2~W4 동안 dogfood 완주 외 게이트 변동 여지 없음 — 1개월 회고 때 이 구조를 사용자와 재논의 (처방 제안 아님, 사실 기록).

---

## 1개월 회고 (PMF 게이트 1st check)

PMF 게이트 5조건 통과 여부 (`pmf_gate_progress.md`):
- 알파 W2 5명 중 3+ 사용
- 본인 dogfood 1개월 X 일 (X >= 25)
- 카톡 직접 응답 N명 (≥ 10이 시작점)
- ICP 인터뷰 5명 (Mom Test 방식)
- npm 다운로드 / GitHub Star 추이

3+ 통과 → M3 결제 wiring 진입 검토
미달 → D-021 stop-loss #2 발동 → 가격·포지셔닝 재설계 1회 → 미달 시 보류
