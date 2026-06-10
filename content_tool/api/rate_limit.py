"""Per-user / per-IP request throttling (defense-in-depth).

This Python backend is local/evals-only (production runs the Workers port), but
we still throttle abuse-prone mutation endpoints (run creation, resume/publish,
apply-edits, topic-batch creation/promotion) so a local or misbehaving client
cannot stampede Gemini, WordPress, or the DB.

The limiter keys on the *authenticated editor identity* when present — the
``X-Editor-Email`` header that the reverse proxy / SSO injects and that
:mod:`content_tool.api.editor_auth` trusts — and falls back to the client IP for
unauthenticated callers. Limits are deliberately generous (abuse-prevention, not
a product quota) so they never trip normal interactive or test traffic.
"""

import logging

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

logger = logging.getLogger(__name__)

# Generous abuse-prevention caps. Interactive use and the test suite stay well
# under these; they only bite a runaway/scripted client.
RUN_CREATE_LIMIT = "30/minute"
RUN_MUTATION_LIMIT = "30/minute"


def editor_identity_key(request: Request) -> str:
    """Rate-limit key: authenticated editor email if known, else client IP.

    Mirrors the identity trust model in :mod:`content_tool.api.editor_auth`:
    the ``X-Editor-Email`` header is injected by the reverse proxy / SSO and is
    the closest thing this backend has to an authenticated principal. When it is
    absent (e.g. unauthenticated / local), we fall back to the remote address so
    every caller is still bucketed.
    """
    email = (request.headers.get("X-Editor-Email") or "").strip().lower()
    if email:
        return f"editor:{email}"
    return f"ip:{get_remote_address(request)}"


# Single application-wide limiter. ``headers_enabled`` surfaces the standard
# ``Retry-After`` / ``X-RateLimit-*`` response headers.
limiter = Limiter(
    key_func=editor_identity_key,
    headers_enabled=True,
)


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> Response:
    """Return a generic 429 with ``Retry-After`` and no internal detail leakage."""
    logger.warning(
        "rate limit exceeded for %s on %s (limit=%s)",
        editor_identity_key(request),
        request.url.path,
        exc.limit,
    )
    response = JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded. Please retry later."},
    )
    # slowapi populates the Retry-After / X-RateLimit-* headers via the limiter's
    # request-state hook; ensure a Retry-After is always present as a fallback.
    return request.app.state.limiter._inject_headers(
        response, request.state.view_rate_limit
    )
