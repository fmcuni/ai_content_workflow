import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic_settings import (
    BaseSettings,
    JsonConfigSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

DEFAULT_CONFIG_DIR = Path.home() / "Library" / "Application Support" / "BowtieContentTool"


def desktop_config_dir() -> Path:
    """Directory holding the desktop app's local config file.

    Overridable via ``BOWTIE_CONFIG_DIR`` (used by tests and packaging).
    """
    override = os.environ.get("BOWTIE_CONFIG_DIR")
    return Path(override) if override else DEFAULT_CONFIG_DIR


def desktop_config_path() -> Path:
    return desktop_config_dir() / "config.json"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env.local", case_sensitive=False, extra="ignore"
    )

    # Credentials are optional so the app can boot into a "needs setup" state.
    postgres_url: str | None = None
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-3.1-pro-preview"
    gemini_thinking_level: str = "high"
    log_level: str = "info"

    # WordPress
    wp_base_url: str = "https://www.bowtie.com.hk/blog"
    wp_target: str = "staging"                # staging | production
    wp_username: str = ""                     # WP user the editor authenticates as
    wp_app_password: str = ""                 # Application Password
    wp_timeout: float = 15.0
    wp_seo_plugin: str = ""                   # "", "yoast", "rankmath" — "" = auto-detect

    # Refresh route
    refresh_config_path: str = "config/refresh.yaml"
    refresh_cron_enabled: bool = True

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # Precedence: init kwargs > env > .env.local > desktop JSON file > defaults.
        path = desktop_config_path()
        json_source = JsonConfigSettingsSource(
            settings_cls, json_file=path if path.is_file() else None
        )
        return (init_settings, env_settings, dotenv_settings, json_source, file_secret_settings)


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def is_configured(settings: Settings) -> bool:
    """True when the minimum credentials needed to run are present."""
    return bool(settings.postgres_url) and bool(settings.gemini_api_key)


@lru_cache(maxsize=1)
def get_refresh_config() -> dict[str, Any]:
    settings = get_settings()
    path = Path(settings.refresh_config_path)
    if not path.exists():
        raise FileNotFoundError(f"refresh config not found: {path}")
    with path.open() as f:
        return yaml.safe_load(f)
