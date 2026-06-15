# Plan 3 — Production Subgraph Implementation Plan

**Prereq:** Plans 1 + 2 shipped.

**Goal:** Build the Production subgraph — `writer` (with grounding + urlContext), `resolve_citations` (deterministic), `render_html` (deterministic), `audit` (deterministic + LLM). Wire the refine loop (writer⇄audit, max 2 iterations). Compose into the root graph with HITL_2 interrupt.

**Architecture:** Writer uses Gemini grounding and produces structured `{diagnose, markup, citation_intents}`. A deterministic `resolve_citations` node follows vertex redirects, applies source policy, appends `## 資訊來源` Markdown. A deterministic `render_html` node converts Markdown to WP-ready HTML with shortcodes, the Bowtie FAQ widget, and inline JSON-LD. The `audit` node runs deterministic Python checks first (free + fast), then an LLM judgement pass, combines findings, and returns to writer with refine notes if any `must_fix=true` finding exists and `iteration < 2`.

---

## File structure (new + modified)

```
ai_content_tool_2/
├── content_tool/
│   ├── models/
│   │   ├── writer.py                   # NEW (WriterOutput, CitationIntent)
│   │   ├── audit.py                    # NEW (AuditFinding, AuditOutput)
│   │   ├── citation.py                 # NEW (ResolvedCitation)
│   │   └── persona.py                  # NEW (PersonaPack)
│   ├── agents/
│   │   ├── writer.py                   # NEW
│   │   ├── resolve_citations.py        # NEW
│   │   ├── render_html.py              # NEW
│   │   └── audit.py                    # NEW
│   ├── graph/
│   │   ├── production.py               # NEW
│   │   └── root.py                     # MODIFY (compose Production + HITL_2)
│   ├── db/models.py                    # MODIFY: drafts, citations, url_resolution_cache, renders, audit_runs
│   └── policy/
│       └── personas.py                 # NEW (load brand_voice YAML packs)
├── config/
│   └── personas/
│       └── bowtie-editor.yaml          # NEW
├── prompts/
│   ├── writer_small_refresh.md         # NEW (port from n8n)
│   ├── writer_full_rewrite.md          # NEW (port from n8n)
│   └── audit.md                        # NEW
├── migrations/versions/
│   ├── 0003_drafts_citations_url_cache.py    # NEW
│   ├── 0004_renders.py                 # NEW
│   └── 0005_audit_runs.py              # NEW
└── tests/
    ├── fixtures/
    │   ├── gemini_responses/
    │   │   ├── writer_small_refresh_ok.json
    │   │   ├── writer_full_rewrite_ok.json
    │   │   ├── audit_pass.json
    │   │   └── audit_fail.json
    │   └── markdown/
    │       ├── writer_sample.md
    │       └── writer_with_denied_citation.md
    ├── unit/
    │   ├── test_writer_schema.py
    │   ├── test_audit_schema.py
    │   ├── test_render_html.py
    │   └── test_audit_deterministic.py
    └── integration/
        ├── test_writer_node.py
        ├── test_resolve_citations_node.py
        ├── test_audit_node.py
        ├── test_production_refine_loop.py
        └── test_root_graph_e2e.py
```

---

### Task 1: Persona pack — bowtie-editor

**Files:**
- Create: `config/personas/bowtie-editor.yaml`, `content_tool/models/persona.py`, `content_tool/policy/personas.py`, `tests/unit/test_persona_load.py`

- [ ] **Step 1: Create `config/personas/bowtie-editor.yaml`**

```yaml
name: Bowtie 編輯
voice_rules:
  - 用字自然、清晰、專業
  - 避免空泛套話與過度推銷
  - 避免內地用語（信息、软件、网络、视频）
  - 優先使用香港讀者熟悉的詞彙與例子
banned_terms:
  - 信息          # use 資訊 instead
  - 软件          # use 軟件
  - 网络          # use 網絡
  - 视频          # use 影片
  - 优势          # use 優勢
  - 注释          # use 註解 / 註釋
required_phrasings:
  - "自願醫保"     # not 自愿医保
  - "強積金"       # not 强积金
  - "危疾保"
  - "扣稅"
disclaimer_templates:
  medical: "本文僅供參考，並非醫療建議。如有疑問請諮詢註冊醫生。"
  insurance: "本文僅供參考，實際保障條款以保單為準。"
tone_examples:
  good:
    - "如果你最近開始留意自願醫保扣稅，以下幾點值得先弄清楚..."
    - "簡單來說，第三期的存活率比想像中高，但前提是要..."
  bad:
    - "本文将为您详细介绍..."
    - "希望本文能够帮助到大家。"
```

- [ ] **Step 2: Implement `content_tool/models/persona.py`**

```python
from pydantic import BaseModel


class PersonaPack(BaseModel):
    name: str
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, str]
    tone_examples: dict[str, list[str]]

    def to_prompt_block(self) -> str:
        """Render as a Chinese-language persona block for system prompts."""
        good = "\n".join(f"  好：{x}" for x in self.tone_examples.get("good", []))
        bad = "\n".join(f"  壞：{x}" for x in self.tone_examples.get("bad", []))
        return (
            f"# 撰稿人格\n"
            f"角色：{self.name}\n"
            f"語氣規則：\n" + "\n".join(f"- {r}" for r in self.voice_rules) + "\n"
            f"避免使用的字詞：{', '.join(self.banned_terms)}\n"
            f"必須採用的香港用語：{', '.join(self.required_phrasings)}\n"
            f"語氣示例：\n{good}\n{bad}\n"
        )
```

- [ ] **Step 3: Implement `content_tool/policy/personas.py`**

```python
from pathlib import Path

import yaml

from content_tool.models.persona import PersonaPack


def load_persona(name: str, base_dir: Path = Path("config/personas")) -> PersonaPack:
    path = base_dir / f"{name}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return PersonaPack.model_validate(raw)
```

- [ ] **Step 4: Write test — `tests/unit/test_persona_load.py`**

```python
from content_tool.policy.personas import load_persona


def test_bowtie_editor_loads():
    p = load_persona("bowtie-editor")
    assert "信息" in p.banned_terms
    assert "自願醫保" in p.required_phrasings
    block = p.to_prompt_block()
    assert "撰稿人格" in block
    assert "Bowtie 編輯" in block
```

- [ ] **Step 5: Run + commit**

Run: `pytest tests/unit/test_persona_load.py -v`
Expected: PASS

```bash
git add config/personas/ content_tool/models/persona.py content_tool/policy/personas.py tests/unit/test_persona_load.py
git commit -m "feat: persona packs (bowtie-editor) with prompt-block rendering"
```

---

### Task 2: Writer + Audit Pydantic schemas

**Files:**
- Create: `content_tool/models/writer.py`, `content_tool/models/audit.py`, `content_tool/models/citation.py`
- Create: `tests/unit/test_writer_schema.py`, `tests/unit/test_audit_schema.py`
- Create: `tests/fixtures/gemini_responses/writer_small_refresh_ok.json`, `audit_pass.json`, `audit_fail.json`

- [ ] **Step 1: Create fixtures**

`tests/fixtures/gemini_responses/writer_small_refresh_ok.json`:
```json
{
  "diagnose": "本次更新主要為大腸癌存活率與篩查資格的數字刷新，並新增 MSI-H 標靶相關 FAQ。保留 70% 以上原文結構。",
  "markup": "# 大腸癌：症狀、篩查、治療與保險指南（2026）\n%%meta desc=了解大腸癌的早期症狀、篩查方法與香港保險保障。%%\n\n大腸癌是香港常見的癌症之一...\n\n%%adv_panel id=1%%\n\n## 大腸癌篩查方法\n大便潛血測試...\n\n%%page_widget id=2%%\n\n## 常見問題\n%%acf_faq type=q%%\n篩查資格是什麼？\n%%acf_faq type=a%%\n50 至 75 歲香港居民...\n%%end%%\n",
  "citation_intents": [
    {"claim": "篩查資格 50-75 歲", "why_cited": "驗證資格年齡"},
    {"claim": "第三期五年存活率約 68.7%", "why_cited": "核實 2026 數字"}
  ]
}
```

`tests/fixtures/gemini_responses/audit_pass.json`:
```json
{
  "overall_pass": true,
  "severity_summary": {"high": 0, "medium": 0, "low": 1},
  "findings": [
    {"id": "f1", "category": "voice", "severity": "low", "location": "intro", "issue": "可以更口語", "suggested_fix": "首段加一句直接問題", "must_fix": false}
  ]
}
```

`tests/fixtures/gemini_responses/audit_fail.json`:
```json
{
  "overall_pass": false,
  "severity_summary": {"high": 1, "medium": 1, "low": 0},
  "findings": [
    {"id": "f1", "category": "citation", "severity": "high", "location": "intro", "issue": "引用 bowtie.com.hk", "suggested_fix": "改用 ha.org.hk", "must_fix": true},
    {"id": "f2", "category": "coverage", "severity": "medium", "location": "section: 治療", "issue": "未提及 MSI-H", "suggested_fix": "新增段落", "must_fix": false}
  ]
}
```

- [ ] **Step 2: Implement `content_tool/models/writer.py`**

```python
from pydantic import BaseModel


class CitationIntent(BaseModel):
    claim: str
    why_cited: str


class WriterOutput(BaseModel):
    diagnose: str
    markup: str
    citation_intents: list[CitationIntent]
```

- [ ] **Step 3: Implement `content_tool/models/audit.py`**

```python
from typing import Literal

from pydantic import BaseModel


AuditCategory = Literal["format", "compliance", "voice", "coverage", "safety", "citation"]
Severity = Literal["high", "medium", "low"]


class AuditFinding(BaseModel):
    id: str
    category: AuditCategory
    severity: Severity
    location: str
    issue: str
    suggested_fix: str
    must_fix: bool


class SeveritySummary(BaseModel):
    high: int
    medium: int
    low: int


class AuditOutput(BaseModel):
    overall_pass: bool
    severity_summary: SeveritySummary
    findings: list[AuditFinding]

    def has_blocking(self) -> bool:
        return self.severity_summary.high > 0 or any(f.must_fix for f in self.findings)
```

- [ ] **Step 4: Implement `content_tool/models/citation.py`**

```python
from typing import Literal

from pydantic import BaseModel


PolicyDecision = Literal["allowed", "denied", "community_exception"]


class ResolvedCitation(BaseModel):
    chunk_idx: int
    vertex_uri: str
    final_url: str | None
    domain: str | None
    title: str | None
    policy_decision: PolicyDecision
    denied_reason: str | None = None
    was_displayed: bool = False
    resolution_error: str | None = None
```

- [ ] **Step 5: Write + run schema tests**

`tests/unit/test_writer_schema.py`:
```python
import json
from pathlib import Path

from content_tool.models.writer import WriterOutput


def test_writer_output_parses():
    data = json.loads(Path("tests/fixtures/gemini_responses/writer_small_refresh_ok.json").read_text(encoding="utf-8"))
    out = WriterOutput.model_validate(data)
    assert "%%adv_panel id=1%%" in out.markup
    assert len(out.citation_intents) == 2
```

`tests/unit/test_audit_schema.py`:
```python
import json
from pathlib import Path

from content_tool.models.audit import AuditOutput


def test_pass_blocking_is_false():
    data = json.loads(Path("tests/fixtures/gemini_responses/audit_pass.json").read_text(encoding="utf-8"))
    a = AuditOutput.model_validate(data)
    assert a.overall_pass
    assert not a.has_blocking()


def test_fail_blocking_is_true():
    data = json.loads(Path("tests/fixtures/gemini_responses/audit_fail.json").read_text(encoding="utf-8"))
    a = AuditOutput.model_validate(data)
    assert not a.overall_pass
    assert a.has_blocking()
```

Run: `pytest tests/unit/test_writer_schema.py tests/unit/test_audit_schema.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add content_tool/models/writer.py content_tool/models/audit.py content_tool/models/citation.py tests/unit/test_writer_schema.py tests/unit/test_audit_schema.py tests/fixtures/gemini_responses/
git commit -m "feat: Pydantic schemas for Writer, Audit, ResolvedCitation"
```

---

### Task 3: Writer prompts (small_refresh + full_rewrite + audit)

**Files:**
- Create: `prompts/writer_small_refresh.md`, `prompts/writer_full_rewrite.md`, `prompts/audit.md`

- [ ] **Step 1: Create `prompts/writer_small_refresh.md`** (port verbatim from n8n with the additions in spec §A.2)

```markdown
{persona_block}

你是香港網誌內容更新編輯。你的任務是根據現有文章與 content gap analysis，做一篇 small refresh 版本的完整文章更新稿，目標是在不作不必要大改的前提下，提升內容競爭力，爭取 outrank Google 香港繁體中文 Organic top 5。

今天是 {today_date}

你會收到：
- topic
- focus_keywords
- existing_article_URL
- existing_article_markdown
- outline (writer 的最終大綱)
- acf_adv_id
- acf_widget_id
- gap_analysis
- (若有) refine_notes：上一輪 audit 必須處理的問題

目標：
- 保留現有文章 70% 以上原有結構與內容骨幹
- 整體改動量以不超過約 30% 為原則
- 只補新資訊 / 新數字 / 新政策 / 新 FAQ / 新例子 / 新比較 / 新步驟
- 在必要時刪除明顯過時、錯誤、重複或拖慢可讀性的段落
- 令文章更完整、更適合香港讀者、更可信、更易被搜尋系統及 AI 擷取重點

引用與資料來源規則：
- 主動使用 googleSearch 與 urlContext 工具核實時間敏感資訊（年份、收費、政策、法規、資格、流程、醫療或保險條款）
- 不可引用 bowtie.com.hk 或任何其他保險公司網站作為資料來源
- 首選來源：.gov.hk / .gov / .edu / .edu.hk / WHO / 香港保險業監管局 / IFEC / 醫管局
- 例外：當 topic_category 為社區回應 / 用戶經驗 / 社會討論時，可引用 reddit / lihkg / hk.discuss 等社區來源
- 引用必須在文中自然 ground 到具體段落
- 不要在 markup 中手寫 `## 資訊來源` 區塊；該區塊由後處理流程根據 grounding metadata 自動生成

硬性規則：
1. H1 只可 small tweak，不可完全改題。
2. meta description 可以重寫。
3. H2 wording 原則上不可改；只有在明顯過時、不準確、與最新 intent 不符時才可改。
4. shortcode 位置：首段後必須有 `%%adv_panel id=acf_adv_id%%`；FAQ 區塊前必須有 `%%page_widget id=acf_widget_id%%`。
5. FAQ 區塊以下列 shortcode 表示，每個 shortcode 必須獨立成行：
   ```
   %%acf_faq type=q%%
   問題
   %%acf_faq type=a%%
   答案
   %%end%%
   ```
6. 不可捏造數字、年份、法例、醫療或保險條款；如未能核實，使用保守中性寫法。

寫作要求：
1. 先理解 existing_article_markdown，再根據 gap_analysis 與 outline 補足缺口。
2. 優先處理 gap_analysis.update_plan 的 must_add / must_update / must_remove / must_reorder / faq_to_add / facts_to_verify。
3. 所有內容使用香港繁體中文。
4. 每個 H2 之後，先用 1 段直接回答該 heading，優先 2 至 4 句講清核心答案。
5. 按內容選擇最適合的呈現方式：定義/結論用段落；條件/資格用項目列表；流程/步驟用編號列表；比較/收費用 Markdown 表格。
6. 標題下第一段要先答題，首句盡量點名該 heading 的核心概念。

SEO 及 AI Search 優化要求：
1. H1 自然、清楚、具搜尋意圖，整合 focus_keywords 及語義相關字詞，但不可堆砌。
2. meta description 具體、自然、可讀。
3. 內文自然覆蓋同義詞、近義詞、常見問法。
4. 優先寫出定義、直接答案、條件、步驟、比較、例外與注意事項。

如有 refine_notes：
- 必須逐項處理 refine_notes 列出的 must_fix 問題
- 不可改動仍然合格的段落
- 完成後在 diagnose 中說明你處理了哪些 refine_notes

輸出格式要求：
1. diagnose 使用香港繁體中文，約 100 字，說明為何採取此 small refresh 路線。
2. markup 只可輸出最終完整文章 Markdown，不可輸出任何解說、前言、註解、JSON code fence。
3. markup 內容順序：
   - 第一行：# H1 標題
   - 第二行：%%meta desc=...%%
   - 正文首段
   - %%adv_panel id=acf_adv_id%%
   - 餘下正文
   - %%page_widget id=acf_widget_id%%
   - ## 常見問題
   - FAQ shortcodes
4. 不要使用 HTML 標籤，不要使用 Markdown code fence。
5. citation_intents 必須列出你引用了什麼 claim 及為何引用。

只輸出符合 schema 的 JSON。
```

- [ ] **Step 2: Create `prompts/writer_full_rewrite.md`**

Same skeleton as small_refresh, but the body reflects spec §A.3 (full restructure allowed, can rewrite H1/H2/H3/order; only required to preserve topic/keywords/acf IDs/verifiable facts). Reuse the same 引用與資料來源規則, shortcode rules, FAQ shortcodes, and output format sections verbatim. Differences:

- Replace "保留現有文章 70% 以上原有結構與內容骨幹" with "把 existing_article_markdown 視為背景參考，不是主要結構約束"
- Replace H1/H2 "small tweak" rules with "可重寫 H1、meta description、H2、H3、section order、正文邏輯與 FAQ"
- diagnose 描述為何需要 full rewrite

(Engineer: produce the file by editing a copy of `writer_small_refresh.md` and updating those sections.)

- [ ] **Step 3: Create `prompts/audit.md`**

```markdown
{persona_block}

你是 Bowtie 內容審核員，獨立審核已撰寫的文章。你不會重寫文章，只會列出問題。

今天是 {today_date}

你會收到：
- final_markup (已 render 為 HTML 後的 post body)
- gap_analysis.update_plan
- citation_intents（writer 自報引用了什麼）
- citations（系統解析後的最終引用清單，包含 policy_decision）
- 持人格 (persona pack)
- 系統已完成的 deterministic 檢查結果（regex 格式、shortcode 位置、FAQPage schema、policy cross-check）

任務：
1. 評估 claim 安全性：是否捏造數字、年份、法例、醫療或保險條款。
2. 評估品牌語氣是否符合 persona pack：banned_terms / required_phrasings / tone_examples。
3. 評估香港在地化：是否出現內地用語、不通順的繁中、文化錯位。
4. 評估 coverage：gap_analysis.update_plan.must_add / must_update / must_remove / faq_to_add / facts_to_verify 是否已處理；若以 deterministic 啟發式判斷為「需 LLM 判斷」的條目，需由你判斷。
5. 評估 citation_intents 是否被 allowed citations 支持。
6. severity 分級：
   - high：捏造事實、引用被拒絕來源、shortcode 結構錯誤、JSON-LD 不合法
   - medium：覆蓋率不足、語氣不符、缺少 disclaimer
   - low：可改善但不影響上線

輸出要求：
- 嚴格依照 schema 輸出 JSON
- 每個 finding 必須附 location（section/heading 名或行號）與具體 suggested_fix
- 不要重新撰寫文章
- must_fix=true 只可用於 high severity 或屬於合規/citation 必修問題
- overall_pass = (severity_summary.high == 0) AND (沒有 must_fix=true)
```

- [ ] **Step 4: Commit**

```bash
git add prompts/writer_small_refresh.md prompts/writer_full_rewrite.md prompts/audit.md
git commit -m "feat: writer (small_refresh + full_rewrite) + audit system prompts"
```

---

### Task 4: drafts + citations + url_resolution_cache + renders + audit_runs tables

**Files:**
- Modify: `content_tool/db/models.py`
- Create: `migrations/versions/0003_drafts_citations_url_cache.py`
- Create: `migrations/versions/0004_renders.py`
- Create: `migrations/versions/0005_audit_runs.py`

- [ ] **Step 1: Append ORM models to `content_tool/db/models.py`**

```python
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import TIMESTAMP, Boolean, ForeignKey, Integer, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column


class Draft(Base):
    __tablename__ = "drafts"
    __table_args__ = (UniqueConstraint("run_id", "iteration"), {"schema": "content_tool"})

    draft_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True),
                                         ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"),
                                         nullable=False)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    diagnose: Mapped[str] = mapped_column(String, nullable=False)
    markup_raw: Mapped[str] = mapped_column(String, nullable=False)
    final_markup: Mapped[str | None] = mapped_column(String)
    citation_intents: Mapped[list] = mapped_column(JSONB, nullable=False)
    grounding_chunks: Mapped[list | None] = mapped_column(JSONB)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    thinking_tokens: Mapped[int | None]
    latency_ms: Mapped[int | None]


class Citation(Base):
    __tablename__ = "citations"

    citation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    draft_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True),
                                           ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
                                           nullable=False)
    chunk_idx: Mapped[int]
    vertex_uri: Mapped[str] = mapped_column(String, nullable=False)
    final_url: Mapped[str | None] = mapped_column(String)
    domain: Mapped[str | None] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    policy_decision: Mapped[str] = mapped_column(String, nullable=False)
    denied_reason: Mapped[str | None] = mapped_column(String)
    was_displayed: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution_error: Mapped[str | None] = mapped_column(String)
    resolved_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))


class UrlResolutionCache(Base):
    __tablename__ = "url_resolution_cache"

    vertex_uri: Mapped[str] = mapped_column(String, primary_key=True)
    final_url: Mapped[str | None] = mapped_column(String)
    domain: Mapped[str | None] = mapped_column(String)
    resolved_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    error: Mapped[str | None] = mapped_column(String)


class Render(Base):
    __tablename__ = "renders"

    render_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    draft_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True),
                                           ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
                                           nullable=False)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    seo_title: Mapped[str] = mapped_column(String, nullable=False)
    meta_description: Mapped[str] = mapped_column(String, nullable=False)
    html_body: Mapped[str] = mapped_column(String, nullable=False)
    faq_schema_jsonld: Mapped[dict | None] = mapped_column(JSONB)
    excerpt_suggestion: Mapped[str | None] = mapped_column(String)
    slug_suggestion: Mapped[str | None] = mapped_column(String)


class AuditRun(Base):
    __tablename__ = "audit_runs"

    audit_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    draft_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True),
                                           ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
                                           nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    overall_pass: Mapped[bool]
    severity_high: Mapped[int] = mapped_column(default=0)
    severity_medium: Mapped[int] = mapped_column(default=0)
    severity_low: Mapped[int] = mapped_column(default=0)
    llm_findings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    deterministic_findings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    latency_ms: Mapped[int | None]
```

- [ ] **Step 2: Create migration `migrations/versions/0003_drafts_citations_url_cache.py`**

```python
"""drafts + citations + url_resolution_cache

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    op.create_table(
        "drafts",
        sa.Column("draft_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), nullable=False),
        sa.Column("iteration", sa.Integer, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("diagnose", sa.String, nullable=False),
        sa.Column("markup_raw", sa.String, nullable=False),
        sa.Column("final_markup", sa.String),
        sa.Column("citation_intents", postgresql.JSONB, nullable=False),
        sa.Column("grounding_chunks", postgresql.JSONB),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("thinking_tokens", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        sa.UniqueConstraint("run_id", "iteration"),
        schema="content_tool",
    )
    op.create_table(
        "citations",
        sa.Column("citation_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_idx", sa.Integer),
        sa.Column("vertex_uri", sa.String, nullable=False),
        sa.Column("final_url", sa.String),
        sa.Column("domain", sa.String),
        sa.Column("title", sa.String),
        sa.Column("policy_decision", sa.String, nullable=False),
        sa.Column("denied_reason", sa.String),
        sa.Column("was_displayed", sa.Boolean, server_default=sa.text("false")),
        sa.Column("resolution_error", sa.String),
        sa.Column("resolved_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        schema="content_tool",
    )
    op.create_index("citations_draft_id_idx", "citations", ["draft_id"], schema="content_tool")
    op.create_table(
        "url_resolution_cache",
        sa.Column("vertex_uri", sa.String, primary_key=True),
        sa.Column("final_url", sa.String),
        sa.Column("domain", sa.String),
        sa.Column("resolved_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("error", sa.String),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("url_resolution_cache", schema="content_tool")
    op.drop_table("citations", schema="content_tool")
    op.drop_table("drafts", schema="content_tool")
```

- [ ] **Step 3: Create migration `0004_renders.py`**

```python
"""renders

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"


def upgrade() -> None:
    op.create_table(
        "renders",
        sa.Column("render_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("seo_title", sa.String, nullable=False),
        sa.Column("meta_description", sa.String, nullable=False),
        sa.Column("html_body", sa.String, nullable=False),
        sa.Column("faq_schema_jsonld", postgresql.JSONB),
        sa.Column("excerpt_suggestion", sa.String),
        sa.Column("slug_suggestion", sa.String),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("renders", schema="content_tool")
```

- [ ] **Step 4: Create migration `0005_audit_runs.py`**

```python
"""audit_runs

Revision ID: 0005
Revises: 0004
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"


def upgrade() -> None:
    op.create_table(
        "audit_runs",
        sa.Column("audit_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.drafts.draft_id", ondelete="CASCADE"),
                  nullable=False, unique=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("overall_pass", sa.Boolean, nullable=False),
        sa.Column("severity_high", sa.Integer, server_default="0"),
        sa.Column("severity_medium", sa.Integer, server_default="0"),
        sa.Column("severity_low", sa.Integer, server_default="0"),
        sa.Column("llm_findings", postgresql.JSONB, nullable=False),
        sa.Column("deterministic_findings", postgresql.JSONB, nullable=False),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("audit_runs", schema="content_tool")
```

- [ ] **Step 5: Apply + commit**

```bash
alembic upgrade head
git add content_tool/db/models.py migrations/versions/0003_drafts_citations_url_cache.py migrations/versions/0004_renders.py migrations/versions/0005_audit_runs.py
git commit -m "feat(db): drafts + citations + url cache + renders + audit_runs"
```

---

### Task 5: Writer node

**Files:**
- Create: `content_tool/agents/writer.py`, `tests/integration/test_writer_node.py`

- [ ] **Step 1: Write failing test — `tests/integration/test_writer_node.py`**

```python
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.writer import run_writer
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_writer_writes_draft_iteration_0(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="production",
        article_url="https://e.com", topic="大腸癌", keywords=["大腸癌"], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
    ))
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="# old"))
    db_session.add(GapAnalysisRow(
        run_id=run_id, model="gemini-3.5-flash", thinking_level="high",
        payload=json.loads(Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")),
    ))
    db_session.add(OutlineRow(
        run_id=run_id, payload=json.loads(Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")),
    ))
    await db_session.commit()

    canned = json.loads(Path("tests/fixtures/gemini_responses/writer_small_refresh_ok.json").read_text(encoding="utf-8"))
    gemini = FakeGeminiClient(canned_responses={"writer": canned})

    draft = await run_writer(
        session=db_session, gemini=gemini, run_id=run_id, iteration=0,
        today=date(2026, 5, 21), refine_notes=None,
    )

    assert draft.iteration == 0
    assert "%%adv_panel id=1%%" in draft.markup_raw

    row = (await db_session.execute(select(Draft).where(Draft.run_id == run_id))).scalar_one()
    assert row.iteration == 0
    assert "大腸癌" in row.markup_raw
```

- [ ] **Step 2: Implement `content_tool/agents/writer.py`**

```python
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.writer import WriterOutput
from content_tool.policy.personas import load_persona


PROMPT_PATHS = {
    "small_refresh": Path("prompts/writer_small_refresh.md"),
    "full_rewrite": Path("prompts/writer_full_rewrite.md"),
}


@dataclass
class WriterRunResult:
    iteration: int
    diagnose: str
    markup_raw: str
    citation_intents: list[dict]
    grounding_chunks: list[dict] | None
    draft_id: UUID


def build_system_prompt(route: str, persona_name: str, today: date) -> str:
    template = PROMPT_PATHS[route].read_text(encoding="utf-8")
    persona = load_persona(persona_name)
    return template.replace("{persona_block}", persona.to_prompt_block()).replace("{today_date}", today.isoformat())


def build_user_prompt(
    *,
    run: Run, gap_analysis: dict, outline: dict, existing_markdown: str,
    refine_notes: list[dict] | None,
) -> str:
    import json as _j
    base = (
        f"topic: {run.topic}\n"
        f"focus_keywords: {', '.join(run.keywords)}\n"
        f"existing_article_URL: {run.article_url}\n"
        f"acf_adv_id: {run.acf_adv_id}\n"
        f"acf_widget_id: {run.acf_widget_id}\n"
        f"topic_category: {run.topic_category or 'N/A'}\n\n"
        f"# outline\n{_j.dumps(outline, ensure_ascii=False)}\n\n"
        f"# gap_analysis\n{_j.dumps(gap_analysis, ensure_ascii=False)}\n\n"
        f"# existing_article_markdown\n{existing_markdown}\n"
    )
    if refine_notes:
        base += (
            f"\n# refine_notes（上一輪 audit 必修問題）\n"
            f"{_j.dumps(refine_notes, ensure_ascii=False)}\n"
        )
    return base


async def run_writer(
    *,
    session: AsyncSession, gemini: GeminiClient, run_id: UUID,
    iteration: int, today: date, refine_notes: list[dict] | None,
) -> WriterRunResult:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    fa = (await session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))).scalar_one()
    ga = (await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))).scalar_one()
    o = (await session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))).scalar_one()

    sys_prompt = build_system_prompt(run.chosen_route, run.persona, today)
    user_prompt = build_user_prompt(
        run=run, gap_analysis=ga.payload, outline=o.payload,
        existing_markdown=fa.markdown, refine_notes=refine_notes,
    )

    result = await gemini.generate(
        agent="writer", system_prompt=sys_prompt, user_prompt=user_prompt,
        response_schema=WriterOutput.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )
    out = WriterOutput.model_validate(result.parsed)

    draft = Draft(
        run_id=run_id, iteration=iteration,
        diagnose=out.diagnose, markup_raw=out.markup,
        citation_intents=[c.model_dump() for c in out.citation_intents],
        grounding_chunks=result.grounding_chunks,
        tokens_in=result.tokens_in, tokens_out=result.tokens_out,
        thinking_tokens=result.thinking_tokens, latency_ms=result.latency_ms,
    )
    session.add(draft)
    await session.commit()
    await session.refresh(draft)

    return WriterRunResult(
        iteration=iteration, diagnose=out.diagnose, markup_raw=out.markup,
        citation_intents=[c.model_dump() for c in out.citation_intents],
        grounding_chunks=result.grounding_chunks, draft_id=draft.draft_id,
    )
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/integration/test_writer_node.py -v`
Expected: PASS

```bash
git add content_tool/agents/writer.py tests/integration/test_writer_node.py
git commit -m "feat: writer node with persona injection and refine-loop support"
```

---

### Task 6: URL resolver + cache

**Files:**
- Create: `content_tool/agents/url_resolver.py`
- Create: `tests/unit/test_url_resolver.py`

- [ ] **Step 1: Write failing test**

```python
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import respx
from httpx import Response

from content_tool.agents.url_resolver import UrlResolver
from content_tool.db.models import UrlResolutionCache


@pytest.mark.asyncio
async def test_resolves_vertex_redirect(db_session):
    vertex = "https://vertexaisearch.cloud.google.com/abc123"
    final = "https://www.ia.org.hk/tc/about-us/role.html"

    resolver = UrlResolver(session=db_session, timeout=5.0)

    with respx.mock(assert_all_called=True) as router:
        router.head(vertex).mock(return_value=Response(302, headers={"Location": final}))
        router.head(final).mock(return_value=Response(200))
        resolved = await resolver.resolve(vertex)

    assert resolved.final_url == final
    assert resolved.domain == "ia.org.hk"


@pytest.mark.asyncio
async def test_uses_cache_on_second_call(db_session):
    vertex = "https://vertexaisearch.cloud.google.com/cached"
    db_session.add(UrlResolutionCache(
        vertex_uri=vertex, final_url="https://cached.gov.hk/x", domain="cached.gov.hk",
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    ))
    await db_session.commit()

    resolver = UrlResolver(session=db_session, timeout=5.0)
    # No respx mocks — should hit cache only
    resolved = await resolver.resolve(vertex)
    assert resolved.final_url == "https://cached.gov.hk/x"
```

- [ ] **Step 2: Implement `content_tool/agents/url_resolver.py`**

```python
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
import tldextract
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import UrlResolutionCache


@dataclass
class ResolvedUrl:
    vertex_uri: str
    final_url: str | None
    domain: str | None
    error: str | None = None


class UrlResolver:
    def __init__(self, session: AsyncSession, timeout: float = 5.0,
                 ttl_days: int = 7, client: httpx.AsyncClient | None = None) -> None:
        self._session = session
        self._timeout = timeout
        self._ttl = timedelta(days=ttl_days)
        self._client = client

    async def resolve(self, vertex_uri: str) -> ResolvedUrl:
        # Cache lookup
        row = (await self._session.execute(
            select(UrlResolutionCache).where(UrlResolutionCache.vertex_uri == vertex_uri)
        )).scalar_one_or_none()
        if row and row.expires_at > datetime.now(timezone.utc):
            return ResolvedUrl(vertex_uri, row.final_url, row.domain, row.error)

        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout, follow_redirects=True)
        try:
            try:
                resp = await client.head(vertex_uri)
                final = str(resp.url)
                ext = tldextract.extract(final)
                domain = f"{ext.domain}.{ext.suffix}".lower() if ext.suffix else final
                error = None
            except Exception as e:  # noqa: BLE001
                final = None
                domain = None
                error = str(e)

            stmt = insert(UrlResolutionCache).values(
                vertex_uri=vertex_uri, final_url=final, domain=domain, error=error,
                expires_at=datetime.now(timezone.utc) + self._ttl,
            ).on_conflict_do_update(
                index_elements=["vertex_uri"],
                set_={"final_url": final, "domain": domain, "error": error,
                      "resolved_at": datetime.now(timezone.utc),
                      "expires_at": datetime.now(timezone.utc) + self._ttl},
            )
            await self._session.execute(stmt)
            await self._session.commit()
            return ResolvedUrl(vertex_uri, final, domain, error)
        finally:
            if own:
                await client.aclose()
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/unit/test_url_resolver.py -v`
Expected: PASS

```bash
git add content_tool/agents/url_resolver.py tests/unit/test_url_resolver.py
git commit -m "feat: URL resolver with Postgres cache"
```

---

### Task 7: resolve_citations node

**Files:**
- Create: `content_tool/agents/resolve_citations.py`, `tests/integration/test_resolve_citations_node.py`

- [ ] **Step 1: Write failing test**

```python
from datetime import date
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.agents.resolve_citations import run_resolve_citations
from content_tool.db.models import Citation, Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run


@pytest.mark.asyncio
async def test_drops_denied_sources(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="production",
        article_url="https://e.com", topic="x", keywords=[], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
    ))
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    draft = Draft(
        run_id=run_id, iteration=0, diagnose="d", markup_raw="# H1\nbody\n",
        citation_intents=[],
        grounding_chunks=[
            {"web": {"uri": "https://vertexaisearch.cloud.google.com/a", "title": "Bowtie"}},
            {"web": {"uri": "https://vertexaisearch.cloud.google.com/b", "title": "IA"}},
        ],
    )
    db_session.add(draft)
    await db_session.commit()

    with respx.mock(assert_all_called=True) as router:
        router.head("https://vertexaisearch.cloud.google.com/a").mock(
            return_value=Response(302, headers={"Location": "https://www.bowtie.com.hk/x"})
        )
        router.head("https://www.bowtie.com.hk/x").mock(return_value=Response(200))
        router.head("https://vertexaisearch.cloud.google.com/b").mock(
            return_value=Response(302, headers={"Location": "https://www.ia.org.hk/y"})
        )
        router.head("https://www.ia.org.hk/y").mock(return_value=Response(200))

        result = await run_resolve_citations(session=db_session, draft_id=draft.draft_id, topic_category=None)

    citations = (await db_session.execute(select(Citation).where(Citation.draft_id == draft.draft_id))).scalars().all()
    bowtie = next(c for c in citations if c.domain == "bowtie.com.hk")
    ia = next(c for c in citations if c.domain == "ia.org.hk")

    assert bowtie.policy_decision == "denied"
    assert bowtie.denied_reason == "bowtie_owned"
    assert bowtie.was_displayed is False
    assert ia.policy_decision == "allowed"
    assert ia.was_displayed is True

    assert "## 資訊來源" in result["final_markup"]
    assert "ia.org.hk" in result["final_markup"]
    assert "bowtie.com.hk" not in result["final_markup"]
```

- [ ] **Step 2: Implement `content_tool/agents/resolve_citations.py`**

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.agents.url_resolver import UrlResolver
from content_tool.db.models import Citation, Draft
from content_tool.policy.source_policy import SourcePolicy


_DEFAULT_POLICY_PATH = Path("config/source_policy.yaml")


def _build_sources_md(allowed: list[tuple[str, str]]) -> str:
    """allowed = [(domain, final_url), ...] in display order."""
    if not allowed:
        return ""
    lines = ["", "## 資訊來源"]
    for i, (domain, url) in enumerate(allowed, 1):
        lines.append(f"{i}. [{domain}]({url})")
    return "\n".join(lines) + "\n"


async def run_resolve_citations(
    *,
    session: AsyncSession, draft_id: UUID, topic_category: str | None,
    policy_path: Path = _DEFAULT_POLICY_PATH,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    draft = (await session.execute(select(Draft).where(Draft.draft_id == draft_id))).scalar_one()
    policy = SourcePolicy.load_from(policy_path)
    resolver = UrlResolver(session=session, client=client)

    allowed_for_display: list[tuple[str, str]] = []

    for idx, chunk in enumerate(draft.grounding_chunks or []):
        web = chunk.get("web") or {}
        vertex_uri = web.get("uri")
        title = web.get("title")
        if not vertex_uri:
            continue

        resolved = await resolver.resolve(vertex_uri)
        domain = resolved.domain
        if domain:
            decision = policy.evaluate(domain, topic_category=topic_category)
        else:
            decision = type("D", (), {"decision": "denied", "reason": "other"})()  # tiny shim
        was_displayed = decision.decision in {"allowed", "community_exception"} and resolved.final_url is not None

        session.add(Citation(
            draft_id=draft_id, chunk_idx=idx, vertex_uri=vertex_uri,
            final_url=resolved.final_url, domain=domain, title=title,
            policy_decision=decision.decision, denied_reason=getattr(decision, "reason", None),
            was_displayed=was_displayed, resolution_error=resolved.error,
        ))
        if was_displayed and resolved.final_url:
            allowed_for_display.append((domain, resolved.final_url))

    sources_md = _build_sources_md(allowed_for_display)
    final_markup = draft.markup_raw.rstrip() + "\n" + sources_md

    await session.execute(update(Draft).where(Draft.draft_id == draft_id).values(final_markup=final_markup))
    await session.commit()

    return {"final_markup": final_markup, "displayed_count": len(allowed_for_display)}
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/integration/test_resolve_citations_node.py -v`
Expected: PASS

```bash
git add content_tool/agents/resolve_citations.py tests/integration/test_resolve_citations_node.py
git commit -m "feat: resolve_citations node — vertex redirect resolution + source policy"
```

---

### Task 8: render_html node (deterministic Markdown→HTML)

**Files:**
- Create: `content_tool/agents/render_html.py`, `tests/unit/test_render_html.py`

- [ ] **Step 1: Write failing tests**

```python
import pytest

from content_tool.agents.render_html import render_html


SAMPLE = """\
# 大腸癌：症狀、篩查、治療與保險指南（2026）
%%meta desc=了解大腸癌的早期症狀、篩查方法。%%

大腸癌是香港常見的癌症之一。

%%adv_panel id=1%%

## 大腸癌篩查方法

大便潛血測試是常見的初步篩查方法。

%%page_widget id=2%%

## 常見問題
%%acf_faq type=q%%
篩查資格是什麼？
%%acf_faq type=a%%
50 至 75 歲香港居民。
%%end%%
%%acf_faq type=q%%
大腸癌可以根治嗎？
%%acf_faq type=a%%
若早期發現，治癒率高。
%%end%%

## 資訊來源
1. [www.ia.org.hk](https://www.ia.org.hk/x)
"""


def test_extracts_seo_title_and_meta():
    r = render_html(SAMPLE)
    assert r.seo_title == "大腸癌：症狀、篩查、治療與保險指南（2026）"
    assert r.meta_description == "了解大腸癌的早期症狀、篩查方法。"


def test_strips_h1_from_body():
    r = render_html(SAMPLE)
    assert "<h1>" not in r.html_body


def test_shortcodes_passthrough():
    r = render_html(SAMPLE)
    assert '[adv_panel id="1"]' in r.html_body
    assert '[page_widget id="2"]' in r.html_body


def test_faq_widget_html_first_active():
    r = render_html(SAMPLE)
    assert 'class="editor__item editor__faq"' in r.html_body
    assert 'class="e-faq__list is--active"' in r.html_body
    # First answer body has inline display:block
    assert 'style="display: block;"' in r.html_body


def test_jsonld_present_at_top():
    r = render_html(SAMPLE)
    assert r.html_body.startswith('<script type="application/ld+json">')
    assert r.faq_schema_jsonld is not None
    assert r.faq_schema_jsonld["@type"] == "FAQPage"
    assert len(r.faq_schema_jsonld["mainEntity"]) == 2


def test_sources_become_ol():
    r = render_html(SAMPLE)
    assert "<h2>資訊來源</h2>" in r.html_body
    assert "<ol>" in r.html_body
    assert '<a href="https://www.ia.org.hk/x">www.ia.org.hk</a>' in r.html_body


def test_no_raw_html_passthrough():
    bad = SAMPLE.replace("大腸癌是香港", "<script>alert(1)</script>大腸癌是香港")
    with pytest.raises(ValueError, match="sanitization"):
        render_html(bad)
```

- [ ] **Step 2: Implement `content_tool/agents/render_html.py`**

```python
import json
import re
from dataclasses import dataclass

from markdown_it import MarkdownIt


@dataclass
class RenderResult:
    seo_title: str
    meta_description: str
    html_body: str
    faq_schema_jsonld: dict | None
    excerpt_suggestion: str
    slug_suggestion: str


_META_RE = re.compile(r"^%%meta desc=(.*?)%%\s*$", re.MULTILINE)
_ADV_RE = re.compile(r"%%adv_panel id=(\d+)%%")
_WIDGET_RE = re.compile(r"%%page_widget id=(\d+)%%")
_FAQ_BLOCK_RE = re.compile(
    r"%%acf_faq type=q%%\s*\n(.*?)\n%%acf_faq type=a%%\s*\n(.*?)\n%%end%%",
    re.DOTALL,
)


def _build_faq_html(items: list[tuple[str, str]]) -> str:
    if not items:
        return ""
    parts: list[str] = ['<div class="editor__item editor__faq">', '  <div class="e-faq__wrap">']
    for i, (q, a) in enumerate(items):
        active = " is--active" if i == 0 else ""
        body_style = ' style="display: block;"' if i == 0 else ""
        parts.extend([
            f'    <div class="e-faq__list{active}">',
            f'      <div class="e-faq__head">{q}<span class="e-faq__icon icon-add"></span></div>',
            f'      <div class="e-faq__body"{body_style}>',
            f'        <p>{a}</p>',
            '      </div>',
            '    </div>',
        ])
    parts.extend(['  </div>', '</div>'])
    return "\n".join(parts)


def _build_faq_jsonld(items: list[tuple[str, str]]) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": q,
             "acceptedAnswer": {"@type": "Answer", "text": a}}
            for q, a in items
        ],
    }


def _check_no_raw_html(markdown_body: str) -> None:
    """Refuse if writer somehow emitted a raw <script> or other dangerous tag."""
    if re.search(r"<\s*(script|style|iframe|object|embed)\b", markdown_body, re.IGNORECASE):
        raise ValueError("html sanitization failed: writer emitted disallowed raw tag")


def render_html(markdown: str) -> RenderResult:
    lines = markdown.splitlines()
    # H1 = first line starting with '# '
    if not lines or not lines[0].startswith("# "):
        raise ValueError("first markdown line must be '# H1'")
    seo_title = lines[0][2:].strip()

    rest = "\n".join(lines[1:])

    meta_m = _META_RE.search(rest)
    if not meta_m:
        raise ValueError("missing %%meta desc=...%% line")
    meta_description = meta_m.group(1).strip()
    rest = _META_RE.sub("", rest, count=1).lstrip()

    # Sanitization gate (run BEFORE we transform anything writer-controlled)
    _check_no_raw_html(rest)

    # Extract FAQ items, then strip FAQ shortcodes from rest
    faq_items = [(q.strip(), a.strip()) for q, a in _FAQ_BLOCK_RE.findall(rest)]
    rest = _FAQ_BLOCK_RE.sub("", rest)
    # Remove "## 常見問題" line if it's followed only by what was FAQ
    rest = re.sub(r"##\s*常見問題\s*\n", "", rest)

    # Markdown → HTML (without FAQ block; we'll inject)
    md = MarkdownIt("commonmark").enable(["table"])
    body_html = md.render(rest)

    # Replace shortcodes (after MD rendering — they survive as raw text inside <p>)
    body_html = _ADV_RE.sub(lambda m: f'[adv_panel id="{m.group(1)}"]', body_html)
    body_html = _WIDGET_RE.sub(lambda m: f'[page_widget id="{m.group(1)}"]', body_html)

    # FAQ widget + JSON-LD
    faq_html = _build_faq_html(faq_items)
    faq_jsonld = _build_faq_jsonld(faq_items) if faq_items else None
    jsonld_script = ""
    if faq_jsonld is not None:
        jsonld_script = (
            '<script type="application/ld+json">\n'
            + json.dumps(faq_jsonld, ensure_ascii=False, indent=2)
            + "\n</script>\n"
        )

    final = jsonld_script + body_html
    if faq_html:
        final += "\n<h2>常見問題</h2>\n" + faq_html + "\n"

    # Excerpt: first <p>... text, ≤160 chars
    p_match = re.search(r"<p>(.*?)</p>", body_html, re.DOTALL)
    excerpt = (p_match.group(1)[:160] if p_match else "")
    slug_suggestion = ""  # preserved-by-default for updates; left empty here

    return RenderResult(
        seo_title=seo_title,
        meta_description=meta_description,
        html_body=final,
        faq_schema_jsonld=faq_jsonld,
        excerpt_suggestion=excerpt,
        slug_suggestion=slug_suggestion,
    )
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/unit/test_render_html.py -v`
Expected: PASS (7 tests)

```bash
git add content_tool/agents/render_html.py tests/unit/test_render_html.py
git commit -m "feat: render_html — shortcodes, FAQ widget, JSON-LD, sanitization"
```

---

### Task 9: render_html node wrapper + Renders persist

**Files:**
- Modify: `content_tool/agents/render_html.py` (add `run_render_html` async wrapper)
- Create: `tests/integration/test_render_html_node.py`

- [ ] **Step 1: Append wrapper to `content_tool/agents/render_html.py`**

```python
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Draft, Render


async def run_render_html(
    *, session: AsyncSession, draft_id: UUID,
) -> RenderResult:
    draft = (await session.execute(select(Draft).where(Draft.draft_id == draft_id))).scalar_one()
    md = draft.final_markup or draft.markup_raw
    result = render_html(md)
    session.add(Render(
        draft_id=draft_id,
        seo_title=result.seo_title,
        meta_description=result.meta_description,
        html_body=result.html_body,
        faq_schema_jsonld=result.faq_schema_jsonld,
        excerpt_suggestion=result.excerpt_suggestion,
        slug_suggestion=result.slug_suggestion,
    ))
    await session.commit()
    return result
```

- [ ] **Step 2: Write integration test**

```python
from datetime import date
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.render_html import run_render_html
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run


@pytest.mark.asyncio
async def test_render_html_node_writes_renders_row(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="production",
        article_url="https://e.com", topic="x", keywords=[], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
    ))
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    draft = Draft(
        run_id=run_id, iteration=0, diagnose="d",
        markup_raw="# H1\n%%meta desc=m%%\n\nfirst para.\n\n%%adv_panel id=1%%\n\n## x\nbody\n",
        final_markup="# H1\n%%meta desc=m%%\n\nfirst para.\n\n%%adv_panel id=1%%\n\n## x\nbody\n\n## 資訊來源\n1. [a.gov](https://a.gov/x)\n",
        citation_intents=[],
    )
    db_session.add(draft)
    await db_session.commit()

    result = await run_render_html(session=db_session, draft_id=draft.draft_id)

    assert result.seo_title == "H1"
    row = (await db_session.execute(select(Render).where(Render.draft_id == draft.draft_id))).scalar_one()
    assert row.html_body == result.html_body
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/integration/test_render_html_node.py -v`
Expected: PASS

```bash
git add content_tool/agents/render_html.py tests/integration/test_render_html_node.py
git commit -m "feat: render_html node wrapper + renders row persist"
```

---

### Task 10: Audit deterministic checks (Python, no LLM)

**Files:**
- Create: `content_tool/agents/audit_checks.py`, `tests/unit/test_audit_deterministic.py`

- [ ] **Step 1: Write failing tests**

```python
from content_tool.agents.audit_checks import run_deterministic_checks


GOOD_HTML = """\
<script type="application/ld+json">{"@type":"FAQPage"}</script>
<p>first paragraph.</p>
[adv_panel id="1"]
<h2>section</h2>
<p>body</p>
[page_widget id="2"]
<h2>常見問題</h2>
<div class="editor__item editor__faq">faq...</div>
<h2>資訊來源</h2>
<ol><li><a href="https://a.gov/x">a.gov</a></li></ol>
"""


def test_passes_clean_html():
    findings = run_deterministic_checks(GOOD_HTML, citations_denied_displayed=False)
    assert all(f["severity"] != "high" for f in findings)


def test_flags_missing_adv_panel():
    html = GOOD_HTML.replace('[adv_panel id="1"]', "")
    findings = run_deterministic_checks(html, citations_denied_displayed=False)
    cats = {f["category"] for f in findings}
    assert "format" in cats


def test_flags_missing_page_widget():
    html = GOOD_HTML.replace('[page_widget id="2"]', "")
    findings = run_deterministic_checks(html, citations_denied_displayed=False)
    assert any(f["category"] == "format" and "page_widget" in f["issue"] for f in findings)


def test_flags_denied_citation_displayed():
    findings = run_deterministic_checks(GOOD_HTML, citations_denied_displayed=True)
    assert any(f["category"] == "citation" and f["must_fix"] for f in findings)


def test_flags_missing_sources_section():
    html = GOOD_HTML.replace("<h2>資訊來源</h2>", "")
    findings = run_deterministic_checks(html, citations_denied_displayed=False)
    assert any(f["category"] == "format" and "資訊來源" in f["issue"] for f in findings)
```

- [ ] **Step 2: Implement `content_tool/agents/audit_checks.py`**

```python
import re
from typing import Any


def run_deterministic_checks(
    html_body: str, *, citations_denied_displayed: bool,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    if not re.search(r'\[adv_panel id="\d+"\]', html_body):
        findings.append({
            "id": "det-fmt-adv", "category": "format", "severity": "high",
            "location": "body", "issue": "缺少 [adv_panel id=...] shortcode",
            "suggested_fix": "在首段後加入 adv_panel shortcode",
            "must_fix": True,
        })

    if not re.search(r'\[page_widget id="\d+"\]', html_body):
        findings.append({
            "id": "det-fmt-widget", "category": "format", "severity": "high",
            "location": "body", "issue": "缺少 [page_widget id=...] shortcode",
            "suggested_fix": "在常見問題前加入 page_widget shortcode",
            "must_fix": True,
        })

    if "<h2>資訊來源</h2>" not in html_body:
        findings.append({
            "id": "det-fmt-sources", "category": "format", "severity": "high",
            "location": "tail", "issue": "缺少 <h2>資訊來源</h2> section",
            "suggested_fix": "確保 resolve_citations 已產生資訊來源 section",
            "must_fix": True,
        })

    if 'class="editor__item editor__faq"' not in html_body:
        findings.append({
            "id": "det-fmt-faq", "category": "format", "severity": "high",
            "location": "tail", "issue": "缺少 Bowtie FAQ widget div",
            "suggested_fix": "render_html 必須輸出 editor__faq 結構",
            "must_fix": True,
        })

    if not re.search(r'<script type="application/ld\+json">', html_body):
        findings.append({
            "id": "det-fmt-jsonld", "category": "format", "severity": "high",
            "location": "head", "issue": "缺少 FAQPage JSON-LD",
            "suggested_fix": "render_html 必須在 body 頂部注入 application/ld+json",
            "must_fix": True,
        })

    if citations_denied_displayed:
        findings.append({
            "id": "det-cite-denied", "category": "citation", "severity": "high",
            "location": "資訊來源", "issue": "顯示了被 policy 拒絕的來源",
            "suggested_fix": "改用 GOV / EDU 等高可信來源",
            "must_fix": True,
        })

    return findings
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/unit/test_audit_deterministic.py -v`
Expected: PASS

```bash
git add content_tool/agents/audit_checks.py tests/unit/test_audit_deterministic.py
git commit -m "feat: deterministic audit checks (format + citation policy)"
```

---

### Task 11: Audit node (deterministic + LLM)

**Files:**
- Create: `content_tool/agents/audit.py`, `tests/integration/test_audit_node.py`

- [ ] **Step 1: Write failing test**

```python
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.audit import run_audit
from content_tool.db.models import AuditRun, Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_audit_pass_flow(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="production",
        article_url="https://e.com", topic="x", keywords=[], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
    ))
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={"update_plan": {}}))
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    draft = Draft(
        run_id=run_id, iteration=0, diagnose="d", markup_raw="# H1\nbody",
        final_markup="# H1\nbody", citation_intents=[],
    )
    db_session.add(draft)
    await db_session.commit()
    await db_session.refresh(draft)
    # Render passes all det checks
    db_session.add(Render(
        draft_id=draft.draft_id,
        seo_title="H1", meta_description="m",
        html_body=(
            '<script type="application/ld+json">{"@type":"FAQPage"}</script>'
            '<p>x</p>[adv_panel id="1"]<h2>x</h2><p>y</p>[page_widget id="2"]'
            '<h2>常見問題</h2><div class="editor__item editor__faq">x</div>'
            '<h2>資訊來源</h2><ol><li>x</li></ol>'
        ),
    ))
    await db_session.commit()

    canned = json.loads(Path("tests/fixtures/gemini_responses/audit_pass.json").read_text(encoding="utf-8"))
    gemini = FakeGeminiClient(canned_responses={"audit": canned})

    res = await run_audit(
        session=db_session, gemini=gemini, draft_id=draft.draft_id,
        topic_category=None, today=date(2026, 5, 21),
    )
    assert res.overall_pass is True

    row = (await db_session.execute(select(AuditRun).where(AuditRun.draft_id == draft.draft_id))).scalar_one()
    assert row.overall_pass is True
```

- [ ] **Step 2: Implement `content_tool/agents/audit.py`**

```python
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.agents.audit_checks import run_deterministic_checks
from content_tool.db.models import AuditRun, Citation, Draft, GapAnalysisRow, Render, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.audit import AuditOutput
from content_tool.policy.personas import load_persona


PROMPT_PATH = Path("prompts/audit.md")


def build_system_prompt(persona_name: str, today: date) -> str:
    persona = load_persona(persona_name)
    return PROMPT_PATH.read_text(encoding="utf-8") \
        .replace("{persona_block}", persona.to_prompt_block()) \
        .replace("{today_date}", today.isoformat())


def build_user_prompt(
    *,
    html_body: str, gap_update_plan: dict, citation_intents: list,
    citations_summary: list, deterministic_findings: list,
) -> str:
    import json as _j
    return (
        f"# final_html\n{html_body}\n\n"
        f"# gap_analysis.update_plan\n{_j.dumps(gap_update_plan, ensure_ascii=False)}\n\n"
        f"# citation_intents\n{_j.dumps(citation_intents, ensure_ascii=False)}\n\n"
        f"# citations (resolved)\n{_j.dumps(citations_summary, ensure_ascii=False)}\n\n"
        f"# deterministic_findings\n{_j.dumps(deterministic_findings, ensure_ascii=False)}"
    )


async def run_audit(
    *,
    session: AsyncSession, gemini: GeminiClient, draft_id: UUID,
    topic_category: str | None, today: date,
) -> AuditOutput:
    draft = (await session.execute(select(Draft).where(Draft.draft_id == draft_id))).scalar_one()
    run = (await session.execute(select(Run).where(Run.run_id == draft.run_id))).scalar_one()
    ga = (await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id))).scalar_one()
    render = (await session.execute(select(Render).where(Render.draft_id == draft_id))).scalar_one()
    citations = (await session.execute(select(Citation).where(Citation.draft_id == draft_id))).scalars().all()

    citations_summary = [
        {"domain": c.domain, "final_url": c.final_url, "policy": c.policy_decision,
         "displayed": c.was_displayed, "denied_reason": c.denied_reason}
        for c in citations
    ]
    denied_displayed = any(c.was_displayed and c.policy_decision == "denied" for c in citations)

    det_findings = run_deterministic_checks(render.html_body, citations_denied_displayed=denied_displayed)

    sys_prompt = build_system_prompt(run.persona, today)
    user_prompt = build_user_prompt(
        html_body=render.html_body,
        gap_update_plan=ga.payload.get("update_plan", {}),
        citation_intents=draft.citation_intents,
        citations_summary=citations_summary,
        deterministic_findings=det_findings,
    )

    result = await gemini.generate(
        agent="audit", system_prompt=sys_prompt, user_prompt=user_prompt,
        response_schema=AuditOutput.model_json_schema(), tools=[],
    )
    llm_audit = AuditOutput.model_validate(result.parsed)

    combined_findings = list(llm_audit.findings) + [
        # promote det findings into AuditFinding shape
        type(llm_audit.findings[0]).model_validate(f) if llm_audit.findings else
        __import__("content_tool.models.audit", fromlist=["AuditFinding"]).AuditFinding.model_validate(f)
        for f in det_findings
    ] if det_findings else list(llm_audit.findings)

    # Recompute overall_pass with det findings folded in
    high_total = sum(1 for f in combined_findings if f.severity == "high")
    any_must_fix = any(f.must_fix for f in combined_findings)
    overall_pass = (high_total == 0) and not any_must_fix
    merged = AuditOutput(
        overall_pass=overall_pass,
        severity_summary={
            "high": sum(1 for f in combined_findings if f.severity == "high"),
            "medium": sum(1 for f in combined_findings if f.severity == "medium"),
            "low": sum(1 for f in combined_findings if f.severity == "low"),
        },
        findings=combined_findings,
    )

    session.add(AuditRun(
        draft_id=draft_id, overall_pass=merged.overall_pass,
        severity_high=merged.severity_summary.high,
        severity_medium=merged.severity_summary.medium,
        severity_low=merged.severity_summary.low,
        llm_findings={"findings": [f.model_dump() for f in llm_audit.findings]},
        deterministic_findings={"findings": det_findings},
        tokens_in=result.tokens_in, tokens_out=result.tokens_out, latency_ms=result.latency_ms,
    ))
    await session.commit()
    return merged
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/integration/test_audit_node.py -v`
Expected: PASS

```bash
git add content_tool/agents/audit.py tests/integration/test_audit_node.py
git commit -m "feat: audit node (deterministic + LLM, merged findings)"
```

---

### Task 12: Production subgraph with refine loop

**Files:**
- Create: `content_tool/graph/production.py`, `tests/integration/test_production_refine_loop.py`

- [ ] **Step 1: Implement `content_tool/graph/production.py`**

```python
from datetime import date
from typing import Any
from uuid import UUID

from langgraph.graph import END, START, StateGraph
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.agents.audit import run_audit
from content_tool.agents.render_html import run_render_html
from content_tool.agents.resolve_citations import run_resolve_citations
from content_tool.agents.writer import run_writer
from content_tool.db.models import AuditRun, Draft
from content_tool.gemini.client import GeminiClient
from content_tool.models.state import ContentToolState


MAX_ITERATIONS = 2


def build_production_graph(*, session_factory: async_sessionmaker, gemini: GeminiClient):
    async def n_writer(state: ContentToolState) -> dict[str, Any]:
        # Build refine_notes from prior audit if iteration > 0
        refine_notes: list[dict] | None = None
        if state["iteration"] > 0 and state["audit_findings"]:
            findings = state["audit_findings"].get("findings", [])
            refine_notes = [f for f in findings if f.get("must_fix") or f.get("severity") == "high"]
        async with session_factory() as session:
            result = await run_writer(
                session=session, gemini=gemini, run_id=UUID(state["run_id"]),
                iteration=state["iteration"], today=date.fromisoformat(state["today_date"]),
                refine_notes=refine_notes,
            )
        return {
            "writer_output": {
                "draft_id": str(result.draft_id), "diagnose": result.diagnose,
                "markup_raw": result.markup_raw, "citation_intents": result.citation_intents,
            },
            "grounding_chunks": result.grounding_chunks,
        }

    async def n_resolve_citations(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            r = await run_resolve_citations(
                session=session, draft_id=UUID(state["writer_output"]["draft_id"]),
                topic_category=state["topic_category"],
            )
        return {"final_markup": r["final_markup"]}

    async def n_render_html(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            result = await run_render_html(
                session=session, draft_id=UUID(state["writer_output"]["draft_id"]),
            )
        return {"render": {
            "seo_title": result.seo_title, "meta_description": result.meta_description,
            "html_body": result.html_body, "faq_schema_jsonld": result.faq_schema_jsonld,
            "excerpt_suggestion": result.excerpt_suggestion,
        }}

    async def n_audit(state: ContentToolState) -> dict[str, Any]:
        async with session_factory() as session:
            a = await run_audit(
                session=session, gemini=gemini,
                draft_id=UUID(state["writer_output"]["draft_id"]),
                topic_category=state["topic_category"],
                today=date.fromisoformat(state["today_date"]),
            )
        return {"audit_findings": {
            "overall_pass": a.overall_pass,
            "severity_summary": a.severity_summary.model_dump(),
            "findings": [f.model_dump() for f in a.findings],
        }}

    def route_after_audit(state: ContentToolState) -> str:
        af = state["audit_findings"]
        if not af or af["overall_pass"]:
            return END
        if state["iteration"] >= MAX_ITERATIONS - 1:  # iteration is 0-indexed; cap at 2 total = max index 1
            return END
        return "writer"

    async def n_increment_iteration(state: ContentToolState) -> dict[str, int]:
        return {"iteration": state["iteration"] + 1}

    g = StateGraph(ContentToolState)
    g.add_node("writer", n_writer)
    g.add_node("resolve_citations", n_resolve_citations)
    g.add_node("render_html", n_render_html)
    g.add_node("audit", n_audit)
    g.add_node("bump", n_increment_iteration)

    g.add_edge(START, "writer")
    g.add_edge("writer", "resolve_citations")
    g.add_edge("resolve_citations", "render_html")
    g.add_edge("render_html", "audit")
    g.add_conditional_edges("audit", route_after_audit, {"writer": "bump", END: END})
    g.add_edge("bump", "writer")
    return g
```

- [ ] **Step 2: Write integration test exercising refine loop**

```python
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
import respx
from httpx import Response

from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import (
    Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run,
)
from content_tool.gemini.client import GeminiResult
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.graph.production import build_production_graph


class CountingFakeGemini(FakeGeminiClient):
    """First audit call fails, second passes — exercises the refine loop."""

    def __init__(self, canned):
        super().__init__(canned)
        self.audit_calls = 0

    async def generate(self, **kwargs):
        if kwargs["agent"] == "audit":
            self.audit_calls += 1
            if self.audit_calls == 1:
                parsed = self._canned["audit_fail"]
            else:
                parsed = self._canned["audit_pass"]
            self.calls.append(kwargs)
            return GeminiResult(parsed=parsed, raw_text=json.dumps(parsed),
                                tokens_in=100, tokens_out=50, thinking_tokens=10, latency_ms=5)
        return await super().generate(**kwargs)


@pytest.mark.asyncio
async def test_refine_loop_iterates_then_passes(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="production",
            article_url="https://e.com", topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 21), chosen_route="small_refresh",
        ))
        s.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x"))
        s.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={"update_plan": {}}))
        s.add(OutlineRow(run_id=run_id, payload={}))
        await s.commit()

    canned = {
        "writer": json.loads(Path("tests/fixtures/gemini_responses/writer_small_refresh_ok.json").read_text(encoding="utf-8")),
        "audit_fail": json.loads(Path("tests/fixtures/gemini_responses/audit_fail.json").read_text(encoding="utf-8")),
        "audit_pass": json.loads(Path("tests/fixtures/gemini_responses/audit_pass.json").read_text(encoding="utf-8")),
    }
    gemini = CountingFakeGemini(canned)

    graph = build_production_graph(session_factory=sf, gemini=gemini).compile()
    initial = {
        "run_id": str(run_id),
        "article_url": "x", "topic": "x", "keywords": [], "mode": "auto",
        "edit_note": None, "acf_adv_id": 1, "acf_widget_id": 2,
        "persona": "bowtie-editor", "topic_category": None,
        "today_date": "2026-05-21",
        "existing_article_markdown": "x", "wp_post_id": 1, "wp_categories": [],
        "gap_analysis": {"update_plan": {}}, "outline": {}, "chosen_route": "small_refresh",
        "writer_output": None, "grounding_chunks": None, "citations": None,
        "render": None, "final_markup": None, "audit_findings": None, "iteration": 0,
        "hitl_1_decision": None, "hitl_1_edits": None,
        "hitl_2_decision": None, "hitl_2_notes": None,
        "status": "production", "error": None,
    }

    with respx.mock(assert_all_called=False):
        final = await graph.ainvoke(initial)

    assert final["audit_findings"]["overall_pass"] is True
    assert gemini.audit_calls == 2
    await engine.dispose()
```

- [ ] **Step 3: Run + commit**

Run: `pytest tests/integration/test_production_refine_loop.py -v -s`
Expected: PASS

```bash
git add content_tool/graph/production.py tests/integration/test_production_refine_loop.py
git commit -m "feat: Production subgraph with writer⇄audit refine loop"
```

---

### Task 13: Wire Production into root graph + HITL_2 interrupt

**Files:**
- Modify: `content_tool/graph/root.py`

- [ ] **Step 1: Replace `content_tool/graph/root.py`**

```python
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.gemini.client import GeminiClient
from content_tool.graph.production import build_production_graph
from content_tool.graph.strategy import build_strategy_graph
from content_tool.models.state import ContentToolState


def build_root_graph(
    *,
    session_factory: async_sessionmaker,
    gemini: GeminiClient,
    checkpointer: AsyncPostgresSaver,
):
    strategy = build_strategy_graph(session_factory=session_factory, gemini=gemini).compile()
    production = build_production_graph(session_factory=session_factory, gemini=gemini).compile()

    root = StateGraph(ContentToolState)
    root.add_node("strategy", strategy)
    root.add_node("production", production)

    # HITL_1 interrupt is BEFORE production; HITL_2 is BEFORE persist.
    async def n_persist(state: ContentToolState) -> dict:
        return {"status": "persisted"}

    root.add_node("persist", n_persist)
    root.add_edge(START, "strategy")
    root.add_edge("strategy", "production")
    root.add_edge("production", "persist")
    root.add_edge("persist", END)

    return root.compile(
        checkpointer=checkpointer,
        interrupt_before=["production", "persist"],
    )
```

- [ ] **Step 2: Commit**

```bash
git add content_tool/graph/root.py
git commit -m "feat: root graph with Production + HITL_1 + HITL_2 interrupts"
```

---

### Task 14: Extend `/runs/{id}/resume` for HITL_2

**Files:**
- Modify: `content_tool/api/schemas.py`, `content_tool/api/routes/runs.py`

- [ ] **Step 1: Append to `content_tool/api/schemas.py`**

```python
class Hitl2Request(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    notes: str | None = None
    edited_html_body: str | None = None      # if editor tweaked HTML
    edited_seo_title: str | None = None
    edited_meta_description: str | None = None
    wp_publish_status: Literal["draft", "future", "publish"] = "draft"
    wp_author_id: int | None = None
    wp_category_ids: list[int] | None = None
    wp_tag_ids: list[int] | None = None
    wp_featured_media_id: int | None = None
    wp_slug: str | None = None
    wp_excerpt: str | None = None
    wp_publish_at: datetime | None = None
```

- [ ] **Step 2: Extend `content_tool/api/routes/runs.py`**

Add a second resume endpoint specific to HITL_2:

```python
from datetime import datetime

from content_tool.api.schemas import Hitl2Request


@router.post("/{run_id}/hitl-2")
async def hitl_2(
    run_id: UUID, payload: Hitl2Request,
    sf=Depends(get_session_factory), runner=Depends(get_runner),
) -> dict:
    from sqlalchemy import update
    from content_tool.db.models import Run

    async with sf() as session:
        await session.execute(
            update(Run).where(Run.run_id == run_id).values(
                hitl_2_decision=payload.decision,
                hitl_2_notes=payload.notes,
                approved_at=datetime.utcnow() if payload.decision == "approve" else None,
                approved_by="placeholder-editor",  # Plan 4 binds real identity
                wp_publish_status=payload.wp_publish_status,
                wp_author_id=payload.wp_author_id,
                wp_category_ids=payload.wp_category_ids,
                wp_tag_ids=payload.wp_tag_ids,
                wp_featured_media_id=payload.wp_featured_media_id,
                wp_slug=payload.wp_slug,
                wp_excerpt=payload.wp_excerpt,
                wp_publish_at=payload.wp_publish_at,
            )
        )
        await session.commit()

    state_update: dict = {"hitl_2_decision": payload.decision, "hitl_2_notes": payload.notes}
    if payload.edited_html_body and state_update.get("render"):
        # writer/render_html stored render; editor wants to override
        state_update["render"] = {
            **state_update["render"],
            "html_body": payload.edited_html_body,
            "seo_title": payload.edited_seo_title or state_update["render"].get("seo_title"),
            "meta_description": payload.edited_meta_description or state_update["render"].get("meta_description"),
        }

    if payload.decision != "approve":
        # END the run path; Plan 4 + UI can show rejection state
        state_update["status"] = "rejected" if payload.decision == "reject" else "changes_requested"

    await runner.resume(run_id, state_update)
    return {"ok": True}
```

- [ ] **Step 3: Commit**

```bash
git add content_tool/api/schemas.py content_tool/api/routes/runs.py
git commit -m "feat(api): HITL_2 resume with WP metadata fields"
```

---

### Task 15: Root-graph E2E test

**Files:**
- Create: `tests/integration/test_root_graph_e2e.py`

- [ ] **Step 1: Write the test**

```python
import asyncio
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
import respx
from httpx import Response

from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Run
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph
from sqlalchemy import select


@pytest.mark.asyncio
async def test_root_graph_with_two_hitl_resumes(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="e@x.com", status="pending",
            article_url="https://www.bowtie.com.hk/blog/zh/x/",
            topic="x", keywords=["x"], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 21),
        ))
        await s.commit()

    canned = {
        "gap_analysis": json.loads(Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")),
        "outline": json.loads(Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")),
        "writer": json.loads(Path("tests/fixtures/gemini_responses/writer_small_refresh_ok.json").read_text(encoding="utf-8")),
        "audit": json.loads(Path("tests/fixtures/gemini_responses/audit_pass.json").read_text(encoding="utf-8")),
    }
    gemini = FakeGeminiClient(canned)

    with respx.mock(assert_all_called=False) as router:
        router.get("https://www.bowtie.com.hk/blog/zh/x/").mock(
            return_value=Response(200, headers={"Link": "<https://www.bowtie.com.hk/blog/?p=99>; rel=shortlink"}, text="x")
        )
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts/99").mock(
            return_value=Response(200, json={
                "id": 99, "slug": "x", "categories": [42], "link": "x",
                "title": {"rendered": "x"}, "status": "publish", "author": 5,
                "modified_gmt": "2026-04-12T08:30:00",
                "content": {"rendered": "<p>x</p>"},
            })
        )
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/categories").mock(
            return_value=Response(200, json=[{"id": 42, "name": "x", "slug": "x"}])
        )
        # HEAD requests for grounding chunks (none, since fake writer has none) — no mocks needed

        async with make_checkpointer(postgres_url) as cp:
            graph = build_root_graph(session_factory=sf, gemini=gemini, checkpointer=cp)
            config = {"configurable": {"thread_id": str(run_id)}}
            initial = {
                "run_id": str(run_id), "article_url": "https://www.bowtie.com.hk/blog/zh/x/",
                "topic": "x", "keywords": ["x"], "mode": "auto",
                "edit_note": None, "acf_adv_id": 1, "acf_widget_id": 2,
                "persona": "bowtie-editor", "topic_category": None,
                "today_date": "2026-05-21",
                "existing_article_markdown": None, "wp_post_id": None, "wp_categories": None,
                "gap_analysis": None, "outline": None, "chosen_route": None,
                "writer_output": None, "grounding_chunks": None, "citations": None,
                "render": None, "final_markup": None, "audit_findings": None, "iteration": 0,
                "hitl_1_decision": None, "hitl_1_edits": None,
                "hitl_2_decision": None, "hitl_2_notes": None,
                "status": "pending", "error": None,
            }

            # Run until first interrupt (HITL_1, before production)
            await graph.ainvoke(initial, config=config)
            st = await graph.aget_state(config)
            assert "production" in st.next

            # Resume — proceeds into production
            await graph.aupdate_state(config, {"hitl_1_decision": "approve"})
            await graph.ainvoke(None, config=config)
            st = await graph.aget_state(config)
            assert "persist" in st.next

            # Resume — final persist
            await graph.aupdate_state(config, {"hitl_2_decision": "approve"})
            final = await graph.ainvoke(None, config=config)
            assert final["status"] == "persisted"

    await engine.dispose()
```

- [ ] **Step 2: Run + commit**

Run: `pytest tests/integration/test_root_graph_e2e.py -v -s`
Expected: PASS

```bash
git add tests/integration/test_root_graph_e2e.py
git commit -m "test: root graph end-to-end with HITL_1 + HITL_2 resumes"
```

---

## Self-review checklist

| Concern | Covered |
|---|---|
| Persona pack loader | Task 1 |
| Writer / Audit / Citation Pydantic models | Task 2 |
| Writer prompts (both routes) + audit prompt | Task 3 |
| DB migrations for drafts/citations/cache/renders/audit | Task 4 |
| Writer node + persona injection + refine notes | Task 5 |
| URL resolver + cache | Task 6 |
| resolve_citations node + source policy application | Task 7 |
| render_html (HTML body + JSON-LD + FAQ widget + sanitization) | Tasks 8-9 |
| Audit deterministic checks | Task 10 |
| Audit node combining det + LLM | Task 11 |
| Production subgraph + refine loop | Task 12 |
| Root graph + HITL_2 interrupt | Task 13 |
| HITL_2 API contract | Task 14 |
| End-to-end test | Task 15 |

After Plan 3 ships: the full LangGraph backend runs via the API with both HITL gates. No UI yet (Plan 4); no real WP push (Plan 5 swaps the persist no-op for `publish_to_wordpress`).
