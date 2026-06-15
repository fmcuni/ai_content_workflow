"""Golden + label-set tests for ``PersonaPack.to_prompt_block`` (workstream B2).

The persona block scaffolding labels are auto-derived from
``VoiceLocale.output_language``: a non-Chinese (Latin-script) output language
emits English labels; a Chinese output language (incl. the default
``"香港繁體中文"``) keeps the Traditional-Chinese strings **byte-identical** to
before parameterization.
"""

from content_tool.models.persona import (
    DisclaimerTemplate,
    GlossaryEntry,
    PersonaPack,
    VoiceLocale,
)

# Captured BEFORE the label parameterization change — bowtie-editor-shaped pack
# with the default (zh-Hant) locale. Asserting against this guarantees HK-ZH
# voices are byte-identical to the pre-change output.
GOLDEN_ZH_HANT = (
    "# 撰稿人格\n"
    "角色：Bowtie 健康顧問\n"  # noqa: RUF001
    "語氣規則：\n"  # noqa: RUF001
    "- 親切專業\n"
    "- 避免術語堆砌\n"
    "避免使用的字詞：便宜, 最平\n"  # noqa: RUF001
    "必須採用的香港用語：醫療保障, 保費\n"  # noqa: RUF001
    "語氣示例：\n"  # noqa: RUF001
    "  好：投保前先了解保障範圍。\n"  # noqa: RUF001
    "  壞：呢個 plan 好抵買！\n"  # noqa: RUF001
    "# 詞彙表 · Glossary\n"
    "- 用「自願醫保」（避用：VHIS）\n"  # noqa: RUF001
    "- 禁用：人壽保險（避用：life insurance） — 監管要求統一用法\n"  # noqa: RUF001
    "- 避用：cheap → 改用「affordable」\n"  # noqa: RUF001
    "- 保留原文：AI\n"  # noqa: RUF001
)


def _base_pack(locale: VoiceLocale | None = None) -> PersonaPack:
    return PersonaPack(
        name="Bowtie 健康顧問",
        voice_rules=["親切專業", "避免術語堆砌"],
        banned_terms=["便宜", "最平"],
        required_phrasings=["醫療保障", "保費"],
        disclaimer_templates={
            "general": DisclaimerTemplate(condition="always", disclaimer="本文僅供參考")
        },
        tone_examples={
            "good": ["投保前先了解保障範圍。"],
            "bad": ["呢個 plan 好抵買！"],  # noqa: RUF001
        },
        glossary=[
            GlossaryEntry(
                term="自願醫保", preferred="自願醫保", variants=["VHIS"], status="preferred"
            ),
            GlossaryEntry(
                term="人壽保險",
                variants=["life insurance"],
                status="forbidden",
                notes="監管要求統一用法",
            ),
            GlossaryEntry(term="cheap", preferred="affordable", variants=[], status="avoid"),
            GlossaryEntry(term="AI", variants=[], status="do_not_translate"),
        ],
        locale=locale if locale is not None else VoiceLocale(),
    )


def test_zh_hant_block_is_byte_identical_to_golden() -> None:
    # Arrange: default locale (Chinese output_language → zh-Hant labels).
    pack = _base_pack()

    # Act
    block = pack.to_prompt_block()

    # Assert: byte-for-byte unchanged from before parameterization.
    assert block == GOLDEN_ZH_HANT


def test_default_locale_matches_explicit_chinese_output_language() -> None:
    # The default-factory VoiceLocale and an explicit Chinese output language agree.
    assert _base_pack().to_prompt_block() == _base_pack(
        VoiceLocale(output_language="香港繁體中文")
    ).to_prompt_block()


def test_en_block_emits_english_scaffolding() -> None:
    # Arrange: a non-Chinese output language auto-derives English labels.
    pack = _base_pack(VoiceLocale(output_language="English"))

    # Act
    block = pack.to_prompt_block()

    # Assert: English labels present.
    assert "# Persona\n" in block
    assert "Role: Bowtie 健康顧問\n" in block
    assert "Voice rules:\n" in block
    assert "Terms to avoid: 便宜, 最平\n" in block
    assert "Required phrasings: 醫療保障, 保費\n" in block
    assert "Tone examples:\n" in block
    assert "  Good: 投保前先了解保障範圍。\n" in block
    assert "  Bad: 呢個 plan 好抵買！\n" in block  # noqa: RUF001
    assert "# Glossary\n" in block
    assert '- Use "自願醫保" (avoid: VHIS)\n' in block
    assert '- Forbidden: 人壽保險 (avoid: life insurance) — 監管要求統一用法\n' in block
    assert '- Avoid: cheap → use "affordable"\n' in block
    assert "- Do not translate: AI\n" in block


def test_en_block_has_no_traditional_chinese_scaffolding() -> None:
    # Arrange: a non-Chinese output language auto-derives English labels.
    pack = _base_pack(VoiceLocale(output_language="English"))

    # Act
    block = pack.to_prompt_block()

    # Assert: none of the zh-Hant scaffolding substrings leak into the en block.
    forbidden_scaffolding = [
        "# 撰稿人格",
        "角色：",  # noqa: RUF001
        "語氣規則：",  # noqa: RUF001
        "避免使用的字詞：",  # noqa: RUF001
        "必須採用的香港用語：",  # noqa: RUF001
        "語氣示例：",  # noqa: RUF001
        "好：",  # noqa: RUF001
        "壞：",  # noqa: RUF001
        "詞彙表",
        "禁用：",  # noqa: RUF001
        "避用：",  # noqa: RUF001
        "改用",
        "保留原文：",  # noqa: RUF001
        "用「",
        "（避用：",  # noqa: RUF001
    ]
    for token in forbidden_scaffolding:
        assert token not in block, f"unexpected zh-Hant scaffolding {token!r} in en block"
