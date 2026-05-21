from typing import Literal

import httpx

SeoPlugin = Literal["yoast", "rankmath"]


async def detect_seo_plugin(
    wp_base_url: str, client: httpx.AsyncClient | None = None
) -> SeoPlugin | None:
    own = client is None
    client = client or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await client.get(f"{wp_base_url}/wp-json/wp/v2/types/post")
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
