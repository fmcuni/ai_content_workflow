"""Setup status API.

Reports whether the backend has the credentials it needs to run, so the web
client can gate the app on a configured backend. Credentials are supplied via the
environment / ``.env.local`` for this backend (the production Workers backend
exposes its own setup endpoints).
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from content_tool.config import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/setup", tags=["setup"])

_REQUIRED_FIELDS = ("postgres_url", "gemini_api_key")


def settings_provider() -> Settings:
    """Indirection so tests can override settings without env coupling."""
    return get_settings()


SettingsDep = Annotated[Settings, Depends(settings_provider)]


class SetupStatus(BaseModel):
    configured: bool
    missing: list[str]
    wp_configured: bool


@router.get("/status", response_model=SetupStatus)
def status(settings: SettingsDep) -> SetupStatus:
    missing = [field for field in _REQUIRED_FIELDS if not getattr(settings, field)]
    wp_configured = bool(settings.wp_username and settings.wp_app_password)
    return SetupStatus(configured=not missing, missing=missing, wp_configured=wp_configured)
