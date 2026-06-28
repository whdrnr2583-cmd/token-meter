# 05. 결정 박제 (Decision Log)

기록 시점의 결정과 근거를 박제. 번복 시 새 항목 추가하고 이유 기록.

## D-040. v0.1.19 sub-agent & cache 비용 귀속 — PMF 동결룰 1회 우회
**날짜**: 2026-06-28
**결정**: 유료 0건 상태에서 신규기능(sub-agent 비용 귀속 분석) 추가. PMF "결제 0건 → 신규기능 금지" 메타룰을 의식적으로 1회 우회.
**우회 사유 (박제 의무)**:
- 사용자가 일일점검 세션 중 "토큰미터 고도화 진행" 명시 지시 → 방향 선택 AskUserQuestion에서 "신규기능 고도화(우회)" 선택.
- 비-매매 메타룰은 사용자 명시 + 이유 박제 시 우회 가능 (rule_integrity 메모리). 전례: D-031 우회(v0.1.16), v0.1.17(5/27).
- 선택 기능 = 4지선다 중 "서브에이전트·캐시 비용 심화분석" — 기존 #1 moat("MCP·도구별 분석") 확장이며 dogfood 데이터(Agent 91.6s avg·cache read 660M)가 직접 가리킨 항목.
**구현 범위**:
- 신규 스키마: `token_events.agent_id` / `tool_events.agent_id` (additive·nullable, ALTER 가드, USD/dedup 불변).
- ingest가 `<project>/<sessionId>/subagents/agent-<id>.jsonl` 파일경로에서 agent_id 스탬프 (JSONL 본문의 sessionId는 부모 것이라 경로가 유일 식별원).
- 백필: `ingest --force` 시 기존 행에 agent_id UPDATE (NULL일 때만 → 메인패스가 태그 덮어쓰기 X).
- `subagentCosts()` 쿼리 + MCP tool/prompt `subagent_costs` + CLI `subagents`.
- 테스트 3종 추가(75 pass), audit ALL INVARIANTS HOLD.
**리스크 인식**: D-025 stop-loss(~7/8, 6개월 매출 0 + 200h) 타임라인을 시간소비로 가속. 결제 견인 아님 — 진짜 레버는 distribution. 본 우회는 1회성, post-publish 신규기능 재동결.
**미집행**: publish/commit/tag는 사용자 명시 지시 후만 (현재 로컬 빌드·테스트까지만). package.json 0.1.19 bump 완료, npm 미발행.

---

## D-001. 결제 인프라: Polar.sh
**날짜**: 2026-05-13
**결정**: Stripe 직접 대신 Polar.sh 사용
**근거**:
- MoR (Merchant of Record) → 한국 1인이 글로벌 매출 세무 신고 부담 0
- 사업자 등록·Stripe 계좌 셋업 며칠 절약
- 4% + $0.40 (구독·국제 카드 추가 시 ~6%) → $9~12 구독 기준 $0.30/유저 추가 비용 감내 가능
- GitHub 네이티브, Tailwind Labs·Midday 등 검증된 채택
**감내 단점**: 지원 응답 느림 (2026-02 Reddit), 카드만 지원, Apple/Google Pay 없음
**전환 시점**: 유료 1,000명 돌파 시 Stripe 직접 + 한국 사업자 등록 재검토
**참고**: [Polar vs Stripe](https://polar.sh/resources/comparison/stripe)

---

## D-002. 토큰 카운트: 로컬 JSONL 파싱만
**날짜**: 2026-05-13
**결정**: 자체 토크나이저 안 만듦. 벤더 공식 카운트만 사용.
**근거**:
- tiktoken은 Claude에 **12% 오차** (OpenAI 토크나이저)
- Anthropic 휴리스틱 (1토큰 ≈ 3.5 chars)은 **20% 오차**
- Anthropic 토큰 카운트 API 호출 = 비용 + 레이턴시
- Claude Code는 모든 토큰을 **로컬 JSONL에 100% 정확 기록** (`~/.claude/projects/`)
- Cursor도 SQLite에 API 응답 카운트 저장
**구현**: 로컬 로그 파일 read-only watch, 자체 카운트 안 함
**한계**: 벤더 간 토큰 비교 무의미 → **$ 단위 비교 강제**

---

## D-003. 첫 통합 클라이언트: Claude Code 단독
**날짜**: 2026-05-13
**결정**: M1은 Claude Code만 통합. Cursor·Codex·Desktop은 M2 이후.
**근거**:
- Claude Code JSONL 형식 가장 공개적·안정적
- 본인이 Claude Code 메인 사용자 → 자체 검증 가능
- 단일 클라이언트로 PMF 게이트 통과 시 멀티로 확장
- 멀티 동시 시도 = MVP 범위 폭발 위험

---

## D-004. 라이선스: 코어 MIT + Pro 기능 closed
**날짜**: 2026-05-13
**결정**: 토큰 파싱·대시보드 코어는 MIT 오픈소스. 권장 엔진·자동 액션·sync는 closed source.
**근거**:
- OSS = 개발자 신뢰 + GitHub trending = 무료 마케팅
- ccusage·tokscale 모두 MIT → 표준 기대
- Pro 기능 closed = 수익화 보장
- 분리 명확: "core observability free, intelligence layer paid"

---

## D-005. 서버 부하 정책: 로컬 우선, 클라우드는 옵트인
**날짜**: 2026-05-13
**결정**: 모든 핵심 기능 로컬 SQLite. 클라우드 sync는 Pro 옵션.
**근거**:
- 사용자 운영 룰: 서버 부담 최소화
- 1인 운영 → 인프라 장애 대응 부담 최소
- 프라이버시 강점 (토큰 로그에 민감 정보 가능)
- Pro sync 옵션은 Cloudflare Workers + R2로 사용자당 월 $0.05 수준

---

## D-006. 가격 sweet spot: Pro $12 / Pro+ $25
**날짜**: 2026-05-13
**결정**: Free → Pro $12 → Pro+ $25 → Team $39/user
**근거**:
- $5: 컨버전 좋지만 마진·지원 부담 동일 → 비효율
- $12: "Cursor Pro($20)의 60%" 카피, 월 $100+ 지출자에 ROI 명확
- $25: 자동 액션 + 알림에 대한 가치 인식 가능
- $39 Team: Notion Team $15 비싸지만 AI 카테고리 정당화

**검증 필요**: M3에 가격 A/B 테스트 ($9 vs $12 vs $15)

---

## D-007. 신뢰·보안 영역 회피
**날짜**: 2026-05-13
**결정**: 에이전트 보안 가드레일, 권한 통제 등은 안 함.
**근거**:
- 사용자 룰: "보안은 네임드 아니면 안 씀"
- 인디 SaaS가 사고 시 책임 부담 큼
- 차별점은 옵저버빌리티·효율 자체로 충분

**예외**: 자동 액션의 "에이전트 깨뜨림 안전장치"는 운영 안정성 차원에서 유지

---

## D-008. 익명 벤치마크 데이터: 옵트인만
**날짜**: 2026-05-13
**결정**: "당신은 평균 사용자보다 30% 더 씀" 같은 비교 기능은 옵트인 사용자 데이터로만.
**근거**:
- 사용자 신뢰 + 법적 안전
- 옵트인 동의서 명확 (집계 통계만, 원본 데이터 비공개)
- 추후 익명 데이터 API 수익화 가능 (Year 3)

---

## D-009. 멀티벤더 정체성 처음부터 명시
**날짜**: 2026-05-13
**결정**: 모든 마케팅 카피·README에 "multi-vendor" 강조.
**근거**:
- Anthropic·Cursor 네이티브 토큰 보드 위협 최대 리스크
- 단일 벤더 사용자는 빼앗기되, 멀티 사용자(2.3개 평균)는 우리만 가능
- "the only place to see all your AI spend"

---

## D-010. MVP 첫 4주: 가시화만, 액션·권장 미포함
**날짜**: 2026-05-13
**결정**: M1은 순수 대시보드. 권장 엔진은 M2, 자동 액션은 M3.
**근거**:
- 가시화 자체로 PMF 검증 가능 (사용자가 매주 보러 오는가)
- 권장·액션은 가시화 위에서만 가치
- 범위 축소 = 4주 안 가능성 ↑

---

## D-011. 클라이언트 통합 순서 수정
**날짜**: 2026-05-13
**결정**: M2에 Codex 우선 통합 (기존 Cursor 우선 계획 수정)
**근거**:
- Codex 통합 난이도 ★ (Claude Code와 동일) — `~/.codex/history.jsonl` + `turn.completed.usage` 공식 노출
- Cursor 통합 난이도 ★★★ — SQLite 토큰 명시 저장 불확실, 형식 변경 위험
- "Claude + Codex" 멀티벤더 카피 빠르게 확보 → Anthropic·Cursor 네이티브 위협 우회
- ccusage가 이미 Codex 지원 → 참고 가능
**새 순서**: Claude Code → Codex → Gemini CLI → Claude Desktop → Cursor

---

## D-012. TPS·속도 인사이트 기능 포함
**날짜**: 2026-05-13
**결정**: Pro 기능에 모델별 평균 TPS·시간대별 성능 인사이트 추가
**근거**:
- JSONL의 timestamp + 토큰 카운트로 평균 TPS 계산 가능
- 모델 선택 권장 (Gemini 2.5 Pro 빠름, Opus 4.7 느림 등) → 사용자 가치 명확
- 시간대별 혼잡 감지 → 실용적 인사이트
**한계 박제**:
- 로그 기반은 **평균값만** (응답 시작 ~ 완료)
- TTFT·ITL 정밀 측정은 스트리밍 자체 가로채기 필요 → Pro+ MCP 프록시 모드에서만
- UI에 "추정 평균" 명시. 정확한 벤치마크는 외부 사이트 참조 권장

---

## D-013. 스코프 집중: Claude Code + Codex 단독 (클라우드)
**날짜**: 2026-05-13
**결정**: 클라우드 측은 Claude Code + Codex 2개만 진행. Gemini CLI, Cursor, Claude Desktop, Windsurf 모두 의도적 제외.
**근거**:
- Claude Code + Codex 모두 **JSONL 공식·표준** → 통합 난이도 ★ 동일
- Gemini CLI는 telemetry 옵트인 필요, 사용자 풀 작음
- Cursor SQLite는 토큰 명시 저장 불확실 + 형식 변경 위험
- Claude Desktop은 로그 형식 다양, 비용 분석 가치 낮음
- 스코프 집중 = MVP·후속 빠른 사이클 = 경쟁자 추월 속도
**리스크**: Cursor 사용자 잠재 시장 제외. 대신 로컬 LLM 시장 진입으로 보상.
**번복 트리거**: Cursor가 토큰 사용량을 공식 API로 노출 → 재검토

---

## D-014. 로컬 LLM 통합 (페르소나 B 진입)
**날짜**: 2026-05-13
**결정**: M3부터 Ollama·LM Studio·llama.cpp·vLLM 통합. HTTP 프록시 모드로 정밀 TPS·TTFT·ITL 측정.
**근거**:
- 사용자 요구: "비용 지불하더라도 사용되는 수준"
- 로컬 LLM 사용자 1~3M 글로벌, mainstream화 (2026)
- LLM API 80% 가격 인하로 로컬 vs 클라우드 ROI 계산 수요 증가
- 기존 OSS 도구는 **단발 CLI**, GUI·지속 모니터링·권장 부재 → 명백 공백
- 프록시 모드 = 밀리초 정확도 TPS/TTFT/ITL → 로그 파싱 대비 압도 차별점
- 하이브리드 사용자 (페르소나 AB) = 양쪽 통합 가치 가장 큼 = WTP 최고
**구현**:
- M3: Ollama (가장 보편) + LM Studio
- M4: llama.cpp (server 모드) + vLLM
- 모두 OpenAI-호환 API → 단일 프록시 어댑터로 커버
**리스크**: 기술 복잡도 (OS별, GPU별), WTP 가설 미검증
**검증 게이트** (M3 진입 전):
- 로컬 빌더 5명 인터뷰 중 3명 유료 의향
- 본인 Ollama 프록시 PoC 성공
- r/LocalLLaMA 베타 대기 30+ 반응
**번복 트리거**: 3개 게이트 중 2개 미달 → 로컬 진입 보류, 클라우드 단독 집중

---

## D-015. TPS·성능 측정 핵심 기능화
**날짜**: 2026-05-13
**결정**: TPS·TTFT·ITL을 Pro 핵심 기능으로 포지셔닝 (기존 사이드 기능 → 핵심)
**근거**:
- 클라우드: 평균 TPS는 로그로 추정 가능 (timestamp + 토큰)
- 로컬: 프록시 모드로 **밀리초 정확** TTFT/ITL/TPS 측정 가능
- 페르소나 B에게 TPS는 **1차 가치** (비용 가시화 < 성능 가시화)
- 페르소나 A에게 모델 선택 권장의 근거 데이터
**구현**:
- Pro: 평균 TPS, 모델·시간대별 비교
- Pro+: 정밀 TTFT/ITL (프록시 모드), GPU/VRAM 상관 분석
**한계 명시**: 클라우드 측은 "추정 평균"으로 라벨링, 정밀 벤치마크는 외부 사이트 참조 권장

---

## D-016. 가격 인상 ($12 → $15, $25 → $29) [폐기됨, D-017로 대체]
**날짜**: 2026-05-13
**결정**: Pro $15, Pro+ $29, Team $49/user
**근거**:
- 로컬 LLM 통합 + GPU 모니터링 추가 가치
- TPS 정밀 측정 = 고급 기능
- 페르소나 B (GPU $1k+ 보유)는 $15 인식 다름 ("$5k GPU의 0.3%")
- $15 = "Cursor Pro($20)의 75%" 카피
**폐기 이유**: 무료 티어가 너무 좁아 유입 풀 부족. 가격이 freemium 마찰 증가. D-017로 재설계.

---

## D-017. 무료 티어 강화 + 가격 인하 + Early Bird [폐기됨, D-020로 대체]
**날짜**: 2026-05-13
**결정**:
- **Free**: 멀티 소스 (Claude Code + Codex + 로컬 1개) + 30일 히스토리 + 모델·시간대 비교 + 기본 차트
- **Pro**: $12/월 ($120/년) [Early Bird $9/월 6개월 한정, 영구 락인]
- **Pro+**: $24/월 ($240/년)
- **Team**: $29/user/월

**근거**:
- 무료 티어 비교: ccusage (무한 + Claude Code only), tokscale (멀티 CLI) → 우리 Free가 둘을 흡수해야 유입 가능
- 개발자 freemium 전환율 1~3% → **풀 자체를 키우는 게 우선**
- 매출 시뮬레이션:
  - 이전: 무료 3k × 2% × $17 ARPU = $12k ARR
  - 수정: 무료 8k × 3% × $14 ARPU = $40k ARR
  - **3배 잠재**
- Early Bird $9는 한 끼 식사 = 심리적 anchor, 평생 락인으로 초기 고객 신뢰
- Notion Team $15 anchor 고려 시 Team $29가 정당화 한계

**시뮬레이션 가정 (검증 필요)**:
- 무료 사용자 8k Y1 = HN Show + GitHub trending 성공 + 페르소나 B 진입 가정
- 전환율 3% = freemium 평균 (실제는 1~5% 분포)
- 미달 시: M4에 가격·플랜 재설계 (Pro $7 등 추가 인하 검토)

**번복 트리거**: Year 1 ARR < $20k 도달 → 전체 재설계

---

## D-019. MCP·도구별 귀속을 핵심 차별점으로
**날짜**: 2026-05-13
**결정**: MCP 서버·도구 단위 토큰·지연 분석을 Free 기본 기능으로 포함. ccusage·tokscale 등 경쟁자 대비 명확 우위.

**근거**:
- 경쟁자 모두 **총 토큰**만 표시. MCP 단위 자동 분석 부재.
- JSONL의 `tool_use.name` 표준 `mcp__<server>__<tool>` 패턴으로 자동 그룹핑 가능
- 도구 응답 토큰·지연은 **100% 직접 측정** 가능 (heuristic 불필요)
- 사용자 가치: "어느 MCP가 토큰 가장 먹는지" 한 눈에 보임 → 권장 액션 직결

**측정 정밀도 박제**:
- 🟢 100% 정확: 호출 횟수, 응답 토큰, 지연
- 🟡 80% 추정: 청구 기여도 (LLM 추론과 툴 호출 혼재)
- 🔴 불가: 개별 토큰 단위 귀속

**Free 포함 사유**:
- 차별 카피 "Token Meter만 MCP별 분석" → 무료 사용자 흡수
- ccusage 사용자 이주 트리거 = "오, 이건 ccusage엔 없네"

**Pro 업그레이드 트리거**:
- 자동 trim 액션 (MCP 분석 결과 기반 자동 화이트리스트 적용)
- 클라우드-로컬 환산 (MCP 비용 → 로컬 대체 가능액)

---

## D-018. Free 티어 의도적 우위 정책
**날짜**: 2026-05-13
**결정**: Free가 ccusage·tokscale을 무조건 이기는 수준으로 유지.
**근거**:
- "왜 Token Meter Free를 쓸까?" 답이 명확해야 함
- Free가 약하면 유저가 무료 OSS 도구 옵션을 먼저 시도
- 우리 무료의 우월 차별점: **GUI + 멀티벤더 + 로컬 1 endpoint**
- 경쟁자가 이 셋을 동시에 무료로 제공할 가능성 낮음
**Pro 전환 트리거**:
- 무제한 히스토리 (30일 한계 도달 시)
- 권장 리포트 (수동 분석 vs 자동 제안)
- 클라우드-로컬 환산 (하이브리드 사용자)
**번복 트리거**: 무료 사용자 증가 but 유료 전환 1% 미만 → Free 일부 축소 검토

---

## D-020. Pro $5 단일 가격 + Pro+ 추후 + 응대·내부 토큰 최소화
**날짜**: 2026-05-13
**결정**:
- **가격 구조 단순화**: Free + Pro $5/월 **2단계만** 현재 작업
- **Pro+ ($24, 로컬 LLM·GPU·자동 액션) 추후 작업 보류** (M4+ 조건부)
- **Team (TBD) 추후 보류**
- **응대**: 이메일 단일 채널 + Gemini 자동 응답. 결제·환불·버그만 본인 처리
- **내부 LLM 토큰 최소**: 핵심 기능 LLM 0회 호출. Pro 권장 리포트만 주 1회 배치, 유저당 월 토큰 예산 캡 $0.20

**근거**:

### 가격 인하 ($12 → $5)
- 응대비 $0 (Gemini 자동) 확보 → 마진 81% 유지 가능 ($5 - $0.70 Polar - $0.05 인프라 - $0.20 LLM = $4.05)
- 한 끼 식사 anchor → 즉시 결제 마찰 최소
- 카톡 1차 신호 = 통증 존재 확인, WTP는 미검증 → 낮은 가격으로 진입
- $12에서 풀 확장이 가격 인상으로 잠재 차단

### Pro+ 보류
- 로컬 LLM 프록시 = 기술 복잡도 큼 (OS별, GPU별, 프록시 안정성)
- 로컬 LLM WTP 가설 미검증 (페르소나 B)
- GPU 트래킹·자동 액션 = 핵심 가치 검증 안 됨
- 4단계 동시 관리 = 1인 시간 폭발
- **추후 분리 게이트** (M4+): Pro 100명 + 로컬 LLM 요청 30건 + Ollama 프록시 PoC 성공

### 응대 자동화 (Gemini)
- 지원비 $5 매출 단가의 가장 큰 위협
- Gemini 자동 응답으로 80%+ 처리
- 시스템 프롬프트: "결제·환불·버그 = 본인 에스컬레이션"
- FAQ·셀프서비스 페이지 강화

### 내부 토큰 최소화
- 매출 단가 $5에 내부 LLM 비용이 들어가면 마진 즉시 무너짐
- 모든 핵심 분석은 **heuristics·정규식·timestamp 산수**로 처리:
  - 토큰 카운트 (JSONL 자체)
  - 비용 환산 (가격표 곱셈)
  - TPS·TTFT·ITL (timestamp)
  - MCP 그룹핑 (정규식)
  - 시간대 변동 (집계)
- LLM 호출 = Pro 주간 권장 리포트 1회 배치 (유저당 토큰 캡 $0.20)

### Free 티어 (네이티브 % 압도)
- Claude·Codex 네이티브 = 토큰 잔여 % 만 표시
- Token Meter Free = 프로젝트별 + MCP별 + 모델별 + 시간대별 + $ 환산 + 30일 + 평균 TPS = **7개 차원 우위**
- 카톡 사용자 통증 ("얼마/어디서 썼는지 모름") 직접 해결

**유닛 이코노믹스**:
- Pro $5 Gross: $4.05 (81%)
- 9개월 LTV: $36
- LTV/CAC: CAC $10 = 3.6x ✅, CAC $5 = 7.2x ✅
- MRR $1k = 235명, $5k = 1,175명

**검증 후 가격 인상 옵션** (M6+):
- Pro+ 분리 ($24) → ARPU 상승
- 미통과 시 Pro $5 → $7 인상 (신규만), 기존 락인

**번복 트리거**:
- M3 종료 후 Pro 유료 < 30명 → 가격·포지셔닝 재설계
- Gemini 응대 오답률 > 10% → 본인 응대 비율 ↑ → 마진 무너짐 → 가격 인상 강제

---

## D-021. 빌드 우선 접근 (사전 검증 생략)
**날짜**: 2026-05-13
**결정**: M0 사전 검증 (카톡 5명 + 본인 1주 데이터 분석) 생략. 곧장 M1 착수.

**근거**:
- Claude/Codex Max 잉여 → 빌드용 LLM 비용 $0
- 자본 0, 실제 비용 = 시간 40~80시간 (4-8주)
- 본인이 페르소나 A 헤비 유저 → 자가 dogfooding이 인터뷰 대용
- 출시 = 가장 강한 검증 (인터뷰 응답 50% 거짓말 vs 실제 DAU·결제 100% 진실)
- 자동매매 자동화 완료 → 시간 여유
- 콘텐츠 트랙 시너지 (한국 1인 글로벌 SaaS 도전 자체가 콘텐츠)

**유지되는 안전장치 (Stop-loss)**:
1. M1 시간 캡 **8주** (4주 목표). 초과 시 일시 중단. 본업·v18 침범 0
2. M2 출시 후 4주: DAU 30 + GitHub Star 100 미만 → 콘텐츠 가속 1회 → 미달 시 보류
3. M3 결제 후 4주: 유료 10명 미만 → 가격·포지셔닝 재설계 1회 → 미달 시 보류
4. 주차별 빌드 로그 1편 (블로그 or X) → 실패해도 콘텐츠 잔존

**번복 트리거**: 8주 초과 또는 위 stop-loss 게이트 2회 연속 미달

---

## D-022. 제품명 확정: Token Meter
**날짜**: 2026-05-13
**결정**: 제품명을 **Token Meter**로 확정. 도메인 후보 우선순위:
- `tokenmeter.dev` (1순위, 개발자 친화)
- `tokenmeter.io` (2순위)
- `token-meter.com` (3순위)

**근거**:
- 한국·영어권 동일 즉시 이해 ("전기 미터", "수도 미터" 비유)
- 11자, 2단어, 음절 4개 — 카피·도메인·NPM 모두 자연스러움
- 카피 직결: "Your token meter for Claude, Codex, and more"
- "Token Pulse"의 pulse는 비전공자에게 직관 약함
- AI Meter 후보 대비 "토큰"이 명시되어 카테고리 즉시 인지

**기각 후보**:
- AI Meter: 너무 범용, 검색 SEO 약함
- TokenLog: 검색 친화적이나 "로그"는 정적 느낌
- AI Tab: 영미권 특화, 한국어권 직관 약함

**적용 범위 (즉시)**:
- 문서·UI·CLI 표기 전체 교체 완료
- `package.json` name → `token-meter`, bin → `token-meter`

**적용 보류 (M3 결제 직전)**:
- 디렉토리 `token-pulse/` 그대로 (이름 교체 비용 > 가치)
- DB 경로 `~/.tokenpulse/` → 신규 설치는 `~/.tokenmeter/`, 기존 유저는 자동 마이그레이션 (M3 출시 직전)
- 도메인 등록 + Polar 상품명

**번복 트리거**: 도메인 모두 선점 + 합리적 대체 도메인 없음 → 후보 재검토

---

## D-023. 배포 인프라: Cloudflare 서버리스 + GitHub + npm (koreanpulse Lightsail 절대 분리)
**날짜**: 2026-05-13
**결정**:
- **koreanpulse Lightsail 절대 공유 안 함** (v18 자동매매·us-advisor 트랙 보호)
- **신규 Lightsail도 만들지 않음** (1인 운영 부담)
- **배포 스택**: GitHub (OSS) + npm (CLI 배포) + Cloudflare Pages (랜딩) + Cloudflare Workers + D1 (라이선스 API)
- **Polar.sh** 결제 (D-001 유지)

**근거**:
- Token Meter는 본질적으로 **로컬 우선** 제품 (D-005). 실서버 부하 = 라이선스 검증(5KB) + 정적 사이트만
- 트레이딩 인프라와 같은 서버 공유 시: HN 트래픽 폭발 / DDoS / Docker 충돌 → 트레이딩 차질 위험 (stop-loss 직접 트리거)
- Cloudflare 무료 한도: Workers 10만 req/일, D1 5GB, Pages 무제한 → 유료 1,000명까지 월 인프라비 $0~5
- 1인 운영: 서버리스 = 모니터링·OS 패치·Docker 불필요 → 본업·트레이딩 시간 보존

**M2-M3 단계 구조**:
```
github.com/<owner>/token-meter       ← public OSS (MIT, CLI 코어)
github.com/<owner>/token-meter-site  ← private (랜딩, CF Pages)
github.com/<owner>/token-meter-api   ← private (라이선스 API, CF Workers + D1)
```

**도메인**: `tokenmeter.dev` 1순위 (Cloudflare Registrar $12/yr). 백업: `tokenmeter.io`, `gettokenmeter.com`.

**배포 순서**:
1. **이번 주**: 도메인 등록 + Cloudflare 계정 점검 + npm 계정 확인 + GitHub 신규 organization 또는 username 선택
2. **M2 (5-8주)**: GitHub 공개 + npm publish + CF Pages 랜딩 + 베타 대기 폼
3. **M3 (9-12주)**: CF Workers 라이선스 API + Polar webhook + 이메일 발송 (Resend 무료 3k/월)

**Year 1 인프라 비용 예측**: 도메인 $12 + Polar 수수료 6% 외 0. 유료 200명 시 매출 $1,000/월 × 89% Gross.

**번복 트리거**:
- Cloudflare 무료 한도 폭발 (Pro 1,000명 초과 + 가격 인상 전) → 부분 셀프호스팅 검토
- 코어 OSS 가 분기점 도달 후 자체 클라우드 sync 수요 폭증 → R2 도입 (Pro+ 출시 시)

---

## D-024. Actions 모듈: 빌트인 최소 + 웹훅으로 확장
**날짜**: 2026-05-13
**결정**:
- **빌트인 액션 3종만 출시**: 데스크탑 알림 / 이메일 / 웹훅 POST
- **나머지는 웹훅으로 사용자 커스터마이즈** + 가이드 문서(`docs/customization.md`) 제공
- **Free**: 데스크탑 알림 1개 룰만 활성
- **Pro $5**: 무제한 룰 + 이메일 + 웹훅 + 주간 digest
- **Pro+ M4+**: MCP 자동 trim·모델 자동 전환 등 행동 변경 액션 (D-007 신뢰 룰 통과 후)

**근거**:
- 사용자 요구: "간단한 것만 빌트인, 나머지는 커스텀 가이드"
- 웹훅 1개 = Slack·Discord·n8n·Zapier·Pipedream·사용자 스크립트 전부 커버 → 빌트인 어댑터 안 만들어도 됨
- 응대 폭발 차단 ($5 단가 보호): "Slack 안 됨" 응대 = 사용자 본인이 Slack 웹훅 URL 설정 책임
- 행동 변경류는 매출 단가 대비 신뢰 비용 폭발 → Pro+로 분리 유지

**빌트인 3종 명세**:
| 액션 | Free | Pro | 구현 |
|---|---|---|---|
| `notify.desktop` | 1 룰 | 무제한 | 브라우저 Notification API (대시보드 폴링) |
| `notify.webhook` | ❌ | 무제한 | 로컬 fetch POST |
| `notify.email` | ❌ | 무제한 | CF Workers `/v1/action/email` → Resend |
| `digest.weekly` | ❌ | 1 (고정) | 동일 (이메일 변형) |

**안전장치**:
- 룰별 쿨다운 기본 24h
- 기본 OFF, 명시적 ON
- 드라이런: "이 룰은 지난 30일 동안 N회 발화했을 것" 미리보기
- 발화 로그 (`rule_firings`) 감사용

**커스텀 가이드 범위** (`docs/customization.md`):
- 웹훅 payload 스펙
- Slack/Discord incoming webhook 연결 레시피
- n8n·Zapier·Pipedream 연결 레시피
- 사용자 스크립트 트리거 레시피 (간단한 Node/Python 수신기 예제)
- "안전한 자동 액션 작성법" 가이드 (사용자 책임 명시)

**번복 트리거**:
- Pro 결제자의 50%+ 가 "Slack 빌트인 어댑터 원함" → Slack 빌트인 검토 (그래도 자동 액션은 Pro+ 유지)
- 행동 변경류 요청 누적 30+ → Pro+ M4 게이트 검증 가속

---

## D-025. 현실 기대치 박제: 콘텐츠 트랙 우선 + Y1 ARR $2k base
**날짜**: 2026-05-13
**결정**:
- **정체성 재정의**: "공개 빌드 + 무료 도구" 우선. Pro $5 결제는 부가
- **Y1 ARR 목표 재설정**:
  - **base $2,000**, **stretch $6,000**, **optimistic $20,000** (이전 D-020 $48k optimistic 폐기)
- **본업 대체 시도 명시 차단**: Token Meter는 부업·콘텐츠 트랙 (트랙 분리 룰 정합)
- **콘텐츠 KPI 추가**: 빌드 로그 12편, GitHub Star 500, DAU 100, 카톡 직접 응답자 50명
- **Pro+ ($24) 출시 게이트**: M6 + Pro 100명 + 로컬 LLM 요청 30건. 미통과 시 영구 Pro $5 단독

**근거**:
- ccusage 무료 = 70% 풀 흡수 → 진짜 결제 트리거는 Smart alerts 1개에 의존
- "$7,735 cost 절약" 카피는 Max 유저에게 **역방향** 인지 ("Max 좋다 → 추가 결제 왜?"). 진짜 WTP는 Pro $20 한도 도달 유저로 좁아짐
- MCP 분해 차별점은 ccusage 1주 캐치업 가능 → 단기 우위만
- 글로벌 영문 GTM 1인 미검증 (4.3 박제) → HN/Reddit 운빨 의존
- 본인이 Claude·Codex Max 사용하며 빌드 → 자기 dogfood의 자기 기만 위험 박제 필요

**중단 조건 (Stop-loss) 갱신**:
다음 중 하나라도 발생 시 **즉시 일시 중단**:
1. 8주 안에 알파 못 띄움
2. 본업·v18·us-advisor·koreanpulse 운영 차질
3. 사용자 룰 위반 (트랙·자본·5거래일 욕망)
4. **6개월 누적 매출 $200 + 시간 200시간 초과** (이전 $500보다 보수)
5. M1 PMF 게이트 2회 연속 미달
6. **"이걸로 1억 벌겠다"는 자기 기만 발생 시 즉시 본업·v18 회복 우선 모드 전환**

**잘 되는 경우 / 평타 / 망해도**:
| 시나리오 | 결과 | 자산 |
|---|---|---|
| 잘 됨 | $500~3,000/월, GitHub 인지도 ↑ | 이직 가치 ↑, 콘텐츠 자산 |
| 평타 | $50~200/월 | 코드·박제·블로그 글 잔존 |
| 망함 | $0 | **자본 손실 0** (시간만), 박제 데이터·콘텐츠 자산 잔존 |

**6개월 후 자가 점검**:
- project_reality_pin.md 재읽기
- "Token Meter가 자동매매 알파 음수 회피 행동인가?" 정직 답변
- 본업·v18 회복 우선 모드 전환 여부 결정

**번복 트리거**:
- Pro+ 게이트 통과 + Y1 ARR $20k+ 도달 → 본업 비중 조정 가능 (그래도 즉시 전업 X)
- Y1 매출 $200 미달 + 시간 200h 초과 → 폐기 또는 OSS 단독 유지 (수익화 포기)

---

## D-026. 히스토리 단계화 + Pro 4종 강화
**날짜**: 2026-05-13
**결정**:
- **히스토리 재분배**: Free **7일** / Pro **30일** / Pro+ **무제한**
- **Pro 강화 4종 추가**: 세션 드릴다운 · 비용 예측 · CSV·JSON export · 커스텀 가격 매트릭스
- **Pro+ 차별점 추가**: 무제한 히스토리 + 다중 머신 동기화 + PDF 자동 리포트
- **Free 차별점 유지 (D-018 갱신)**: ccusage·tokscale 대비 7일 한정이라도 멀티벤더 + MCP 분해 + GUI + 알림 1 룰로 우위

**근거**:
- 이전 Pro 차별점 = "무제한 히스토리 + Smart alerts" 두 축 중 히스토리는 결제 트리거 약함 ("30일이면 충분" 인식)
- 자동 trim **룰 제안** · 벤치마크 비교만으로는 $5 정당화 약함
- 4종 추가는 **내부 LLM 0회 + 인프라 0 + 신뢰 비용 0** → 마진 81% 유지
- "잘 다룰 사람은 알아서 잘 다룬다" — Free 축소가 결제 마찰보다 풀 자체에 큰 영향 없음 (advanced 유저는 OSS 코드 자체 fork 가능)

**Pro 강화 4종 명세**:

| 기능 | Free | Pro | 가치 |
|---|---|---|---|
| **세션·턴별 드릴다운** | ❌ | ✅ | "5/4 $2,400 어느 세션·메시지가 비쌌나" 클릭 3회 답 |
| **비용 예측·페이스** | ❌ | ✅ | "현재 페이스 → 월말 $X 예상", "예산 50% 도달 (월 10일)" |
| **CSV·JSON export** | ❌ | ✅ (30일) | 회계·외부 BI·자체 분석. UI · CLI 양쪽 |
| **커스텀 가격 매트릭스** | ❌ | ✅ | 회사 API 약정 단가 입력 → 정확한 비용 산정 |

**Free 검증 (D-018 갱신)**:
- Free 7일이라도: 멀티벤더 ✅ + MCP 분해 ✅ + GUI ✅ + 데스크탑 알림 1 룰 ✅ + 평균 TPS ✅
- ccusage 무제한 vs Token Meter 7일 — 히스토리 단일 차원만 ccusage 우위, 5개 차원 압도
- Advanced 유저는 OSS fork로 우회 가능 (MIT 코어 보장)

**구현 시점**:
- 히스토리 단계화: M3 (라이선스 게이팅 활성 시점). 그 전까지 dev는 무제한
- Pro 4종: M3 결제 출시 직전 묶음 구현 (예상 +10~15시간)
- Pro+ 추가 기능 (다중 머신 sync·PDF): Pro+ 출시 시점 (M4+)

**번복 트리거**:
- Free 7일 한도가 가입 직후 이탈률 폭증 → Free 14일 완화 검토 (가입 후 30일 무료 trial로 변형 가능)
- Pro 4종 중 결제자 사용률 < 20%인 기능 → 6개월 후 평가, 사용률 낮은 것 제거 또는 Pro+로 이동

**관련 박제**: D-018 Free 의도적 우위 / D-024 Smart alerts / D-020 가격 / D-025 현실 KPI

---

## D-027. 비용 중복 계산 버그 수정 — request_id 단위 dedup
**날짜**: 2026-05-13
**결정**: Claude Code JSONL의 동일 `request_id` 다중 등장을 **전역 dedup**. 1 request_id = 1 청구 이벤트.

**버그 진단**:
- Claude Code가 단일 API 응답을 여러 assistant 이벤트로 쪼개 JSONL에 기록 (예: `[thinking]` 블록 + `[text]` 블록 분리)
- 모든 분기는 **동일 request_id + 100% 동일 usage tuple** 유지
- `/resume` 등으로 **다른 세션 JSONL에도 같은 request_id 복제** 등장
- 검증 결과: 본인 데이터 **128/128 multi-entry 케이스가 usage 일치**, 최악 18회 중복
- **비용 60.3% 과대 계산** ($7,748 → 실제 $1,583)

**수정 사항**:
1. [src/parser.ts](src/parser.ts) — `seenRequestIds` set으로 파일 내 dedup (첫 등장만 적재)
2. [src/db.ts](src/db.ts) — 기존 unique index `(session_id, ts, request_id, model)` 폐기
   - 신규: `UNIQUE INDEX (source, request_id) WHERE request_id IS NOT NULL` (전역 dedup)
   - fallback: `(session_id, ts, model) WHERE request_id IS NULL` (Codex는 synth id로 항상 NOT NULL이라 여기로 안 옴)
3. [scripts/migrate-dedup.cjs](scripts/migrate-dedup.cjs) — 1회성: 레거시 index drop + token_events·ingest_state wipe → 전체 재ingest
4. Codex parser는 영향 없음 (synth requestId 이미 유일)

**실측 영향 (30일 누적)**:
| 지표 | 수정 전 | 수정 후 | 변화 |
|---|---|---|---|
| Claude Code USD | $7,718 | **$1,551** | -80% |
| Claude Code events | 8,857 | 2,374 | -73% |
| Codex USD | $33.71 | $33.71 | 0 |
| **합계** | **$7,752** | **$1,585** | **-80%** |
| 일평균 (Claude) | $258 | $52 | 합리적 ($200 Max 플랜과 정합) |

**시사점**:
- 카톡 사용자에게 **"내 종량제 환산 비용"** 표시 시 이전 수치는 5배 과장. 신뢰 사고 위험 컸음
- M2 출시 전 발견·수정 → 운영상 노출 0
- 다른 경쟁자 (ccusage 등)도 같은 버그 가능성 → 우리 dedup 정확성 자체가 차별점이 될 수 있음

**박제 학습**:
- JSONL 같은 stream 데이터는 의미상 1단위와 물리적 1줄이 다를 수 있음. 항상 의미 단위 키 (`request_id`)로 dedup
- 회계·비용 수치는 출시 전 반드시 외부 anchor (실결제 청구액)와 cross-check

**번복 트리거**:
- Anthropic이 향후 동일 request_id로 진짜 별개 청구를 발생시키는 경우 (현재 없음) → dedup 전략 재검토

---

## D-028. MCP 서버 모드 — 간단 헬퍼 4종 (Free 포함)
**날짜**: 2026-05-13
**결정**: Token Meter를 MCP 서버로도 노출 (`token-meter mcp`, stdio). Claude Code·Cursor·Claude Desktop이 호출. **Free 티어 포함** (Pro+의 풀 MCP 인터페이스와 별개의 경량 버전).

**근거**:
- 사용자 요구: "터미널 실수로 닫았을 때 도움 주는 간단한 MCP"
- MCP는 CLI 닫힘을 **막을 수 없음** (구조적). 대신 "닫혀도 데이터 안 잃음 + 빠른 resume" 보조
- 본인 데이터(JSONL·SQLite)만 읽음. 벤더 API·프로세스 제어 일절 없음 → 신뢰 비용 0
- Free 포함 사유: "Token Meter는 MCP로도 쓸 수 있다"는 차별점 자체가 마케팅. ccusage 등 경쟁자 없음

**노출 도구 4종**:
| 도구 | 용도 |
|---|---|
| `usage_summary` | today/week/month 비용·토큰 요약, 모델·프로젝트별 |
| `recent_sessions` | 최근 N시간 활동 세션 (실수로 닫은 거 찾기), `claude --resume` / `codex resume` 명령 즉시 제공 |
| `session_tools` | 특정 session_id가 쓴 MCP·도구별 호출수·응답크기·평균지연 ("왜 이 세션이 비쌌나" 디버깅) |
| `refresh_data` | JSONL 재스캔 |

**구현**:
- [src/mcp.ts](src/mcp.ts) — `@modelcontextprotocol/sdk` McpServer + StdioServerTransport
- [src/cli.ts](src/cli.ts) — `token-meter mcp` 명령
- [src/sessions.ts](src/sessions.ts) — `recentSessions()` 추가
- [docs/mcp-server.md](docs/mcp-server.md) — Claude Code·Cursor 등록 가이드
- [scripts/test-mcp.cjs](scripts/test-mcp.cjs) — handshake 스모크 테스트 (initialize → tools/list → tools/call)
- 의존성 추가: `@modelcontextprotocol/sdk`, `zod`

**"중단 세션 감지" 백로그 (M4+ nice-to-have)**:
- 현재 `recent_sessions`는 "최근 활동 세션" 기준. 진짜 "tool_use 후 tool_result 없이 끊김" 정밀 감지는 파서에 dangling-tool 카운트 추가 필요 → M4+ 정밀화
- v1은 "최근 N시간" 휴리스틱으로 충분 (사용자가 판단)

**Pro+ 풀 MCP 인터페이스와의 관계**:
- D-024·02-product.md의 Pro+ MCP 인터페이스 (`get_savings_recommendations`, `enable_trim`, `enable_local_routing` 등 행동 변경류)는 별개로 M4+ 유지
- 이번 D-028은 **읽기 전용 경량 4종만 Free 포함**

**번복 트리거**:
- MCP 도구 사용량 극저조 (6개월 호출 < 100건) → Free에서 빼고 Pro 한정 검토 (그래도 코드는 유지)

---

## D-029. v0.1.0 publish 실전 박제 — npm scope + token-meter.dev + Pages 수동 deploy + Tally + 결제 wiring 보류
**날짜**: 2026-05-13
**결정**:
- **npm 패키지**: `@whdrnr2583/token-meter` (scoped) — bare `token-meter` 충돌 (similar-name vs 기존 `tokenmeter`). bin alias `token-meter` (npm scope strip 자동 매핑)
- **GitHub**: `whdrnr2583-cmd/tokenmeter` (public, MIT)
- **도메인**: `token-meter.dev` (CF Registrar $14/yr 추정, Year 1 인프라비 박제 갱신). 1순위 `tokenmeter.dev` 선점됨 (D-022 번복 트리거 발동)
- **랜딩**: CF Pages `tokenmeter-site` → `https://token-meter.dev` (build output: `infra/site`)
- **CF Pages 자동 배포 X**: `wrangler pages deploy` 수동만. Connect to Git 비활성. PMF 게이트 대비 명시적 control 우선
- **베타 폼**: Tally 임베드 `https://tally.so/r/2E16vD` (Self email notifications ON, Free tier 충분). CF Workers + D1 wiring 보류 (PMF 게이트 위반)
- **Email Routing**: `hello@token-meter.dev` → `whdrnr2583@gmail.com` (CF 무료, MX 자동)
- **bin 필드 자동 제거 경고**: scoped 패키지에서 unscoped bin key 자동 제거됨. npm이 패키지 이름 scope strip해서 binary 자동 매핑 (`token-meter` 명령 정상 작동)
- **결제 wiring (Polar/Workers/D1) M3 보류**: PMF 게이트 (알파 5 / 본인 dogfood 1개월 / 카톡 50 / 인터뷰 10) 통과 후만 진입

**박제 학습 가치**:
1. **npm `view <name>` 404는 정확 일치만 검증**. punycode normalize 충돌 (`tokenmeter` ↔ `token-meter`)은 publish 403에서만 발견. 사전 verify 강화 필요: 변형 5개 (`tokenmeter`, `token-meter`, `tokenmeter-cli`, `tokenpulse`, `aimeter`) 동시 조회 + 실패 대비 scope fallback 사전 준비
2. **CF Registrar 1순위 도메인 선점 빈도 높음** (`.dev` 인기). 백업 후보 5개 + 가격대 사전 정리 의무. D-022 박제 갱신 트리거 발동 시 즉시 옵션 4-5개 verify
3. **CF Pages "Workers & Pages" 통합 UI 함정**: dashboard "Create" 누르면 Workers default 진입. Pages는 "Looking to deploy Pages? Get started" 별도 링크 또는 wrangler CLI `pages deploy`로 우회 가능 (더 빠름)
4. **wrangler 4.x `pages domain add` 명령 제거됨**. Dashboard GUI로만 커스텀 도메인 추가 가능 (v3까지 있던 CLI 명령 deprecated)
5. **CF email obfuscation default ON**: `<a href="mailto:...">` 평문 노출되지 X. JavaScript로 자동 deobfuscate, 사용자 클릭 시 정상 mailto. 평문 원하면 CF Scrape Shield 설정에서 끄기 가능 — 보안 차원에서 ON 유지 정합

**번복 트리거**:
- PMF 게이트 통과 (결제 5건 + 인터뷰 5건 누적) → Connect to Git 자동 배포 + Pro+ 게이트 검증 가속
- npm bin 매핑 실패 보고 (`token-meter` 명령 누락) → v0.1.1 패치 (bin 필드 단일 string으로 변경)
- Tally Free tier limit 도달 (월 100 응답 초과) → Tally Pro 또는 자체 폼 (CF Workers wiring 진입 결정)
- 도메인 가용성 캐시 stale (RUNBOOK 갱신 누락) → 6개월마다 1순위 후보 자동 verify

**관련 박제**: D-001 Polar / D-005 로컬 우선 / D-021 stop-loss / D-022 제품명 / D-023 인프라 분리 / D-025 현실 KPI / D-027 dedup

---

## D-030. v0.1.2 patch — serve subcommand 누락 fix + `--version`/`--help` flags
**날짜**: 2026-05-14
**결정**: dogfood T+24h에서 발견된 P0 버그 1건 + 관용 UX 1건 묶음 패치. PMF 게이트 정합 (신규 기능 X, README 약속 동작 회복).

**버그 진단**:
- README:15 / CHANGELOG[0.1.0]:28에 `npx @whdrnr2583/token-meter serve` 안내됨 (대시보드 http://localhost:8765)
- 실제 `src/cli.ts`에 `serve` 서브커맨드 없음. `ingest` / `stats` / `mcp` 3종만.
- 사용자가 README 첫 명령 따라가다 즉시 unknown command + exit 1
- 원인: `src/server.ts`는 top-level `await app.listen` 단독 entry → `npm run serve` 스크립트로만 동작. npx / 글로벌 설치 사용자는 dashboard 못 띄움

**수정 사항**:
1. [src/server.ts](src/server.ts) — `export async function startDashboard()` 으로 wrap. `if (process.argv[1] === fileURLToPath(import.meta.url))` 가드로 직접 실행 (`npm run serve`) 시 auto-run 보존
2. [src/cli.ts](src/cli.ts) — `serve` 서브커맨드 추가 (mcp 패턴 동일: `await import('./server.js').then(m => m.startDashboard())`)
3. `--version` / `-v` flag (package.json runtime read) + `--help` / `-h` / `help` flag (exit 0)
4. USAGE 상수화

**검증**:
- typecheck / test (18/18) / audit (8 invariants) / build all green
- `node dist/cli.js --help` exit 0, unknown command exit 1
- `node dist/cli.js --version` → `0.1.2`
- `node dist/cli.js serve` → `Token Meter dashboard ready at http://127.0.0.1:8765`
- npx clean 환경 (`cd /Desktop && npx -y @whdrnr2583/token-meter@0.1.2 --version`) → `0.1.2` + `--help` serve 라인 노출 확인

**npm publish 박제 학습** (D-029 갱신):
- 5/13 publish 후 npm 로그인 세션 만료. `npm whoami` → E401 → `npm publish` → E404 disguised permission error
- 해결: `npm login` 재인증 후 OTP prompt 정상 작동. publish 성공 `+ @whdrnr2583/token-meter@0.1.2` (2026-05-14 11:54 UTC)
- bin 경고 (`bin[token-meter] script name dist/cli.js was invalid and removed`)는 D-029 cosmetic 재발생. scope strip 자동 매핑으로 `token-meter` 명령 정상 작동

**Git/CI 박제**:
- commit `ce81b37` fix + `d1d2a82` dogfood T+24h + `3f8e2c5` v0.1.2 dogfood 갱신 + `838616e` 30d retro
- `git tag v0.1.2 ce81b37` + `git push origin v0.1.2` → release.yml CI 멱등 가드 (npm view skip) 동작 추정 (27s run)

**번복 트리거**: v0.1.2의 `serve` 동작 실패 보고 → v0.1.3 패치. `--help` exit code 보고 → 조정.

---

## D-031. 사용자 outbound 채널 영구 차단 + PMF 게이트 5조건 우회 + LLM Opus 의견 우선
**날짜**: 2026-05-14
**결정**: 사용자 명시 정책 갱신. Token Meter는 다음 5건 영구 적용.

1. **Outbound 채널 전면 차단** (**Gmail email + Hacker News 예외**): 카톡 알림 / Reddit DM (r/ClaudeAI · r/Codex · r/LocalLLaMA) / ICP 인터뷰 cold DM / Multiplier DM / LinkedIn / Substack / Twitter / Discord / Slack / Smartkarma / 메일 magazine 등 **모든 social·platform 발신 마케팅·리서치 채널 차단**. 자체 발신 0. **단 (a) Gmail email (`hello@token-meter.dev` Reply-to) 회신 + (b) Hacker News (Show HN, 워밍, 댓글)는 허용** — 2026-05-14 사용자 글로벌 outbound rule [[feedback_gmail_only_outbound]] 정합 갱신.

2. **Gmail-only inbound**: `hello@token-meter.dev` → `whdrnr2583@gmail.com` Email Routing 답신 + Tally `tally.so/r/2E16vD` 자발적 입력만 수용.

3. **PMF 게이트 5조건 명시 우회**: [[D-020]] / [[D-029]] 박제의 "알파 5명 / dogfood 1개월 / 카톡 50명 / ICP 인터뷰 10명 / Y1 ARR base $2k" 게이트는 **결제 wiring·Pro/Pro+ 기능 진입 차단 조건으로 폐기**. 본인 dogfood만 측정 의미 유지 (자기 검증 가치).

4. **외부 의견 < LLM Opus 의견**: GPT-5.5 Pro / 외부 LLM audit / 사용자 인터뷰 / 카톡 응답 등 **외부 의견 가치 부정**. 사용자 본인 + Opus 양자 결정만. `feedback_external_llm_review_selective_accept.md` 박제는 "selective accept"였으나 Token Meter에서 **외부 LLM 입력 자체 차단**.

5. **빌드·실패 우선**: [[D-021]] 박제 강화. 외부 검증 기다리지 않고 출시 → 실 결제·DAU·버그 보고로 학습. PMF 게이트 통과 의존 X.

**사용자 발화 (2026-05-14)**:
> "남들 기다리는거 이제 그냥 넘어가자. 성공하는데 누구 허락받아야 하는게 말이 안된다 걍 부딫히고 줘터지면서 배울래. 그냥 gmail로 보내는거 제외하곤 아무것도 메시지를 보내지 않는다. 우리는 우리의 방식으로 나아간다. 남들 호응, 의견을 기다리는게 전문가 의견을 받는게 중요하다 해도 LLM opus의 의견보다 못하다. 인지해라."

**근거**:
- 사용자 본인 룰 갱신 (제3자 승인 우회 아님) → `feedback_rule_integrity.md` 정합
- 콘텐츠 트랙 우선 + 글로벌 1인 영문 GTM 미검증 정합 ([[D-025]])
- 1인 운영 시간 캡 보호 (인터뷰 / DM 응답 부담 0)

**유지되는 stop-loss** (반드시 cross-check):
- 본업·v18·us-advisor·koreanpulse 운영 차질 **0**
- 시간 캡 주 **10시간**
- 6개월 누적 매출 **$200 미달 + 200h 초과** 시 즉시 OSS 단독 유지 또는 폐기 ([[D-025]])
- "이걸로 1억 벌겠다" 자기 기만 발화 시 즉시 본업·v18 회복 우선 모드 전환

**번복 트리거**:
- 본업·v18·us-advisor·koreanpulse 침범 발생 → 즉시 Token Meter 일시 중단
- 6개월 매출 $200 + 200h 초과 → 폐기 or OSS 단독 모드
- 사용자 본인 명시 갱신 (예: "ICP 인터뷰 받자" / "카톡 알림 보내자") → 그 시점에 본 박제 부분 갱신

**폐기되는 박제·작업**:
- `_workspace/pmf_gate_progress.md` 5조건 진행 매트릭스 → **LEGACY 마킹**
- `_workspace/icp_interview_template.md` → **LEGACY 마킹** (코드·박제 보존, 진행 X)
- `_workspace/kakao_announcement_v1.md` → **LEGACY 마킹**
- `_workspace/listing_drafts.md` 등 외부 채널 deliverable → 유지하되 LEGACY 마킹

**진입 가능 작업** (사용자 결정 후만):
- α. Pro $5 4종 기능 명세 (`docs/pro-features.md`)
- β. Pro 라이선스 게이팅 코드 (`src/license.ts`)
- γ. 결제 wiring (Polar / CF Workers / D1)
- δ. Pro+ $24 명세 + 가격 페이지 표시
- ε. CF Pages 랜딩 가격 카피 갱신 (5$/24$ 가격 표시 + "Pro after beta" 정직 표현)

**관련 박제**: [[D-021]] 빌드 우선 / [[D-025]] 현실 KPI / [[D-020]] / [[D-029]] PMF 게이트 (본 박제로 부분 폐기)

---

## D-032. Polar webhook 시그너처 검증 — Polar는 Standard Webhooks와 다름
**날짜**: 2026-05-15
**결정**: Polar webhook signature는 표준 Standard Webhooks spec과 두 군데 다르다. 우리 verify 로직은 manual implementation 사용. `standardwebhooks` npm 패키지 사용 금지.

**진단 (5/14 ~ 5/15 e2e 디버깅, 4 variant 동시 시도로 발견)**:

1. **HMAC key derivation**: Polar는 secret 전체 (53자, `polar_whs_` prefix **포함**)를 **raw UTF-8 bytes** 로 HMAC key 사용. base64 decode **안 함**.
   - Standard Webhooks 표준: `whsec_<base64>` prefix strip 후 base64 decode → ~32 bytes 키
   - Polar 실제: secret string `polar_whs_<43chars>` 전체 53 bytes를 raw UTF-8로 키
   - 검증: 4 variant 동시 시도 (`base64_stripped`, `raw_stripped`, `raw_full`, `base64_full`) → 오직 `raw_full` 만 매칭

2. **Event id 위치**: Polar는 event id를 body에 넣지 X. `webhook-id` **HTTP header**에 emit. 우리 코드가 `evt.id` (body)를 찾으면 항상 미존재 → 401 통과 후 400 missing_fields.

**구현 (infra/api/src/index.ts)**:
- `verifyPolarSignature`: `new TextEncoder().encode(secret)` (53 bytes)를 HMAC-SHA256 key로 importKey. signed payload = `${wid}.${wts}.${rawBody}`. expected base64(HMAC) vs `webhook-signature` header의 `v1,<sig>` token timing-safe 비교
- `eventId = wid` (header from `c.req.header('webhook-id')`) 로 webhook_events.id INSERT

**금지**:
- `standardwebhooks` npm 패키지 사용 (Polar용 미작동, 1.x 의존성 제거됨)
- secret을 base64 decode 후 HMAC key 사용 (Standard Webhooks 표준이지만 Polar 미적용)

**번복 트리거**:
- Polar가 향후 spec에 정합 (base64 key, body id) → 우리 코드 갱신
- Polar API 응답 헤더에 spec 변경 알림 명시 → 모니터링

**관련 박제**: [[D-001]] Polar.sh / [[D-031]] outbound 차단 / [[feedback_ls_denied_polar_pivot]] (Standard Webhooks 시그너처 박제 — 본 진단으로 갱신).

---

## D-033. MCP prompts 추가 (slash-command 노출) — dogfood UX 카테고리, 결제 trigger 아님
**날짜**: 2026-05-15
**결정**: `src/mcp.ts` 4 tools 각각에 1:1 페어링되는 MCP prompts 등록. 클라이언트(Claude Code · Cursor · Claude Desktop)가 자동으로 `/mcp__token-meter__<name>` 슬래시 명령으로 노출.

**노출 슬래시 4종**:
| 슬래시 | arg | 페어 tool |
|---|---|---|
| `/mcp__token-meter__usage_summary` | `period` (today\|week\|month, default today) | `usage_summary` |
| `/mcp__token-meter__recent_sessions` | `within_hours` (1-720, default 24) | `recent_sessions` |
| `/mcp__token-meter__session_tools` | `session_id` (required) | `session_tools` |
| `/mcp__token-meter__refresh_data` | — | `refresh_data` |

**카테고리 분류 (정직 박제)**:
- **dogfood UX 편의**: 사용자 본인 1명 발의. 외부 ICP 요청 0. 슬래시 직접 호출 선호 power user UX 마이크로 개선.
- **결제 trigger 아님**: [[D-026]] Pro 4종 (세션 드릴다운 / 비용 예측 / CSV·JSON export / 커스텀 가격 매트릭스)과 무관. Pro $5 결제 정당화 강화 X.
- **차별점 강도 약함**: ccusage / tokscale 대비 marketing 트로피 아님. README/HN 카피 부수적 한 줄 추가만 가능.

**근거 (사용자 명시 결정)**:
- 사용자 발화 (2026-05-15): "지금 기능도 유지하고, MCP prompts도 추가하자" — 자연어 호출 패턴 유지하면서 추가
- 의견 요청에 "사업가적으로 비추, dogfood UX 편의 카테고리라면 OK" 답변 → 사용자 1번 선택 (dogfood UX 진행)
- [[D-031]] 사용자 명시 메타룰 우회 룰 정합 (비-매매 메타룰은 사용자 명시 + 이유 박제 시 우회 가능)

**구현**:
- [src/mcp.ts](src/mcp.ts) `server.registerPrompt(...)` 4개 (~60 LOC 추가)
- [scripts/test-mcp.cjs](scripts/test-mcp.cjs) + [scripts/test-mcp-built.cjs](scripts/test-mcp-built.cjs) prompts/list + prompts/get 검증 추가
- [docs/mcp-server.md](docs/mcp-server.md) 슬래시 명령 표 추가 (자연어·슬래시 둘 다 동등)
- [CHANGELOG.md](CHANGELOG.md) v0.1.6 entry

**검증**:
- typecheck / test 33/33 / audit 8 invariants / build all green
- dist MCP 스모크: prompts/list 4 prompts 노출, prompts/get usage_summary period=month echo OK

**위험**:
- 유지보수: tool signature 변경 시 prompt arg 시그너처도 동시 갱신 의무 (drift 약함)
- 마케팅 oversell 위험: "slash commands!" 카피로 가치 과장 시 자기 기만. 카피는 부수적·정직 표기 유지 ("/와 자연어 둘 다 동등")

**번복 트리거**:
- 6개월 dogfood 사용 빈도 자연어 호출 vs 슬래시 = 자연어 압도 → prompts 제거 검토 (코드는 50 LOC라 부담 작음, 유지 default)
- MCP prompt API breaking change (SDK 변경) → 마이그레이션 비용 평가

**관련 박제**: [[D-028]] MCP 서버 모드 4 헬퍼 / [[D-031]] 사용자 명시 메타룰 우회 / [[D-026]] Pro 4종 결제 trigger (본 박제는 결제 trigger 아닌 dogfood UX)

---

## D-034. `/token-meter` custom slash command — Claude Code only, dogfood UX 확장
**날짜**: 2026-05-15
**결정**: MCP 클라이언트의 `/mcp__<server>__<prompt>` prefix 강제 spec을 우회하기 위해 Claude Code `~/.claude/commands/<name>.md` Custom Slash Command 시스템으로 `/token-meter` 슬래시 도입. 단일 진입점에서 오늘 사용량 + MCP·도구별 분해 + 다른 명령 hint + Pro $5 안내 한 번에 노출.

**기술 사실 박제**:
- **MCP spec 한계**: `server.registerPrompt('usage_summary', ...)` 등록해도 클라이언트는 항상 `/mcp__token-meter__usage_summary` 로 노출. prompt name을 짧게 해도 결과는 동일 prefix. **MCP 자체로 `/token-meter` 한 줄 직접 불가능**.
- **우회 path**: Claude Code 별도 시스템 — `~/.claude/commands/<name>.md` markdown 파일이 슬래시 prompt. 사용자가 `/token-meter` 입력 시 markdown 본문이 LLM에 prompt로 주입.
- **Cursor / Claude Desktop은 슬래시 시스템 다름** — 1차 미지원, 본인 = 주 사용자 ROI 최대.

**구현**:
- [src/install-command.ts](src/install-command.ts) — `installClaudeCodeCommand()` (install-mcp 패턴 복제: idempotent, .bak 백업, dry-run, targetPath override 테스트 seam)
- `commandTemplate()` 본문 = `usage_summary` 호출 지시 + 결과 그대로 출력 + Pro 안내 블록 fixed text
- [src/cli.ts](src/cli.ts) — `token-meter install-command claude-code [--dry-run]` 서브명령
- [src/mcp.ts](src/mcp.ts) — `usage_summary` tool 응답에 MCP·도구별 top 5 섹션 추가 (단일 호출로 슬래시 출력 충분)
- [test/install-command.test.ts](test/install-command.test.ts) — 7 케이스 (create / idempotent / update-managed / refuse-unmanaged / dry-run create / dry-run stale / template content)
- [docs/mcp-server.md](docs/mcp-server.md) — `/token-meter` 섹션 신설
- 의존성 추가: **0**

**카테고리 분류 (정직 박제)**:
- **dogfood UX + 약한 marketing surface**: [[D-033]] v0.1.6 슬래시 prompts (긴 prefix)는 dogfood UX 카테고리. v0.1.7 `/token-meter` 한 줄은 **dogfood UX + 결제 카피 자연 노출 surface** 1개 추가. 본인 + 슬래시 선호 user 호출 시 Pro 안내 자동 표시.
- **결제 trigger 직접 아님**: Pro 안내 1줄로 awareness 증가는 가능. 하지만 [[D-026]] Pro 4종 (세션 드릴다운 / 비용 예측 / CSV export / 커스텀 가격)이 실 결제 정당화 mechanism. 슬래시는 noise floor 채움.
- **마케팅 oversell 위험**: "/token-meter" 카피로 가치 과장 시 자기 기만. README/카피는 부수적·정직 표기 유지.

**근거 (사용자 명시 결정)**:
- 사용자 발화 (2026-05-15 22:14 KST): "/mcp_token-meter는 좀 이상해. 다른 mcp명령어처럼 /했을때 바로 나와야지 /token-meter ... 기본적인거 '오늘사용량 MCP별사용량' 보기좋게 간단히 보여주고, 다른명령어나 pro구독 내용 사람들에게 보여주는형태를 기대했다"
- "진행해주세요" — [[D-031]] 사용자 명시 메타룰 우회 룰 정합

**위험 + 안전장치**:
- **기존 슬래시 파일 충돌**: 사용자가 `~/.claude/commands/token-meter.md` 직접 작성한 경우 → install이 `@whdrnr2583/token-meter` 마커 없으면 `skipped` + exit 1 (덮어쓰기 거부). 본인 환경의 기존 `tokenmeter.md` (no 하이픈)는 별개 슬래시라 영향 X.
- **Custom slash command spec 변경 위험**: Claude Code 향후 슬래시 시스템 변경 시 1회 마이그레이션. 안정성은 plain markdown이라 매우 작음.

**번복 트리거**:
- 6개월 dogfood 빈도: `/token-meter` 사용 << 자연어 호출 → 부담 작지만 유지 default (50 LOC 추가뿐)
- Pro 안내 카피로 항의 / 부정 응답 보고 → Pro 블록 제거 또는 옵션화
- Cursor / Claude Desktop user 추가 30+ → 클라이언트 분기 확장 검토

**관련 박제**: [[D-033]] v0.1.6 MCP prompts (slash 시작점, 긴 prefix) / [[D-028]] MCP 서버 4 헬퍼 / [[D-031]] 사용자 명시 메타룰 우회 / [[D-026]] Pro 4종 결제 trigger (본 박제는 noise floor surface, 직접 trigger 아님)

---

## D-035. GitHub repo rename — naming 함정 해소 (`tokenmeter` → `token-meter`)
**날짜**: 2026-05-15
**결정**: GitHub repository를 `whdrnr2583-cmd/tokenmeter` → `whdrnr2583-cmd/token-meter`로 rename. 모든 in-repo 레퍼런스 + 임베디드 raw URL 갱신. README 상단에 npm·GitHub·site 한 줄 명시 추가.

**진단 (외부 발견)**:
- 누군가 npm scope `@whdrnr2583/token-meter` 보고 GitHub URL 추론: `github.com/whdrnr2583/token-meter` → **404** (username `whdrnr2583` 비존재) + `github.com/whdrnr2583-cmd/token-meter` → **404** (repo `tokenmeter` no 하이픈)
- 불일치 4축:
  | 항목 | 값 |
  |---|---|
  | GitHub username | `whdrnr2583-cmd` (`-cmd` suffix) |
  | GitHub repo (이전) | `tokenmeter` (no 하이픈) |
  | npm scope | `@whdrnr2583` (no `-cmd`) |
  | npm package | `token-meter` (with 하이픈) |
  | 도메인 | `token-meter.dev` (with 하이픈) |

**결정 사유**:
- 발견 단계 trust hit. 검색·share·인용 시 마찰
- GitHub auto-redirect로 기존 링크는 유지됨 → repo rename 비용 5분
- username rename (`whdrnr2583-cmd` → `whdrnr2583`)은 보류: OAuth·token·CI secret 연쇄 깨짐 위험. ROI 음수
- 결과: GitHub repo만 rename, README에 canonical lookup row 추가

**구현**:
- 사용자가 GitHub Settings → repo rename 직접 실행 (5분)
- 9 파일 일괄 URL 갱신: package.json / server.json / README.md / docs/mcp-server.md / infra/site/index.html / src/cli.ts / _workspace/dogfood_daily.md / _workspace/listing_drafts.md
- README.md 상단 1줄 추가: `npm · GitHub · site` canonical links
- raw.githubusercontent.com URL은 redirect 안 됨 → 무조건 갱신 (4곳)
- D-029 박제 본문 (`whdrnr2583-cmd/tokenmeter` 명시 라인) historical fact 보존, 본 박제로 cross-reference

**검증**:
- 회귀 4종 통과 (typecheck / test 40 / audit / build)
- dist MCP 스모크 통과
- `grep -r "whdrnr2583-cmd/tokenmeter\b"` 활성 파일에서 0건 (legacy + D-029 historical 박제 제외)

**박제 학습**:
1. **신규 프로젝트는 publish 전 naming consistency cross-check 의무**: GitHub username + repo + npm scope + npm package + domain + product name 6축 일관성 매트릭스
2. **npm publish가 GitHub repo 이름을 lock하지 않음** — repository.url은 단순 메타데이터. rename 후 v+1 publish하면 npm 페이지도 갱신
3. **raw.githubusercontent.com URL은 GitHub auto-redirect 무시** → repo rename 시 raw URL 별도 갱신 의무
4. **사용자 reporter cross-check가 강한 signal** — 추측 의존을 발견의 출발점으로 두면 naming 함정 자가 발견 어려움. 외부 시도 1회로 즉시 노출됨

**번복 트리거**:
- GitHub auto-redirect가 향후 중단 (현재 spec상 영구) → 기존 링크 일괄 갱신 sweep
- username rename 진짜 필요 시점 (해외 user 다수 confusion 보고 30+) → 별개 박제로 진입

**관련 박제**: [[D-022]] 제품명 Token Meter / [[D-029]] npm scope strip 자동 매핑 (이전 박제 본문에 옛 URL 명시 — historical 보존) / [[feedback_listing_vs_discovery]] 등재 ≠ 발견 (본 fix는 discovery layer correction, 등재와 별개)

---

## D-036. Attribution accuracy 개선 설계 — dual-home·프로젝트·subagent 3축 + 출력 규격 (build 보류)
**날짜**: 2026-05-17
**결정**: 아래 3축 attribution(귀속) 한계를 **0.2.0 "attribution accuracy" 한 묶음**으로 개선하되,
**build는 PMF 게이트 통과 후로 보류**. 본 항목은 그때 착수할 설계를 미리 박제.

**배경**: 2026-05-17 dogfood 점검 세션에서 token-meter 자체 데이터로 한계 3건 발견.
- **dual-home**: ingest를 `cmd.exe`(Windows home)로 돌려 실사용(WSL home)을 100배+ 과소집계
  (5/17 실측 $0.29 vs 실제 $285.84). dogfood 절차를 WSL 우선으로 수정해 임시 대응했으나
  제품 차원 한계 잔존. (`_workspace/dogfood_daily.md` 5/17 행 참조)
- **프로젝트 분해**: `project = 세션 cwd`인데 사용자가 mono-cwd 습관 → 전 프로젝트가
  한 버킷($5365/8686ev). 경쟁표상 "프로젝트별 분해"가 Free 차별점인데 사실상 무력.
- **subagent 구분 불가**: `tool_events`에 subagent 종류 컬럼 없음. 원본 JSONL엔
  `subagent_type` 존재(general-purpose·krx-trader·ops-monitor·risk-auditor 등 확인).

**핵심 통찰**: 셋 다 같은 뿌리 — 기록 단위가 굵고, 고칠 정보는 **이미 JSONL 안에 있음**.
공통 fix 패턴 = "JSONL에 이미 있는 더 잘게 쪼갠 필드를 nullable 컬럼으로 흡수".

**설계 — 3축**:
- **① dual-home**: 최소안 = `ingest --home <path>` 플래그 + 다른 home 자동감지 시 1줄 경고.
  완성안 = config `claudeHomes: []` 다중 home을 **한 DB로** 병합 ingest. 안전성 =
  `(source, request_id)` dedup([[D-027]])이 중복 자동제거 보장. DB 경로를 home과 분리.
- **② 프로젝트**: B2(빠름) = config 프로젝트 맵 `{name: path}` 결정론적 분류.
  B1(정답) = 파서가 Read/Edit/Bash의 파일경로 인자를 `tool_events.target_path` 신규 컬럼에
  저장 → 세션별 최빈 상위 디렉토리로 project 추론.
- **③ subagent**: C1 = Task tool_use의 `subagent_type` → `tool_events.subagent_type` 컬럼
  (~20 LOC). C2 = subagent 내부 턴 태그 → `token_events.subagent_type` → agent별 USD 집계.
  3축 중 **가성비 최고** (데이터 완비·변경 작음·기존 도구별 분석을 agent별로 자연 확장).

**공통 구현 원칙**:
- 새 컬럼 전부 **nullable + `ALTER TABLE ADD COLUMN`** (비파괴). 옛 행 NULL 유지,
  강제 re-ingest로 backfill 가능 (JSONL 원본 디스크 보존).
- 새 차원마다 **audit invariant 1개** 추가 (`Σ(차원별 USD) == 총 USD`, 기존 roll-up
  보존검사 패턴).
- 구현 순서(쌀→비쌈): **C1 → ①경고+`--home` → C2 → ②B1**.

**출력 규격 (output contract)** — 신규 attribution 뷰가 내는 답변은 규격을 따라야 함:
- CLI stdout·MCP 응답 둘 다 고정 규격. 모든 attribution 뷰 =
  **[차원값 · 지표 · share% · 합계행]** 4요소 필수 — 출력만 봐도 Σ가 self-check 되게.
- 한 행 = 한 줄, 고정 필드 순서·구분자, 단위 명시($ / tokens / ms).
- empty·error 상태도 **정의된 형태로 명시** (silent 금지 — "no data" 출력).
- MCP 응답은 CHANGELOG 0.1.9 token-efficient 규율 유지 (compact, 패딩 0).
- 출력 포맷 = downstream LLM·스크립트가 파싱하는 **사실상의 API** → 변경 시 CHANGELOG 기록 의무.
- 출력의 total == audit invariant가 검증하는 total (1:1 일치).

**PMF 게이트**: 결제 0건·알파 0명 동안 build 보류. attribution 정밀도는 PMF 이후 polish —
지금 최우선은 "도구를 사용자 앞에 놓는 것".

**번복 트리거**:
- 유료/알파 사용자가 프로젝트별 또는 agent별 breakdown을 명시 요청 → 해당 축만 우선 착수.
- split-env(WSL+Windows) 사용자 리포트 1건이라도 → ① 최소안(`--home` + 경고) 즉시.

**관련 박제**: [[D-002]] 로컬 JSONL 파싱 (attribution 원천) / [[D-027]] dedup
(다중 home 병합 안전성 근거).

---

## D-037. 가격 테이블 최신화 — (A) 무료 갱신·"as of" 고지 / (B) Pro 계약단가 매트릭스 (build 보류)
**날짜**: 2026-05-17
**결정**: 모델 가격 변경·신규 모델 대응을 두 갈래로 분리 설계. **build는 PMF 게이트 통과 후로
보류**, 본 항목은 설계만 박제.

**배경**: `src/pricing.ts:11`의 `PRICES`는 13개 모델 **하드코딩 테이블** + 주석 "updated
2026-05". 사용자가 가격 수정·모델 추가할 통로 없음 (env/config/CLI 전무) → 소스 편집 + npm
재배포만 가능 = 개발자 전용. `resolveModel()` family fallback이 신규 모델을 ballpark로
추정해 크래시는 없으나, **기존 모델 가격이 바뀌면 재배포 전까지 조용히 옛 단가로 계산** =
비용 도구가 소리 없이 거짓말.

**핵심 구분**: "가격 변경/신규 모델 반영"은 서로 다른 두 문제 — 섞으면 무료 티어가 조용히
틀려짐.
- **(A) 내장 테이블 최신 유지** — 공개가 변경·신규 모델 = 유지보수 문제. **무료**여야 함.
- **(B) 사용자별 계약 단가** — 회사 볼륨 계약 오버라이드 = 정당하게 **Pro**.

**설계 (A) — 무료**:
- `PRICES` 하드코딩 TS → 패키지 번들 `pricing.json`으로 분리.
- `~/.tokenmeter/pricing.json` 사용자 오버라이드 파일 지원 → **재배포 없이 모델 추가·가격
  수정**.
- `ingest` 시 테이블 미등록 모델 string 감지 → 1줄 경고 (family fallback 추정 중임을 명시).
- **"Prices as of YYYY-MM" 고지** — 모든 비용 출력(CLI·MCP·대시보드)에 가격표 기준 시점을
  1줄 표기. 내장 테이블이 stale해도 사용자가 **눈으로 staleness 판단 가능** → "조용한
  거짓말"이 "정직한 추정"으로 전환. ([[D-036]] 출력 규격의 일부로 편입)
- 추정 ~1-2h.

**설계 (B) — Pro** (`docs/pro-features.md §6` 스펙 그대로):
- `pricing_overrides(model, *_per_mtok, effective_from, …)` 테이블 + GUI 설정탭 +
  `pricing import/reset` CLI + 오버라이드 추가 시 과거 `usd_estimate` 백필 재계산.
- 추정 ~3-4h.

**무료/유료 선**: 무료 = "JSON 직접 편집 + 기준시점 고지" (단일 전역 단가·수동) / Pro =
"관리형 GUI + effective_from 시점별 계약단가 + 과거 자동 recompute". 방어 가능한 분리 —
무료 편집은 fiddly·전역·비버전, Pro는 관리형·시점별·이력 재계산.

**구현 순서**: (A) 먼저 (correctness·정직성·무료·소규모) → (B)는 첫 Pro 결제 후.

**PMF 게이트**: build 전부 보류 (결제 0건). 그동안 내장 테이블 갱신은 dev patch 릴리스로만
임시 대응 — "as of" 고지가 없는 현 상태에선 사용자가 staleness를 못 보는 게 최대 약점,
(A) 착수 전까지 감수.

**번복 트리거**:
- 첫 Pro 결제 발생 → (B) custom pricing matrix 착수.
- 회사 계약단가 사용자 요청 1건 → (B) 우선순위 상향.
- 외부 사용자가 "가격이 틀리다" 리포트 → (A) 즉시 착수 (correctness 항목으로 승격).

**관련 박제**: [[D-002]] 로컬 JSONL 파싱·자체 토크나이저 없음 (가격표가 $ 환산의 단일
의존점) / [[D-036]] 출력 규격 ("as of" 고지를 output contract에 편입).

---

## D-038. 게이팅 default-ON + /4haiku Pro 기능 검토 → 커스텀 가격·익명 벤치마크 폐기, 캐시 효율·낭비 신호 빌드
**날짜**: 2026-05-18
**버전**: v0.1.10

**결정**: (1) 라이선스 게이팅을 default-ON으로 전환. (2) `/4haiku` 5-에이전트 검토 결과
광고만 되고 미빌드였던 Pro 기능 4종 중 **커스텀 가격 매트릭스·익명 벤치마크 2종 폐기**,
**캐시 효율 분석·낭비 신호 2종을 신규 빌드**해 Pro 헤드라인으로. (3) 모든 광고 surface를
빌드 상태와 일치시킴.

**배경**: 게이팅 코드(`src/license.ts`, [[D-031]] γ)는 v0.1.3부터 존재하나 dormant —
`TOKEN_METER_GATING` 미설정 시 전원 Pro+로 해석돼 평상시 티어 구분이 전혀 작동 안 함.
한편 랜딩·슬래시·README·`docs/pro-features.md`는 Pro 혜택으로 비용 예측·CSV export·커스텀
가격 매트릭스·익명 벤치마크·주간 권장·자동 trim을 광고했으나 `src/`에 구현 0 — 결제 시
"없는 걸 파는" 신뢰·환불 리스크.

**(1) 게이팅 default-ON**:
- `isGatingEnabled()` 기본 true. `TOKEN_METER_GATING=0`(또는 false)은 개발·dogfood용
  escape hatch(전원 Pro+). trim 처리 — cmd.exe `set X=0 ` 공백 함정 방어.
- Polar checkout + webhook → 라이선스 발급 경로가 live(2026-05-15 첫 e2e)이므로 베타
  dormant 기본을 flip. npm 다음 버전부터 라이선스 없으면 Free.

**(2) /4haiku Pro 기능 검토** (5 Haiku 병렬, depth task, ~367K tokens):
- 광고 4종 전부 B-1순위 점수 낮음(2~4.5/10). 평결:
  - **커스텀 가격 매트릭스 → 폐기**: ICP(개인 빌더)는 공개 정가 사용, 회사 계약단가
    수요 없음. [[D-037]] (B) 설계를 폐기로 대체 — (A) "as of" 고지·pricing.json은 유효.
  - **익명 벤치마크 → 폐기**: 사용자 ~0 = cold-start로 비교 모수 자체가 없음 +
    local-first 신뢰와 충돌. [[D-008]] 옵트인 설계 보류.
- 검토가 발굴한 진짜 Pro 가치(미광고) = **낭비 탐지 + 캐시 효율** → 신규 빌드:
  - **캐시 효율 분석**: hit ratio, 캐시 절감액(gross/net), 캐시 생성비. LLM 0.
  - **낭비 신호**: 도구 응답 outlier(max>5×avg & >10k) + 미회수 캐시 날. LLM 0 휴리스틱.
  - 둘 다 Pro 게이트. `stats.cacheStats()`/`wasteSignals()` + 단위테스트 5.
- 비용 예측·CSV export는 폐기 아님 — "추후 증분"으로 강등(planned 표기).

**(3) 광고 정합**: 랜딩 #pricing·`/token-meter` 슬래시·README 가격표·`docs/pro-features.md`
배너+매트릭스를 빌드된 것만 표시하도록 수정. README가 Free를 "30일"로 잘못 표기한 것도
정정(실제 7일).

**메타룰 노트**: `/4haiku`의 "본 프로젝트 침범 X" 룰은 사용자 명시 우회([[D-031]] 정합 —
비-매매 메타룰, 1회, 리뷰 도구 용도). PMF 게이트는 [[D-031]]에서 이미 폐기 → 빌드 차단 X.

**번복 트리거**:
- 외부 사용자가 회사 계약단가 오버라이드 요청 → 커스텀 가격 매트릭스 재검토.
- Pro 결제 5건 + 사용자 100+ → 익명 벤치마크 cold-start 해소 시 재검토.
- 캐시 효율·낭비 신호를 결제자가 "왜 Pro냐" 불만 → Free 재분배 검토.

**관련 박제**: [[D-031]] γ 게이팅 flip 트리거 + 메타룰 우회 / [[D-037]] (B) 폐기로 대체,
(A) 유효 / [[D-008]] 익명 벤치마크 옵트인 보류 / [[D-020]] Pro $5 단일가 / [[D-026]] Pro
기능 강화 (4haiku 검토로 구성 재정의).

---

## D-039. D-031 outbound 차단 단발 우회 — 카톡 Pro WTP 검증 인터뷰
**날짜**: 2026-05-18

**결정**: [[D-031]] outbound 채널 차단을 **카톡 AI 오픈채팅방 1채널·단발(이번 검증 라운드
한정)**으로 우회. Pro 티어 WTP(지불의향) 가설을 Mom Test 방식 인터뷰로 검증. 사용자 명시
선택(A안).

**배경**: v0.1.10로 Pro 광고-빌드 정합·기능 차별가치(캐시 효율·낭비 신호)는 확보했으나
**실 유료 결제 0건**(0.1.0 publish 5/13 이래). "개인 AI 빌더가 토큰 관찰성에 월 $5를 낼
의향이 있는가"라는 핵심 가설이 미검증 + 검증 메커니즘 부재 — outbound 차단 상태에서
dogfood(본인 1명)만 신호원. 기능을 더 쌓는 건 [[D-038]] 4haiku 검토에서 무효로 확인 →
가설 검증이 다음 단계.

**우회 범위 (정확히)**:
- 채널: **카톡 AI 오픈채팅방만**. v0.1.0 원 launch 채널, 한국어(영어 장벽 0, 사용자 직접).
- 기간: **단발** — 이번 검증 라운드(~ICP 5명 인터뷰)만. 라운드 종료 시 자동 원상복귀.
- 미우회: Reddit·Discord·Twitter·LinkedIn 등 [[D-031]] 나머지 social 채널은 차단 유지.
  outbound 허용 = Gmail + HN + (한시) 카톡.

**방식 (Mom Test, 연구 ≠ 영업)**:
- 미래 가정("$5 낼래요?")이 아니라 현재 행동·과거 통증 사건을 질문 → WTP를 *추론*.
- 진짜 WTP 신호 = 이미 돈·시간을 들여 해결책을 만든 사람.
- 인터뷰 중 Token Meter·가격·URL·"써보세요" unprompted 발화 금지
  ([[feedback_research_interview_vs_sales_pitch]] 정합). 상대가 먼저 물으면 그때만 한 줄.
- 가이드·결과 로그: `_workspace/wtp_validation_kakao.md`.

**판정 기준**: ~5명 ICP 인터뷰 중 강(强) 신호 3+ → Pro 가설 존속·M3 결제 트랙 검토 /
강 신호 0~1 → Pro 폐기·Free OSS 재포지셔닝 진지 검토.

**번복/종료 트리거**:
- 검증 라운드 종료 → 카톡 우회 자동 종료, [[D-031]] 원상복귀.
- 카톡 외 채널로 넓히려면 별도 결정 필요 (본 박제는 카톡 1채널 한정).

**관련 박제**: [[D-031]] 우회 대상 (비-매매 메타룰, 사용자 명시 우회 —
[[feedback_rule_integrity]] §우회 정합) / [[D-038]] Pro 기능 현황 /
[[feedback_research_interview_vs_sales_pitch]] 연구·영업 분리.

**개정 2026-05-19**: 방식을 'Mom Test 검증 인터뷰' → **'maker-share(내가 만든 도구 공유)
+ 답글에서 대화·반응 수집'**으로 고도화 (사용자 명시). 제품이 이미 빌드·배포된 상태
(post-build)라 idea 검증 인터뷰보다 maker-share가 적합 — dev 커뮤니티의 정상 공유
형식이라 양쪽 다 안 불편. 카톡 1채널·단발 범위는 불변. opener에 Pro·가격·가격페이지
URL 비노출 유지(npm 무료 OSS 링크만), 가격은 상대가 먼저 물을 때만 한 줄. 이 라운드
1차 판정 = **free 도구 pull 신호** (Pro WTP는 free가 당겨진 뒤 다음 라운드). 가이드 =
`_workspace/wtp_validation_kakao.md`.

---

## 향후 결정 보류 항목

| 번호 | 항목 | 결정 시점 |
|---|---|---|
| TBD-1 | 최종 제품명·도메인 | M1 시작 전 |
| TBD-2 | 자동 액션 기본 ON/OFF 정책 | M3 출시 시 |
| TBD-3 | 자동 모델 라우팅 (로컬↔클라우드) | M4 |
| TBD-4 | GPU 모니터링 OS 우선순위 (NVIDIA 우선?) | M4 |
| TBD-5 | 한국어 UI 지원 여부 | M6 |
| TBD-6 | 모바일 앱 출시 여부 | Year 2 |
| TBD-7 | API 공개 시점·정책 | Year 2 |
| TBD-8 | Polar → Stripe 전환 시점 | 유료 1,000명 |
| TBD-10 | Pro+ ($24) 출시 여부·시점 | M4-M6 게이트 검증 후 |
| TBD-11 | Pro $5 → $7 인상 시점 | Pro+ 미출시 시 M6+ |
| TBD-9 | 익명 벤치마크 DB API 수익화 | Year 3 |
