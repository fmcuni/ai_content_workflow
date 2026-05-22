import base64
from typing import Literal

import httpx

SeoPlugin = Literal["yoast", "rankmath"]


async def detect_seo_plugin(
    wp_base_url: str,
    *,
    username: str = "",
    app_password: str = "",
    client: httpx.AsyncClient | None = None,
) -> SeoPlugin | None:
    """Probe WP's `types/post` endpoint and infer the SEO plugin from its meta_fields.

    `username` + `app_password` form a WP Application Password Basic auth header.
    Most production WP installs (including security-plugin-protected ones) reject
    anonymous reads of `/wp/v2/types`, so credentials are effectively required.
    Both are optional to keep unit-test fixtures and unauthenticated installs working.
    """
    own = client is None
    client = client or httpx.AsyncClient(timeout=10.0)
    try:
        headers: dict[str, str] = {}
        if username and app_password:
            token = base64.b64encode(f"{username}:{app_password}".encode()).decode()
            headers["authorization"] = f"Basic {token}"
        resp = await client.get(
            f"{wp_base_url}/wp-json/wp/v2/types/post", headers=headers
        )
        resp.raise_for_status()
        data = resp.json()
        meta_fields = data.get("post", {}).get("meta_fields", [])
        if any(m.startswith("_yoast_wpseo_") for m in meta_fields):
            return "yoast"
        if any(m.startswith("rank_math_") for m in meta_fields):
            return "rankmath"
        return None
    finally:
        if own:
            await client.aclose()
