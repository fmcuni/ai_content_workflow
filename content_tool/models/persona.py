from typing import Literal

from pydantic import BaseModel, Field

GlossaryStatus = Literal["preferred", "avoid", "forbidden", "do_not_translate"]


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

    def to_prompt_block(self, context_text: str | None = None) -> str:
        """Render as a Chinese-language persona block for system prompts.

        When ``context_text`` is supplied the glossary section is filtered to
        only entries whose term/variants/preferred form substring-match the
        context. Keeps prompts bounded for large termbases while still
        surfacing the entries that matter for the current brief/draft.
        """
        good = "\n".join(f"  好：{x}" for x in self.tone_examples.get("good", []))  # noqa: RUF001
        bad = "\n".join(f"  壞：{x}" for x in self.tone_examples.get("bad", []))  # noqa: RUF001
        glossary_section = self._render_glossary(context_text)
        return (
            f"# 撰稿人格\n"
            f"角色：{self.name}\n"  # noqa: RUF001
            f"語氣規則：\n" + "\n".join(f"- {r}" for r in self.voice_rules) + "\n"  # noqa: RUF001
            f"避免使用的字詞：{', '.join(self.banned_terms)}\n"  # noqa: RUF001
            f"必須採用的香港用語：{', '.join(self.required_phrasings)}\n"  # noqa: RUF001
            f"語氣示例：\n{good}\n{bad}\n"  # noqa: RUF001
            f"{glossary_section}"
        )

    def _render_glossary(self, context_text: str | None) -> str:
        entries = self._filter_glossary(context_text)
        if not entries:
            return ""
        lines: list[str] = ["# 詞彙表 · Glossary"]  # noqa: RUF001
        for e in entries:
            variants = f"（避用：{', '.join(e.variants)}）" if e.variants else ""  # noqa: RUF001
            note = f" — {e.notes}" if e.notes else ""
            if e.status == "forbidden":
                lines.append(f"- 禁用：{e.term}{variants}{note}")  # noqa: RUF001
            elif e.status == "avoid":
                target = e.preferred or "(無替代詞)"  # noqa: RUF001
                lines.append(f"- 避用：{e.term} → 改用「{target}」{variants}{note}")  # noqa: RUF001
            elif e.status == "do_not_translate":
                lines.append(f"- 保留原文：{e.term}{note}")  # noqa: RUF001
            else:
                lines.append(f"- 用「{e.preferred or e.term}」{variants}{note}")  # noqa: RUF001
        return "\n".join(lines) + "\n"

    def _filter_glossary(self, context_text: str | None) -> list[GlossaryEntry]:
        if context_text is None:
            return list(self.glossary)
        haystack = context_text.lower()
        return [
            e for e in self.glossary
            if any(s.lower() in haystack for s in e.lookup_strings())
        ]
