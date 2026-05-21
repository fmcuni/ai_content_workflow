import pytest

from content_tool.config import Settings


def test_settings_loads_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_URL", "postgresql+asyncpg://u:p@h/d")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
    s = Settings()  # type: ignore[call-arg]
    assert s.postgres_url == "postgresql+asyncpg://u:p@h/d"
    assert s.gemini_api_key == "fake-key"
    assert s.gemini_model == "gemini-3.5-flash"  # default
    assert s.gemini_thinking_level == "high"     # default
    assert s.log_level == "info"                  # default
