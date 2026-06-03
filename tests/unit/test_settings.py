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


def test_default_gemini_model_is_pro_preview():
    s = Settings(_env_file=None, postgres_url=None, gemini_api_key=None)
    assert s.gemini_model == "gemini-3.1-pro-preview"
