from content_tool.policy.personas import load_persona


def test_bowtie_editor_loads():
    p = load_persona("bowtie-editor")
    assert "信息" in p.banned_terms
    assert "自願醫保" in p.required_phrasings
    block = p.to_prompt_block()
    assert "撰稿人格" in block
    assert "Bowtie 編輯" in block
