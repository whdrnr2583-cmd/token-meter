# MCP Directory 등재 Drafts (v0.1.1, 2026-05-13)

> 메타룰 정합: 발견 통로 확보 only. 마케팅 push X. PMF 게이트와 독립.
> 사용자 영어 장벽 박제 — paste-back 패턴.

---

## 단계 0: v0.1.1 npm patch publish (사용자 직접, 5분)

먼저 v0.1.1로 패치 (mcpName 필드 추가 반영). Windows PowerShell:

```powershell
cd <repo>
git add package.json CHANGELOG.md
git commit -m "feat(0.1.1): add mcpName for MCP Registry"
git push

npm publish --access public
# OTP 입력
```

publish 성공 후 검증:
```powershell
npm view @whdrnr2583/token-meter version  # → 0.1.1
```

git tag (release.yml 트리거):
```powershell
git tag v0.1.1
git push origin v0.1.1
```

---

## 단계 1: MCP Registry 공식 등재 (15분)

### 1-A. mcp-publisher CLI 설치

GitHub Releases에서 최신 binary 다운로드: https://github.com/modelcontextprotocol/registry/releases/latest

- Windows: `mcp-publisher_*_windows_amd64.zip`
- WSL/Linux: `mcp-publisher_*_linux_amd64.tar.gz`

PowerShell (Windows native):
```powershell
# 압축 해제 후 PATH 추가 (예: C:\tools\mcp-publisher\)
# 또는 mcp-publisher.exe를 C:\Windows\System32\에 복사
mcp-publisher.exe --help
```

WSL:
```bash
cd /tmp
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_<VERSION>_linux_amd64.tar.gz" | tar xz
sudo mv mcp-publisher /usr/local/bin/
mcp-publisher --help
```

### 1-B. server.json 생성

`token-pulse/` 디렉토리에서:
```powershell
mcp-publisher init
```

자동 생성된 `server.json`을 다음 내용으로 갱신:

```json
{
  "name": "io.github.whdrnr2583-cmd/token-meter",
  "description": "Local-first dashboard + MCP server for Claude Code and Codex token usage. Per-MCP/tool breakdown, session drill-down, hourly stats.",
  "version": "0.1.1",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@whdrnr2583/token-meter",
      "version": "0.1.1",
      "transport": { "type": "stdio" }
    }
  ],
  "repository": {
    "url": "https://github.com/whdrnr2583-cmd/token-meter",
    "source": "github"
  },
  "websiteUrl": "https://token-meter.dev"
}
```

### 1-C. GitHub OAuth 로그인

```powershell
mcp-publisher login github
```

- device code + URL 출력 → 브라우저로 GitHub 인증
- `whdrnr2583-cmd` 계정으로 인증

### 1-D. Publish

```powershell
mcp-publisher publish
```

성공 시 https://registry.modelcontextprotocol.io 에서 `io.github.whdrnr2583-cmd/token-meter` 검색 가능.

### 1-E. 검증

브라우저:
- https://registry.modelcontextprotocol.io 접속
- 검색창에 `token-meter` 입력
- listing 확인

박제 (`feedback_listing_vs_discovery.md`): URL by name 외에 search by keyword 검증 의무.

---

## ⚠️ 2026-05-13 1차 시도 실패 — 박제

첫 시도 실수 2건:
1. **fork 내 PR**: GitHub UI에서 base를 사용자 fork 자체로 설정 (`whdrnr2583-cmd/awesome-mcp-servers:main`). upstream punkpeye가 못 봄. → 닫음
2. **cross-fork PR 위치**: Ctrl+F Monitoring 검색을 못 해서 Social Media 섹션 (VK ↔ LinkedIn) 사이에 entry 추가됨. punkpeye 자동 bot이 `missing-glama` label 부착. → 닫음

**박제 학습 (D-030 권고)**:
- punkpeye/awesome-mcp-servers는 **Glama.ai 사전 등재 + score badge 의무** (~2024 정책). 단순 entry PR은 자동 `missing-glama` label + stale
- koreanpulse PR #5893 (5/5 open, 8일 stale) 사례가 증거
- 진입 순서: **Glama.ai 등재 → score badge URL 받기 → README entry에 badge 포함 → 정확한 위치 (Monitoring) → cross-fork PR**

## 단계 2 (개정): 5/20 W1 dogfood 후 일괄 재진행

### 2-A. Glama.ai 등재 (30분-1시간)

1. https://glama.ai 접속
2. 본인 GitHub 계정으로 로그인
3. Search 또는 Add → `@whdrnr2583/token-meter` 또는 GitHub repo URL 입력
4. Glama가 자동 indexing — npm 메타데이터 + GitHub README 분석
5. 또는 manual submission form (있다면) 작성
6. 등재 후 **score badge URL** 받음 (보통 `https://glama.ai/mcp/servers/@whdrnr2583/token-meter/badge`)

### 2-B. README entry 갱신 (Glama badge 포함)

기존 entry:
```markdown
- [whdrnr2583-cmd/token-meter](https://github.com/whdrnr2583-cmd/token-meter) 📇 🏠 - Local-first dashboard + MCP server for Claude Code and Codex token usage.
```

Glama badge 포함:
```markdown
- [whdrnr2583-cmd/token-meter](https://github.com/whdrnr2583-cmd/token-meter) [![smithery badge](https://glama.ai/mcp/servers/@whdrnr2583/token-meter/badge)](https://glama.ai/mcp/servers/@whdrnr2583/token-meter) 📇 🏠 - Local-first dashboard + MCP server for Claude Code and Codex token usage.
```

(다른 entries의 badge 형식 cross-check 후 최종 결정)

### 2-C. Fork sync (재진입 전)

1. https://github.com/whdrnr2583-cmd/awesome-mcp-servers 접속
2. "Sync fork" 클릭 → upstream 최신 main 반영
3. (필요 시 기존 branch `whdrnr2583-cmd-patch-1` 삭제 후 새 branch)

### 2-D. 정확한 위치에 추가 + cross-fork PR

GitHub UI에서 fork의 README 편집:
1. Ctrl+F `<a name="monitoring">` 검색 (📊 Monitoring 섹션)
2. 알파벳 위치에 entry 추가 (2-B의 갱신된 라인)
3. Commit → **Create a new branch + PR**
4. PR 생성 시 **반드시 cross-fork**:
   - 직접 URL: `https://github.com/punkpeye/awesome-mcp-servers/compare/main...whdrnr2583-cmd:awesome-mcp-servers:<new-branch>`
   - 또는 "compare across forks" 링크 → base: punkpeye / head: whdrnr2583-cmd 명시
5. PR title 정확히: `Add token-meter — Claude Code + Codex usage observability`
6. PR body는 위 §단계 2-C 영문 (Description 비우지 말 것)

### 2-E. PR 모니터링

- `missing-glama` label이 자동 제거되거나 (badge 포함 시), 또는 maintainer 직접 review
- merge 또는 추가 요청 (예: 카테고리 이동, badge 수정)

## 단계 2 박제 (1차 실패 5/13, 재진행 5/20)

### 2-A. Repo Fork

브라우저로 https://github.com/punkpeye/awesome-mcp-servers 접속 → 우측 상단 **Fork** 클릭 → `whdrnr2583-cmd/awesome-mcp-servers` 생성.

### 2-B. README 편집

Fork된 repo에서 `README.md` 열기 → 편집 모드 (연필 아이콘).

**Monitoring 카테고리 검색** (Ctrl+F: `<a name="monitoring">`):
```
📊 <a name="monitoring"></a>Monitoring
```

해당 섹션 내에 alphabetical 위치에 다음 entry 추가 (entries는 보통 알파벳순 정렬됨):

```markdown
- [whdrnr2583-cmd/token-meter](https://github.com/whdrnr2583-cmd/token-meter) 📇 🏠 - Local-first dashboard + MCP server for Claude Code and Codex token usage. Per-MCP/tool breakdown, session drill-down, hourly stats, USD cost estimates.
```

badge 의미:
- 📇 TypeScript
- 🏠 Local-first (사용자 PC, 클라우드 X)

### 2-C. Commit + PR

편집 화면 하단:
- Commit message: `Add token-meter (Claude Code + Codex usage observability)`
- Commit description (선택): `Local-first MCP server. npm: @whdrnr2583/token-meter`
- "Create a new branch for this commit and start a pull request" 선택
- Propose changes 클릭

PR 화면에서:
- **PR title**: `Add token-meter — Claude Code + Codex usage observability`
- **PR body** (paste-back, 영문):

```
Token Meter is a local-first dashboard + MCP server that parses the JSONL files
Claude Code and Codex already write to disk, and surfaces them as a real
dashboard: per-project, per-model, per-MCP-server, per-tool, per-hour usage
plus USD-equivalent cost estimates. The data never leaves the machine.

Highlights vs existing entries:
- Multi-vendor (Claude Code + Codex) in one view
- Per-MCP-server token + latency breakdown (the JSONL exposes `tool_use.name`
  with `mcp__<server>__<tool>` patterns)
- MCP server mode (`token-meter mcp`) so Claude Code itself can query the data
- MIT licensed core, no SDK, no proxy

npm: https://www.npmjs.com/package/@whdrnr2583/token-meter
Site: https://token-meter.dev
Docs: https://github.com/whdrnr2583-cmd/token-meter/blob/main/README.md

Placed under Monitoring (📊) — it's primarily a usage-observability tool, not a
generic developer tool. Happy to move to a different section if maintainers
prefer.

Badges:
- 📇 TypeScript
- 🏠 Local-first (no cloud dependency, no account required)
```

"Create pull request" 클릭.

### 2-D. 검증

- PR URL 받음 (예: https://github.com/punkpeye/awesome-mcp-servers/pull/####)
- maintainer 리뷰 대기 (보통 1-7일)
- merge되면 awesome-mcp-servers README에 노출

박제: search by keyword 검증 — `awesome-mcp-servers token-meter` Google 검색 5/20+ 시점.

---

## 단계 3: 응대 정책 (PR 코멘트 받았을 때)

영문 paste-back 필요 시 알려주세요. 카테고리 이동 / description 수정 / 추가 정보 요청 등.

**거부 받으면 (낮은 확률)**: 한국어로 사유 알려주시면 영문 응답 또는 다른 PR 옵션 (Developer Tools 등) 안내.

---

## 박제 (등재 후 갱신)

- [ ] v0.1.1 publish 시각: ____
- [ ] MCP Registry publish 시각: ____ (URL: ____)
- [ ] awesome-mcp-servers PR 번호: ____ (URL: ____)
- [ ] PR merged 시각: ____
- [ ] Registry / awesome list에서 검색 결과 노출 확인: ____
- [ ] 등재 후 npm 다운로드 증가 (1주 후 측정): ____
- [ ] 등재 후 GitHub Star 증가 (1주 후): ____

박제 학습 가치: 등재 시간 비용 30분 vs 다운로드/Star 증가 = ROI 계산 (`pmf_gate_progress.md` 갱신).
