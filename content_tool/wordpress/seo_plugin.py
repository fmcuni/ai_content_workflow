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
    """Infer the SEO plugin from the post endpoint's registered REST meta schema.

    We send an ``OPTIONS`` to ``/wp/v2/posts`` and read
    ``schema.properties.meta.properties``. Only meta keys registered with
    ``show_in_rest`` appear there — which are exactly the keys WordPress will
    accept through the ``meta`` param on publish. So a hit here means both
    "this plugin is installed" and "we can actually write its meta over REST".

    Note: ``/wp/v2/types/post`` does NOT expose meta keys on stock WordPress
    (its ``post`` object has no ``meta_fields``), so probing it always yielded
    ``None`` and silently dropped the SEO meta on every publish.

    `username` + `app_password` form a WP Application Password Basic auth header.
    Most production WP installs (including security-plugin-protected ones) reject
    anonymous reads, so credentials are effectively required. Both are optional
    to keep unit-test fixtures and unauthenticated installs working.
    """
    own = client is None
    client = client or httpx.AsyncClient(timeout=10.0)
    try:
        headers: dict[str, str] = {}
        if username and app_password:
            token = base64.b64encode(f"{username}:{app_password}".encode()).decode()
            headers["authorization"] = f"Basic {token}"
        resp = await client.request(
            "OPTIONS", f"{wp_base_url}/wp-json/wp/v2/posts", headers=headers
        )
        resp.raise_for_status()
        data = resp.json()
        meta_props = (
            data.get("schema", {})
            .get("properties", {})
            .get("meta", {})
            .get("properties", {})
        )
        keys = list(meta_props.keys())
        if any(k.startswith("_yoast_wpseo_") for k in keys):
            return "yoast"
        if any(k.startswith("rank_math_") for k in keys):
            return "rankmath"
        return None
    finally:
        if own:
            await client.aclose()
