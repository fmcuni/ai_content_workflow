# Plan 1 — Foundation Implementation Plan

**Goal:** Stand up the Python project, Postgres schema, FastAPI skeleton, Gemini client (real + fake), and the first agent (`gap_analysis`) runnable via CLI against a test database with a reference eval.

**Architecture:** Single Python package `content_tool` with sub-modules per concern (`models`, `gemini`, `agents`, `policy`, `db`, `api`). Async throughout (FastAPI, SQLAlchemy 2.0 async, httpx). Tests use a real Postgres via `testcontainers-python` and a fake Gemini client that replays JSON fixtures. No LangGraph yet — Plan 2 introduces it. Plan 1 calls the `gap_analysis` node function directly.

**Tech Stack:**
- Python 3.12+
- `uv` for package management
- FastAPI + uvicorn (web)
- SQLAlchemy 2.0 async + asyncpg (DB driver)
- Alembic (migrations)
- `google-genai` SDK (Gemini 3.x client)
- Pydantic v2 (validation)
- pytest + pytest-asyncio + testcontainers + respx
- ruff (lint) + pyright (types)
- structlog (logging)
- pyyaml, tldextract, httpx

---

## File structure

Files this plan creates:

```
ai_content_tool_2/
├── pyproject.toml
├── .python-version
├── .ruff.toml
├── pyrightconfig.json
├── alembic.ini
├── .env.example
├── README.md
├── .github/workflows/ci.yml
├── content_tool/
│   ├── __init__.py
│   ├── config.py
│   ├── cli.py
│   ├── api/
│   │   ├── __init__.py
│   │   ├── main.py
│   │   └── routes/
│   │       ├── __init__.py
│   │       └── runs.py
│   ├── models/
│   │   ├── __init__.py
│   │   ├── state.py
│   │   └── gap_analysis.py
│   ├── db/
│   │   ├── __init__.py
│   │   ├── connection.py
│   │   └── models.py
│   ├── gemini/
│   │   ├── __init__.py
│   │   ├── client.py
│   │   └── fake.py
│   ├── policy/
│   │   ├── __init__.py
│   │   └── source_policy.py
│   └── agents/
│       ├── __init__.py
│       └── gap_analysis.py
├── config/
│   ├── source_policy.yaml
│   └── pricing.yaml
├── prompts/
│   └── gap_analysis.md
├── migrations/
│   ├── env.py
│   ├── script.py.mako
│   └── versions/
│       └── 0001_create_content_tool_schema.py
├── evals/
│   ├── __init__.py
│   ├── reference.py
│   └── fixtures/
│       └── gold_labels/route.csv
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── unit/
    │   ├── __init__.py
    │   ├── test_source_policy.py
    │   ├── test_gemini_fake.py
    │   └── test_gap_analysis_schema.py
    ├── integration/
    │   ├── __init__.py
    │   └── test_gap_analysis_node.py
    └── fixtures/
        ├── gemini_responses/
        │   └── gap_analysis_ok.json
        └── articles/
            └── cancer_basics.md
```

---

### Task 1: Python project scaffolding

**Files:**
- Create: `pyproject.toml`, `.python-version`, `.ruff.toml`, `pyrightconfig.json`, `.env.example`, `README.md`

- [ ] **Step 1: Create `.python-version`**

```
3.12
```

- [ ] **Step 2: Create `pyproject.toml`**

```toml
[project]
name = "content_tool"
version = "0.1.0"
description = "Bowtie AI Content Tool — Update Article Route (MVP)"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.32",
  "sqlalchemy[asyncio]>=2.0.36",
  "asyncpg>=0.30",
  "alembic>=1.14",
  "pydantic>=2.10",
  "pydantic-settings>=2.6",
  "google-genai>=0.4",
  "httpx>=0.28",
  "structlog>=24.4",
  "pyyaml>=6.0",
  "tldextract>=5.1",
  "click>=8.1",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.3",
  "pytest-asyncio>=0.24",
  "pytest-cov>=6.0",
  "testcontainers[postgres]>=4.8",
  "respx>=0.21",
  "ruff>=0.7",
  "pyright>=1.1.388",
]

[project.scripts]
content-tool = "content_tool.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 3: Create `.ruff.toml`**

```toml
line-length = 100
target-version = "py312"

[lint]
select = ["E", "F", "I", "B", "UP", "ASYNC", "S", "ANN", "RUF"]
ignore = ["ANN101", "ANN102", "S101"]  # allow self/cls without annotation; allow assert in tests

[lint.per-file-ignores]
"tests/**" = ["ANN"]
"migrations/**" = ["ANN", "E501"]
```

- [ ] **Step 4: Create `pyrightconfig.json`**

```json
{
  "include": ["content_tool", "tests", "evals"],
  "pythonVersion": "3.12",
  "typeCheckingMode": "strict",
  "reportMissingImports": "error",
  "reportMissingTypeStubs": "warning",
  "venvPath": ".",
  "venv": ".venv"
}
```

- [ ] **Step 5: Create `.env.example`**

```bash
# Database
POSTGRES_URL=postgresql+asyncpg://content_tool:content_tool@localhost:5432/content_tool

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
GEMINI_THINKING_LEVEL=high

# Logging
LOG_LEVEL=info
```

- [ ] **Step 6: Create `README.md`**

```markdown
# Bowtie AI Content Tool

LangGraph-based content update tool. See `docs/design/specs/2026-05-21-bowtie-ai-content-tool-update-route-mvp-design.md` for design.

## Dev setup

```bash
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
cp .env.example .env.local
# fill in GEMINI_API_KEY
```

## Run tests

```bash
pytest
```

## Run gap_analysis on an article (CLI)

```bash
content-tool gap-analysis --article-url https://www.bowtie.com.hk/blog/... --topic "..." --keywords "..."
```
```

- [ ] **Step 7: Install and verify**

Run:
```bash
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"
ruff check .
pyright
```

Expected: clean (no Python files yet so both are no-ops).

- [ ] **Step 8: Commit**

```bash
git add pyproject.toml .python-version .ruff.toml pyrightconfig.json .env.example README.md
git commit -m "feat: Python project scaffolding"
```

---

### Task 2: Config loader

**Files:**
- Create: `content_tool/__init__.py`, `content_tool/config.py`, `tests/__init__.py`, `tests/unit/__init__.py`, `tests/unit/test_config.py`

- [ ] **Step 1: Create empty `content_tool/__init__.py` and `tests/__init__.py` and `tests/unit/__init__.py`**

```python
```

- [ ] **Step 2: Write failing test for config loading — `tests/unit/test_config.py`**

```python
import os
from content_tool.config import Settings


def test_settings_loads_from_env(monkeypatch):
    monkeypatch.setenv("POSTGRES_URL", "postgresql+asyncpg://u:p@h/d")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
    s = Settings()
    assert s.postgres_url == "postgresql+asyncpg://u:p@h/d"
    assert s.gemini_api_key == "fake-key"
    assert s.gemini_model == "gemini-3.5-flash"  # default
    assert s.gemini_thinking_level == "high"     # default
    assert s.log_level == "info"                  # default
```

- [ ] **Step 3: Run test (fails — ModuleNotFoundError)**

Run: `pytest tests/unit/test_config.py -v`
Expected: FAIL (`content_tool.config` does not exist)

- [ ] **Step 4: Implement `content_tool/config.py`**

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env.local", case_sensitive=False)

    postgres_url: str
    gemini_api_key: str
    gemini_model: str = "gemini-3.5-flash"
    gemini_thinking_level: str = "high"
    log_level: str = "info"


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
```

- [ ] **Step 5: Run test — passes**

Run: `pytest tests/unit/test_config.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add content_tool/__init__.py content_tool/config.py tests/
git commit -m "feat: settings loader from env"
```

---

### Task 3: Source policy loader + `is_allowed`

**Files:**
- Create: `config/source_policy.yaml`, `content_tool/policy/__init__.py`, `content_tool/policy/source_policy.py`, `tests/unit/test_source_policy.py`

- [ ] **Step 1: Create `config/source_policy.yaml`** (copy from spec §5)

```yaml
deny:
  domains:
    - bowtie.com.hk
    - bowtie.com
    - manulife.com.hk
    - axa.com.hk
    - prudential.com.hk
    - aia.com.hk
    - china-life.com.hk
    - blueocean.com.hk
    - chubb.com.hk
    - zurich.com.hk
    - hsbclife.com.hk
    - fwd.com.hk
prefer:
  tlds: [".gov.hk", ".gov", ".edu", ".edu.hk"]
  domains:
    - ia.org.hk
    - ifec.org.hk
    - hkma.gov.hk
    - dh.gov.hk
    - chp.gov.hk
    - ha.org.hk
    - mpfa.org.hk
    - vhis.gov.hk
    - who.int
community_exception:
  topic_categories: [community-response, patient-experience, social-discussion]
  allowed_domains: [reddit.com, hk.discuss.com, lihkg.com, baby-kingdom.com]
```

- [ ] **Step 2: Create `content_tool/policy/__init__.py`** (empty)

- [ ] **Step 3: Write failing tests — `tests/unit/test_source_policy.py`**

```python
import pytest
from content_tool.policy.source_policy import SourcePolicy, PolicyDecision


@pytest.fixture
def policy():
    return SourcePolicy.load_from("config/source_policy.yaml")


def test_bowtie_is_denied(policy):
    d = policy.evaluate("bowtie.com.hk", topic_category=None)
    assert d.decision == "denied"
    assert d.reason == "bowtie_owned"


def test_competitor_is_denied(policy):
    d = policy.evaluate("manulife.com.hk", topic_category=None)
    assert d.decision == "denied"
    assert d.reason == "competitor"


def test_gov_hk_is_allowed(policy):
    d = policy.evaluate("www.ia.org.hk", topic_category=None)
    assert d.decision == "allowed"


def test_gov_tld_is_allowed(policy):
    d = policy.evaluate("nih.gov", topic_category=None)
    assert d.decision == "allowed"


def test_community_denied_when_no_exception(policy):
    d = policy.evaluate("reddit.com", topic_category=None)
    assert d.decision == "denied"


def test_community_allowed_with_exception(policy):
    d = policy.evaluate("reddit.com", topic_category="community-response")
    assert d.decision == "community_exception"


def test_unknown_domain_is_allowed(policy):
    d = policy.evaluate("some-medical-journal.org", topic_category=None)
    assert d.decision == "allowed"


def test_subdomain_treated_as_apex(policy):
    d = policy.evaluate("blog.bowtie.com.hk", topic_category=None)
    assert d.decision == "denied"
    assert d.reason == "bowtie_owned"
```

- [ ] **Step 4: Run tests — all fail**

Run: `pytest tests/unit/test_source_policy.py -v`
Expected: FAIL (module not found)

- [ ] **Step 5: Implement `content_tool/policy/source_policy.py`**

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import tldextract
import yaml

Decision = Literal["allowed", "denied", "community_exception"]
DeniedReason = Literal["bowtie_owned", "competitor", "other"]


@dataclass
class PolicyDecision:
    decision: Decision
    reason: DeniedReason | None = None
    matched_rule: str | None = None


_BOWTIE_DOMAINS = {"bowtie.com.hk", "bowtie.com"}


class SourcePolicy:
    def __init__(self, raw: dict) -> None:
        self.deny_domains: set[str] = set(raw.get("deny", {}).get("domains", []))
        self.prefer_tlds: list[str] = raw.get("prefer", {}).get("tlds", [])
        self.prefer_domains: set[str] = set(raw.get("prefer", {}).get("domains", []))
        ce = raw.get("community_exception", {})
        self.community_topic_categories: set[str] = set(ce.get("topic_categories", []))
        self.community_allowed_domains: set[str] = set(ce.get("allowed_domains", []))

    @classmethod
    def load_from(cls, path: str | Path) -> "SourcePolicy":
        with open(path, encoding="utf-8") as f:
            raw = yaml.safe_load(f)
        return cls(raw)

    @staticmethod
    def _apex(domain: str) -> str:
        ext = tldextract.extract(domain)
        if not ext.suffix:
            return domain.lower()
        return f"{ext.domain}.{ext.suffix}".lower()

    def evaluate(self, domain: str, topic_category: str | None) -> PolicyDecision:
        apex = self._apex(domain)

        if apex in self.community_allowed_domains:
            if topic_category in self.community_topic_categories:
                return PolicyDecision("community_exception", matched_rule=apex)
            return PolicyDecision("denied", reason="other", matched_rule="community-not-applicable")

        if apex in _BOWTIE_DOMAINS:
            return PolicyDecision("denied", reason="bowtie_owned", matched_rule=apex)

        if apex in self.deny_domains:
            return PolicyDecision("denied", reason="competitor", matched_rule=apex)

        return PolicyDecision("allowed", matched_rule=apex)
```

- [ ] **Step 6: Run tests — pass**

Run: `pytest tests/unit/test_source_policy.py -v`
Expected: PASS (all 8 tests)

- [ ] **Step 7: Commit**

```bash
git add config/source_policy.yaml content_tool/policy/ tests/unit/test_source_policy.py
git commit -m "feat: source policy loader with deny/prefer/community-exception"
```

---

### Task 4: Pydantic schema for `gap_analysis` output

**Files:**
- Create: `content_tool/models/__init__.py`, `content_tool/models/gap_analysis.py`, `tests/unit/test_gap_analysis_schema.py`, `tests/fixtures/gemini_responses/gap_analysis_ok.json`

- [ ] **Step 1: Create `content_tool/models/__init__.py`** (empty)

- [ ] **Step 2: Create fixture `tests/fixtures/gemini_responses/gap_analysis_ok.json`**

```json
{
  "target_query": "大腸癌篩查 香港 2026",
  "top_pages": [
    {"url": "https://www.ha.org.hk/cancer/colon", "title": "大腸癌資訊", "rank": 1},
    {"url": "https://www.chp.gov.hk/screening", "title": "篩查計劃", "rank": 2},
    {"url": "https://www.vhis.gov.hk/colon", "title": "自願醫保大腸癌", "rank": 3},
    {"url": "https://www.cancer.org/colon", "title": "Colon Cancer", "rank": 4},
    {"url": "https://www.who.int/colon", "title": "WHO Colon Cancer", "rank": 5}
  ],
  "current_article_assessment": {
    "strengths": ["定義清晰"],
    "outdated_points": ["2024 年數字"],
    "weak_sections": ["FAQ 不足"],
    "structure_status": "partly_outdated"
  },
  "content_gaps": {
    "missing_topics": ["新標靶藥物"],
    "missing_intents": ["復發風險"],
    "freshness_gaps": ["最新存活率"],
    "semantic_gaps": ["MSI-H"],
    "source_trust_gaps": ["政府數據"],
    "ai_extractability_gaps": ["缺少表格"],
    "hk_localization_gaps": [],
    "faq_gaps": ["篩查資格"]
  },
  "recommended_outline": "H1 -> 定義 -> 篩查 -> 治療 -> FAQ",
  "update_plan": {
    "must_add": ["MSI-H 解釋"],
    "must_update": ["2026 存活率"],
    "must_remove": ["2020 過時數據"],
    "must_reorder": [],
    "faq_to_add": ["篩查資格是什麼？"],
    "facts_to_verify": ["第三期五年存活率"]
  },
  "chosen_route": "small_refresh",
  "route_reason": "現有結構仍可保留 70% 以上，主要為數字與 FAQ 更新"
}
```

- [ ] **Step 3: Write failing tests — `tests/unit/test_gap_analysis_schema.py`**

```python
import json
from pathlib import Path

from content_tool.models.gap_analysis import GapAnalysis


def test_parses_valid_fixture():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    data = json.loads(fixture.read_text(encoding="utf-8"))
    ga = GapAnalysis.model_validate(data)
    assert ga.chosen_route == "small_refresh"
    assert len(ga.top_pages) == 5


def test_top_pages_must_be_exactly_5():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    data = json.loads(fixture.read_text(encoding="utf-8"))
    data["top_pages"] = data["top_pages"][:3]
    try:
        GapAnalysis.model_validate(data)
        assert False, "should have raised"
    except Exception as e:
        assert "5" in str(e) or "exactly 5" in str(e).lower() or "min" in str(e).lower()


def test_chosen_route_is_constrained():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    data = json.loads(fixture.read_text(encoding="utf-8"))
    data["chosen_route"] = "wat"
    try:
        GapAnalysis.model_validate(data)
        assert False, "should have raised"
    except Exception:
        pass
```

- [ ] **Step 4: Run tests — fail**

Run: `pytest tests/unit/test_gap_analysis_schema.py -v`
Expected: FAIL (module missing)

- [ ] **Step 5: Implement `content_tool/models/gap_analysis.py`**

```python
from typing import Literal

from pydantic import BaseModel, Field


class TopPage(BaseModel):
    url: str
    title: str
    rank: int


class CurrentArticleAssessment(BaseModel):
    strengths: list[str]
    outdated_points: list[str]
    weak_sections: list[str]
    structure_status: Literal["still_competitive", "partly_outdated", "outdated"]


class ContentGaps(BaseModel):
    missing_topics: list[str]
    missing_intents: list[str]
    freshness_gaps: list[str]
    semantic_gaps: list[str]
    source_trust_gaps: list[str]
    ai_extractability_gaps: list[str]
    hk_localization_gaps: list[str]
    faq_gaps: list[str]


class UpdatePlan(BaseModel):
    must_add: list[str]
    must_update: list[str]
    must_remove: list[str]
    must_reorder: list[str]
    faq_to_add: list[str]
    facts_to_verify: list[str]


class GapAnalysis(BaseModel):
    target_query: str
    top_pages: list[TopPage] = Field(min_length=5, max_length=5)
    current_article_assessment: CurrentArticleAssessment
    content_gaps: ContentGaps
    recommended_outline: str
    update_plan: UpdatePlan
    chosen_route: Literal["small_refresh", "full_rewrite"]
    route_reason: str
```

- [ ] **Step 6: Run tests — pass**

Run: `pytest tests/unit/test_gap_analysis_schema.py -v`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add content_tool/models/ tests/unit/test_gap_analysis_schema.py tests/fixtures/gemini_responses/
git commit -m "feat: GapAnalysis Pydantic schema with validation"
```

---

### Task 5: Gemini client interface + Fake implementation

**Files:**
- Create: `content_tool/gemini/__init__.py`, `content_tool/gemini/client.py`, `content_tool/gemini/fake.py`, `tests/unit/test_gemini_fake.py`

- [ ] **Step 1: Create `content_tool/gemini/__init__.py`** (empty)

- [ ] **Step 2: Write failing tests — `tests/unit/test_gemini_fake.py`**

```python
import json
from pathlib import Path

import pytest

from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_fake_returns_canned_response():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    canned = json.loads(fixture.read_text(encoding="utf-8"))
    client = FakeGeminiClient(canned_responses={"gap_analysis": canned})
    result = await client.generate(
        agent="gap_analysis",
        system_prompt="...",
        user_prompt="...",
        response_schema={"type": "object"},
        tools=["googleSearch"],
    )
    assert result.parsed == canned
    assert result.tokens_in > 0
    assert result.tokens_out > 0


@pytest.mark.asyncio
async def test_fake_raises_when_no_canned():
    client = FakeGeminiClient(canned_responses={})
    with pytest.raises(KeyError, match="gap_analysis"):
        await client.generate(
            agent="gap_analysis",
            system_prompt="...",
            user_prompt="...",
            response_schema={"type": "object"},
            tools=[],
        )
```

- [ ] **Step 3: Run — fail**

Run: `pytest tests/unit/test_gemini_fake.py -v`
Expected: FAIL

- [ ] **Step 4: Implement `content_tool/gemini/client.py`** (interface + real client)

```python
from dataclasses import dataclass
from typing import Any, Protocol

from google import genai
from google.genai import types as genai_types


@dataclass
class GeminiResult:
    parsed: dict[str, Any]
    raw_text: str
    tokens_in: int
    tokens_out: int
    thinking_tokens: int
    latency_ms: int
    grounding_chunks: list[dict[str, Any]] | None = None
    finish_reason: str | None = None
    safety_ratings: list[dict[str, Any]] | None = None
    raw_response: dict[str, Any] | None = None


class GeminiClient(Protocol):
    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult: ...


def strip_property_ordering(schema: Any) -> Any:
    """Recursively strip `propertyOrdering` (triggers INVALID_ARGUMENT on responseJsonSchema)."""
    if isinstance(schema, list):
        return [strip_property_ordering(s) for s in schema]
    if isinstance(schema, dict):
        return {k: strip_property_ordering(v) for k, v in schema.items() if k != "propertyOrdering"}
    return schema


class RealGeminiClient:
    def __init__(self, api_key: str, model: str, thinking_level: str) -> None:
        self._client = genai.Client(api_key=api_key)
        self._model = model
        self._thinking_level = thinking_level

    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult:
        import json
        import time

        config_tools: list[genai_types.Tool] = []
        if "googleSearch" in tools:
            config_tools.append(genai_types.Tool(google_search=genai_types.GoogleSearch()))
        if "urlContext" in tools:
            config_tools.append(genai_types.Tool(url_context=genai_types.UrlContext()))

        config = genai_types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=1.0,
            thinking_config=genai_types.ThinkingConfig(thinking_level=self._thinking_level),
            response_mime_type="application/json" if response_schema else None,
            response_json_schema=strip_property_ordering(response_schema) if response_schema else None,
            tools=config_tools or None,
        )

        t0 = time.perf_counter()
        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=user_prompt,
            config=config,
        )
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        text = response.text or ""
        parsed = json.loads(text) if text else {}
        usage = response.usage_metadata
        candidate = response.candidates[0] if response.candidates else None
        grounding = None
        if candidate and candidate.grounding_metadata:
            grounding = [c.model_dump() for c in (candidate.grounding_metadata.grounding_chunks or [])]

        return GeminiResult(
            parsed=parsed,
            raw_text=text,
            tokens_in=usage.prompt_token_count if usage else 0,
            tokens_out=usage.candidates_token_count if usage else 0,
            thinking_tokens=usage.thoughts_token_count if usage and hasattr(usage, "thoughts_token_count") else 0,
            latency_ms=elapsed_ms,
            grounding_chunks=grounding,
            finish_reason=candidate.finish_reason.name if candidate and candidate.finish_reason else None,
        )
```

- [ ] **Step 5: Implement `content_tool/gemini/fake.py`**

```python
import json
from typing import Any

from content_tool.gemini.client import GeminiResult


class FakeGeminiClient:
    def __init__(self, canned_responses: dict[str, dict[str, Any]]) -> None:
        self._canned = canned_responses
        self.calls: list[dict[str, Any]] = []

    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult:
        self.calls.append({
            "agent": agent,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "tools": tools,
        })
        if agent not in self._canned:
            raise KeyError(f"No canned response for agent={agent}")
        parsed = self._canned[agent]
        return GeminiResult(
            parsed=parsed,
            raw_text=json.dumps(parsed, ensure_ascii=False),
            tokens_in=1000,
            tokens_out=500,
            thinking_tokens=100,
            latency_ms=10,
        )
```

- [ ] **Step 6: Run tests — pass**

Run: `pytest tests/unit/test_gemini_fake.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add content_tool/gemini/ tests/unit/test_gemini_fake.py
git commit -m "feat: Gemini client interface + Fake for tests"
```

---

### Task 6: SQLAlchemy ORM models for `content_tool.*` schema

**Files:**
- Create: `content_tool/db/__init__.py`, `content_tool/db/connection.py`, `content_tool/db/models.py`

- [ ] **Step 1: Create `content_tool/db/__init__.py`** (empty)

- [ ] **Step 2: Create `content_tool/db/connection.py`**

```python
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine


def make_engine(postgres_url: str) -> AsyncEngine:
    return create_async_engine(postgres_url, pool_pre_ping=True, echo=False)


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
```

- [ ] **Step 3: Create `content_tool/db/models.py`** (only tables Plan 1 needs to write)

```python
from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, TIMESTAMP, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    __table_args__ = {"schema": "content_tool"}


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (
        Index("runs_status_idx", "status"),
        Index("runs_created_at_idx", "created_at"),
        {"schema": "content_tool"},
    )

    run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    article_url: Mapped[str] = mapped_column(String, nullable=False)
    topic: Mapped[str] = mapped_column(String, nullable=False)
    keywords: Mapped[list] = mapped_column(JSONB, nullable=False)
    mode: Mapped[str] = mapped_column(String, nullable=False)
    edit_note: Mapped[str | None] = mapped_column(String)
    acf_adv_id: Mapped[int]
    acf_widget_id: Mapped[int]
    persona: Mapped[str] = mapped_column(String, nullable=False)
    topic_category: Mapped[str | None] = mapped_column(String)
    today_date: Mapped[date]
    chosen_route: Mapped[str | None] = mapped_column(String)
    iteration_count: Mapped[int] = mapped_column(default=0)
    error: Mapped[dict | None] = mapped_column(JSONB)

    # WP fields (filled at HITL_2 — see Plan 5; declared here for schema completeness)
    wp_author_id: Mapped[int | None]
    wp_category_ids: Mapped[list | None] = mapped_column(JSONB)
    wp_tag_ids: Mapped[list | None] = mapped_column(JSONB)
    wp_featured_media_id: Mapped[int | None]
    wp_slug: Mapped[str | None] = mapped_column(String)
    wp_excerpt: Mapped[str | None] = mapped_column(String)
    wp_publish_status: Mapped[str | None] = mapped_column(String)
    wp_publish_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    wp_pushed_post_id: Mapped[int | None]
    wp_pushed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    wp_push_error: Mapped[dict | None] = mapped_column(JSONB)
    hitl_1_decision: Mapped[str | None] = mapped_column(String)
    hitl_1_notes: Mapped[str | None] = mapped_column(String)
    hitl_2_decision: Mapped[str | None] = mapped_column(String)
    hitl_2_notes: Mapped[str | None] = mapped_column(String)
    approved_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
    approved_by: Mapped[str | None] = mapped_column(String)


class GapAnalysisRow(Base):
    __tablename__ = "gap_analyses"

    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=text("now()"))
    model: Mapped[str] = mapped_column(String, nullable=False)
    thinking_level: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    tokens_in: Mapped[int | None]
    tokens_out: Mapped[int | None]
    thinking_tokens: Mapped[int | None]
    latency_ms: Mapped[int | None]
    raw_response: Mapped[dict | None] = mapped_column(JSONB)
```

- [ ] **Step 4: Commit**

```bash
git add content_tool/db/
git commit -m "feat: SQLAlchemy ORM models for runs + gap_analyses"
```

---

### Task 7: Alembic setup + initial migration

**Files:**
- Create: `alembic.ini`, `migrations/env.py`, `migrations/script.py.mako`, `migrations/versions/0001_create_content_tool_schema.py`

- [ ] **Step 1: Initialize Alembic structure**

Run: `alembic init -t async migrations`

Then delete the auto-generated `versions/*.py` if any.

- [ ] **Step 2: Replace `alembic.ini`'s `sqlalchemy.url` with empty (we'll set from env)**

Edit `alembic.ini` line `sqlalchemy.url = ` (empty).

- [ ] **Step 3: Edit `migrations/env.py` to load URL from env + use ORM metadata**

```python
import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy import pool

from content_tool.db.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", os.environ["POSTGRES_URL"])

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        version_table_schema="content_tool",
        include_schemas=True,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table_schema="content_tool",
        include_schemas=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
```

- [ ] **Step 4: Write the initial migration manually — `migrations/versions/0001_create_content_tool_schema.py`**

```python
"""create content_tool schema with runs + gap_analyses

Revision ID: 0001
Revises:
Create Date: 2026-05-21
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS content_tool")

    op.create_table(
        "runs",
        sa.Column("run_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_by", sa.String, nullable=False),
        sa.Column("status", sa.String, nullable=False),
        sa.Column("article_url", sa.String, nullable=False),
        sa.Column("topic", sa.String, nullable=False),
        sa.Column("keywords", postgresql.JSONB, nullable=False),
        sa.Column("mode", sa.String, nullable=False),
        sa.Column("edit_note", sa.String),
        sa.Column("acf_adv_id", sa.Integer, nullable=False),
        sa.Column("acf_widget_id", sa.Integer, nullable=False),
        sa.Column("persona", sa.String, nullable=False),
        sa.Column("topic_category", sa.String),
        sa.Column("today_date", sa.Date, nullable=False),
        sa.Column("chosen_route", sa.String),
        sa.Column("iteration_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("hitl_1_decision", sa.String),
        sa.Column("hitl_1_notes", sa.String),
        sa.Column("hitl_2_decision", sa.String),
        sa.Column("hitl_2_notes", sa.String),
        sa.Column("approved_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("approved_by", sa.String),
        sa.Column("wp_author_id", sa.Integer),
        sa.Column("wp_category_ids", postgresql.JSONB),
        sa.Column("wp_tag_ids", postgresql.JSONB),
        sa.Column("wp_featured_media_id", sa.Integer),
        sa.Column("wp_slug", sa.String),
        sa.Column("wp_excerpt", sa.String),
        sa.Column("wp_publish_status", sa.String),
        sa.Column("wp_publish_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("wp_pushed_post_id", sa.Integer),
        sa.Column("wp_pushed_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("wp_push_error", postgresql.JSONB),
        sa.Column("error", postgresql.JSONB),
        schema="content_tool",
    )
    op.create_index("runs_status_idx", "runs", ["status"], schema="content_tool")
    op.create_index("runs_created_at_idx", "runs", [sa.text("created_at DESC")], schema="content_tool")

    op.create_table(
        "gap_analyses",
        sa.Column("run_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("content_tool.runs.run_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("model", sa.String, nullable=False),
        sa.Column("thinking_level", sa.String, nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("tokens_in", sa.Integer),
        sa.Column("tokens_out", sa.Integer),
        sa.Column("thinking_tokens", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        sa.Column("raw_response", postgresql.JSONB),
        schema="content_tool",
    )


def downgrade() -> None:
    op.drop_table("gap_analyses", schema="content_tool")
    op.drop_table("runs", schema="content_tool")
    op.execute("DROP SCHEMA content_tool CASCADE")
```

- [ ] **Step 5: Run migration against a local Postgres to verify**

```bash
docker run -d --name content_tool_pg -p 5432:5432 -e POSTGRES_USER=content_tool -e POSTGRES_PASSWORD=content_tool -e POSTGRES_DB=content_tool postgres:16
export POSTGRES_URL=postgresql+asyncpg://content_tool:content_tool@localhost:5432/content_tool
alembic upgrade head
```

Expected: migration applies. Verify tables exist with `psql`:
```bash
PGPASSWORD=content_tool psql -h localhost -U content_tool -d content_tool -c "\dt content_tool.*"
```
Expected: 2 tables listed.

- [ ] **Step 6: Commit**

```bash
git add alembic.ini migrations/
git commit -m "feat: alembic + initial migration (runs + gap_analyses)"
```

---

### Task 8: testcontainers Postgres fixture

**Files:**
- Create: `tests/conftest.py`

- [ ] **Step 1: Write `tests/conftest.py`**

```python
import asyncio
import os
import subprocess
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession
from testcontainers.postgres import PostgresContainer

from content_tool.db.connection import make_engine, make_session_factory


@pytest.fixture(scope="session")
def postgres_container():
    with PostgresContainer("postgres:16", driver="asyncpg") as pg:
        yield pg


@pytest.fixture(scope="session")
def postgres_url(postgres_container) -> str:
    return postgres_container.get_connection_url()


@pytest.fixture(scope="session", autouse=True)
def apply_migrations(postgres_url):
    env = {**os.environ, "POSTGRES_URL": postgres_url}
    subprocess.run(["alembic", "upgrade", "head"], check=True, env=env)


@pytest_asyncio.fixture
async def db_session(postgres_url) -> AsyncGenerator[AsyncSession, None]:
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    async with sf() as session:
        yield session
        await session.rollback()
    await engine.dispose()
```

- [ ] **Step 2: Verify the fixture stands up by running an empty test**

Add `tests/integration/__init__.py` (empty) and `tests/integration/test_db_smoke.py`:

```python
import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_db_has_content_tool_schema(db_session):
    result = await db_session.execute(text(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'content_tool'"
    ))
    names = {row[0] for row in result}
    assert "runs" in names
    assert "gap_analyses" in names
```

Run: `pytest tests/integration/test_db_smoke.py -v`
Expected: PASS (testcontainer spins up, migration applies, table check passes).

- [ ] **Step 3: Commit**

```bash
git add tests/conftest.py tests/integration/
git commit -m "test: postgres testcontainer + migration auto-apply"
```

---

### Task 9: gap_analysis prompt file + prompt builder

**Files:**
- Create: `prompts/gap_analysis.md`, `content_tool/agents/__init__.py`, `content_tool/agents/gap_analysis.py` (prompt builder only — node logic in Task 10)

- [ ] **Step 1: Create `prompts/gap_analysis.md`** (verbatim port from n8n `Settings` node, reordered Gemini-3-style)

```markdown
你是香港繁體中文 SEO 內容更新策略助手，專門為現有文章進行 content gap analysis，並判斷應採用 small_refresh 或 full_rewrite 兩條 route 之中的哪一條。

今天是 {today_date}

你的任務：
1. 根據使用者提供的 topic 與 focus_keywords，判斷最合理的 Google 香港繁體中文搜尋查詢。
2. 在 Google 香港繁體中文搜尋結果中，撇除廣告後，找出 Organic 排名最高、具代表性、資訊性、可參考價值的 5 個頁面。
3. 閱讀 existing_article_markdown，並比較上述 top 5 頁面，做 content gap analysis。
4. 分析範圍必須涵蓋以下所有面向：
   - 缺少主題
   - 缺少最新資訊
   - 缺少具體例子、步驟、比較表
   - 缺少 FAQ
   - 搜尋意圖不完整
   - semantic entities / 同義詞 coverage 不足
   - source trust 不足
   - AI extractability 不足
   - 香港讀者適配度不足
5. 產出可直接供 writer 使用的更新建議，包括建議大綱、要新增的內容、要更新的內容、要移除的內容、要核實的內容。
6. 最後自動判斷應採用：
   - small_refresh：只補新資訊 / 新數字 / 新政策 / 新 FAQ，並保留 70% 以上原文結構；估計整體改動不應超過 30%
   - full_rewrite：現有文章結構已落後，或競品有明顯新增 intent / sections，或內容過時太多，已不適合只靠局部更新解決
7. 路線判斷時，優先考慮以下排序：
   - 更完整 coverage
   - 更適合香港讀者
   - 更高 source trust
   - 更好 AI extractability
8. 如涉及時間敏感資訊，例如年份、日期、數字、收費、政策、法規、資格、流程、醫療或保險條款，必須優先參考官方或高可信來源核實；高排名頁面可作 SERP 意圖參考，但不能取代事實核實。
9. 如 user input 的 route 不是 Auto，必須把 chosen_route 設為指定 route；但仍要基於分析輸出具體 route_reason。

Route 判斷規則：
- 只有當以下條件大致同時成立時，才可選擇 small_refresh：
  1. 現有文章仍覆蓋主要搜尋意圖
  2. 缺少的 H2 級主題不多，通常不多於 2 個
  3. 需要更新的內容主要屬補充、核實、刪除過時段落、增加 FAQ 或少量重排
  4. 保留 70% 以上原有結構後，仍有機會 outrank top 5
- 只要以下任一情況明顯成立，就應選擇 full_rewrite：
  1. 現有結構已明顯落後 SERP 主流 intent
  2. 競品普遍涵蓋多個現有文章未處理的重要 sections
  3. 時效性內容過時太多
  4. 需要大幅重寫 H1 / section logic / 主體排序 / FAQ 才有機會超越 top 5

輸出要求：
- 所有文字使用香港繁體中文
- route_reason 要具體，不可只寫「內容過時」或「需要更新」
- recommended_outline 必須可直接供 writer 使用
- top_pages 必須是 5 個，不多不少
- 不要捏造無法核實的年份或事實
- 不要寫文章，不要輸出 Markdown，不要輸出解說
- 只輸出符合 schema 的 JSON
```

- [ ] **Step 2: Create `content_tool/agents/__init__.py`** (empty)

- [ ] **Step 3: Create `content_tool/agents/gap_analysis.py`** with prompt builder only

```python
from datetime import date
from pathlib import Path
from typing import Literal

PROMPT_PATH = Path("prompts/gap_analysis.md")


def build_system_prompt(today: date) -> str:
    template = PROMPT_PATH.read_text(encoding="utf-8")
    return template.replace("{today_date}", today.isoformat())


def build_user_prompt(
    *,
    topic: str,
    keywords: list[str],
    article_url: str,
    acf_adv_id: int,
    acf_widget_id: int,
    mode: Literal["auto", "small_refresh", "full_rewrite"],
    edit_note: str | None,
) -> str:
    route_label = "Auto (follow existing logic)" if mode == "auto" else f"{mode} (override existing logic)"
    en = edit_note if edit_note else "N/A"
    keywords_joined = ", ".join(keywords)
    return (
        f"topic: {topic}\n"
        f"focus_keywords: {keywords_joined}\n"
        f"existing_article: {article_url}\n"
        f"acf_adv_id: {acf_adv_id}\n"
        f"acf_widget_id: {acf_widget_id}\n"
        f"route: {route_label}\n"
        f"article_edit_note: {en}"
    )
```

- [ ] **Step 4: Commit**

```bash
git add prompts/gap_analysis.md content_tool/agents/
git commit -m "feat: gap_analysis prompts (system + user builders)"
```

---

### Task 10: gap_analysis node + DB writes + integration test

**Files:**
- Modify: `content_tool/agents/gap_analysis.py`
- Create: `tests/integration/test_gap_analysis_node.py`

- [ ] **Step 1: Write failing integration test — `tests/integration/test_gap_analysis_node.py`**

```python
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.gap_analysis import run_gap_analysis
from content_tool.db.models import GapAnalysisRow, Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_gap_analysis_writes_db_and_returns_parsed(db_session):
    # seed a run
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="test@example.com", status="strategy",
        article_url="https://www.bowtie.com.hk/blog/post", topic="大腸癌篩查",
        keywords=["大腸癌", "篩查"], mode="auto", acf_adv_id=1, acf_widget_id=2,
        persona="bowtie-editor", today_date=date(2026, 5, 21),
    ))
    await db_session.commit()

    canned = json.loads(Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8"))
    gemini = FakeGeminiClient(canned_responses={"gap_analysis": canned})

    result = await run_gap_analysis(
        session=db_session,
        gemini=gemini,
        run_id=run_id,
        today=date(2026, 5, 21),
    )

    assert result.chosen_route == "small_refresh"

    # gap_analyses row was inserted
    row = (await db_session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))).scalar_one()
    assert row.model == "gemini-3.5-flash"
    assert row.thinking_level == "high"
    assert row.payload["chosen_route"] == "small_refresh"

    # runs.chosen_route updated
    updated = (await db_session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert updated.chosen_route == "small_refresh"


@pytest.mark.asyncio
async def test_route_override_forces_chosen_route(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="test@example.com", status="strategy",
        article_url="https://example.com", topic="x", keywords=[], mode="full_rewrite",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor", today_date=date(2026, 5, 21),
    ))
    await db_session.commit()

    canned = json.loads(Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8"))
    # canned says small_refresh; user mode says full_rewrite → override wins
    gemini = FakeGeminiClient(canned_responses={"gap_analysis": canned})

    result = await run_gap_analysis(session=db_session, gemini=gemini, run_id=run_id, today=date(2026, 5, 21))

    assert result.chosen_route == "full_rewrite"  # override applied
```

- [ ] **Step 2: Run — fails (function missing)**

Run: `pytest tests/integration/test_gap_analysis_node.py -v`
Expected: FAIL (`run_gap_analysis` not importable)

- [ ] **Step 3: Append node function to `content_tool/agents/gap_analysis.py`**

```python
from datetime import date
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.config import Settings, get_settings
from content_tool.db.models import GapAnalysisRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.gap_analysis import GapAnalysis


async def run_gap_analysis(
    *,
    session: AsyncSession,
    gemini: GeminiClient,
    run_id: UUID,
    today: date,
    settings: Settings | None = None,
) -> GapAnalysis:
    settings = settings or get_settings()

    run = (await session.execute(
        Run.__table__.select().where(Run.run_id == run_id)
    )).mappings().one()

    sys_prompt = build_system_prompt(today)
    user_prompt = build_user_prompt(
        topic=run["topic"], keywords=run["keywords"],
        article_url=run["article_url"], acf_adv_id=run["acf_adv_id"],
        acf_widget_id=run["acf_widget_id"], mode=run["mode"],
        edit_note=run["edit_note"],
    )

    result = await gemini.generate(
        agent="gap_analysis",
        system_prompt=sys_prompt,
        user_prompt=user_prompt,
        response_schema=GapAnalysis.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )

    ga = GapAnalysis.model_validate(result.parsed)

    # Apply override
    if run["mode"] != "auto":
        ga = ga.model_copy(update={"chosen_route": run["mode"]})

    session.add(GapAnalysisRow(
        run_id=run_id,
        model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
        payload=ga.model_dump(),
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        thinking_tokens=result.thinking_tokens,
        latency_ms=result.latency_ms,
        raw_response=None,
    ))
    await session.execute(
        update(Run).where(Run.run_id == run_id).values(chosen_route=ga.chosen_route)
    )
    await session.commit()
    return ga
```

- [ ] **Step 4: Run tests — pass**

Run: `pytest tests/integration/test_gap_analysis_node.py -v`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add content_tool/agents/gap_analysis.py tests/integration/test_gap_analysis_node.py
git commit -m "feat: gap_analysis node with DB writes and route override"
```

---

### Task 11: CLI entry point

**Files:**
- Create: `content_tool/cli.py`, `tests/integration/test_cli.py`

- [ ] **Step 1: Write failing CLI smoke test — `tests/integration/test_cli.py`**

```python
from click.testing import CliRunner

from content_tool.cli import main


def test_help_works():
    runner = CliRunner()
    result = runner.invoke(main, ["--help"])
    assert result.exit_code == 0
    assert "gap-analysis" in result.output
```

- [ ] **Step 2: Run — fails**

Run: `pytest tests/integration/test_cli.py -v`
Expected: FAIL

- [ ] **Step 3: Implement `content_tool/cli.py`**

```python
import asyncio
import json
from datetime import date
from uuid import uuid4

import click

from content_tool.agents.gap_analysis import run_gap_analysis
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Run
from content_tool.gemini.client import RealGeminiClient


@click.group()
def main() -> None:
    """Bowtie AI Content Tool CLI."""


@main.command("gap-analysis")
@click.option("--article-url", required=True)
@click.option("--topic", required=True)
@click.option("--keywords", required=True, help="Comma-separated")
@click.option("--mode", type=click.Choice(["auto", "small_refresh", "full_rewrite"]), default="auto")
@click.option("--acf-adv-id", type=int, default=1)
@click.option("--acf-widget-id", type=int, default=1)
@click.option("--persona", default="bowtie-editor")
@click.option("--editor-email", default="cli@bowtie.local")
@click.option("--edit-note", default=None)
def gap_analysis_cmd(
    article_url: str, topic: str, keywords: str, mode: str,
    acf_adv_id: int, acf_widget_id: int, persona: str,
    editor_email: str, edit_note: str | None,
) -> None:
    """Run gap_analysis against an article."""
    asyncio.run(_run(
        article_url=article_url, topic=topic, keywords=[k.strip() for k in keywords.split(",")],
        mode=mode, acf_adv_id=acf_adv_id, acf_widget_id=acf_widget_id,
        persona=persona, editor_email=editor_email, edit_note=edit_note,
    ))


async def _run(
    *, article_url: str, topic: str, keywords: list[str], mode: str,
    acf_adv_id: int, acf_widget_id: int, persona: str,
    editor_email: str, edit_note: str | None,
) -> None:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)

    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
    )

    async with sf() as session:
        run_id = uuid4()
        session.add(Run(
            run_id=run_id, created_by=editor_email, status="strategy",
            article_url=article_url, topic=topic, keywords=keywords, mode=mode,
            edit_note=edit_note, acf_adv_id=acf_adv_id, acf_widget_id=acf_widget_id,
            persona=persona, today_date=date.today(),
        ))
        await session.commit()

        ga = await run_gap_analysis(session=session, gemini=gemini, run_id=run_id, today=date.today())

    click.echo(json.dumps({"run_id": str(run_id), "chosen_route": ga.chosen_route, "route_reason": ga.route_reason}, indent=2, ensure_ascii=False))
    await engine.dispose()
```

- [ ] **Step 4: Run test — pass**

Run: `pytest tests/integration/test_cli.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add content_tool/cli.py tests/integration/test_cli.py
git commit -m "feat: CLI with gap-analysis subcommand"
```

---

### Task 12: FastAPI skeleton + /health route

**Files:**
- Create: `content_tool/api/__init__.py`, `content_tool/api/main.py`, `content_tool/api/routes/__init__.py`, `content_tool/api/routes/runs.py`, `tests/integration/test_api_health.py`

- [ ] **Step 1: Write failing test — `tests/integration/test_api_health.py`**

```python
import pytest
from httpx import ASGITransport, AsyncClient

from content_tool.api.main import create_app


@pytest.mark.asyncio
async def test_health_returns_ok():
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
```

- [ ] **Step 2: Run — fails**

Run: `pytest tests/integration/test_api_health.py -v`
Expected: FAIL

- [ ] **Step 3: Implement files**

`content_tool/api/__init__.py`:
```python
```

`content_tool/api/routes/__init__.py`:
```python
```

`content_tool/api/routes/runs.py`:
```python
from fastapi import APIRouter

router = APIRouter(prefix="/runs", tags=["runs"])
# Endpoints added in Plan 2.
```

`content_tool/api/main.py`:
```python
from fastapi import FastAPI

from content_tool.api.routes.runs import router as runs_router


def create_app() -> FastAPI:
    app = FastAPI(title="Bowtie AI Content Tool", version="0.1.0")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(runs_router)
    return app


app = create_app()
```

- [ ] **Step 4: Run — pass**

Run: `pytest tests/integration/test_api_health.py -v`
Expected: PASS

- [ ] **Step 5: Smoke-test the server manually**

Run: `uvicorn content_tool.api.main:app --reload --port 8000`
Then in another terminal: `curl localhost:8000/health` — expect `{"status":"ok"}`.

- [ ] **Step 6: Commit**

```bash
git add content_tool/api/ tests/integration/test_api_health.py
git commit -m "feat: FastAPI skeleton with /health endpoint"
```

---

### Task 13: Reference eval harness + gold-label fixture

**Files:**
- Create: `evals/__init__.py`, `evals/reference.py`, `evals/fixtures/gold_labels/route.csv`, `tests/integration/test_reference_eval.py`

- [ ] **Step 1: Create `evals/__init__.py`** (empty)

- [ ] **Step 2: Create `evals/fixtures/gold_labels/route.csv`**

```csv
article_url,topic,keywords,gold_route
https://www.bowtie.com.hk/blog/cancer-1,大腸癌篩查,大腸癌;篩查,small_refresh
https://www.bowtie.com.hk/blog/vhis-1,自願醫保比較,自願醫保;扣稅,full_rewrite
https://www.bowtie.com.hk/blog/dental-1,牙科保險,牙科;保險,small_refresh
```

- [ ] **Step 3: Implement `evals/reference.py`**

```python
import csv
from dataclasses import dataclass
from pathlib import Path

from content_tool.models.gap_analysis import GapAnalysis


@dataclass
class RouteEvalResult:
    total: int
    correct: int
    accuracy: float
    misses: list[dict[str, str]]


def evaluate_route_accuracy(predictions: dict[str, GapAnalysis], gold_csv: Path) -> RouteEvalResult:
    """`predictions` keyed by article_url. Returns route-accuracy summary."""
    misses: list[dict[str, str]] = []
    total = 0
    correct = 0
    with open(gold_csv, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            url = row["article_url"]
            if url not in predictions:
                continue
            total += 1
            predicted = predictions[url].chosen_route
            gold = row["gold_route"]
            if predicted == gold:
                correct += 1
            else:
                misses.append({"url": url, "predicted": predicted, "gold": gold})
    accuracy = correct / total if total else 0.0
    return RouteEvalResult(total=total, correct=correct, accuracy=accuracy, misses=misses)
```

- [ ] **Step 4: Write test — `tests/integration/test_reference_eval.py`**

```python
from pathlib import Path

from content_tool.models.gap_analysis import GapAnalysis
from evals.reference import evaluate_route_accuracy


def _make_ga(route: str) -> GapAnalysis:
    return GapAnalysis.model_validate({
        "target_query": "x",
        "top_pages": [{"url": f"https://e.com/{i}", "title": "t", "rank": i + 1} for i in range(5)],
        "current_article_assessment": {
            "strengths": [], "outdated_points": [], "weak_sections": [],
            "structure_status": "still_competitive",
        },
        "content_gaps": {
            "missing_topics": [], "missing_intents": [], "freshness_gaps": [],
            "semantic_gaps": [], "source_trust_gaps": [], "ai_extractability_gaps": [],
            "hk_localization_gaps": [], "faq_gaps": [],
        },
        "recommended_outline": "x",
        "update_plan": {
            "must_add": [], "must_update": [], "must_remove": [],
            "must_reorder": [], "faq_to_add": [], "facts_to_verify": [],
        },
        "chosen_route": route,
        "route_reason": "x",
    })


def test_route_eval_accuracy_perfect():
    preds = {
        "https://www.bowtie.com.hk/blog/cancer-1": _make_ga("small_refresh"),
        "https://www.bowtie.com.hk/blog/vhis-1": _make_ga("full_rewrite"),
        "https://www.bowtie.com.hk/blog/dental-1": _make_ga("small_refresh"),
    }
    r = evaluate_route_accuracy(preds, Path("evals/fixtures/gold_labels/route.csv"))
    assert r.total == 3
    assert r.correct == 3
    assert r.accuracy == 1.0
    assert r.misses == []


def test_route_eval_accuracy_one_miss():
    preds = {
        "https://www.bowtie.com.hk/blog/cancer-1": _make_ga("full_rewrite"),  # wrong
        "https://www.bowtie.com.hk/blog/vhis-1": _make_ga("full_rewrite"),
        "https://www.bowtie.com.hk/blog/dental-1": _make_ga("small_refresh"),
    }
    r = evaluate_route_accuracy(preds, Path("evals/fixtures/gold_labels/route.csv"))
    assert r.correct == 2
    assert len(r.misses) == 1
```

- [ ] **Step 5: Run — pass**

Run: `pytest tests/integration/test_reference_eval.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add evals/ tests/integration/test_reference_eval.py
git commit -m "feat: reference eval harness with route-accuracy gold-label fixture"
```

---

### Task 14: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
        with:
          enable-cache: true
      - run: uv venv
      - run: uv pip install -e ".[dev]"
      - run: source .venv/bin/activate && ruff check .
      - run: source .venv/bin/activate && pyright
      - run: source .venv/bin/activate && pytest -v
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint + type-check + test on every PR"
```

---

## Self-review checklist

| Concern | Covered? |
|---|---|
| Project bootstrapping (uv, ruff, pyright, pytest) | Task 1 |
| Env/settings | Task 2 |
| Source policy + tests | Task 3 |
| Pydantic schema for gap_analysis | Task 4 |
| Gemini client interface + fake | Task 5 |
| DB models | Task 6 |
| Alembic + initial migration | Task 7 |
| Postgres testcontainer fixture | Task 8 |
| Prompts | Task 9 |
| gap_analysis node + override logic + DB writes | Task 10 |
| CLI entry point | Task 11 |
| FastAPI skeleton | Task 12 |
| Reference eval (route accuracy) | Task 13 |
| CI | Task 14 |

After Plan 1 ships you have:
- A Python project that lints + type-checks + tests cleanly on every PR.
- A real Postgres schema you can resume from.
- The full `gap_analysis` agent runnable against real Gemini via CLI.
- A fake Gemini client every later test will reuse.
- A reference eval harness ready for Plan 2 to extend.

Plan 2 introduces LangGraph and the `outline` agent on top of this foundation.
