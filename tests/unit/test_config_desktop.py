from content_tool.config import Settings, is_configured


def test_is_configured_false_when_creds_missing():
    s = Settings(_env_file=None, postgres_url=None, gemini_api_key=None)
    assert not is_configured(s)


def test_is_configured_false_when_only_one_present():
    s = Settings(_env_file=None, postgres_url="postgresql://u@h/db", gemini_api_key=None)
    assert not is_configured(s)


def test_is_configured_true_when_both_present():
    s = Settings(_env_file=None, postgres_url="postgresql://u@h/db", gemini_api_key="k")
    assert is_configured(s)


def test_default_gemini_model_is_pro_preview(tmp_path, monkeypatch):
    monkeypatch.setenv("BOWTIE_CONFIG_DIR", str(tmp_path))
    s = Settings(_env_file=None, postgres_url=None, gemini_api_key=None)
    assert s.gemini_model == "gemini-3.1-pro-preview"


def test_json_file_supplies_values(tmp_path, monkeypatch):
    monkeypatch.setenv("BOWTIE_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    (tmp_path / "config.json").write_text(
        '{"postgres_url": "postgresql://from-file/db"}', encoding="utf-8"
    )
    s = Settings(_env_file=None)
    assert s.postgres_url == "postgresql://from-file/db"


def test_env_overrides_json_file(tmp_path, monkeypatch):
    monkeypatch.setenv("BOWTIE_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("POSTGRES_URL", "postgresql://from-env/db")
    (tmp_path / "config.json").write_text(
        '{"postgres_url": "postgresql://from-file/db"}', encoding="utf-8"
    )
    s = Settings(_env_file=None)
    assert s.postgres_url == "postgresql://from-env/db"
