# Voices Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/voices` page that lists every persona, lets editors create / edit / archive personas, and shows the LangGraph topology with each LLM agent's system prompt template and a "load real user prompt from past run" picker — replacing today's YAML-only workflow.

**Architecture:** New `content_tool.personas` table (Alembic migration) becomes source of truth; YAML file stays as cold-start seed and fallback. `load_persona()` becomes async, DB-first. Two new FastAPI routers: `/personas` (CRUD + usage) and `/prompts` (graph metadata + template content + on-demand user-prompt rendering from past run state). New Next.js route `/voices` reuses existing broadsheet typography; key components are `Rolodex`, `StyleCard`, `RedlineList` (the visual hook), `PressWorkflow` + `AgentRow`, `PromptInspector`, `ComposeDrawer`.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy (async) + Alembic, PostgreSQL, Pydantic v2, pytest + testcontainers; Next.js (custom — see `web/AGENTS.md` — read `node_modules/next/dist/docs/` before touching framework APIs), React Query (`@tanstack/react-query`), TypeScript, Tailwind, the project's existing `ui/*` primitives.

**Spec:** [docs/superpowers/specs/2026-05-26-voices-page-design.md](../specs/2026-05-26-voices-page-design.md)

**File map (locks in decomposition):**

Backend
- Create `alembic/versions/0008_personas.py` — table + seed insert
- Create `content_tool/db/persona_model.py` — `Persona` SQLAlchemy row (kept out of `db/models.py` to avoid that file growing)
- Modify `content_tool/db/models.py` — re-export `Persona` for callers that import from the umbrella module
- Modify `content_tool/policy/personas.py` — async, DB-first `load_persona()`; add CRUD helpers
- Modify `content_tool/agents/writer.py`, `content_tool/agents/audit.py`, `content_tool/refresh/evaluator.py` — `await load_persona(...)`
- Create `content_tool/api/routes/personas.py` — CRUD + usage
- Create `content_tool/api/routes/prompts.py` — `/graph`, `/templates/{id}`, `/user-example`
- Create `content_tool/api/prompt_graph.py` — hand-written graph metadata constant
- Modify `content_tool/api/schemas.py` — add `PersonaIn`/`PersonaOut`/`PersonaUsage`
- Modify `content_tool/api/main.py` — `include_router` the two new routers

Web
- Modify `web/lib/types.ts` — `Persona`, `PromptGraph`, `PromptNode`, `UserPromptExample`
- Modify `web/lib/api.ts` — `personasApi`, `promptsApi`
- Modify `web/components/Masthead.tsx` — nav entry
- Create `web/app/voices/page.tsx`
- Create `web/components/voices/Rolodex.tsx`
- Create `web/components/voices/StyleCard.tsx`
- Create `web/components/voices/RedlineList.tsx`
- Create `web/components/voices/PressWorkflow.tsx`
- Create `web/components/voices/AgentRow.tsx`
- Create `web/components/voices/PromptInspector.tsx`
- Create `web/components/voices/UserExamplePicker.tsx`
- Create `web/components/voices/ComposeDrawer.tsx`

Tests
- `tests/unit/test_persona_load.py` — extend with DB cases
- `tests/integration/test_api_personas.py` — new
- `tests/integration/test_api_prompts.py` — new
- `tests/unit/test_prompt_graph.py` — new (sanity check the hand-written constant)

---

## Task 1: Alembic migration + seed

**Files:**
- Create: `alembic/versions/0008_personas.py`
- Reference (read-only): `alembic/versions/0007_evals.py`, `config/personas/bowtie-editor.yaml`

- [ ] **Step 1: Write the migration**

```python
# alembic/versions/0008_personas.py
"""personas

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-26
"""

from pathlib import Path

import sqlalchemy as sa
import yaml
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    op.create_table(
        "personas",
        sa.Column("persona_id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("slug", sa.String, nullable=False, unique=True),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("voice_rules", postgresql.JSONB, nullable=False),
        sa.Column("banned_terms", postgresql.JSONB, nullable=False),
        sa.Column("required_phrasings", postgresql.JSONB, nullable=False),
        sa.Column("disclaimer_templates", postgresql.JSONB, nullable=False),
        sa.Column("tone_examples", postgresql.JSONB, nullable=False),
        sa.Column("is_archived", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("created_by", sa.String, nullable=True),
        sa.Column("updated_by", sa.String, nullable=True),
        schema="content_tool",
    )

    # Seed bowtie-editor from the YAML file so existing runs continue to resolve.
    yaml_path = Path(__file__).resolve().parents[2] / "config" / "personas" / "bowtie-editor.yaml"
    raw = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    op.execute(
        sa.text(
            "INSERT INTO content_tool.personas "
            "(slug, name, voice_rules, banned_terms, required_phrasings, "
            " disclaimer_templates, tone_examples) "
            "VALUES (:slug, :name, :vr, :bt, :rp, :dt, :te)"
        ).bindparams(
            sa.bindparam("slug", "bowtie-editor"),
            sa.bindparam("name", raw["name"]),
            sa.bindparam("vr", raw["voice_rules"], type_=postgresql.JSONB),
            sa.bindparam("bt", raw["banned_terms"], type_=postgresql.JSONB),
            sa.bindparam("rp", raw["required_phrasings"], type_=postgresql.JSONB),
            sa.bindparam("dt", raw["disclaimer_templates"], type_=postgresql.JSONB),
            sa.bindparam("te", raw["tone_examples"], type_=postgresql.JSONB),
        )
    )


def downgrade() -> None:
    op.drop_table("personas", schema="content_tool")
```

- [ ] **Step 2: Apply migration locally and verify**

```bash
alembic upgrade head
```

Then in a psql shell or via SQLAlchemy:

```bash
psql "$POSTGRES_URL" -c "SELECT slug, name FROM content_tool.personas;"
```

Expected: one row, `bowtie-editor | Bowtie 編輯`.

- [ ] **Step 3: Verify downgrade works**

```bash
alembic downgrade -1 && alembic upgrade head
```

Expected: no error; table re-created and re-seeded.

- [ ] **Step 4: Commit**

```bash
git add alembic/versions/0008_personas.py
git commit -m "feat(db): personas table + seed bowtie-editor from YAML"
```

---

## Task 2: SQLAlchemy `Persona` model

**Files:**
- Create: `content_tool/db/persona_model.py`
- Modify: `content_tool/db/models.py` (add `from content_tool.db.persona_model import Persona  # noqa: F401`)
- Test: `tests/unit/test_persona_load.py` (extend later in Task 5)

- [ ] **Step 1: Write the model**

```python
# content_tool/db/persona_model.py
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import TIMESTAMP, Boolean, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from content_tool.db.models import Base


class Persona(Base):
    __tablename__ = "personas"
    __table_args__ = {"schema": "content_tool"}  # noqa: RUF012

    persona_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    slug: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    voice_rules: Mapped[list] = mapped_column(JSONB, nullable=False)
    banned_terms: Mapped[list] = mapped_column(JSONB, nullable=False)
    required_phrasings: Mapped[list] = mapped_column(JSONB, nullable=False)
    disclaimer_templates: Mapped[dict] = mapped_column(JSONB, nullable=False)
    tone_examples: Mapped[dict] = mapped_column(JSONB, nullable=False)
    is_archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    created_by: Mapped[str | None] = mapped_column(String)
    updated_by: Mapped[str | None] = mapped_column(String)
```

- [ ] **Step 2: Re-export from models.py**

Add at the bottom of `content_tool/db/models.py`:

```python
from content_tool.db.persona_model import Persona  # noqa: E402, F401
```

(Placed at the bottom because `persona_model.py` imports `Base` from this file — avoids a circular import at module-load time.)

- [ ] **Step 3: Smoke-test the import**

```bash
python -c "from content_tool.db.models import Persona; print(Persona.__tablename__)"
```

Expected: `personas`.

- [ ] **Step 4: Commit**

```bash
git add content_tool/db/persona_model.py content_tool/db/models.py
git commit -m "feat(db): Persona SQLAlchemy model"
```

---

## Task 3: Async `load_persona` (DB-first, YAML fallback) + CRUD helpers

**Files:**
- Modify: `content_tool/policy/personas.py`
- Test: `tests/unit/test_persona_load.py`

- [ ] **Step 1: Write the failing tests**

Replace the contents of `tests/unit/test_persona_load.py`:

```python
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Persona
from content_tool.policy.personas import (
    create_persona,
    list_personas,
    load_persona,
    load_persona_from_yaml,
    set_archived,
    update_persona,
)


@pytest.mark.asyncio
async def test_load_persona_falls_back_to_yaml_when_db_empty(db_session: AsyncSession):
    p = await load_persona("bowtie-editor", session=db_session)
    assert p.name == "Bowtie 編輯"
    assert "信息" in p.banned_terms


@pytest.mark.asyncio
async def test_load_persona_reads_from_db_when_present(db_session: AsyncSession):
    db_session.add(Persona(
        slug="ghost-writer",
        name="Ghost",
        voice_rules=["rule A"],
        banned_terms=["X"],
        required_phrasings=["Y"],
        disclaimer_templates={"medical": "..."},
        tone_examples={"good": ["g"], "bad": ["b"]},
    ))
    await db_session.commit()
    p = await load_persona("ghost-writer", session=db_session)
    assert p.name == "Ghost"
    assert p.voice_rules == ["rule A"]


def test_load_persona_from_yaml_pure_sync():
    p = load_persona_from_yaml("bowtie-editor")
    assert p.name == "Bowtie 編輯"


@pytest.mark.asyncio
async def test_create_and_update_persona(db_session: AsyncSession):
    created = await create_persona(
        session=db_session,
        slug="new-voice",
        name="New Voice",
        voice_rules=["r1"],
        banned_terms=["b1"],
        required_phrasings=["p1"],
        disclaimer_templates={},
        tone_examples={"good": [], "bad": []},
        created_by="franco@bowtie",
    )
    assert created.slug == "new-voice"

    updated = await update_persona(
        session=db_session,
        slug="new-voice",
        patch={"name": "Renamed"},
        updated_by="franco@bowtie",
    )
    assert updated.name == "Renamed"


@pytest.mark.asyncio
async def test_archive_then_restore(db_session: AsyncSession):
    db_session.add(Persona(
        slug="will-archive", name="x",
        voice_rules=[], banned_terms=[], required_phrasings=[],
        disclaimer_templates={}, tone_examples={"good": [], "bad": []},
    ))
    await db_session.commit()

    await set_archived(session=db_session, slug="will-archive", archived=True)
    rows = await list_personas(session=db_session, include_archived=False)
    assert all(r.slug != "will-archive" for r in rows)

    rows_all = await list_personas(session=db_session, include_archived=True)
    assert any(r.slug == "will-archive" and r.is_archived for r in rows_all)
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/unit/test_persona_load.py -v
```

Expected: `ImportError` on the helper names, then test failures.

- [ ] **Step 3: Rewrite `personas.py`**

```python
# content_tool/policy/personas.py
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Persona
from content_tool.models.persona import PersonaPack

_DEFAULT_PERSONA_DIR = Path(__file__).resolve().parents[2] / "config" / "personas"


def load_persona_from_yaml(
    name: str, base_dir: Path = _DEFAULT_PERSONA_DIR
) -> PersonaPack:
    """Synchronous YAML fallback. Used at cold-start and in unit tests."""
    path = base_dir / f"{name}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return PersonaPack.model_validate(raw)


def _row_to_pack(row: Persona) -> PersonaPack:
    return PersonaPack.model_validate({
        "name": row.name,
        "voice_rules": row.voice_rules,
        "banned_terms": row.banned_terms,
        "required_phrasings": row.required_phrasings,
        "disclaimer_templates": row.disclaimer_templates,
        "tone_examples": row.tone_examples,
    })


async def load_persona(
    slug: str,
    *,
    session: AsyncSession,
) -> PersonaPack:
    """DB-first lookup with YAML fallback when no row exists for this slug."""
    row = (
        await session.execute(select(Persona).where(Persona.slug == slug))
    ).scalar_one_or_none()
    if row is not None:
        return _row_to_pack(row)
    return load_persona_from_yaml(slug)


async def list_personas(
    *, session: AsyncSession, include_archived: bool = False
) -> list[Persona]:
    q = select(Persona).order_by(Persona.created_at.asc())
    if not include_archived:
        q = q.where(Persona.is_archived.is_(False))
    return list((await session.execute(q)).scalars().all())


async def get_persona(*, session: AsyncSession, slug: str) -> Persona | None:
    return (
        await session.execute(select(Persona).where(Persona.slug == slug))
    ).scalar_one_or_none()


async def create_persona(
    *,
    session: AsyncSession,
    slug: str,
    name: str,
    voice_rules: list[str],
    banned_terms: list[str],
    required_phrasings: list[str],
    disclaimer_templates: dict[str, str],
    tone_examples: dict[str, list[str]],
    created_by: str | None = None,
) -> Persona:
    row = Persona(
        slug=slug,
        name=name,
        voice_rules=voice_rules,
        banned_terms=banned_terms,
        required_phrasings=required_phrasings,
        disclaimer_templates=disclaimer_templates,
        tone_examples=tone_examples,
        created_by=created_by,
        updated_by=created_by,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def update_persona(
    *,
    session: AsyncSession,
    slug: str,
    patch: dict[str, Any],
    updated_by: str | None = None,
) -> Persona:
    row = await get_persona(session=session, slug=slug)
    if row is None:
        raise LookupError(f"persona '{slug}' not found")
    # slug is immutable post-create
    for key, value in patch.items():
        if key == "slug":
            continue
        setattr(row, key, value)
    row.updated_at = datetime.now(UTC)
    row.updated_by = updated_by
    await session.commit()
    await session.refresh(row)
    return row


async def set_archived(
    *, session: AsyncSession, slug: str, archived: bool
) -> Persona:
    return await update_persona(
        session=session, slug=slug, patch={"is_archived": archived}
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/unit/test_persona_load.py -v
```

Expected: all five tests PASS.

- [ ] **Step 5: Commit**

```bash
git add content_tool/policy/personas.py tests/unit/test_persona_load.py
git commit -m "refactor(personas): async DB-first load_persona + CRUD helpers"
```

---

## Task 4: Update writer / audit / refresh callers to `await load_persona`

**Files:**
- Modify: `content_tool/agents/writer.py`
- Modify: `content_tool/agents/audit.py`
- Modify: `content_tool/refresh/evaluator.py`

- [ ] **Step 1: Find the call sites**

```bash
grep -rn "load_persona\|build_system_prompt" content_tool/agents content_tool/refresh
```

Expected three call sites: `writer.py:34`, `audit.py:19`, `refresh/evaluator.py`.

- [ ] **Step 2: Update writer.py**

Replace `build_system_prompt` and its caller inside `run_writer`:

```python
# content_tool/agents/writer.py — REPLACE build_system_prompt and its caller

async def build_system_prompt(
    route: str, persona_name: str, today: date, *, session: AsyncSession
) -> str:
    template = PROMPT_PATHS[route].read_text(encoding="utf-8")
    persona = await load_persona(persona_name, session=session)
    return template.replace("{persona_block}", persona.to_prompt_block()).replace(
        "{today_date}", today.isoformat()
    )
```

Inside `run_writer`, change:

```python
sys_prompt = build_system_prompt(route, run.persona, today)
```

to:

```python
sys_prompt = await build_system_prompt(route, run.persona, today, session=session)
```

- [ ] **Step 3: Update audit.py**

```python
# content_tool/agents/audit.py — REPLACE build_system_prompt and its caller

async def build_system_prompt(
    persona_name: str, today: date, *, session: AsyncSession
) -> str:
    persona = await load_persona(persona_name, session=session)
    return (
        _PROMPT_PATH.read_text(encoding="utf-8")
        .replace("{persona_block}", persona.to_prompt_block())
        .replace("{today_date}", today.isoformat())
    )
```

Inside `run_audit`, change:

```python
sys_prompt = build_system_prompt(run.persona, today)
```

to:

```python
sys_prompt = await build_system_prompt(run.persona, today, session=session)
```

- [ ] **Step 4: Update refresh/evaluator.py**

Locate the line `sys_prompt = build_system_prompt(effective_persona, date.today())` in `content_tool/refresh/evaluator.py`. The evaluator already opens a session; pass it through. If the evaluator does not already receive a session, route the call through the session it has; if it has only a session factory, open a session there. Concrete change:

```python
# whatever the current code is, replace the build_system_prompt call with:
sys_prompt = await build_system_prompt(
    effective_persona, date.today(), session=session
)
```

If `build_system_prompt` in `evaluator.py` is locally defined, mirror the writer/audit pattern: make it `async`, accept `session: AsyncSession`, `await load_persona(...)`.

- [ ] **Step 5: Run the existing test suites to confirm no regression**

```bash
pytest tests/integration/test_writer_node.py tests/integration/test_audit_node.py tests/integration/test_refresh_scan_article.py -v
```

Expected: PASS (these existing tests must continue to pass).

- [ ] **Step 6: Commit**

```bash
git add content_tool/agents/writer.py content_tool/agents/audit.py content_tool/refresh/evaluator.py
git commit -m "refactor(agents): await async load_persona in writer/audit/refresh"
```

---

## Task 5: Pydantic schemas for personas

**Files:**
- Modify: `content_tool/api/schemas.py`

- [ ] **Step 1: Add the schemas**

Append to `content_tool/api/schemas.py`:

```python
# --- Personas ---------------------------------------------------------------

class PersonaIn(BaseModel):
    slug: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")
    name: str = Field(min_length=1, max_length=128)
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, str]
    tone_examples: dict[str, list[str]]


class PersonaPatch(BaseModel):
    name: str | None = None
    voice_rules: list[str] | None = None
    banned_terms: list[str] | None = None
    required_phrasings: list[str] | None = None
    disclaimer_templates: dict[str, str] | None = None
    tone_examples: dict[str, list[str]] | None = None


class PersonaOut(BaseModel):
    persona_id: UUID
    slug: str
    name: str
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, str]
    tone_examples: dict[str, list[str]]
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    created_by: str | None
    updated_by: str | None


class PersonaUsage(BaseModel):
    slug: str
    by_status: dict[str, int]
    total: int
```

(`UUID`, `datetime`, `BaseModel`, `Field` are already imported at the top of `schemas.py` — verify before relying on that.)

- [ ] **Step 2: Verify the file parses**

```bash
python -c "from content_tool.api.schemas import PersonaIn, PersonaOut, PersonaPatch, PersonaUsage; print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add content_tool/api/schemas.py
git commit -m "feat(api): persona schemas"
```

---

## Task 6: `/personas` router

**Files:**
- Create: `content_tool/api/routes/personas.py`
- Test: `tests/integration/test_api_personas.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/integration/test_api_personas.py
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_list_personas_includes_seed(api_client: AsyncClient):
    r = await api_client.get("/personas")
    assert r.status_code == 200
    slugs = [p["slug"] for p in r.json()]
    assert "bowtie-editor" in slugs


@pytest.mark.asyncio
async def test_get_persona_by_slug(api_client: AsyncClient):
    r = await api_client.get("/personas/bowtie-editor")
    assert r.status_code == 200
    assert r.json()["name"] == "Bowtie 編輯"


@pytest.mark.asyncio
async def test_create_persona_round_trip(api_client: AsyncClient):
    payload = {
        "slug": "test-voice",
        "name": "Test Voice",
        "voice_rules": ["clear"],
        "banned_terms": ["X"],
        "required_phrasings": ["Y"],
        "disclaimer_templates": {"medical": "z"},
        "tone_examples": {"good": ["a"], "bad": ["b"]},
    }
    r = await api_client.post("/personas", json=payload)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["slug"] == "test-voice"
    assert body["is_archived"] is False

    r2 = await api_client.get(f"/personas/{payload['slug']}")
    assert r2.status_code == 200
    assert r2.json()["name"] == "Test Voice"


@pytest.mark.asyncio
async def test_create_persona_slug_collision_409(api_client: AsyncClient):
    payload = {
        "slug": "bowtie-editor",  # seeded
        "name": "Dup", "voice_rules": [], "banned_terms": [],
        "required_phrasings": [], "disclaimer_templates": {},
        "tone_examples": {"good": [], "bad": []},
    }
    r = await api_client.post("/personas", json=payload)
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_update_persona_name(api_client: AsyncClient):
    create = {
        "slug": "edit-me", "name": "Old",
        "voice_rules": [], "banned_terms": [], "required_phrasings": [],
        "disclaimer_templates": {}, "tone_examples": {"good": [], "bad": []},
    }
    await api_client.post("/personas", json=create)

    r = await api_client.put("/personas/edit-me", json={"name": "New"})
    assert r.status_code == 200
    assert r.json()["name"] == "New"


@pytest.mark.asyncio
async def test_archive_hides_from_default_list(api_client: AsyncClient):
    await api_client.post("/personas", json={
        "slug": "archived-one", "name": "x",
        "voice_rules": [], "banned_terms": [], "required_phrasings": [],
        "disclaimer_templates": {}, "tone_examples": {"good": [], "bad": []},
    })
    r = await api_client.post("/personas/archived-one/archive")
    assert r.status_code == 200
    assert r.json()["is_archived"] is True

    r2 = await api_client.get("/personas")
    assert all(p["slug"] != "archived-one" for p in r2.json())

    r3 = await api_client.get("/personas?include_archived=true")
    assert any(p["slug"] == "archived-one" for p in r3.json())


@pytest.mark.asyncio
async def test_usage_endpoint_counts_runs(api_client: AsyncClient):
    r = await api_client.get("/personas/bowtie-editor/usage")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "bowtie-editor"
    assert "by_status" in body
    assert "total" in body
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/integration/test_api_personas.py -v
```

Expected: 404s (router not mounted yet).

- [ ] **Step 3: Implement the router**

```python
# content_tool/api/routes/personas.py
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from content_tool.api.schemas import (
    PersonaIn,
    PersonaOut,
    PersonaPatch,
    PersonaUsage,
)
from content_tool.db.models import Persona, Run
from content_tool.policy.personas import (
    create_persona,
    get_persona,
    list_personas,
    set_archived,
    update_persona,
)

router = APIRouter(prefix="/personas", tags=["personas"])


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


def _to_out(row: Persona) -> PersonaOut:
    return PersonaOut.model_validate({
        "persona_id": row.persona_id,
        "slug": row.slug,
        "name": row.name,
        "voice_rules": row.voice_rules,
        "banned_terms": row.banned_terms,
        "required_phrasings": row.required_phrasings,
        "disclaimer_templates": row.disclaimer_templates,
        "tone_examples": row.tone_examples,
        "is_archived": row.is_archived,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "created_by": row.created_by,
        "updated_by": row.updated_by,
    })


@router.get("", response_model=list[PersonaOut])
async def list_(
    include_archived: bool = Query(False),
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[PersonaOut]:
    async with sf() as session:
        rows = await list_personas(session=session, include_archived=include_archived)
        return [_to_out(r) for r in rows]


@router.get("/{slug}", response_model=PersonaOut)
async def get_(slug: str, sf=Depends(get_session_factory)) -> PersonaOut:  # noqa: ANN001, B008
    async with sf() as session:
        row = await get_persona(session=session, slug=slug)
        if row is None:
            raise HTTPException(404, "persona not found")
        return _to_out(row)


@router.post("", response_model=PersonaOut, status_code=201)
async def create_(
    payload: PersonaIn,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> PersonaOut:
    async with sf() as session:
        try:
            row = await create_persona(
                session=session,
                slug=payload.slug,
                name=payload.name,
                voice_rules=payload.voice_rules,
                banned_terms=payload.banned_terms,
                required_phrasings=payload.required_phrasings,
                disclaimer_templates=payload.disclaimer_templates,
                tone_examples=payload.tone_examples,
            )
        except IntegrityError as e:
            raise HTTPException(409, f"slug '{payload.slug}' already exists") from e
        return _to_out(row)


@router.put("/{slug}", response_model=PersonaOut)
async def update_(
    slug: str,
    payload: PersonaPatch,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> PersonaOut:
    async with sf() as session:
        patch = payload.model_dump(exclude_unset=True)
        try:
            row = await update_persona(session=session, slug=slug, patch=patch)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        return _to_out(row)


@router.post("/{slug}/archive", response_model=PersonaOut)
async def archive_(slug: str, sf=Depends(get_session_factory)) -> PersonaOut:  # noqa: ANN001, B008
    async with sf() as session:
        try:
            row = await set_archived(session=session, slug=slug, archived=True)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        return _to_out(row)


@router.post("/{slug}/restore", response_model=PersonaOut)
async def restore_(slug: str, sf=Depends(get_session_factory)) -> PersonaOut:  # noqa: ANN001, B008
    async with sf() as session:
        try:
            row = await set_archived(session=session, slug=slug, archived=False)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        return _to_out(row)


@router.get("/{slug}/usage", response_model=PersonaUsage)
async def usage_(slug: str, sf=Depends(get_session_factory)) -> PersonaUsage:  # noqa: ANN001, B008
    async with sf() as session:
        row = await get_persona(session=session, slug=slug)
        if row is None:
            raise HTTPException(404, "persona not found")
        q = (
            select(Run.status, func.count())
            .where(Run.persona == slug)
            .group_by(Run.status)
        )
        rows = (await session.execute(q)).all()
        by_status = {status: int(n) for (status, n) in rows}
        return PersonaUsage(slug=slug, by_status=by_status, total=sum(by_status.values()))
```

- [ ] **Step 4: Wire the router into the app**

In `content_tool/api/main.py`:

```python
# Add to the imports block
from content_tool.api.routes.personas import router as personas_router

# Add inside create_app() with the other include_router calls
app.include_router(personas_router)
```

- [ ] **Step 5: Run the tests to confirm pass**

```bash
pytest tests/integration/test_api_personas.py -v
```

Expected: all seven PASS.

- [ ] **Step 6: Commit**

```bash
git add content_tool/api/routes/personas.py content_tool/api/main.py tests/integration/test_api_personas.py
git commit -m "feat(api): /personas CRUD + usage"
```

---

## Task 7: Hand-written prompt-graph metadata

**Files:**
- Create: `content_tool/api/prompt_graph.py`
- Test: `tests/unit/test_prompt_graph.py`

The graph topology rarely changes and only changes via code review. Encoding it as a constant beats a runtime introspection helper.

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/test_prompt_graph.py
from content_tool.api.prompt_graph import PROMPT_GRAPH


def test_graph_has_both_subgraphs():
    sub = {n["sub_graph"] for n in PROMPT_GRAPH["nodes"]}
    assert {"strategy", "production"}.issubset(sub)


def test_persona_bound_agents_are_writer_and_audit():
    bound = {n["id"] for n in PROMPT_GRAPH["nodes"] if n.get("uses_persona")}
    assert bound == {"writer", "audit"}


def test_hitl_gates_present():
    gates = {g["id"] for g in PROMPT_GRAPH["gates"]}
    assert gates == {"HITL_1", "HITL_2"}


def test_template_ids_match_prompt_files():
    expected = {"audit", "gap_analysis", "outline",
                "writer_small_refresh", "writer_full_rewrite"}
    found = {n["system_prompt_template_id"]
             for n in PROMPT_GRAPH["nodes"]
             if n.get("system_prompt_template_id")}
    assert expected.issubset(found)
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/unit/test_prompt_graph.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement the constant**

```python
# content_tool/api/prompt_graph.py
"""Hand-written metadata describing the LangGraph topology for UI rendering.

The topology only changes via code review (graph/*.py), so we encode it as
a constant rather than introspecting at runtime.
"""

PROMPT_GRAPH: dict = {
    "nodes": [
        # Strategy sub-graph
        {
            "id": "fetch_article",
            "sub_graph": "strategy",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Pulls the existing WordPress post by URL and stores raw HTML + markdown.",
        },
        {
            "id": "gap_analysis",
            "sub_graph": "strategy",
            "order": 2,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "gap_analysis",
            "description": "Picks small_refresh vs full_rewrite by comparing the article to fresh search results.",
        },
        {
            "id": "outline",
            "sub_graph": "strategy",
            "order": 3,
            "kind": "llm",
            "uses_persona": False,
            "system_prompt_template_id": "outline",
            "description": "Drafts the section-by-section outline the writer will follow.",
        },
        # Production sub-graph
        {
            "id": "writer",
            "sub_graph": "production",
            "order": 1,
            "kind": "llm",
            "uses_persona": True,
            "system_prompt_template_id": "writer_small_refresh",
            "alt_template_ids": ["writer_full_rewrite"],
            "description": "Writes the full Markdown draft in the persona's voice. Two templates: small_refresh and full_rewrite, chosen by gap analysis.",
        },
        {
            "id": "resolve_citations",
            "sub_graph": "production",
            "order": 2,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Resolves citation intents to real URLs and applies the source policy.",
        },
        {
            "id": "render_html",
            "sub_graph": "production",
            "order": 3,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Converts the resolved Markdown to HTML, plus SEO meta + FAQ JSON-LD.",
        },
        {
            "id": "audit",
            "sub_graph": "production",
            "order": 4,
            "kind": "llm",
            "uses_persona": True,
            "system_prompt_template_id": "audit",
            "description": "Reviews the rendered HTML against the persona's voice rules and compliance constraints.",
        },
        # Publish — sits outside the two sub-graphs, after HITL_2
        {
            "id": "publish",
            "sub_graph": "publish",
            "order": 1,
            "kind": "deterministic",
            "uses_persona": False,
            "system_prompt_template_id": None,
            "description": "Pushes the approved draft to WordPress via REST.",
        },
    ],
    "edges": [
        {"from": "fetch_article", "to": "gap_analysis"},
        {"from": "gap_analysis", "to": "outline"},
        {"from": "outline", "to": "writer", "label": "HITL_1"},
        {"from": "writer", "to": "resolve_citations"},
        {"from": "resolve_citations", "to": "render_html"},
        {"from": "render_html", "to": "audit"},
        {"from": "audit", "to": "writer", "label": "internal refine ≤2"},
        {"from": "audit", "to": "publish", "label": "HITL_2 · approve"},
        {"from": "audit", "to": "writer", "label": "HITL_2 · request_changes ≤3"},
    ],
    "gates": [
        {"id": "HITL_1", "before": "writer",
         "label": "GATE · HITL_1",
         "description": "Editor reviews the outline and route choice."},
        {"id": "HITL_2", "before": "publish",
         "label": "GATE · HITL_2",
         "description": "Editor reviews the rendered draft; may approve, request changes (up to 3 rounds), or reject."},
    ],
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pytest tests/unit/test_prompt_graph.py -v
```

Expected: all four PASS.

- [ ] **Step 5: Commit**

```bash
git add content_tool/api/prompt_graph.py tests/unit/test_prompt_graph.py
git commit -m "feat(api): prompt graph metadata constant"
```

---

## Task 8: `/prompts` router — graph + templates

**Files:**
- Create: `content_tool/api/routes/prompts.py`
- Modify: `content_tool/api/main.py`
- Test: `tests/integration/test_api_prompts.py`

- [ ] **Step 1: Write the failing tests (graph + templates only — user-example added in Task 9)**

```python
# tests/integration/test_api_prompts.py
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_graph_metadata(api_client: AsyncClient):
    r = await api_client.get("/prompts/graph")
    assert r.status_code == 200
    body = r.json()
    assert {"nodes", "edges", "gates"}.issubset(body.keys())
    persona_bound = {n["id"] for n in body["nodes"] if n.get("uses_persona")}
    assert persona_bound == {"writer", "audit"}


@pytest.mark.asyncio
async def test_template_audit_loads(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates/audit")
    assert r.status_code == 200
    body = r.json()
    assert "{persona_block}" in body["template"]
    assert body["template_id"] == "audit"


@pytest.mark.asyncio
async def test_template_unknown_id_404s(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates/does_not_exist")
    assert r.status_code == 404
```

- [ ] **Step 2: Run to verify failure**

```bash
pytest tests/integration/test_api_prompts.py -v
```

Expected: 404 (no router).

- [ ] **Step 3: Implement graph + templates endpoints**

```python
# content_tool/api/routes/prompts.py
from pathlib import Path

from fastapi import APIRouter, HTTPException

from content_tool.api.prompt_graph import PROMPT_GRAPH

router = APIRouter(prefix="/prompts", tags=["prompts"])

_PROMPT_DIR = Path(__file__).resolve().parents[3] / "prompts"
_TEMPLATE_FILES = {
    "audit": "audit.md",
    "gap_analysis": "gap_analysis.md",
    "outline": "outline.md",
    "writer_small_refresh": "writer_small_refresh.md",
    "writer_full_rewrite": "writer_full_rewrite.md",
}


@router.get("/graph")
async def graph() -> dict:
    return PROMPT_GRAPH


@router.get("/templates/{template_id}")
async def template(template_id: str) -> dict:
    filename = _TEMPLATE_FILES.get(template_id)
    if filename is None:
        raise HTTPException(404, f"unknown template_id '{template_id}'")
    path = _PROMPT_DIR / filename
    return {"template_id": template_id, "template": path.read_text(encoding="utf-8")}
```

- [ ] **Step 4: Wire into main.py**

```python
from content_tool.api.routes.prompts import router as prompts_router
# ...
app.include_router(prompts_router)
```

- [ ] **Step 5: Run tests to verify pass**

```bash
pytest tests/integration/test_api_prompts.py -v
```

Expected: three PASS.

- [ ] **Step 6: Commit**

```bash
git add content_tool/api/routes/prompts.py content_tool/api/main.py tests/integration/test_api_prompts.py
git commit -m "feat(api): /prompts graph + templates"
```

---

## Task 9: `/prompts/user-example` — render a real user prompt from a past run

**Files:**
- Modify: `content_tool/api/routes/prompts.py`
- Test: `tests/integration/test_api_prompts.py` (extend)

This endpoint deterministically re-runs the agents' `build_user_prompt` helpers against persisted state for a given run. No LLM call.

- [ ] **Step 1: Add the failing test**

Append to `tests/integration/test_api_prompts.py`:

```python
@pytest.mark.asyncio
async def test_user_example_unknown_run_404(api_client: AsyncClient):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": "00000000-0000-0000-0000-000000000000", "agent": "writer"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_user_example_unknown_agent_400(api_client: AsyncClient, persisted_full_run):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_full_run, "agent": "bogus"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_user_example_writer_includes_topic(api_client: AsyncClient, persisted_full_run):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_full_run, "agent": "writer"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "topic:" in body["prompt"]
    assert body["agent"] == "writer"


@pytest.mark.asyncio
async def test_user_example_audit_includes_html(api_client: AsyncClient, persisted_full_run):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_full_run, "agent": "audit"},
    )
    assert r.status_code == 200
    assert "# final_html" in r.json()["prompt"]


@pytest.mark.asyncio
async def test_user_example_missing_inputs_422(api_client: AsyncClient, persisted_strategy_only_run):
    """A run that has gap_analysis but no draft cannot render a writer prompt."""
    # writer needs Outline + GapAnalysisRow + FetchedArticle + Run — all present.
    # But audit needs Draft + Render + Citation — none present here.
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_strategy_only_run, "agent": "audit"},
    )
    assert r.status_code == 422
    assert "missing" in r.json()["detail"].lower()
```

This test depends on two new fixtures: `persisted_full_run` (a run with every table populated) and `persisted_strategy_only_run` (gap + outline but no draft). Add them to `tests/integration/conftest.py`.

- [ ] **Step 2: Add the test fixtures**

Append to `tests/integration/conftest.py`:

```python
from datetime import date
from uuid import uuid4

import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.db.models import (
    Citation, Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run,
)


def _base_run(run_id):
    return Run(
        run_id=run_id, created_by="t@bowtie", status="hitl_2",
        article_url="https://wp.test/example",
        topic="自願醫保 2026", keywords=["VHIS"], mode="auto", edit_note=None,
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        topic_category="insurance", today_date=date.today(),
        chosen_route="small_refresh", iteration_count=0,
    )


@pytest_asyncio.fixture
async def persisted_strategy_only_run(
    pg_session_factory: async_sessionmaker,
) -> str:
    run_id = uuid4()
    async with pg_session_factory() as s:
        s.add(_base_run(run_id))
        await s.flush()
        s.add(FetchedArticle(
            run_id=run_id, wp_post_id=42, raw_html="<p>old</p>",
            markdown="old markdown", wp_categories=[], wp_link=None,
        ))
        s.add(GapAnalysisRow(
            run_id=run_id, model="gemini-2.0-flash", thinking_level="low",
            payload={"chosen_route": "small_refresh", "update_plan": {}},
            tokens_in=0, tokens_out=0, thinking_tokens=0, latency_ms=0,
        ))
        s.add(OutlineRow(
            run_id=run_id, payload={"sections": []}, edited_by_human=False,
        ))
        await s.commit()
    return str(run_id)


@pytest_asyncio.fixture
async def persisted_full_run(
    pg_session_factory: async_sessionmaker,
) -> str:
    run_id = uuid4()
    async with pg_session_factory() as s:
        s.add(_base_run(run_id))
        await s.flush()
        s.add(FetchedArticle(
            run_id=run_id, wp_post_id=42, raw_html="<p>old</p>",
            markdown="old markdown", wp_categories=[], wp_link=None,
        ))
        s.add(GapAnalysisRow(
            run_id=run_id, model="gemini-2.0-flash", thinking_level="low",
            payload={"chosen_route": "small_refresh", "update_plan": {"must_add": []}},
            tokens_in=0, tokens_out=0, thinking_tokens=0, latency_ms=0,
        ))
        s.add(OutlineRow(
            run_id=run_id, payload={"sections": []}, edited_by_human=False,
        ))
        draft = Draft(
            run_id=run_id, iteration=0,
            diagnose="ok", markup_raw="# H1\nbody",
            citation_intents=[], grounding_chunks=[],
            tokens_in=0, tokens_out=0, thinking_tokens=0, latency_ms=0,
            final_markup="# H1\nbody",
        )
        s.add(draft)
        await s.flush()
        s.add(Render(
            draft_id=draft.draft_id, seo_title="t",
            meta_description="m", html_body="<h1>H1</h1>",
            faq_schema_jsonld=None, excerpt_suggestion="e", slug_suggestion="s",
        ))
        s.add(Citation(
            draft_id=draft.draft_id, domain="example.com",
            final_url="https://example.com", policy_decision="allowed",
            was_displayed=True, denied_reason=None,
        ))
        await s.commit()
    return str(run_id)
```

If any of the `Run` / `FetchedArticle` / `Draft` / `Render` / `Citation` columns above don't exist verbatim, check the live model in `content_tool/db/models.py` and adjust the field names. Don't invent fields.

- [ ] **Step 3: Run failing tests**

```bash
pytest tests/integration/test_api_prompts.py -v
```

Expected: 5 new failures (404 on the route).

- [ ] **Step 4: Implement the endpoint**

Append to `content_tool/api/routes/prompts.py`:

```python
from uuid import UUID

from fastapi import Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.agents import audit as audit_agent
from content_tool.agents import gap_analysis as gap_agent
from content_tool.agents import outline as outline_agent
from content_tool.agents import writer as writer_agent
from content_tool.db.models import (
    AuditRun, Citation, Draft, FetchedArticle, GapAnalysisRow,
    OutlineRow, Render, Run,
)


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


_USER_PROMPT_AGENTS = {"gap_analysis", "outline", "writer", "audit"}


async def _render_user_prompt(
    *, session: AsyncSession, run: Run, agent: str
) -> str:
    if agent == "gap_analysis":
        return gap_agent.build_user_prompt(
            topic=run.topic, keywords=run.keywords, article_url=run.article_url,
            acf_adv_id=run.acf_adv_id, acf_widget_id=run.acf_widget_id,
            mode=run.mode, edit_note=run.edit_note,
        )

    if agent == "outline":
        ga = (await session.execute(
            select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
        )).scalar_one_or_none()
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run.run_id)
        )).scalar_one_or_none()
        if ga is None or fa is None:
            raise _MissingInputs("outline needs gap_analysis + fetched_article")
        return outline_agent.build_user_prompt(
            gap_analysis_payload=ga.payload,
            existing_markdown=fa.markdown,
            chosen_route=run.chosen_route or "small_refresh",
            acf_adv_id=run.acf_adv_id, acf_widget_id=run.acf_widget_id,
        )

    if agent == "writer":
        ga = (await session.execute(
            select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
        )).scalar_one_or_none()
        ol = (await session.execute(
            select(OutlineRow).where(OutlineRow.run_id == run.run_id)
        )).scalar_one_or_none()
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run.run_id)
        )).scalar_one_or_none()
        if ga is None or ol is None or fa is None:
            raise _MissingInputs(
                "writer needs gap_analysis + outline + fetched_article"
            )
        return writer_agent.build_user_prompt(
            run=run,
            gap_analysis=ga.payload,
            outline=ol.payload,
            existing_markdown=fa.markdown,
            refine_notes=None,
        )

    # agent == "audit"
    draft = (await session.execute(
        select(Draft).where(Draft.run_id == run.run_id)
        .order_by(Draft.iteration.desc()).limit(1)
    )).scalar_one_or_none()
    if draft is None:
        raise _MissingInputs("audit needs a draft")
    ga = (await session.execute(
        select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
    )).scalar_one_or_none()
    render = (await session.execute(
        select(Render).where(Render.draft_id == draft.draft_id)
    )).scalar_one_or_none()
    cits = (await session.execute(
        select(Citation).where(Citation.draft_id == draft.draft_id)
    )).scalars().all()
    audit_row = (await session.execute(
        select(AuditRun).where(AuditRun.draft_id == draft.draft_id)
    )).scalar_one_or_none()
    if ga is None or render is None:
        raise _MissingInputs("audit needs gap_analysis + render")
    return audit_agent.build_user_prompt(
        html_body=render.html_body,
        gap_update_plan=ga.payload.get("update_plan", {}),
        citation_intents=draft.citation_intents,
        citations_summary=[
            {"domain": c.domain, "final_url": c.final_url,
             "policy": c.policy_decision, "displayed": c.was_displayed,
             "denied_reason": c.denied_reason}
            for c in cits
        ],
        deterministic_findings=(
            (audit_row.deterministic_findings or {}).get("findings", [])
            if audit_row else []
        ),
    )


class _MissingInputs(Exception):
    pass


@router.get("/user-example")
async def user_example(
    run_id: UUID = Query(...),  # noqa: B008
    agent: str = Query(...),
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    if agent not in _USER_PROMPT_AGENTS:
        raise HTTPException(400, f"agent must be one of {sorted(_USER_PROMPT_AGENTS)}")
    async with sf() as session:
        run = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if run is None:
            raise HTTPException(404, "run not found")
        try:
            prompt = await _render_user_prompt(session=session, run=run, agent=agent)
        except _MissingInputs as e:
            raise HTTPException(422, f"missing inputs: {e}") from e
        return {"run_id": str(run_id), "agent": agent, "prompt": prompt}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
pytest tests/integration/test_api_prompts.py -v
```

Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add content_tool/api/routes/prompts.py tests/integration/test_api_prompts.py tests/integration/conftest.py
git commit -m "feat(api): /prompts/user-example renders real user prompt from past run"
```

---

## Task 10: Web — TypeScript types + API client

**Files:**
- Modify: `web/lib/types.ts`
- Modify: `web/lib/api.ts`

- [ ] **Step 1: Add types**

Append to `web/lib/types.ts`:

```ts
export interface Persona {
  persona_id: string;
  slug: string;
  name: string;
  voice_rules: string[];
  banned_terms: string[];
  required_phrasings: string[];
  disclaimer_templates: Record<string, string>;
  tone_examples: { good: string[]; bad: string[] };
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface PersonaIn {
  slug: string;
  name: string;
  voice_rules: string[];
  banned_terms: string[];
  required_phrasings: string[];
  disclaimer_templates: Record<string, string>;
  tone_examples: { good: string[]; bad: string[] };
}

export interface PersonaPatch {
  name?: string;
  voice_rules?: string[];
  banned_terms?: string[];
  required_phrasings?: string[];
  disclaimer_templates?: Record<string, string>;
  tone_examples?: { good: string[]; bad: string[] };
}

export interface PersonaUsage {
  slug: string;
  by_status: Record<string, number>;
  total: number;
}

export type PromptKind = "llm" | "deterministic";

export interface PromptNode {
  id: string;
  sub_graph: "strategy" | "production" | "publish";
  order: number;
  kind: PromptKind;
  uses_persona: boolean;
  system_prompt_template_id: string | null;
  alt_template_ids?: string[];
  description: string;
}

export interface PromptEdge { from: string; to: string; label?: string }
export interface PromptGate {
  id: "HITL_1" | "HITL_2";
  before: string;
  label: string;
  description: string;
}

export interface PromptGraph {
  nodes: PromptNode[];
  edges: PromptEdge[];
  gates: PromptGate[];
}

export interface PromptTemplate {
  template_id: string;
  template: string;
}

export interface UserPromptExample {
  run_id: string;
  agent: string;
  prompt: string;
}
```

- [ ] **Step 2: Add `personasApi` and `promptsApi`**

Append to `web/lib/api.ts`:

```ts
import type {
  Persona, PersonaIn, PersonaPatch, PersonaUsage,
  PromptGraph, PromptTemplate, UserPromptExample,
} from "./types";

const PERSONAS_BASE = "/api/personas";
const PROMPTS_BASE = "/api/prompts";

export const personasApi = {
  list: (includeArchived = false) =>
    http<Persona[]>(`${PERSONAS_BASE}${includeArchived ? "?include_archived=true" : ""}`),
  get: (slug: string) => http<Persona>(`${PERSONAS_BASE}/${slug}`),
  create: (body: PersonaIn) =>
    http<Persona>(PERSONAS_BASE, { method: "POST", body: JSON.stringify(body) }),
  update: (slug: string, patch: PersonaPatch) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}`, { method: "PUT", body: JSON.stringify(patch) }),
  archive: (slug: string) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}/archive`, { method: "POST" }),
  restore: (slug: string) =>
    http<Persona>(`${PERSONAS_BASE}/${slug}/restore`, { method: "POST" }),
  usage: (slug: string) =>
    http<PersonaUsage>(`${PERSONAS_BASE}/${slug}/usage`),
};

export const promptsApi = {
  graph: () => http<PromptGraph>(`${PROMPTS_BASE}/graph`),
  template: (id: string) => http<PromptTemplate>(`${PROMPTS_BASE}/templates/${id}`),
  userExample: (runId: string, agent: string) =>
    http<UserPromptExample>(`${PROMPTS_BASE}/user-example?run_id=${runId}&agent=${agent}`),
};
```

(Verify whether `/api/personas` is proxied. The existing `personas` filter on `articlesApi.list` already uses `/api/articles?persona=...` against the FastAPI backend through whatever proxy the existing setup uses — copy that same prefix convention.)

- [ ] **Step 3: Type-check**

```bash
cd web && pnpm tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add web/lib/types.ts web/lib/api.ts
git commit -m "feat(web): persona + prompt API client and types"
```

---

## Task 11: Nav entry

**Files:**
- Modify: `web/components/Masthead.tsx`

- [ ] **Step 1: Add `Voices` to the NAV array**

In `web/components/Masthead.tsx`, replace:

```ts
const NAV = [
  { href: "/", label: "Runs" },
  { href: "/library", label: "Library" },
];
```

with:

```ts
const NAV = [
  { href: "/", label: "Runs" },
  { href: "/library", label: "Library" },
  { href: "/voices", label: "Voices" },
];
```

- [ ] **Step 2: Boot the dev server and visually check**

```bash
cd web && pnpm dev
```

Expected: nav shows `Runs · Library · Voices`. Clicking `Voices` 404s for now — that's fine, the page comes next.

- [ ] **Step 3: Commit**

```bash
git add web/components/Masthead.tsx
git commit -m "feat(web): Voices nav entry"
```

---

## Task 12: `/voices` page scaffold + state

**Files:**
- Create: `web/app/voices/page.tsx`

This task only stands up the shell: SectionHead, fetches `personasApi.list()` and `promptsApi.graph()`, holds `selectedSlug` state, renders placeholders for each movement. Components arrive in later tasks.

- [ ] **Step 1: Write the page**

```tsx
// web/app/voices/page.tsx
"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { SectionHead } from "@/components/SectionHead";
import { personasApi, promptsApi } from "@/lib/api";

export default function VoicesPage() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const personas = useQuery({
    queryKey: ["personas", showArchived],
    queryFn: () => personasApi.list(showArchived),
  });

  const graph = useQuery({
    queryKey: ["prompt-graph"],
    queryFn: () => promptsApi.graph(),
  });

  // Default-select the first non-archived persona once data lands.
  const activeSlug = selectedSlug
    ?? personas.data?.find((p) => !p.is_archived)?.slug
    ?? null;

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 space-y-12">
      <SectionHead
        kicker="Style Sheet · Voices"
        hed="House Voices"
        dek="The personas that shape the desk's copy — and the route each story walks before press."
      />

      {personas.isLoading && <p className="text-ink-faint">Loading voices…</p>}
      {personas.isError && <p className="text-accent-deep text-[13px]">Failed to load voices.</p>}

      {/* Movement 1: Rolodex — replaced in Task 13 */}
      <section aria-label="rolodex" className="border-y border-rule py-6">
        <p className="text-ink-faint text-[12px]">Rolodex placeholder · selected: {activeSlug ?? "none"}</p>
        <label className="ml-4 text-[12px] text-ink-faint">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          /> show archived
        </label>
      </section>

      {/* Movement 2: Style Card — replaced in Task 15 */}
      <section aria-label="style-card">
        <p className="text-ink-faint text-[12px]">Style Card placeholder</p>
      </section>

      {/* Movement 3+4: Press Workflow — replaced in Task 16+ */}
      <section aria-label="press-workflow">
        <p className="text-ink-faint text-[12px]">
          Press Workflow placeholder · {graph.data?.nodes.length ?? "?"} nodes loaded
        </p>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Visually verify in browser**

With `pnpm dev` running, open `http://localhost:3000/voices`. Expected: SectionHead renders, the placeholders show "selected: bowtie-editor" and "X nodes loaded".

- [ ] **Step 3: Commit**

```bash
git add web/app/voices/page.tsx
git commit -m "feat(web): /voices page scaffold with persona + graph queries"
```

---

## Task 13: `Rolodex` component

**Files:**
- Create: `web/components/voices/Rolodex.tsx`
- Modify: `web/app/voices/page.tsx`

- [ ] **Step 1: Build the component**

```tsx
// web/components/voices/Rolodex.tsx
"use client";

import { cn } from "@/lib/utils";
import type { Persona } from "@/lib/types";

interface RolodexProps {
  personas: Persona[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onNewVoice: () => void;
}

export function Rolodex({ personas, selectedSlug, onSelect, onNewVoice }: RolodexProps) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {personas.map((p) => {
        const active = p.slug === selectedSlug;
        return (
          <button
            type="button"
            key={p.slug}
            onClick={() => onSelect(p.slug)}
            className={cn(
              "shrink-0 w-[200px] text-left px-4 py-3 border border-rule",
              "transition-colors hover:bg-paper-deep/60",
              active && "border-accent",
              p.is_archived && "opacity-50",
            )}
          >
            <p
              className="font-display text-[20px] leading-tight text-ink truncate"
              style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
            >
              {p.name}
            </p>
            <p className="mt-1 font-mono text-[10px] tracking-wider text-ink-faint uppercase truncate">
              {p.slug}
            </p>
            {active && <div className="mt-2 h-px bg-accent" />}
            {p.is_archived && (
              <p className="mt-1 font-mono text-[10px] text-ink-faint">archived</p>
            )}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNewVoice}
        className="shrink-0 w-[200px] px-4 py-3 border border-dashed border-rule text-ink-faint hover:text-ink hover:border-ink-soft transition-colors text-left"
      >
        <p
          className="font-display text-[20px] leading-tight"
          style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
        >
          ＋ New voice
        </p>
        <p className="mt-1 font-mono text-[10px] tracking-wider uppercase">draft a new voice</p>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire into page**

In `web/app/voices/page.tsx`, replace the placeholder in the `rolodex` section with:

```tsx
import { Rolodex } from "@/components/voices/Rolodex";
// ...
{/* Movement 1: Rolodex */}
<section aria-label="rolodex" className="border-y border-rule py-6 space-y-3">
  {personas.data && (
    <Rolodex
      personas={personas.data}
      selectedSlug={activeSlug}
      onSelect={setSelectedSlug}
      onNewVoice={() => setComposeMode({ kind: "create" })}
    />
  )}
  <label className="text-[12px] text-ink-faint">
    <input
      type="checkbox"
      checked={showArchived}
      onChange={(e) => setShowArchived(e.target.checked)}
    /> show archived
  </label>
</section>
```

Also add at the top of the component:

```tsx
const [composeMode, setComposeMode] = useState<
  | null
  | { kind: "create" }
  | { kind: "edit"; slug: string }
>(null);
```

The drawer arrives in Task 19; `setComposeMode` is just stub state for now.

- [ ] **Step 3: Visually verify**

Reload `/voices`. Expected: horizontal strip of cards including `bowtie-editor` and the dashed `＋ New voice` card. Click selects; selected card shows accent underline.

- [ ] **Step 4: Commit**

```bash
git add web/components/voices/Rolodex.tsx web/app/voices/page.tsx
git commit -m "feat(web): Rolodex component"
```

---

## Task 14: `RedlineList` component

**Files:**
- Create: `web/components/voices/RedlineList.tsx`

This is the visual hook. Build it in isolation first so it can be reused.

- [ ] **Step 1: Implement**

```tsx
// web/components/voices/RedlineList.tsx
import { cn } from "@/lib/utils";

interface RedlineListProps {
  banned: string[];
  required: string[];
  className?: string;
}

/**
 * Pairs banned terms with required phrasings positionally. If lengths differ,
 * extra entries from the longer list are shown alone (no pair).
 */
export function RedlineList({ banned, required, className }: RedlineListProps) {
  const max = Math.max(banned.length, required.length);
  if (max === 0) return null;
  return (
    <ul className={cn("space-y-2", className)}>
      {Array.from({ length: max }).map((_, i) => {
        const b = banned[i];
        const r = required[i];
        return (
          <li key={i} className="flex items-baseline gap-3 font-display text-[20px]">
            {b ? (
              <s className="text-ink-faint decoration-accent decoration-2">{b}</s>
            ) : (
              <span className="text-ink-faint italic">—</span>
            )}
            <span aria-hidden className="font-mono text-[14px] text-accent">→</span>
            {r ? (
              <em className="not-italic font-display text-ink" style={{ fontVariationSettings: '"opsz" 36' }}>
                {r}
              </em>
            ) : (
              <span className="text-ink-faint italic">—</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 2: Smoke-test in the page**

Temporarily add this in `web/app/voices/page.tsx` (inside the existing render, you can remove after) and reload:

```tsx
import { RedlineList } from "@/components/voices/RedlineList";

// inside the JSX, somewhere visible:
<RedlineList banned={["信息", "软件", "网络"]} required={["資訊", "軟件", "網絡"]} />
```

Expected: three rows, banned term struck through, accent-colored arrow, required term in italic-display.

Remove the demo line before committing.

- [ ] **Step 3: Commit**

```bash
git add web/components/voices/RedlineList.tsx
git commit -m "feat(web): RedlineList component"
```

---

## Task 15: `StyleCard` component + persona usage tag

**Files:**
- Create: `web/components/voices/StyleCard.tsx`
- Modify: `web/app/voices/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// web/components/voices/StyleCard.tsx
"use client";

import { useQuery } from "@tanstack/react-query";

import { personasApi } from "@/lib/api";
import type { Persona } from "@/lib/types";
import { RedlineList } from "./RedlineList";

interface StyleCardProps {
  persona: Persona;
  onEdit: () => void;
}

export function StyleCard({ persona, onEdit }: StyleCardProps) {
  const usage = useQuery({
    queryKey: ["persona-usage", persona.slug],
    queryFn: () => personasApi.usage(persona.slug),
  });

  return (
    <article className="space-y-8">
      <header className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
            {persona.slug}
          </p>
          <h2
            className="font-display-cjk text-[64px] md:text-[88px] leading-[1.05] text-ink"
            style={{ fontVariationSettings: '"opsz" 144, "SOFT" 80' }}
          >
            {persona.name}
          </h2>
          {usage.data && (
            <p className="mt-2 font-mono text-[11px] tracking-wider text-ink-faint">
              {usage.data.total} runs
              {Object.entries(usage.data.by_status).map(([s, n]) => ` · ${s}: ${n}`).join("")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="text-[12px] tracking-wider uppercase text-ink-soft hover:text-accent transition-colors"
        >
          Edit voice →
        </button>
      </header>

      <section>
        <h3 className="kicker mb-3">語氣規則 · Voice rules</h3>
        <ul className="space-y-1.5 text-[15px] leading-relaxed text-ink-soft max-w-[60ch]">
          {persona.voice_rules.map((rule, i) => (
            <li key={i} className="pl-4 -indent-4">· {rule}</li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="kicker mb-3">字詞紅線 · Banned → required</h3>
        <RedlineList
          banned={persona.banned_terms}
          required={persona.required_phrasings}
        />
      </section>

      {Object.keys(persona.disclaimer_templates).length > 0 && (
        <section>
          <h3 className="kicker mb-3">免責聲明 · Disclaimer templates</h3>
          <dl className="space-y-3">
            {Object.entries(persona.disclaimer_templates).map(([key, body]) => (
              <div key={key}>
                <dt className="font-mono text-[11px] tracking-wider uppercase text-ink-faint">{key}</dt>
                <dd className="font-display italic text-ink-soft mt-1">{body}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="grid grid-cols-1 md:grid-cols-[1fr_1px_1fr] gap-6">
        <div>
          <h3 className="kicker mb-2">好 · Tone — good</h3>
          {persona.tone_examples.good.map((q, i) => (
            <blockquote key={i} className="font-display italic text-ink text-[18px] leading-snug mb-3 max-w-[40ch]">
              「{q}」
            </blockquote>
          ))}
        </div>
        <div className="bg-rule hidden md:block" />
        <div>
          <h3 className="kicker mb-2">壞 · Tone — bad</h3>
          {persona.tone_examples.bad.map((q, i) => (
            <blockquote key={i} className="font-display italic text-ink-faint text-[18px] leading-snug mb-3 line-through max-w-[40ch]">
              「{q}」
            </blockquote>
          ))}
        </div>
      </section>
    </article>
  );
}
```

- [ ] **Step 2: Wire into page**

In `web/app/voices/page.tsx`, replace the `style-card` placeholder with:

```tsx
import { StyleCard } from "@/components/voices/StyleCard";
// ...
{/* Movement 2: Style Card */}
<section aria-label="style-card">
  {personas.data && activeSlug && (() => {
    const selected = personas.data.find((p) => p.slug === activeSlug);
    if (!selected) return null;
    return (
      <StyleCard
        persona={selected}
        onEdit={() => setComposeMode({ kind: "edit", slug: selected.slug })}
      />
    );
  })()}
</section>
```

- [ ] **Step 3: Visually verify**

Reload `/voices`. Expected: large `Bowtie 編輯` headline, redline list (信息 → 資訊, 软件 → 軟件 …), tone-example pull quotes side by side.

- [ ] **Step 4: Commit**

```bash
git add web/components/voices/StyleCard.tsx web/app/voices/page.tsx
git commit -m "feat(web): StyleCard with redline list + tone quotes + usage"
```

---

## Task 16: `PressWorkflow` + `AgentRow` (collapsed view only)

**Files:**
- Create: `web/components/voices/PressWorkflow.tsx`
- Create: `web/components/voices/AgentRow.tsx`
- Modify: `web/app/voices/page.tsx`

This task ships the row strip and gate dividers. Expansion / inspector comes in Task 17.

- [ ] **Step 1: `AgentRow.tsx`**

```tsx
// web/components/voices/AgentRow.tsx
"use client";

import { cn } from "@/lib/utils";
import type { PromptNode } from "@/lib/types";

interface AgentRowProps {
  index: number;
  node: PromptNode;
  expanded: boolean;
  onToggle: () => void;
  expandable: boolean;
  children?: React.ReactNode;
}

export function AgentRow({ index, node, expanded, onToggle, expandable, children }: AgentRowProps) {
  const num = String(index).padStart(2, "0");
  return (
    <div className="border-b border-rule">
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        className={cn(
          "w-full grid grid-cols-[48px_1fr_24px] gap-6 py-5 items-start text-left",
          expandable && "hover:bg-paper-deep/40 transition-colors",
        )}
      >
        <div className="font-mono text-[14px] text-ink-faint tabular-nums pt-1">{num}</div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <p
              className="font-display text-[24px] text-ink"
              style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
            >
              {node.id}
            </p>
            <span className="font-mono text-[10px] tracking-wider uppercase text-ink-faint">
              {node.kind === "llm" ? "LLM" : "Deterministic"}
            </span>
            {node.uses_persona && (
              <span className="font-mono text-[10px] tracking-wider uppercase text-accent">
                · Persona-bound
              </span>
            )}
          </div>
          <p className="mt-1 text-[14px] text-ink-soft max-w-[65ch]">{node.description}</p>
        </div>
        <div className="font-mono text-[14px] text-ink-faint pt-1 text-right">
          {expandable ? (expanded ? "↑" : "↓") : ""}
        </div>
      </button>
      {expanded && children && (
        <div className="pb-6 pl-[72px] pr-6">{children}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `PressWorkflow.tsx`**

```tsx
// web/components/voices/PressWorkflow.tsx
"use client";

import { Fragment, useState } from "react";

import type { PromptGraph, PromptNode } from "@/lib/types";
import { AgentRow } from "./AgentRow";

interface PressWorkflowProps {
  graph: PromptGraph;
  renderInspector: (node: PromptNode) => React.ReactNode;
}

const SUB_GRAPH_LABELS: Record<string, string> = {
  strategy: "Bureau · Strategy",
  production: "Desk · Production",
  publish: "Press · Publish",
};

export function PressWorkflow({ graph, renderInspector }: PressWorkflowProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const byGroup = new Map<string, PromptNode[]>();
  for (const n of graph.nodes) {
    if (!byGroup.has(n.sub_graph)) byGroup.set(n.sub_graph, []);
    byGroup.get(n.sub_graph)!.push(n);
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => a.order - b.order);

  const gateBefore = new Map<string, typeof graph.gates[number]>(
    graph.gates.map((g) => [g.before, g]),
  );

  let rowIndex = 0;
  return (
    <div>
      {Array.from(byGroup.entries()).map(([sub, nodes]) => (
        <Fragment key={sub}>
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint pt-6 pb-2">
            {SUB_GRAPH_LABELS[sub] ?? sub}
          </p>
          {nodes.map((node) => {
            rowIndex += 1;
            const gate = gateBefore.get(node.id);
            return (
              <Fragment key={node.id}>
                {gate && (
                  <div className="my-3 flex items-center gap-3">
                    <div className="h-[3px] flex-1 bg-ink" />
                    <span className="font-mono text-[11px] tracking-[0.24em] uppercase text-ink">
                      {gate.label}
                    </span>
                    <div className="h-[3px] flex-1 bg-ink" />
                  </div>
                )}
                <AgentRow
                  index={rowIndex}
                  node={node}
                  expanded={expanded === node.id}
                  onToggle={() => setExpanded((e) => (e === node.id ? null : node.id))}
                  expandable={node.kind === "llm"}
                >
                  {renderInspector(node)}
                </AgentRow>
              </Fragment>
            );
          })}
        </Fragment>
      ))}
      <p className="mt-4 font-mono text-[11px] tracking-wider text-ink-faint">
        Revision loop · audit → writer, max 3 reviewer rounds
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Wire into page (no inspector yet — pass a placeholder)**

In `web/app/voices/page.tsx`, replace the `press-workflow` placeholder:

```tsx
import { PressWorkflow } from "@/components/voices/PressWorkflow";
// ...
{/* Movement 3+4: Press Workflow */}
<section aria-label="press-workflow">
  {graph.data && (
    <PressWorkflow
      graph={graph.data}
      renderInspector={(node) => (
        <p className="text-ink-faint text-[12px]">
          Inspector for {node.id} — coming next
        </p>
      )}
    />
  )}
</section>
```

- [ ] **Step 4: Visually verify**

Expected: ordered rows in two groups (Bureau, Desk), `GATE · HITL_1` divider before `writer`, `GATE · HITL_2` divider before `publish`. Only `writer` and `audit` show `· Persona-bound`. Clicking an LLM row toggles a placeholder; deterministic rows are non-clickable.

- [ ] **Step 5: Commit**

```bash
git add web/components/voices/PressWorkflow.tsx web/components/voices/AgentRow.tsx web/app/voices/page.tsx
git commit -m "feat(web): PressWorkflow + AgentRow with HITL gate dividers"
```

---

## Task 17: `PromptInspector` — system prompt template view

**Files:**
- Create: `web/components/voices/PromptInspector.tsx`
- Modify: `web/app/voices/page.tsx`

- [ ] **Step 1: Implement (system prompt half only — user-example arrives next task)**

```tsx
// web/components/voices/PromptInspector.tsx
"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { promptsApi } from "@/lib/api";
import type { PromptNode } from "@/lib/types";

interface PromptInspectorProps {
  node: PromptNode;
  /** runId picker UI is added in Task 18. */
  userPromptSlot?: React.ReactNode;
}

export function PromptInspector({ node, userPromptSlot }: PromptInspectorProps) {
  const templateIds = [
    node.system_prompt_template_id,
    ...(node.alt_template_ids ?? []),
  ].filter((x): x is string => Boolean(x));

  const [activeId, setActiveId] = useState(templateIds[0] ?? null);

  const tmpl = useQuery({
    enabled: activeId !== null,
    queryKey: ["prompt-template", activeId],
    queryFn: () => promptsApi.template(activeId!),
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-6 mt-2">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <p className="kicker">System prompt</p>
          {templateIds.length > 1 && (
            <div className="flex gap-1">
              {templateIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveId(id)}
                  className={`font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 border ${
                    id === activeId ? "border-accent text-accent" : "border-rule text-ink-faint"
                  }`}
                >
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
        {tmpl.isLoading && <p className="text-ink-faint text-[12px]">Loading…</p>}
        {tmpl.data && (
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-soft border border-rule p-3 max-h-[480px] overflow-auto">
            {tmpl.data.template.replace(
              "{persona_block}",
              "[ persona block — see Style Card above ]",
            )}
          </pre>
        )}
      </div>
      <div>
        <p className="kicker mb-2">User prompt</p>
        {userPromptSlot ?? (
          <p className="text-ink-faint text-[12px]">User prompt picker coming next.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into the page**

In `web/app/voices/page.tsx`, replace the placeholder inspector with:

```tsx
import { PromptInspector } from "@/components/voices/PromptInspector";
// ...
renderInspector={(node) => <PromptInspector node={node} />}
```

- [ ] **Step 3: Visually verify**

Expected: expanding `writer` shows a two-column inspector, system prompt loaded with `{persona_block}` replaced by the inline note, and a `small_refresh / full_rewrite` toggle. Expanding `audit` shows the audit template with no toggle.

- [ ] **Step 4: Commit**

```bash
git add web/components/voices/PromptInspector.tsx web/app/voices/page.tsx
git commit -m "feat(web): PromptInspector — system prompt view with template switcher"
```

---

## Task 18: `UserExamplePicker` — render real user prompt from a past run

**Files:**
- Create: `web/components/voices/UserExamplePicker.tsx`
- Modify: `web/components/voices/PromptInspector.tsx`

- [ ] **Step 1: Implement the picker**

```tsx
// web/components/voices/UserExamplePicker.tsx
"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, promptsApi } from "@/lib/api";

interface UserExamplePickerProps {
  agent: string;
  schemaHint: React.ReactNode;
}

export function UserExamplePicker({ agent, schemaHint }: UserExamplePickerProps) {
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns(),
  });
  const [runId, setRunId] = useState<string | null>(null);

  const example = useQuery({
    enabled: runId !== null,
    queryKey: ["user-example", runId, agent],
    queryFn: () => promptsApi.userExample(runId!, agent),
    retry: false,
  });

  return (
    <div className="space-y-3">
      {schemaHint}

      <div className="flex items-center gap-2">
        <label className="font-mono text-[10px] tracking-wider uppercase text-ink-faint">
          Load example from run
        </label>
        <select
          value={runId ?? ""}
          onChange={(e) => setRunId(e.target.value || null)}
          className="text-[12px] border border-rule bg-paper px-2 py-1 max-w-[280px]"
        >
          <option value="">— pick a run —</option>
          {runs.data?.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {new Date(r.created_at).toISOString().slice(0, 10)} · {r.topic.slice(0, 40)}
            </option>
          ))}
        </select>
      </div>

      {example.isError && (
        <p className="text-accent-deep text-[12px]">
          {(example.error as Error).message}
        </p>
      )}
      {example.data && (
        <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-soft border border-rule p-3 max-h-[480px] overflow-auto">
          {example.data.prompt}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the picker into `PromptInspector`**

Replace the user-prompt half of `PromptInspector.tsx` so it renders both a schema hint and the picker. Add a small `USER_PROMPT_SCHEMAS` lookup at the top of the file:

```tsx
import { UserExamplePicker } from "./UserExamplePicker";

const USER_PROMPT_SCHEMAS: Record<string, { field: string; source: string }[]> = {
  gap_analysis: [
    { field: "topic", source: "runs.topic" },
    { field: "focus_keywords", source: "runs.keywords" },
    { field: "existing_article", source: "runs.article_url" },
    { field: "acf_adv_id", source: "runs.acf_adv_id" },
    { field: "acf_widget_id", source: "runs.acf_widget_id" },
    { field: "route", source: "runs.mode" },
    { field: "article_edit_note", source: "runs.edit_note" },
  ],
  outline: [
    { field: "chosen_route", source: "runs.chosen_route" },
    { field: "acf_adv_id", source: "runs.acf_adv_id" },
    { field: "acf_widget_id", source: "runs.acf_widget_id" },
    { field: "gap_analysis", source: "gap_analyses.payload" },
    { field: "existing_article_markdown", source: "fetched_articles.markdown" },
  ],
  writer: [
    { field: "topic", source: "runs.topic" },
    { field: "focus_keywords", source: "runs.keywords" },
    { field: "existing_article_URL", source: "runs.article_url" },
    { field: "acf_adv_id", source: "runs.acf_adv_id" },
    { field: "acf_widget_id", source: "runs.acf_widget_id" },
    { field: "topic_category", source: "runs.topic_category" },
    { field: "outline", source: "outlines.payload" },
    { field: "gap_analysis", source: "gap_analyses.payload" },
    { field: "existing_article_markdown", source: "fetched_articles.markdown" },
    { field: "refine_notes", source: "audit_runs.findings (must_fix) + reviewer comments" },
  ],
  audit: [
    { field: "final_html", source: "renders.html_body" },
    { field: "gap_analysis.update_plan", source: "gap_analyses.payload.update_plan" },
    { field: "citation_intents", source: "drafts.citation_intents" },
    { field: "citations", source: "citations table (resolved)" },
    { field: "deterministic_findings", source: "audit_runs.deterministic_findings" },
  ],
};
```

Then replace the user-prompt half of the JSX in `PromptInspector`:

```tsx
<div>
  <p className="kicker mb-2">User prompt</p>
  <UserExamplePicker
    agent={node.id}
    schemaHint={
      <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1 text-[12px]">
        {(USER_PROMPT_SCHEMAS[node.id] ?? []).map((s) => (
          <Fragment key={s.field}>
            <dt className="font-mono uppercase tracking-wider text-ink-faint">{s.field}</dt>
            <dd className="text-ink-soft">{s.source}</dd>
          </Fragment>
        ))}
      </dl>
    }
  />
</div>
```

Add `import { Fragment } from "react";` at the top.

- [ ] **Step 3: Visually verify**

Pick a real run (the seeded test run from your dev DB, or any run that's progressed past `audit`). Expected: schema list of fields, then picker; selecting a run renders the actual user prompt below. For an unfinished run, expect a red error message reading something like `422: missing inputs: audit needs a draft`.

- [ ] **Step 4: Commit**

```bash
git add web/components/voices/UserExamplePicker.tsx web/components/voices/PromptInspector.tsx
git commit -m "feat(web): user prompt schema + load-from-run picker"
```

---

## Task 19: `ComposeDrawer` — Create flow

**Files:**
- Create: `web/components/voices/ComposeDrawer.tsx`
- Modify: `web/app/voices/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// web/components/voices/ComposeDrawer.tsx
"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { personasApi } from "@/lib/api";
import type { Persona, PersonaIn } from "@/lib/types";

interface ComposeDrawerProps {
  mode: { kind: "create" } | { kind: "edit"; persona: Persona };
  onClose: () => void;
  onSaved: (slug: string) => void;
}

function emptyForm(): PersonaIn {
  return {
    slug: "",
    name: "",
    voice_rules: [""],
    banned_terms: [""],
    required_phrasings: [""],
    disclaimer_templates: {},
    tone_examples: { good: [""], bad: [""] },
  };
}

function fromPersona(p: Persona): PersonaIn {
  return {
    slug: p.slug,
    name: p.name,
    voice_rules: p.voice_rules.length ? p.voice_rules : [""],
    banned_terms: p.banned_terms.length ? p.banned_terms : [""],
    required_phrasings: p.required_phrasings.length ? p.required_phrasings : [""],
    disclaimer_templates: p.disclaimer_templates,
    tone_examples: {
      good: p.tone_examples.good.length ? p.tone_examples.good : [""],
      bad: p.tone_examples.bad.length ? p.tone_examples.bad : [""],
    },
  };
}

function StringList({
  label, values, onChange,
}: { label: string; values: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">{label}</p>
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={v}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
            className="flex-1 border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
          />
          {values.length > 1 && (
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="text-ink-faint hover:text-accent-deep text-[14px]"
              aria-label="remove"
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="font-mono text-[10px] tracking-wider uppercase text-ink-faint hover:text-ink"
      >
        ＋ 加一行
      </button>
    </div>
  );
}

export function ComposeDrawer({ mode, onClose, onSaved }: ComposeDrawerProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<PersonaIn>(
    mode.kind === "create" ? emptyForm() : fromPersona(mode.persona),
  );

  const createMut = useMutation({
    mutationFn: (body: PersonaIn) => personasApi.create(body),
    onSuccess: (p) => {
      toast.success(`Voice "${p.name}" created`);
      qc.invalidateQueries({ queryKey: ["personas"] });
      onSaved(p.slug);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ slug, body }: { slug: string; body: PersonaIn }) =>
      personasApi.update(slug, {
        name: body.name,
        voice_rules: body.voice_rules.filter(Boolean),
        banned_terms: body.banned_terms.filter(Boolean),
        required_phrasings: body.required_phrasings.filter(Boolean),
        disclaimer_templates: body.disclaimer_templates,
        tone_examples: {
          good: body.tone_examples.good.filter(Boolean),
          bad: body.tone_examples.bad.filter(Boolean),
        },
      }),
    onSuccess: (p) => {
      toast.success(`Voice "${p.name}" updated`);
      qc.invalidateQueries({ queryKey: ["personas"] });
      qc.invalidateQueries({ queryKey: ["persona-usage", p.slug] });
      onSaved(p.slug);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const archiveMut = useMutation({
    mutationFn: (slug: string) => personasApi.archive(slug),
    onSuccess: () => {
      toast.success("Voice archived");
      qc.invalidateQueries({ queryKey: ["personas"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode.kind === "create") {
      createMut.mutate({
        ...form,
        voice_rules: form.voice_rules.filter(Boolean),
        banned_terms: form.banned_terms.filter(Boolean),
        required_phrasings: form.required_phrasings.filter(Boolean),
        tone_examples: {
          good: form.tone_examples.good.filter(Boolean),
          bad: form.tone_examples.bad.filter(Boolean),
        },
      });
    } else {
      updateMut.mutate({ slug: mode.persona.slug, body: form });
    }
  }

  const busy = createMut.isPending || updateMut.isPending;

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/20 z-40"
        onClick={onClose}
        aria-hidden
      />
      <aside className="fixed right-0 top-0 bottom-0 z-50 w-full md:w-[460px] bg-paper border-l border-rule overflow-y-auto">
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <header className="flex items-center justify-between">
            <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
              {mode.kind === "create" ? "Compose · New voice" : "Edit · " + mode.persona.slug}
            </p>
            <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink">×</button>
          </header>

          <div className="space-y-3">
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1">Slug</p>
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                disabled={mode.kind === "edit"}
                className="w-full border-b border-rule bg-transparent py-1 text-[14px] disabled:text-ink-faint focus:outline-none focus:border-ink"
                placeholder="lowercase-with-dashes"
              />
            </div>
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1">Name</p>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full border-b border-rule bg-transparent py-1 text-[18px] font-display"
              />
            </div>
          </div>

          <StringList
            label="Voice rules · 語氣規則"
            values={form.voice_rules}
            onChange={(next) => setForm({ ...form, voice_rules: next })}
          />
          <StringList
            label="Banned terms · 字詞禁用"
            values={form.banned_terms}
            onChange={(next) => setForm({ ...form, banned_terms: next })}
          />
          <StringList
            label="Required phrasings · 必用詞"
            values={form.required_phrasings}
            onChange={(next) => setForm({ ...form, required_phrasings: next })}
          />
          <StringList
            label="Tone — good · 好"
            values={form.tone_examples.good}
            onChange={(next) => setForm({ ...form, tone_examples: { ...form.tone_examples, good: next } })}
          />
          <StringList
            label="Tone — bad · 壞"
            values={form.tone_examples.bad}
            onChange={(next) => setForm({ ...form, tone_examples: { ...form.tone_examples, bad: next } })}
          />

          <footer className="space-y-3 pt-4 border-t border-rule">
            <button
              type="submit"
              disabled={busy || !form.slug || !form.name}
              className="w-full bg-ink text-paper py-2 text-[13px] tracking-wider uppercase disabled:opacity-40"
            >
              {busy ? "Saving…" : mode.kind === "create" ? "Create voice" : "Save changes"}
            </button>
            {mode.kind === "edit" && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Archive "${mode.persona.name}"? Existing runs still resolve; new runs won't see it.`)) {
                    archiveMut.mutate(mode.persona.slug);
                  }
                }}
                className="text-accent-deep text-[12px] hover:underline"
              >
                Archive this voice
              </button>
            )}
          </footer>
        </form>
      </aside>
    </>
  );
}
```

- [ ] **Step 2: Wire into page**

In `web/app/voices/page.tsx`, render the drawer when `composeMode` is set:

```tsx
import { ComposeDrawer } from "@/components/voices/ComposeDrawer";
// ...
{composeMode && personas.data && (
  <ComposeDrawer
    mode={
      composeMode.kind === "create"
        ? { kind: "create" }
        : {
            kind: "edit",
            persona: personas.data.find((p) => p.slug === composeMode.slug)!,
          }
    }
    onClose={() => setComposeMode(null)}
    onSaved={(slug) => {
      setComposeMode(null);
      setSelectedSlug(slug);
    }}
  />
)}
```

- [ ] **Step 3: Manually test the full loop**

With the dev server running:

1. Click `＋ New voice` → drawer opens.
2. Fill in slug `qa-voice`, name `QA Voice`, one voice rule, one banned term, one required phrasing, one good and bad tone example.
3. Click `Create voice` → toast "Voice ... created", drawer closes, rolodex now shows the new card, and it auto-selects.
4. Click `Edit voice →` on the new card. Slug field is disabled. Edit the name. `Save changes`. Style Card updates.
5. Click `Archive this voice`, confirm. Drawer closes, card disappears from rolodex (re-enable `show archived` to see it).
6. Toggle `show archived`, find `qa-voice`, click it → still loads but marked archived.

- [ ] **Step 4: Commit**

```bash
git add web/components/voices/ComposeDrawer.tsx web/app/voices/page.tsx
git commit -m "feat(web): ComposeDrawer for create/edit/archive personas"
```

---

## Task 20: End-to-end verification + cleanup

**Files:** None (verification + cleanup commit if needed)

- [ ] **Step 1: Run the full backend test suite**

```bash
pytest -q
```

Expected: all PASS (the new tests plus every pre-existing test).

- [ ] **Step 2: Type-check the web**

```bash
cd web && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Smoke-test the happy path**

With the API + web both running:

1. `/voices` loads, shows `bowtie-editor` selected by default.
2. The Style Card renders the redline list, voice rules, tone-example pull quotes, and a real usage tag (`N runs · ...`).
3. The Press Workflow shows two sub-graphs with `GATE · HITL_1` and `GATE · HITL_2` dividers; only `writer` and `audit` carry `· Persona-bound`.
4. Expanding `writer` shows the system prompt with `[ persona block — see Style Card above ]` substituted, a `small_refresh / full_rewrite` toggle, and the user-prompt schema + picker. Picking a run renders the actual user prompt.
5. Expanding `audit` shows the audit template (no toggle) and its schema + picker.
6. Create / edit / archive flows from Task 19 all work.
7. After archiving `bowtie-editor` (then immediately restoring it via `POST /personas/bowtie-editor/restore` in DevTools), an existing run that referenced it still renders and still runs — i.e. `load_persona` still resolves an archived persona.

- [ ] **Step 4: If any UI glitches showed up during manual test, fix inline and commit**

```bash
git add -A
git commit -m "fix(voices): smoke-test fixes"
```

- [ ] **Step 5: Final spec compliance check**

Re-read [docs/superpowers/specs/2026-05-26-voices-page-design.md](../specs/2026-05-26-voices-page-design.md) acceptance criteria 1–8 and confirm each passes. If any are missing, open a follow-up task here; do not silently skip.

---

## Self-Review

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| Personas table + seed | Task 1 |
| `Persona` model | Task 2 |
| Async `load_persona` + CRUD + YAML fallback | Task 3 |
| Update writer/audit/refresh callers | Task 4 |
| API schemas | Task 5 |
| `/personas` CRUD + archive + restore + usage | Task 6 |
| Graph metadata constant | Task 7 |
| `/prompts/graph` + `/prompts/templates/{id}` | Task 8 |
| `/prompts/user-example` | Task 9 |
| TS types + API client | Task 10 |
| Nav entry | Task 11 |
| Page scaffold | Task 12 |
| Rolodex | Task 13 |
| RedlineList (the unforgettable detail) | Task 14 |
| StyleCard + usage | Task 15 |
| PressWorkflow + AgentRow + HITL gates | Task 16 |
| PromptInspector — system prompt | Task 17 |
| UserExamplePicker | Task 18 |
| ComposeDrawer — Create / Edit / Archive | Task 19 |
| Full E2E verification | Task 20 |

Every section of the spec maps to at least one task.

**Type consistency:**

- `Persona` shape matches between `tests/integration/test_api_personas.py`, `content_tool/api/schemas.py:PersonaOut`, and `web/lib/types.ts:Persona`. All use `voice_rules`, `banned_terms`, `required_phrasings`, `disclaimer_templates`, `tone_examples`, `is_archived`, `created_at`, `updated_at`, `created_by`, `updated_by`.
- `PromptNode` shape matches between `content_tool/api/prompt_graph.py:PROMPT_GRAPH["nodes"]`, the test in `test_prompt_graph.py`, and `web/lib/types.ts:PromptNode`. All use `id`, `sub_graph`, `order`, `kind`, `uses_persona`, `system_prompt_template_id`, `description`, optional `alt_template_ids`.
- API method names line up: `personasApi.{list,get,create,update,archive,restore,usage}` mirror the FastAPI routes one-for-one.

**Placeholder scan:** No TBDs, no "add error handling," no "similar to Task N." Every code block is complete. Every step has either code, a command, or an explicit visual-verification action.

**Notable trade-offs / risks worth flagging during implementation:**

1. **`pnpm` vs `npm` vs `yarn`** — the plan assumes `pnpm`. If the project uses a different package manager, substitute the equivalent commands.
2. **`/api/personas` URL prefix** — the plan assumes the existing reverse-proxy pattern routes `/api/*` to the FastAPI app. If your Next.js setup uses a different prefix, follow whatever convention `articlesApi` already uses in `web/lib/api.ts`.
3. **`Run` / `Draft` / `Render` column names in Task 9 fixtures** — verify against `content_tool/db/models.py` before pasting. The plan uses field names from the spec; if any have drifted in the live code, prefer the live code and adjust the fixture.

---

## Execution Handoff

Plan complete and saved to [docs/superpowers/plans/2026-05-26-voices-page.md](docs/superpowers/plans/2026-05-26-voices-page.md). Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
