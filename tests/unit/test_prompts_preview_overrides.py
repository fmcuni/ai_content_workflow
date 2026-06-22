# ruff: noqa: RUF001  — CJK fixtures mirror the prompt strings verbatim
"""Phase 2 parity tests: optional draft overrides on POST /templates/:id/preview.

Mirrors `deploy/cloudflare-workers/src/prompts/preview_overrides.test.ts`. The
PARITY_* fixtures and the expected rendered strings are byte-for-byte identical
across both files, so the two backends are asserted to produce the same output
for the same inputs.
"""

from __future__ import annotations

from content_tool import prompts_store
from content_tool.api.routes.prompts import (
    _PersonaOverride,
    _substitute_placeholders,
)
from content_tool.models.persona import GlossaryEntry, PersonaPack, VoiceLocale
from content_tool.policy.source_policy import SourcePolicy
from content_tool.prompts_store import TemplateRow

# ---------------------------------------------------------------------------
# PARITY fixtures — identical to the TS test file.
# ---------------------------------------------------------------------------

PARITY_GLOSSARY_RAW = [
    {"term": "保險", "preferred": "保障", "status": "preferred"},
    {"term": "termlife", "status": "do_not_translate"},
]

PARITY_SOURCE_POLICY_DRAFT = {"prompt_block": "DRAFT POLICY BLOCK 自訂"}


def _parity_persona(glossary: list[GlossaryEntry]) -> PersonaPack:
    return PersonaPack(
        name="Tester",
        voice_rules=["rule"],
        banned_terms=[],
        required_phrasings=[],
        disclaimer_templates={},
        tone_examples={"good": [], "bad": []},
        glossary=glossary,
        locale=VoiceLocale(),
    )


def _row(template_id: str, body: str, category: str = "partial") -> TemplateRow:
    return TemplateRow(
        voice_slug="__shared__",
        template_id=template_id,
        category=category,
        filename=f"{template_id}.md",
        body=body,
        sha256="deadbeef",
        bytes=len(body),
    )


def _snap(*rows: TemplateRow) -> dict[tuple[str, str], TemplateRow]:
    return {(r.voice_slug, r.template_id): r for r in rows}


# ---------------------------------------------------------------------------
# partial_overrides — multi-override assembly threading (engine in
# test_prompts_store_voice.py; here: the preview's exact semantics).
# ---------------------------------------------------------------------------


def test_agent_path_threads_sibling_partial_drafts() -> None:
    snap = _snap(_row("_p2", "stored p2\n"))
    out = prompts_store.resolve_body_with_overrides(
        "HEAD {{include:_p2}} TAIL", snap, {"_p2": "draft p2"}, voice_slug="__shared__"
    )
    assert out == "HEAD draft p2 TAIL"


def test_partial_path_focused_template_wins_over_same_id_override() -> None:
    snap = _snap(
        _row("agent_x", "{{include:_focus}}\n", category="agent"),
        _row("_focus", "stored\n"),
    )
    # Mirrors the route: overrides = {**partial_overrides, focus_id: template}.
    partial_overrides = {"_focus": "from_partial_overrides\n"}
    overrides = {**partial_overrides, "_focus": "FOCUSED WINS\n"}
    out = prompts_store.assemble_with_overrides(
        "agent_x", snap, overrides, voice_slug="__shared__"
    )
    assert out == "FOCUSED WINS\n"


def test_absent_partial_overrides_byte_identical() -> None:
    snap = _snap(_row("_p", "stored"))
    assert (
        prompts_store.resolve_body_with_overrides(
            "A {{include:_p}} B", snap, {}, voice_slug="__shared__"
        )
        == "A stored B"
    )


# ---------------------------------------------------------------------------
# glossary draft override — folded into the persona block via to_prompt_block.
# ---------------------------------------------------------------------------


def test_draft_glossary_renders_same_block_bytes_as_stored() -> None:
    glossary = [GlossaryEntry.model_validate(e) for e in PARITY_GLOSSARY_RAW]
    block = _parity_persona(glossary).to_prompt_block(None)
    # PARITY: byte-identical to the TS test's expected string.
    assert block == (
        "# 撰稿人格\n"
        "角色：Tester\n"
        "語氣規則：\n"
        "- rule\n"
        "避免使用的字詞：\n"
        "必須採用的香港用語：\n"
        "語氣示例：\n\n\n"
        "# 詞彙表 · Glossary\n"
        "- 用「保障」\n"
        "- 保留原文：termlife\n"
    )


# ---------------------------------------------------------------------------
# source_policy draft override — rendered server-side via to_prompt_block.
# ---------------------------------------------------------------------------


def test_draft_source_policy_prompt_block_flows_through() -> None:
    policy = SourcePolicy(dict(PARITY_SOURCE_POLICY_DRAFT))
    out = _substitute_placeholders(
        "policy={source_policy_block}",
        overrides={},
        view={},
        voice="bowtie-editor",
        source_policy_default=policy.to_prompt_block(),
    )
    # PARITY: the draft's trimmed prompt_block is the rendered block.
    assert out == "policy=DRAFT POLICY BLOCK 自訂"


def test_context_source_policy_block_wins_over_draft() -> None:
    policy = SourcePolicy({"prompt_block": "DRAFT"})
    out = _substitute_placeholders(
        "policy={source_policy_block}",
        overrides={"source_policy_block": "CTX WINS"},
        view={},
        voice="bowtie-editor",
        source_policy_default=policy.to_prompt_block(),
    )
    assert out == "policy=CTX WINS"


# ---------------------------------------------------------------------------
# Combined + absent invariants.
# ---------------------------------------------------------------------------


def test_combined_glossary_and_source_policy_reflected_together() -> None:
    glossary = [GlossaryEntry.model_validate(e) for e in PARITY_GLOSSARY_RAW]
    persona_block = _parity_persona(glossary).to_prompt_block(None)
    policy = SourcePolicy(dict(PARITY_SOURCE_POLICY_DRAFT))
    out = _substitute_placeholders(
        "P={persona_block}\nS={source_policy_block}",
        overrides={"persona_block": persona_block, "create_mode_block": "CM"},
        view={},
        voice="bowtie-editor",
        source_policy_default=policy.to_prompt_block(),
        persona_override=_PersonaOverride(locale=VoiceLocale(), glossary=glossary),
    )
    # PARITY: persona block (with glossary) + draft policy block, together.
    assert out == f"P={persona_block}\nS=DRAFT POLICY BLOCK 自訂"


def test_absent_all_three_overrides_byte_identical() -> None:
    template = (
        "P={persona_block}\nD={today_date}\nPOL={source_policy_block}\nC={create_mode_block}"
    )
    ctx = {
        "persona_block": "PB",
        "today_date": "2026-06-15",
        "source_policy_block": "SP",
        "create_mode_block": "CM",
    }
    out = _substitute_placeholders(
        template,
        overrides=dict(ctx),
        view={},
        voice="bowtie-editor",
        source_policy_default="",
    )
    assert out == "P=PB\nD=2026-06-15\nPOL=SP\nC=CM"
