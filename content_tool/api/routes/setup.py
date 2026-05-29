"""First-run setup API for the desktop app.

Lets the desktop shell report configuration status, pre-flight credentials, and
persist them. Secret values are never returned in responses.
"""

from __future__ import annotations

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from content_tool.config import Settings, get_settings
from content_tool.desktop import verify as verify_mod
from content_tool.desktop.config_store import DesktopConfigStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/setup", tags=["setup"])

_REQUIRED_FIELDS = ("postgres_url", "gemini_api_key")
_VALID_PG_SCHEMES = ("postgresql://", "postgresql+asyncpg://")


def settings_provider() -> Settings:
    """Indirection so tests can override settings without env coupling."""
    return get_settings()


SettingsDep = Annotated[Settings, Depends(settings_provider)]


class SetupRequest(BaseModel):
    gemini_api_key: str = Field(min_length=1)
    postgres_url: str = Field(min_length=1)
    wp_base_url: str | None = None
    wp_target: Literal["staging", "production"] | None = None
    wp_username: str | None = None
    wp_app_password: str | None = None

    @field_validator("postgres_url")
    @classmethod
    def _validate_pg_scheme(cls, value: str) -> str:
        if not value.startswith(_VALID_PG_SCHEMES):
            raise ValueError("postgres_url must start with postgresql:// or postgresql+asyncpg://")
        return value


class SetupStatus(BaseModel):
    configured: bool
    missing: list[str]
    wp_configured: bool


class VerifyResult(BaseModel):
    postgres: bool
    gemini: bool


@router.get("/status", response_model=SetupStatus)
def status(settings: SettingsDep) -> SetupStatus:
    missing = [field for field in _REQUIRED_FIELDS if not getattr(settings, field)]
    wp_configured = bool(settings.wp_username and settings.wp_app_password)
    return SetupStatus(configured=not missing, missing=missing, wp_configured=wp_configured)


@router.post("/verify", response_model=VerifyResult)
async def verify(body: SetupRequest, settings: SettingsDep) -> VerifyResult:
    checks = await verify_mod.verify_credentials(
        postgres_url=body.postgres_url,
        gemini_api_key=body.gemini_api_key,
        gemini_model=settings.gemini_model,
    )
    return VerifyResult(**checks)


@router.post("")
async def configure(
    body: SetupRequest,
    request: Request,
    settings: SettingsDep,
) -> JSONResponse:
    checks = await verify_mod.verify_credentials(
        postgres_url=body.postgres_url,
        gemini_api_key=body.gemini_api_key,
        gemini_model=settings.gemini_model,
    )
    if not all(checks.values()):
        return JSONResponse(
            status_code=400,
            content={"detail": "verification_failed", "checks": checks},
        )

    values = {key: value for key, value in body.model_dump().items() if value is not None}
    DesktopConfigStore().save(values)

    # Bring the runtime up live without a process restart. Local import avoids a
    # circular import (main imports this router at module load).
    from content_tool.api.main import init_runtime

    await init_runtime(request.app, get_settings())
    return JSONResponse(status_code=200, content={"configured": True})
