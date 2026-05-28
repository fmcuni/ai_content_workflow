# 2026-05-29 — Prompt-Editor Version History & Lightweight RBAC

Follow-up to [2026-05-28-prompt-unify-and-editor.md](./2026-05-28-prompt-unify-and-editor.md).
Part 2 of that plan shipped the editor with optimistic-concurrency saves and
"git log is the audit trail" as the recovery story. This plan brings two of
the four items it deferred:

1. **Version history + revert UI** — every save is captured in a new
   `prompt_versions` row; editor exposes a "History" panel with one-click
   revert.
2. **Lightweight RBAC** — header-based editor identity (`X-Editor-Email` from
   a trusted reverse proxy) + a small allowlist in config. Gates writes and
   stamps history rows with who edited. Not real auth — a stepping stone
   until a full auth story lands.

The other two items (per-environment overrides, live-edit mid-run) stay
deferred. Live-edit specifically should remain deferred — "next run only"
is the safer default and the editor already documents it; making that note
more prominent is the right fix, not hot-reload.

---

## Part A — Lightweight RBAC

### Configuration

New file `config/prompt_editors.yaml`:

```yaml
# Editors allowed to write prompt templates. The X-Editor-Email header is
# trusted (set by the reverse proxy that does SSO). Anyone in this list can
# save and revert.
editors:
  - franco.ma@bowtie.com.sg
  - <other>@bowtie.com.sg
# When `dev_mode` is true the email gate is skipped — every request can write
# and is stamped as `created_by` = the header value, or "dev@local" when no
# header. Use ONLY in local dev / tests; CI sets PROMPT_EDITOR_DEV_MODE=false.
dev_mode: ${PROMPT_EDITOR_DEV_MODE:-true}
```

Loaded via a new `content_tool/policy/prompt_editors.py` mirroring the
`SourcePolicy` shape: a small dataclass with `is_allowed(email: str) -> bool`
and `dev_mode: bool`. Path resolved at module import; tests can pass an
override.

### Dependency

`content_tool/api/routes/prompts.py` gets:

```python
async def _require_editor(request: Request) -> str:
    """Return the editor's email; 401 if missing, 403 if not allowed.

    Reads X-Editor-Email — assumed set by the SSO reverse proxy. In dev_mode
    a missing header falls back to "dev@local" so local development is not
    blocked. The same dependency is used to stamp version-history rows.
    """
    email = request.headers.get("X-Editor-Email", "").strip().lower()
    policy = _editors_policy()
    if not email:
        if policy.dev_mode:
            return "dev@local"
        raise HTTPException(401, "missing X-Editor-Email header")
    if not policy.is_allowed(email) and not policy.dev_mode:
        raise HTTPException(403, f"{email} is not an authorised prompt editor")
    return email
```

Wired into the two write endpoints:

```python
@router.put("/templates/{template_id}")
async def save_template(
    template_id: str,
    body: _SaveTemplateRequest,
    editor: str = Depends(_require_editor),
    sf=Depends(_get_session_factory),
) -> dict[str, Any]: ...

@router.post("/templates/{template_id}/revert")
async def revert_template(
    template_id: str,
    body: _RevertRequest,
    editor: str = Depends(_require_editor),
    sf=Depends(_get_session_factory),
) -> dict[str, Any]: ...
```

Read endpoints stay unauthenticated. Anyone with network access to the API
host can already read prompt files via the existing list/template endpoints;
restricting reads adds friction without security gain until a real auth
layer exists.

### Frontend wiring

`web/lib/api.ts` is extended so every request carries `X-Editor-Email` taken
from a single source of truth:

- In production the reverse proxy injects the header — the browser doesn't
  set it.
- For local dev a `NEXT_PUBLIC_PROMPT_EDITOR_EMAIL` env var pre-fills the
  header from the browser, so dev mode + local API still stamps a sensible
  identity. Falls back to `dev@local`.
- The header is added in the existing `http<T>` helper so all `/api/prompts/*`
  requests get it; non-prompts endpoints are unaffected.

### Tests

- `tests/integration/test_api_prompts.py`:
  - PUT without `X-Editor-Email` in non-dev mode → 401.
  - PUT with disallowed email → 403.
  - PUT with allowed email → 200 + version row stamped with that email.

---

## Part B — Version history

### Database

New migration `0016_prompt_versions.py`:

```sql
create table content_tool.prompt_versions (
    version_id     uuid primary key default gen_random_uuid(),
    template_id    text not null,                  -- "writer_small_refresh" / "_writer_brand_block"
    sha256         text not null,                  -- sha256 of `body`
    parent_sha256  text,                           -- sha256 of the row this overwrote (null for the first save)
    body           text not null,
    bytes          integer not null,
    saved_by       text not null,                  -- email from _require_editor
    saved_at       timestamptz not null default now(),
    kind           text not null default 'save'    -- 'save' | 'revert' (stamps which endpoint inserted it)
);

create index prompt_versions_template_idx
    on content_tool.prompt_versions (template_id, saved_at desc);
```

Indexed on `(template_id, saved_at desc)` so the history panel reads are O(N)
in the row count, not the table.

### Model

`content_tool/db/models.py` gets a `PromptVersion` class mirroring the
columns; nothing fancy.

### Endpoints

```python
@router.get("/templates/{template_id}/history")
async def template_history(
    template_id: str, limit: int = 50, sf=Depends(_get_session_factory),
) -> dict[str, Any]:
    """Newest-first list of saves for this template. Body is omitted to keep
    the payload small; the consumer fetches a specific version on demand.
    """

@router.get("/templates/{template_id}/versions/{version_id}")
async def template_version(
    template_id: str, version_id: UUID, sf=Depends(_get_session_factory),
) -> dict[str, Any]:
    """Return one version's full body + metadata. Used by the revert flow to
    preview and confirm before writing.
    """

class _RevertRequest(BaseModel):
    target_version_id: UUID
    expected_sha256: str = Field(..., min_length=64, max_length=64)

@router.post("/templates/{template_id}/revert")
async def revert_template(
    template_id: str, body: _RevertRequest, editor=Depends(_require_editor),
    sf=Depends(_get_session_factory),
) -> dict[str, Any]:
    """Atomically replace the on-disk template with the body of the given
    version. Same optimistic-concurrency gate as PUT (current on-disk sha
    must match `expected_sha256`). Inserts a new prompt_versions row with
    kind='revert' so the trail is symmetric.
    """
```

### `save_template` change

After the existing atomic write, insert one row:

```python
async with sf() as session:
    session.add(PromptVersion(
        template_id=template_id,
        sha256=new_sha,
        parent_sha256=current_sha,
        body=body.template,
        bytes=len(new_bytes),
        saved_by=editor,
        kind="save",
    ))
    await session.commit()
```

`revert_template` does the same plus reads the target version's body and
writes it via the existing tmp+os.replace path.

### Frontend

New `History` panel in `web/app/prompts/[templateId]/page.tsx`, slotted into
the right rail beneath "Used by":

- List of recent versions (saved_at relative-time, saved_by, sha short hash,
  kind chip).
- Each row clickable → opens a small dialog showing the version's body in a
  read-only `<pre>` + a "Revert to this" button.
- Revert button calls `POST .../revert` with `target_version_id +
  expected_sha256` (current sha from the editor state). Reuses the same
  409 toast UX as save.
- After a successful revert the panel refreshes and the editor reloads.

### Tests

- `tests/integration/test_api_prompts.py`:
  - PUT inserts a version row matching the saved sha.
  - GET history returns rows in newest-first order, body excluded.
  - GET version returns the full body for a known row.
  - POST revert with current sha writes the historical body back and
    inserts a `kind='revert'` row.
  - POST revert with stale sha → 409.

---

## Work order

1. Migration `0016_prompt_versions` + `PromptVersion` model.
2. `prompt_editors` config loader + `_require_editor` dependency. Tests at
   the dependency level (FastAPI test client + custom header).
3. Stamp version rows in `save_template`; add `GET history`, `GET version`,
   `POST revert`. Integration tests.
4. Frontend: extend `http<T>` to send `X-Editor-Email`; add `historyApi`
   methods to `promptsApi`; render History panel + revert dialog.
5. Playwright smoke: save → see new history row → revert → confirm body
   restored.

## Risks

- **Header spoofing in dev.** The trust model assumes the reverse proxy
  strips client-supplied `X-Editor-Email` before forwarding. If the proxy
  is misconfigured this is bypassable. Document the proxy rule prominently
  in CLAUDE.md when this ships; CI smoke should set the header explicitly.
- **History table growth.** A chatty editor could create many rows per day.
  At ~3 KiB / row × 15 templates × 100 saves/template/year that is ~5 MiB —
  trivial. No pruning needed in v1.
- **Revert race.** Two reverts to different targets concurrent: the second
  loses the sha race and 409s, by design. The user reloads and re-picks.

## Out of scope (still)

- Per-environment prompt overrides — would clash with the single-source-of-
  truth contract this plan codifies in `prompt_versions`. Revisit if the
  staging vs prod prompt drift becomes a real cost.
- Live-edit during in-flight runs — see plan header.
- Real auth (OIDC / session cookies). When that lands, swap
  `_require_editor` for the real identity provider; `prompt_versions` rows
  already store an email-shaped string so the migration is just the
  dependency.
