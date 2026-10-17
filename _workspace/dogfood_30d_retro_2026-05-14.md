# Dogfood 30d 패턴 회고 (2026-04-19 ~ 2026-05-14)

> 박제 목적: ICP 인터뷰 카피 학습 데이터. "내가 발견한 surprising pattern"으로 통증·차별점 토론 진입.
> 출처: `node dist/cli.js stats 30` (2026-05-14 dump).

---

## 본인 사용 총합

- Events: **3,163**
- Input tokens: 9.18M / Output tokens: 5.27M
- **Cache read: 738.43M** / Cache write: 20.55M
- **추정 USD: $1,711.75** (30d, Claude/Codex Max 플랜 사용 중 → 실청구 X, 종량제 환산값)

---

## Surprising pattern 5종 (인터뷰 카피 후보)

### 1. 모델 집중도가 비용 거의 전부 결정 — Opus 4.7이 97.9%

| 모델 | USD | 비중 | events |
|---|---|---|---|
| **claude-opus-4-7** | **$1,676.39** | **97.9%** | 2,488 |
| gpt-5 | $33.71 | 2.0% | 633 |
| claude-sonnet-4-6 | $1.65 | 0.1% | 42 |

→ 인터뷰 시그널: "Opus 쓰는 빈도만 줄여도 비용 80% 절감 가능. 그런데 본인은 'Opus가 더 정확하니까' 합리화로 안 줄임." Sonnet 4.6도 매우 강한데 본인 행동 패턴이 비이성적 = 다른 유저도 비슷할 가능성 큼.

### 2. peak day 1개가 30d의 ¼ — 변동성 폭발

- 4/27 단일일 **$400.40** (전체의 **23.4%**)
- $200+ day: 4일 (4/27, 4/28, 4/29, 5/04, 5/13 — 비공식 5일)
- $50 미만 day: 13일 (40%)
- **평균값 무의미** — peak 1-2일이 전체 결정

→ 인터뷰 시그널: "월말 $1.7k 보고 '평균 $57/day' 계산하면 함정. peak 1~2일이 90%. 그 peak가 뭐였는지 retroactive로 알아내는 게 진짜 통증."

### 3. Cache read 80배 = 비용 폭의 절반은 cache hit ratio가 결정

- Cache read **738M tokens** vs input **9.18M** = **80x**
- Cache 가격 = input의 10% → cache 없이 raw input pricing 했으면 30d $3k+ 추정
- **Cache hit ratio 0% vs 90% 가정 비용 차이 = $1.5k+**

→ 인터뷰 시그널: "Claude Code session 길이 짧으면 cache 무효화 → 비용 폭증. 사용자 대부분 인식 안 함."

### 4. Agent 도구 평균 131초 — batch 깊은 함정

| 도구 | 평균 latency |
|---|---|
| **Agent** | **131,174ms (131초)** |
| WebFetch | 41,979ms |
| Bash | 9,771ms |
| WebSearch | 8,265ms |
| PowerShell | 13,146ms |

→ Agent 한 번 = 평균 2분+. 사용자가 "왜 이 세션이 30분 걸렸지" 디버깅할 때 Agent 호출 17건 = 2분 × 17 = 34분 단순 누적.
→ 인터뷰 시그널: "Agent / WebFetch / Bash batch 호출 시간이 진짜 큰 비용. 토큰보다 wall clock 시간."

### 5. **MCP 사용 사실상 0 (3건 / 3,163 events) — 페르소나 정합 의문**

| MCP tool | calls |
|---|---|
| mcp__ccd_session__spawn_task | 1 |
| mcp__Claude_in_Chrome__list_connecte | 1 |
| **나머지 모두 built-in (Read/Bash/Edit/etc.)** | 3,160 |

→ Token Meter 핵심 차별점 = "**MCP·도구별 분해**" (D-019, STRATEGY.md). 그러나 본인 dogfood로는 **MCP 거의 안 씀** = 본인이 페르소나 A "MCP 헤비 유저"가 아님.
→ **인터뷰 시 솔직 박제 의무**: 본인 사용 패턴은 built-in tool 압도. MCP 차별점은 본인 검증 X → 카톡 AI 오픈채팅방 + r/ClaudeAI에 **"당신은 MCP 얼마나 쓰세요?"** 1차 질문으로 페르소나 가설 자체 검증.

---

## 프로젝트 분포 (자기 인식용)

| 디렉토리 | USD | 비중 |
|---|---|---|
| `<workspace>` (다른 개인 프로젝트 + token-meter) | $1,326 | **77.5%** |
| `Desktop` (잡다) | $200 | 11.7% |
| sharp/montalcini worktree | $106 | 6.2% |
| 나머지 | $80 | 4.6% |

→ 본인 시간 거의 전부가 `<workspace>` (사이드 프로젝트군). 본업 v18 / koreanpulse / token-meter 분간 안 됨 = breakdown 더 세밀 필요. **프로젝트 path가 의미 없는 폴더 이름이라 BI 어려움** → 사용자 인터뷰에 "프로젝트 이름이 path 기반인데 의미 있게 그룹핑 되어 있나요?" 질문 가능.

---

## 인터뷰 회피 사항 (Mom Test 정합)

- "제 패턴 보세요, 어떠세요?" 자랑 X
- "이 surprising pattern 보면 결제 의향 있나요?" 직접 묻기 X (Mom Test 위반)
- "당신도 비슷한가요?" (개방형 청취만)
- "MCP 얼마나 쓰세요?" 첫 질문 후 본인 데이터 노출은 후순위 (사용자 답변 오염 방지)

---

## 다음 액션 (이 박제 후속)

1. ICP 인터뷰 콜드 DM 메시지에 **"MCP 사용 빈도"** 1차 질문 명시 추가 (`icp_interview_template.md` Q3 갱신 검토)
2. v0.1.x 추가 패치 후보: project path가 의미 없는 폴더 이름일 때 group-by alias 옵션 (Pro 기능, M3 이후로 deferred)
3. 인터뷰 결과 5명 누적 후 "MCP 0건 페르소나가 다수면 차별점 카피 재고" 결정 지점

---

## Stop-loss 체크

- 본인 dogfood 1개월 → 25일 가까이 누적 시 페르소나 정합 결정
- 5/13 EOD 게이트 + 본업 v18 침범 0 + 시간 캡 주 10시간 모두 정합 ✓
