import re
from typing import Any, Literal

from pydantic import BaseModel, Field

# CJK detection (CJK Ext A + Unified Ideographs + Compatibility Ideographs).
# Mirrors the web heuristic so the persona-block label set is auto-derived from
# the voice's output language — no separate manual control.
_CJK_RE = re.compile(r"[㐀-鿿豈-﫿]")

GlossaryStatus = Literal["preferred", "avoid", "forbidden", "do_not_translate"]


class VoiceLocale(BaseModel):
    """Per-voice locale / brand identity, stored in ``personas.locale`` (JSONB).

    The defaults reproduce ``bowtie-editor`` (Bowtie HK 繁體中文) **byte-for-byte**,
    so an empty ``{}`` locale is a no-op — existing voices behave exactly as
    before. A voice opts into a different brand/language/market purely as data.

    Fields:
      - ``output_language`` — value for the ``{output_language}`` prompt token.
      - ``brand_name``      — value for the ``{brand_name}`` prompt token.
      - ``market``          — value for the ``{market}`` token (``topic_hot`` etc.).
      - ``sources_heading`` — explicit sources ``<h2>`` text; ``None`` keeps
        today's Traditional↔Simplified script auto-detection (safe for zh voices).
      - ``faq_heading``     — FAQ heading used by ``render_html``'s fallback/split.

    The persona-block label set (Traditional-Chinese vs English scaffolding) is
    **auto-derived** from ``output_language`` — see ``_labels_for``. There is no
    separate manual control.
    """

    output_language: str = "香港繁體中文"
    brand_name: str = "Bowtie"
    market: str = "Google 香港繁中"
    sources_heading: str | None = None
    faq_heading: str = "常見問題"

    @classmethod
    def from_raw(cls, raw: dict[str, Any] | None) -> "VoiceLocale":
        """Build from a raw JSONB value. ``None``/``{}`` → all HK-ZH defaults."""
        if not raw:
            return cls()
        return cls.model_validate(raw)


class PersonaBlockLabels(BaseModel):
    """Scaffolding labels for ``PersonaPack.to_prompt_block``.

    A label set auto-derived from ``VoiceLocale.output_language`` so a non-Chinese
    voice does not emit Traditional-Chinese scaffolding around its content. The
    ``zh-Hant`` set is byte-identical to the strings hardcoded before this change
    so HK-ZH voices are a no-op.
    """

    persona_header: str
    role: str
    voice_rules: str
    banned_terms: str
    required_phrasings: str
    tone_examples: str
    tone_good: str
    tone_bad: str
    glossary_header: str
    forbidden: str
    avoid: str
    avoid_arrow: str  # opener between an avoided term and its replacement target
    avoid_arrow_close: str  # closer after the replacement target
    avoid_no_target: str  # placeholder when no preferred target exists
    do_not_translate: str
    preferred_open: str  # opener before the preferred/term
    preferred_close: str  # closer after the preferred/term
    variants_open: str  # opener wrapping the variant list
    variants_close: str  # closer after the variant list


# zh-Hant (default) — byte-identical to the strings used before parameterization.
# NOTE: the required-phrasings label intentionally keeps the exact pre-change
# Traditional-Chinese bytes so the assembled HK-ZH prompt is unchanged; the
# brand/locale-neutral wording lives only in the English set below.
_LABELS_ZH_HANT = PersonaBlockLabels(
    persona_header="# 撰稿人格",
    role="角色：",  # noqa: RUF001
    voice_rules="語氣規則：",  # noqa: RUF001
    banned_terms="避免使用的字詞：",  # noqa: RUF001
    required_phrasings="必須採用的香港用語：",  # noqa: RUF001
    tone_examples="語氣示例：",  # noqa: RUF001
    tone_good="好：",  # noqa: RUF001
    tone_bad="壞：",  # noqa: RUF001
    glossary_header="# 詞彙表 · Glossary",
    forbidden="禁用：",  # noqa: RUF001
    avoid="避用：",  # noqa: RUF001
    avoid_arrow=" → 改用「",
    avoid_arrow_close="」",
    avoid_no_target="(無替代詞)",
    do_not_translate="保留原文：",  # noqa: RUF001
    preferred_open="用「",
    preferred_close="」",
    variants_open="（避用：",  # noqa: RUF001
    variants_close="）",  # noqa: RUF001
)

# en — English scaffolding; emits NO Traditional-Chinese labels.
_LABELS_EN = PersonaBlockLabels(
    persona_header="# Persona",
    role="Role: ",
    voice_rules="Voice rules:",
    banned_terms="Terms to avoid: ",
    required_phrasings="Required phrasings: ",
    tone_examples="Tone examples:",
    tone_good="Good: ",
    tone_bad="Bad: ",
    glossary_header="# Glossary",
    forbidden="Forbidden: ",
    avoid="Avoid: ",
    avoid_arrow=" → use \"",
    avoid_arrow_close="\"",
    avoid_no_target="(no alternative)",
    do_not_translate="Do not translate: ",
    preferred_open="Use \"",
    preferred_close="\"",
    variants_open=" (avoid: ",
    variants_close=")",
)


def _labels_for(output_language: str) -> PersonaBlockLabels:
    """Pick the persona-block label set from the voice's ``output_language``.

    Auto-derived: a Chinese output language (any CJK ideograph present) → the
    byte-identical Traditional-Chinese set; a non-Chinese (Latin-script) output
    language → English labels. This reproduces the previous explicit ``ui_lang``
    choice for every existing voice without a manual control.
    """
    return _LABELS_ZH_HANT if _CJK_RE.search(output_language) else _LABELS_EN


class GlossaryEntry(BaseModel):
    term: str
    preferred: str = ""
    variants: list[str] = Field(default_factory=list)
    status: GlossaryStatus = "preferred"
    notes: str | None = None

    def lookup_strings(self) -> list[str]:
        out = [self.term, *self.variants]
        if self.preferred:
            out.append(self.preferred)
        return [s for s in out if s]


class DisclaimerTemplate(BaseModel):
    condition: str = ""
    disclaimer: str = ""


class PersonaPack(BaseModel):
    name: str
    voice_rules: list[str]
    banned_terms: list[str]
    required_phrasings: list[str]
    disclaimer_templates: dict[str, DisclaimerTemplate]
    tone_examples: dict[str, list[str]]
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    locale: VoiceLocale = Field(default_factory=VoiceLocale)

    def to_prompt_block(self, context_text: str | None = None) -> str:
        """Render as a Chinese-language persona block for system prompts.

        When ``context_text`` is supplied the glossary section is filtered to
        only entries whose term/variants/preferred form substring-match the
        context. Keeps prompts bounded for large termbases while still
        surfacing the entries that matter for the current brief/draft.
        """
        lbl = _labels_for(self.locale.output_language)
        good = "\n".join(f"  {lbl.tone_good}{x}" for x in self.tone_examples.get("good", []))
        bad = "\n".join(f"  {lbl.tone_bad}{x}" for x in self.tone_examples.get("bad", []))
        glossary_section = self._render_glossary(context_text, lbl)
        return (
            f"{lbl.persona_header}\n"
            f"{lbl.role}{self.name}\n"
            f"{lbl.voice_rules}\n" + "\n".join(f"- {r}" for r in self.voice_rules) + "\n"
            f"{lbl.banned_terms}{', '.join(self.banned_terms)}\n"
            f"{lbl.required_phrasings}{', '.join(self.required_phrasings)}\n"
            f"{lbl.tone_examples}\n{good}\n{bad}\n"
            f"{glossary_section}"
        )

    def _render_glossary(
        self, context_text: str | None, lbl: PersonaBlockLabels | None = None
    ) -> str:
        if lbl is None:
            lbl = _labels_for(self.locale.output_language)
        entries = self._filter_glossary(context_text)
        if not entries:
            return ""
        lines: list[str] = [lbl.glossary_header]
        for e in entries:
            variants = (
                f"{lbl.variants_open}{', '.join(e.variants)}{lbl.variants_close}"
                if e.variants
                else ""
            )
            note = f" — {e.notes}" if e.notes else ""
            if e.status == "forbidden":
                lines.append(f"- {lbl.forbidden}{e.term}{variants}{note}")
            elif e.status == "avoid":
                target = e.preferred or lbl.avoid_no_target
                lines.append(
                    f"- {lbl.avoid}{e.term}{lbl.avoid_arrow}{target}"
                    f"{lbl.avoid_arrow_close}{variants}{note}"
                )
            elif e.status == "do_not_translate":
                lines.append(f"- {lbl.do_not_translate}{e.term}{note}")
            else:
                target = e.preferred or e.term
                lines.append(
                    f"- {lbl.preferred_open}{target}{lbl.preferred_close}{variants}{note}"
                )
        return "\n".join(lines) + "\n"

    def _filter_glossary(self, context_text: str | None) -> list[GlossaryEntry]:
        if context_text is None:
            return list(self.glossary)
        haystack = context_text.lower()
        return [
            e for e in self.glossary
            if any(s.lower() in haystack for s in e.lookup_strings())
        ]
