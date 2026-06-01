"""Shared editor-RBAC dependency for the prompt + source-policy editors.

Trusts an ``X-Editor-Email`` header injected by the reverse proxy / SSO in
front of the API (the browser does not set it). In dev mode
(``PROMPT_EDITOR_DEV_MODE=true`` — the default outside CI) a missing header
falls back to ``dev@local`` so local work isn't blocked. When real OIDC lands
this becomes a one-line swap.
"""

from fastapi import HTTPException, Request

from content_tool.policy.prompt_editors import load_policy


async def require_editor(request: Request) -> str:
    """Resolve the editor's email and enforce the allowlist.

    HTTP 401 if no ``X-Editor-Email`` header (production only).
    HTTP 403 if the editor isn't in the allowlist (production only).
    """
    email = (request.headers.get("X-Editor-Email") or "").strip().lower()
    policy = load_policy()
    if not email:
        if policy.dev_mode:
            return "dev@local"
        raise HTTPException(401, "missing X-Editor-Email header")
    if not policy.is_allowed(email) and not policy.dev_mode:
        raise HTTPException(403, f"{email} is not an authorised prompt editor")
    return email
