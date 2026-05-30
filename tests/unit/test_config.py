import pytest

from content_tool.config import Settings


def test_settings_loads_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_URL", "postgresql+asyncpg://u:p@h/d")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
    # _env_file=None isolates from the repo .env.local so the default-model
    # assertion below tests the code default, not a dev-local override.
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.postgres_url == "postgresql+asyncpg://u:p@h/d"
    assert s.gemini_api_key == "fake-key"
    assert s.gemini_model == "gemini-3.1-pro-preview"  # default
    assert s.gemini_thinking_level == "high"     # default
    assert s.log_level == "info"                  # default


def test_get_refresh_config_loads_yaml() -> None:
    from content_tool.config import get_refresh_config
    cfg = get_refresh_config()
    assert cfg["scheduling"]["default_interval_days"] == 30
    assert cfg["scan"]["llm_cap_per_tick"] == 20
    assert cfg["scoring"]["refresh_threshold"] == 6.0
    assert "facebook.com" in cfg["deterministic"]["link_check_ignore_domains"]
