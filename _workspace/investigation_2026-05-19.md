# 조사 3건 — 2026-05-19

v0.1.12+v0.1.13 fix 기준. 코드 수정 0건 — 발견·평가·권고만.

---

## 조사 A — 크로스플랫폼 로그 위치 탐지 정확성

### OS별 정확성 매트릭스

| 환경 | Claude Code 로그 위치 | token-meter 실행 위치 | 탐지 정확성 | 비고 |
|---|---|---|---|---|
| **Windows native** | `C:\Users\<u>\.claude\projects\` | Windows (cmd.exe) | 정확 | homedir()=C:\Users\<u>, cwd 필드 있음 |
| **Linux native** | `~/.claude/projects/` | Linux | 정확 | cwd 필드 항상 포함, POSIX 경로 |
| **macOS native** | `~/.claude/projects/` | macOS | 정확 | Linux와 동일 경로 구조 |
| **WSL (Claude Code in WSL)** | `/home/<u>/.claude/projects/` | WSL | 정확 | v0.1.12 이후: cwd 필드 → POSIX 경로 정상 |
| **WSL (Claude Code in Windows)** | `C:\Users\<u>\.claude\projects\` (/mnt/c/Users/...) | WSL | **갭** | WSL homedir=/home/<u> → Windows Claude 로그 미탐지 |
| **WSL (Claude Code in 양쪽)** | 두 디렉터리 각각 | WSL | **절반 누락** | WSL 로그만 보임, Windows 로그 안 보임 |

### `/` vs `\` 버그 근본원인 및 현재 상태

**보고된 버그**: `usage_summary`에서 동일 프로젝트가
`/mnt/c/Users/<u>/<project>`와 `\mnt\c\Users\<u>\<project>` 두 줄로 분리 집계.

**근본원인**: `src/ingest.ts` `prettyProjectName()` 함수가 v0.1.12 이전에 POSIX·Windows 구분 없이 모든 `-`를 `\`로 교체했음.
- 코드: `return dirName.replace(/-/g, '\\')` (구 버전)
- POSIX 디렉터리명 `-mnt-c-Users-<u>-<project>` → `\mnt\c\Users\<u>\<project>` (잘못된 백슬래시)
- 반면 JSONL `cwd` 필드는 실제 경로인 `/mnt/c/Users/<u>/<project>` (슬래시)를 담고 있어, 두 값이 DB에 별도 `project` 값으로 저장됨 → 프로젝트 split 발생.

**v0.1.12 수정 후 상태 (파일·라인 기준)**:

1. `src/ingest.ts:34-43` — `prettyProjectName()`: Windows(`^[A-Za-z]--`) vs POSIX 분기 추가. POSIX는 `-` → `/` 변환으로 수정. **신규 ingest에서 split 재현 없음.**

2. `src/parser.ts:51-57` — `parseJsonlFile()`: 모든 JSONL 라인을 순회해 첫 `cwd` 필드를 `project`로 사용. `prettyProjectName` 결과는 `cwd` 없을 때만 fallback. **실증 확인: 실제 JSONL에는 `cwd` 필드가 system/user/attachment 라인 모두에 있음** (`grep -m3 '"cwd"'` 결과로 확인).

3. `src/db.ts:126-138` — `migrate()`: 기존 DB의 백슬래시 시작(`\%`) + 콜론 없는 행을 슬래시로 역변환. 구 split 행 통합. **이미 업데이트된 DB라면 idempotent.**

**잔여 위험**: `cwd` 필드 없는 JSONL 극소수 케이스에서 `prettyProjectName` fallback 사용.
현행 구현도 Windows 경로 내 하이픈(예: `C:\my-project`) 시 오변환 위험은 있으나,
이는 Claude Code 인코딩 이슈(하이픈 디렉터리명)이며 `cwd` 필드가 있는 한 무관.

### WSL 듀얼 환경 — 설계 구조적 갭

**현황**: `claudeProjectsDir()` (`src/ingest.ts:27-29`)는 `homedir()` 한 곳만 스캔.
- WSL에서 token-meter 실행 시: `/home/<u>/.claude/projects/` 만 봄.
- Windows에서 Claude Code를 사용해도 해당 로그(`C:\Users\<u>\.claude\`) 는 탐지 불가.
- 실측: WSL `~/.claude/projects` 6개 디렉터리, Windows `/mnt/c/Users/<u>/.claude/projects` 9개 디렉터리 — 별개로 존재.

**권고**:
- **Quick win (설계 필요 없음)**: WSL 환경에서 `$WSLENV` 또는 `/proc/version` 감지 후 `/mnt/c/Users/<u>/.claude/projects/` 를 추가 스캔 후보로 병합. Windows 사용자가 WSL로 token-meter를 실행할 때 누락 방지.
- **commit-gate 필요 여부**: 신규 설계 로직 추가이므로 `npm test && npm run audit` 필요. v0.1.12 fix와 달리 quick-win 수준이 아닌 중간 규모 변경.
- **우선순위**: 타깃 ICP(Claude Code 헤비유저)가 WSL/Windows 동시 사용 비율이 높을수록 중요. 결제 0건 현시점 → dogfood 1인으로 재현 여부 확인 후 결정.

---

## 조사 B — 홈페이지(랜딩) 수정 필요 항목

**대상 파일**: `<repo>/infra/site/index.html`

수정 항목 5건 — correctness/fix only.

### B-1. "Email alert actions" 티어 오분류 [사실 오류, 중요]

- **위치**: line 175, Pro+ 기능 목록
- **현재**: `<li>Email alert actions</li>` (Pro+ 항목에 위치)
- **문제**: D-024 결정에서 `notify.email`은 **Pro $5** 기능으로 정의. Pro+ 목록에 넣으면 구매자가 Pro로 결제해도 "이메일은 Pro+ 아닌가?"라고 오해.
- **추가 사실**: `src/rules.ts:233-236`에서 `executeEmail()`은 현재 stub (`return 'skipped:email_not_wired_until_m3'`). 즉 기능 자체가 미구현.
- **권고**: Pro+ 항목에서 제거. Pro 항목(`<li><strong>Smart alerts</strong> unlimited — desktop + webhook</li>`)에 email 언급을 추가하되, "구현 예정" 또는 미구현 사실을 반영. 또는 email 전체를 랜딩에서 지울 때까지 숨김. v0.1.12 fix와 함께 v0.1.12 릴리스 묶음으로 처리 가능.

### B-2. iframe title "beta waitlist" vs 실제 상태 불일치 [stale 정보]

- **위치**: line 36, `<iframe ... title="Token Meter beta waitlist">`
- **현재**: `title="Token Meter beta waitlist"`
- **문제**: line 37의 hint 텍스트가 "Free + MIT licensed core, available now. Pro ($5/mo) is live"라고 명시. 제품은 이미 live인데 iframe accessibility title만 "beta waitlist"라고 남아있음.
- **권고**: `title="Token Meter waitlist"` 또는 `title="Token Meter early access"` 수정.

### B-3. Smart alerts 기능 설명에서 Pro 범위 저설명 [사실 부정확, minor]

- **위치**: line 72, features 섹션 Smart alerts 카드
- **현재**: "Threshold rules with desktop and webhook actions. Pipe into Slack, Discord, n8n — your call."
- **문제**: email 알림이 (wired 되면) Pro 범위인데 mention 없음. webhook만 언급. D-024 정의 기준 `notify.desktop + notify.webhook + notify.email` 3종이 Pro.
- **권고**: email stub 미구현이 해소되기 전엔 변경 불필요. email 구현 시 함께 업데이트.

### B-4. DB 경로 `~/.tokenpulse/` 언급 (stale 표기, 미결 마이그레이션)

- **위치**: line 60, Local-first 카드
- **현재**: `SQLite in <code>~/.tokenpulse/</code> (renamed to <code>~/.tokenmeter/</code> in a future release with an automatic migration).`
- **문제**: D-022에 따르면 M3 시점에 마이그레이션 예정. 현재 버전은 여전히 `~/.tokenpulse/`를 쓰므로 기술적으로는 정확한 표기. 하지만 "future release"라는 모호 표현이 v0.1.x 사용자에게 "지금 쓰는 경로가 곧 바뀐다"는 혼란을 줄 수 있음.
- **권고**: 즉각 수정 필요 없음. M3 마이그레이션 실제 구현 시 제거.

### B-5. GitHub 링크 repo명 일관성 확인 (정보성)

- **위치**: nav line 20 등 전체
- **현재**: `whdrnr2583-cmd/token-meter` (package.json, landing, README 모두)
- **MEMORY 박제**: `whdrnr2583-cmd/tokenmeter`로 표기 (MEMORY.md 상단)
- **결론**: **코드베이스 자체는 `token-meter`로 일관됨**. MEMORY의 `tokenmeter`는 오기. 랜딩 링크는 수정 불필요 — MEMORY 정정 대상.

---

## 조사 C — 알림 기능 ROI + 카톡 제거 범위 + 이메일 실현성

### 알림 현황

| 알림 종류 | 구현 상태 | 동작 여부 | 위치 |
|---|---|---|---|
| `notify.desktop` | 구현 완료 | 정상 동작 | `src/rules.ts:223-231`, `enqueueDesktop()` |
| `notify.webhook` | 구현 완료 | 정상 동작 | `src/rules.ts:199-221`, `executeWebhook()` (5초 timeout) |
| `notify.email` | 타입 정의·평가 루프 포함, 실행은 stub | **동작 안 함** | `src/rules.ts:233-236`: `return 'skipped:email_not_wired_until_m3'` |
| `digest.weekly` | 타입 정의 없음, 코드 없음 | 미구현 | docs/pro-features.md §2에 플랜만 존재 |

### 카톡 알람 현황 + 제거 범위

**현황**: 카톡 알람(KakaoTalk push notification)은 **코드·DB 스키마 어디에도 존재하지 않음**.
- `grep -ri "kakao"` 결과: `docs/billing-setup.md:257` 1건 — 사용자 주석(비교 대상 언급), 알람 구현 아님.
- `_workspace/wtp_validation_kakao.md`: 카톡은 마케팅 채널(오픈채팅방 공유)을 의미하는 문서. 알람 기능 아님.
- `D-039`: 카톡 = WTP 검증 채널 (outbound 마케팅). 알람 기능 아님.

**결론**: 카톡 알람 기능은 존재하지 않음 → **제거할 코드 없음.** "카톡 알람"을 문서·로드맵에서 언급한 파일도 없음.

### 이메일 알림 실현성 평가

**설계된 경로** (`docs/pro-features.md §2`):
`notify.email` 규칙 발화 → `src/rules.ts:executeEmail()` → CF Workers `/v1/action/email` → Resend API → 사용자 이메일.

**구현 비용 분석**:

| 구성요소 | 필요 작업 | 비용/리스크 |
|---|---|---|
| Resend 계정 + 도메인 인증 | token-meter.dev DNS 3-4 레코드 추가, SPF/DKIM | 1회, 30분 |
| CF Workers `/v1/action/email` 엔드포인트 | `infra/api/src/index.ts`에 route 추가, Resend API 호출 | ~2-3시간 |
| `executeEmail()` 구현 | stub 제거, license_key 첨부 후 Workers 호출 | ~1시간 |
| 이메일 to 주소 저장 | `EmailActionConfig.to` 필드 이미 정의됨 | 0 추가 작업 |
| 월 비용 | Resend Free tier: 3,000 통/월 | $0 (결제 100건 이하 여유) |
| 인프라 추가 없음 | 기존 CF Workers 재사용 | D-023 위반 없음 |
| RESEND_API_KEY secret | wrangler secret put 1회 | 5분 |

**총 구현 비용**: ~4시간 코딩 + DNS 설정 30분. Resend 월 $0 (3,000통 무료).
**의존**: Resend 계정(가입 무료), CF Workers 재배포.

**ROI 평가**: 비용 낮고 인프라 추가 없음 → **구현 권고 (keep)**.
단, 결제 0건 현시점에서 Pro email 알람이 실제 사용될 가능성은 낮음.
M3 진입 전 기술 준비로 scope-in 가능하나, PMF 게이트(결제 발생) 이후로도 충분.
**우선순위**: dashboard의 notify.desktop + notify.webhook이 이미 작동하므로 급하지 않음.
"가능하면 OK" → 결제 첫 건 발생 시 함께 묶어 구현하는 것이 적합.

### 기타 저ROI 기능 후보

| 기능 | 현황 | 평가 |
|---|---|---|
| `digest.weekly` (주간 이메일 digest) | 코드 없음, docs 플랜만 | email stub 해소 후에나 가능. 결제 0건 시점 동결 적합 |
| Cost forecast / pacing alert | 코드 없음, `src/stats.ts` spec only | 구현 ~3-4h. 차별성 있으나 결제 0건 시 건드리지 말 것 |
| CSV/JSON export | 코드 없음 | 유사 도구(ccusage)도 없는 기능. 중간 ROI. 결제 후 우선순위 낮게 |
| Auto-trim rule suggestions | Pro+ 로드맵. 코드 없음 | M4+ 동결. 건드리지 말 것 |
| Multi-machine sync | Pro+ 로드맵. 코드 없음 | M4+ 동결 |

---

## v0.1.12 묶음 권고 요약

직전 quick-win 6건 + 이번 조사에서 발견된 수정 대상:

| # | 파일 | 수정 내용 | 우선순위 |
|---|---|---|---|
| 기존 1-6 | (quick-win 파일 참조) | 6건 수정 | 완료 |
| A-1 | — | WSL 듀얼 env 스캔 추가 | 중간 (commit-gate 필요) |
| B-1 | `infra/site/index.html` | Email alert actions → Pro+ 목록에서 제거 | **즉시** (사실 오류) |
| B-2 | `infra/site/index.html` | iframe title "beta waitlist" → "waitlist" | 낮음 (minor) |

B-1은 현재 v0.1.12와 함께 묶어도 랜딩 deploy 1회로 해결 가능.
A-1은 설계 변경이므로 별도 PR/version으로 분리 권고.
