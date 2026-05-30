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


def test_config_path_is_absolute_and_exists() -> None:
    """Bundled config must resolve to an absolute path regardless of cwd.

    The packaged desktop sidecar runs with a cwd that is not the repo root, so
    any cwd-relative ``config/...`` lookup raises FileNotFoundError → 500. The
    resolver pins the path to the package/bundle root instead.
    """
    from content_tool.config import config_path, resource_root

    assert resource_root().is_absolute()
    pricing = config_path("pricing.yaml")
    assert pricing.is_absolute()
    assert pricing.is_file()
    assert config_path("refresh.yaml").is_file()


def test_get_refresh_config_independent_of_cwd(
    tmp_path: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    """get_refresh_config must succeed even when cwd has no ``config/`` dir."""
    from content_tool import config as config_mod

    config_mod.get_refresh_config.cache_clear()
    monkeypatch.chdir(tmp_path)  # type: ignore[arg-type]
    cfg = config_mod.get_refresh_config()
    assert cfg["scheduling"]["default_interval_days"] == 30
    config_mod.get_refresh_config.cache_clear()
