# Token Meter — GEO citation tracking

GEO = AI 답변에 **인용되는가**. 온사이트(robots/sitemap/llms.txt/JSON-LD)는 완료 →
이제 레버는 *인용* (awesome-mcp PR 재제출 + HN/조코딩 발사 + GitHub).

각 엔진에서 **웹검색 ON** 상태로 아래 쿼리를 주 1회 던지고, Token Meter가 뜨는지 기록.
엔진: ChatGPT(search) · Perplexity · Claude(search) · Gemini.
점수: **C** = 링크와 함께 인용 / **M** = 이름만 언급 / **—** = 없음.

## 테스트 쿼리
1. What's the best tool to track Claude Code token usage and cost?
2. How do I see how many tokens my Claude Code sessions used?
3. Is there a local/offline dashboard for Codex and Claude Code spending?
4. MCP server to find which MCP tool eats the most tokens
5. open source Claude Code cost / spending tracker

## 로그
| date | engine | q# | C/M/— | cited URL / 메모 |
|------|--------|----|-------|------------------|
| 2026-05-24 | Claude+WebSearch | q1 | — | absent. ccusage(4.8k★)·Claude-Code-Usage-Monitor·MyTokenTracker 노출 |
| 2026-05-24 | Claude+WebSearch | q2 | — | absent. /usage·ccusage·Usage-Monitor |
| 2026-05-24 | Claude+WebSearch | q3 | — | absent. CodeBurn·ccusage·claude-usage·CodexBar·cc-lens (로컬 대시보드 다수) |
| 2026-05-24 | Claude+WebSearch | q4 | — | absent. MCP 토큰최적화 글만, 우리 툴 무관 |
| 2026-05-24 | Claude+WebSearch | q5 | — | absent. ccusage·Claude Usage Tracker·LiteLLM |
| | | | | **요약: 5/5 absent. 카테고리 포화(무료 OSS 다수, ccusage 지배). authority 0 → 불가시. 인용 외에 차별화도 과제.** |

## 주기 / 해석
- **주 1회.** 최신성 중요 (AI 콘텐츠 ~40%/월 감쇠, <30일 = 인용 3.2배).
- 재측정 트리거: awesome-mcp PR 머지, HN/조코딩 발사 직후.
- 목표: q1·q3(고-intent)부터 — → M → C 로 이동.
- ⚠️ ChatGPT 인용 = Bing 인덱싱 전제 → Bing Webmaster 제출(아래 B) 후 ~2-4주 뒤 반영.
