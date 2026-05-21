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
        good = "\n".join(f"  好：{x}" for x in self.tone_examples.get("good", []))  # noqa: RUF001
        bad = "\n".join(f"  壞：{x}" for x in self.tone_examples.get("bad", []))  # noqa: RUF001
        return (
            f"# 撰稿人格\n"
            f"角色：{self.name}\n"  # noqa: RUF001
            f"語氣規則：\n" + "\n".join(f"- {r}" for r in self.voice_rules) + "\n"  # noqa: RUF001
            f"避免使用的字詞：{', '.join(self.banned_terms)}\n"  # noqa: RUF001
            f"必須採用的香港用語：{', '.join(self.required_phrasings)}\n"  # noqa: RUF001
            f"語氣示例：\n{good}\n{bad}\n"  # noqa: RUF001
        )
