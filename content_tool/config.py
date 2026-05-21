from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env.local", case_sensitive=False)

    postgres_url: str
    gemini_api_key: str
    gemini_model: str = "gemini-3.5-flash"
    gemini_thinking_level: str = "high"
    log_level: str = "info"


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
