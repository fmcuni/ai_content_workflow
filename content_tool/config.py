from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def resource_root() -> Path:
    """Root directory holding runtime assets (``config/``, ``prompts/``).

    These live at the repo root, one level above this package. Resolving against
    this root — never the process cwd — keeps asset lookups stable regardless of
    where the process is launched from.
    """
    return Path(__file__).resolve().parents[1]


def config_path(*parts: str) -> Path:
    """Absolute path to a file under the ``config/`` directory."""
    return resource_root().joinpath("config", *parts)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env.local", case_sensitive=False, extra="ignore"
    )

    # Credentials come from the environment / .env.local. They are typed optional
    # so Settings can be constructed in contexts that don't need them (e.g. loading
    # refresh config); runtime wiring (init_runtime) enforces their presence.
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

    # Langfuse observability (all optional; integration is a no-op when disabled)
    langfuse_enabled: bool = False
    langfuse_host: str = "http://localhost:3000"
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None
    # Separates traces by origin in the Langfuse UI (local dev vs evals vs prod).
    # Must be a lowercase alphanumeric string with hyphens/underscores that does
    # not start with "langfuse" (Langfuse environment-name constraint).
    langfuse_environment: str = "development"

    @field_validator("langfuse_enabled", mode="before")
    @classmethod
    def _empty_str_is_disabled(cls, value: object) -> object:
        # A bare ``LANGFUSE_ENABLED=`` in an env file is a common way to express
        # "off"; pydantic would otherwise reject the empty string as an invalid
        # bool and crash startup. Treat it as the disabled default so the
        # integration's no-op guarantee holds.
        if isinstance(value, str) and value.strip() == "":
            return False
        return value


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def is_configured(settings: Settings) -> bool:
    """True when the minimum credentials needed to run are present."""
    return bool(settings.postgres_url) and bool(settings.gemini_api_key)


@lru_cache(maxsize=1)
def get_refresh_config() -> dict[str, Any]:
    settings = get_settings()
    path = Path(settings.refresh_config_path)
    # A relative default ("config/refresh.yaml") must resolve against the repo
    # root, not the process cwd. An absolute override (env) is honored as-is.
    if not path.is_absolute():
        path = resource_root() / path
    if not path.exists():
        raise FileNotFoundError(f"refresh config not found: {path}")
    with path.open() as f:
        return yaml.safe_load(f)
