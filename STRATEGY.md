# Token Meter

> **🟡 상태 (2026-06-28~): OSS-maintain.** stop-loss 회고(D-042 / `_workspace/stop_loss_retro_2026-06-28.md`)
> 평결 = 보류. v0.1.20 게시 유지·무료·본인 dogfood. **신규 기능 빌드 종료(버그·보안만)**.
> 에너지는 결제검증된 머니 트랙(Kolabtree·크몽·컨설팅)으로. 재개는 결제검증 distribution 채널 확보 후 사용자 명시 시만.

> 클라우드 + 로컬 LLM **성능·비용 통합 옵저버빌리티**. AI 빌더용 단일 대시보드.

## 한 줄 정의
**Claude Code + Codex** (클라우드) 와 **Ollama / LM Studio / llama.cpp / vLLM** (로컬) 의 사용 데이터를 통합 캡처해서 토큰 비용·TPS·GPU 활용을 한 곳에서 보고 최적화한다.

## 한 줄 카피 후보
- *"One dashboard for every LLM you run — cloud or local."*
- *"Cut your Claude bill. Tune your Ollama. In one place."*
- *"FinOps and perf monitoring for AI builders."*

## 시장 데이터
- AI 코딩 툴 유료 사용자 (Claude Code + Codex): **3~6M 글로벌**
- 평균 개발자 클라우드 AI 지출: **$180/월** (Anthropic 공식)
- 로컬 LLM 활성 사용자 (Ollama + LM Studio + llama.cpp): **1~3M 글로벌**, MoM 성장 중
- 토큰 67~70%가 낭비 (복수 연구)
- LLM API 가격 1년 새 80% 인하 → 로컬 vs 클라우드 ROI 계산 수요 ↑

## 핵심 가설
**A. 클라우드 측**: 월 $100+ AI 지출 파워유저는 어디서 토큰이 새는지 모른다.
**B. 로컬 측**: $1k+ GPU 보유 개발자는 8개 모델 중 어느 게 가장 빠른지·내 작업에 맞는지 모른다.
**합치면**: "내 LLM 스택 전체를 한 곳에서 본다"는 가치 = 양쪽 모두 결제 정당화.

## 통합 범위 (확정)

### 현재 작업 범위 (Free + Pro $5까지)
| 클라이언트 | 통합 방식 | 우선순위 |
|---|---|---|
| Claude Code | `~/.claude/projects/*.jsonl` 파싱 | M1 |
| Codex (OpenAI) | `~/.codex/history.jsonl` + `turn.completed.usage` | M2 |

**의도적 제외**: Gemini CLI, Cursor, Claude Desktop, Windsurf — 스코프 집중을 위해.

### 추후 작업 (Pro+ $24 출시 시점, M4+)
| 도구 | 통합 방식 |
|---|---|
| Ollama / LM Studio | OpenAI-호환 API 프록시 |
| llama.cpp (server) | OpenAI-호환 API 프록시 |
| vLLM | OpenAI-호환 API 프록시 + Prometheus 메트릭 |

**프록시 모드 이점**: SSE 스트림 직접 가로채기 → **TTFT, ITL, TPS 밀리초 정확도**.
**보류 사유**: 현재는 $5 단일 가격으로 Free + Pro만 작업. Pro+ ($24)는 Pro 사용 데이터·결제 트리거 검증 후 분리.

## TPS·성능 측정 (핵심 기능)

| 지표 | 클라우드 (로그) | 로컬 (프록시) |
|---|---|---|
| 평균 TPS | ✅ 추정 | ✅ 정확 |
| TTFT (Time To First Token) | ⚠ 부정확 | ✅ 정확 (밀리초) |
| ITL (Inter-Token Latency) | ❌ | ✅ 정확 |
| p50/p95/p99 latency | ✅ | ✅ |
| 모델별·시간대별 비교 | ✅ | ✅ |
| GPU/VRAM 상관 | — | ✅ (Pro+) |

## 비즈니스 요약
| Tier | 가격 | 포함 | 작업 |
|---|---|---|---|
| **Free** | $0 | Claude Code + Codex 통합, **MCP·도구별 분석**, 프로젝트별 breakdown, **7일** 히스토리, 모델·시간대 비교, 평균 TPS, $ 환산, **데스크탑 알림 1 룰** | M1~M2 |
| **Pro** | **$5/월** | **30일** 히스토리, **Smart alerts 무제한 (데스크탑·웹훅)**, **세션 드릴다운**, **캐시 효율 분석**, **낭비 신호 (도구 응답 outlier·미회수 캐시)**. 추후 증분: CSV·JSON export·비용 예측. (커스텀 가격 매트릭스·익명 벤치마크는 4haiku 검토로 폐기) | M3 |
| **Pro+ (추후)** | $24/월 예정 | **무제한 히스토리**, 로컬 LLM 프록시 (Ollama·LM Studio·llama.cpp·vLLM), GPU/VRAM 트래킹, **행동 변경 자동 액션 (MCP trim·모델 전환)**, 모델 벤치마크 랩, **다중 머신 동기화**, **PDF 자동 리포트** | **M4+ 보류** |
| **Team (추후)** | TBD | 팀 벤치마크, 공유 DB, 정책 | M7+ 보류 |

**Pro+·Team 분리는 Pro $5 결제 데이터·실사용 트리거 확인 후 결정.**

**Y1 ARR 현실 목표** (D-025): **base $2k** / **stretch $6k** / optimistic $20k. SOM 3년은 Pro+ 게이트 통과 + 글로벌 GTM 성공 가정 시 $50k~$500k.

**정체성**: "공개 빌드 + 무료 도구" 우선, Pro는 부가. 본업 대체 시도 안 함.

### 무료 vs 경쟁자 vs 네이티브 (의도적 우위)
| | Claude·Codex 네이티브 | ccusage | tokscale | claude-usage | **Token Meter Free** |
|---|---|---|---|---|---|
| 표시 형식 | % 잔여만 | CLI | CLI | 대시보드 | **GUI 대시보드** |
| 클라우드 멀티 (Claude+Codex) | 단일 | ❌ | ✅ CLI | ❌ | ✅ |
| 프로젝트별 분해 | ❌ | 부분 | ❌ | 부분 | ✅ |
| $ 환산 | ❌ | ✅ | ✅ | ✅ | ✅ |
| **MCP·도구별 분석** | ❌ | ❌ | ❌ | ❌ | ✅ **우리만** |
| 시간대별 변동 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 히스토리 | 세션 | 무제한 | 무제한 | 무제한 | 30일 |
| 평균 TPS 인사이트 | ❌ | 부분 | ❌ | 부분 | ✅ |

→ **네이티브 % 표시보다 7개 차원 우위** = 카톡 등 사용자 통증 ("얼마 썼는지 모름") 직접 해결.
→ **MCP·도구별 분석**이 가장 강한 단일 차별점.

## MCP 서버 모드
`token-meter mcp` 로 실행 시 Claude Code·Cursor·Claude Desktop이 호출 가능. 도구 4종: `usage_summary` (기간별 비용 요약), `recent_sessions` (실수로 닫은 터미널 세션 찾기 + `claude --resume` 명령 제공), `session_tools` (세션별 도구 디버깅), `refresh_data`. Free 포함. 상세: [docs/mcp-server.md](docs/mcp-server.md).

## 운영 가이드라인
- 자본 투입: **$0** (시간만)
- 시간 캡: 주 **10시간**
- MVP 기간: **4주 (M1 Claude Code only)**
- 결제: **Polar.sh** (한국 1인 글로벌 판매 최적)
- 토큰 카운트: 클라우드 **로컬 JSONL** (로컬 LLM 프록시는 Pro+ 추후)
- **내부 LLM 토큰 소비 최소**: 모든 핵심 기능은 LLM 호출 없이 작동 (heuristics·정규식·timestamp 산수). Pro 권장 리포트만 주 1회 배치 LLM 호출, 유저당 월 토큰 예산 캡 $0.20
- **응대**: 이메일 단일 채널, Gemini 자동 응답. 결제·환불·버그만 본인 처리
- PMF 게이트: M1 알파 3/5, M2 DAU 100, M3 유료 30

## 결정된 사항
| 항목 | 결정 | 이유 |
|---|---|---|
| 클라우드 범위 | Claude Code + Codex만 | 통합 난이도 ★, 사용자당 지출 큼 |
| **가격 (현재 작업)** | **Free + Pro $5/월 2단계만** | 단순화, $5 마진 85% 유지, 풀 확장 우선 |
| **Pro+ ($24) 작업** | **추후 (M4+) 보류** | 로컬 LLM 프록시·GPU 트래킹·자동 액션 전부 후순위. Pro 결제 트리거 확인 후 분리 |
| **응대** | 이메일 + Gemini 자동 | 지원비 $0 (결제·환불·버그만 본인) |
| **내부 토큰** | 핵심 기능 LLM 0회, Pro 권장만 주 1회 배치 | COGS 최소화 |
| TPS 측정 (클라우드) | Free 평균값 표시 | timestamp + 토큰으로 산수 가능 |
| 결제 | Polar.sh | MoR로 세무 부담↓ |
| 라이선스 | 코어 MIT + Pro closed | OSS 신뢰 + 수익화 |
| 의도적 제외 | Gemini CLI, Cursor, Desktop | 스코프 집중 |

## 문서
- [01-problem.md](01-problem.md) — 통증·시장 사이즈 (클라우드 + 로컬)
- [02-product.md](02-product.md) — 제품·기술·MVP·프록시 아키텍처
- [03-business.md](03-business.md) — 가격·GTM·해자·페르소나
- [04-risks.md](04-risks.md) — 리스크·로드맵·KPI
- [05-decisions.md](05-decisions.md) — 결정 박제

## 솔직 자평
- 인터뷰: **0건** → M1 전 클라우드 5명 + 로컬 5명 인터뷰 필수
- 로컬 LLM 시장 WTP 검증: 가설 단계 (직접 데이터 없음)
- 1인 영문 GTM: 미검증
- 본인 1개월 클라우드 + 로컬 사용 데이터 분석 우선

## 즉시 다음 액션
1. 본인 Claude Code JSONL + (보유 시) Ollama 로그 1주 분석 → 진짜 낭비·성능 패턴 박제
2. r/LocalLLaMA + r/ClaudeAI + r/Codex 각 5명 콜드 DM (1주)
3. Polar 계정 가입 + 도메인 후보 5개 체크
4. M1 착수 가/부 결정 (이번 주 일요일)
