from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env.local", case_sensitive=False)

    postgres_url: str
    gemini_api_key: str
    gemini_model: str = "gemini-3.5-flash"
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


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


@lru_cache(maxsize=1)
def get_refresh_config() -> dict[str, Any]:
    settings = get_settings()
    path = Path(settings.refresh_config_path)
    if not path.exists():
        raise FileNotFoundError(f"refresh config not found: {path}")
    with path.open() as f:
        return yaml.safe_load(f)
