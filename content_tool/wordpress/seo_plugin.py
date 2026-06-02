import base64
import logging
import time
from typing import Literal

import httpx

logger = logging.getLogger(__name__)

SeoPlugin = Literal["yoast", "rankmath"]

# The exact post-meta keys we write the SEO description into. We only send one
# of these when that *same key* is a writable REST meta field on the live target
# (see ``detect_seo_plugin``). Sending an unregistered protected key — e.g.
# ``_yoast_wpseo_metadesc`` on an install that registers other ``_yoast_wpseo_*``
# keys but not this one — makes WordPress reject the *entire* publish request.
YOAST_METADESC_KEY = "_yoast_wpseo_metadesc"
RANKMATH_DESC_KEY = "rank_math_description"

# Per-publish detection is cached this long so dry-publish polling doesn't hammer
# the WP OPTIONS endpoint, while still re-detecting far more often than the old
# once-at-startup value (which stayed stale for the whole process lifetime).
_DETECT_TTL_SECONDS = 120.0


def seo_meta_key(plugin: SeoPlugin | None) -> str | None:
    """Map a detected SEO plugin to the meta key we write the description into."""
    if plugin == "yoast":
        return YOAST_METADESC_KEY
    if plugin == "rankmath":
        return RANKMATH_DESC_KEY
    return None


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
    accept through the ``meta`` param on publish. We match the *exact*
    description key (not the plugin namespace), so a hit means both "this
    plugin is installed" and "we can actually write its description meta".

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
        # Require the EXACT description key to be registered, not merely the
        # plugin's namespace. Yoast registers several ``_yoast_wpseo_*`` keys for
        # REST, but ``_yoast_wpseo_metadesc`` itself is frequently a protected
        # key that is NOT writable — claiming "yoast" off the prefix and then
        # sending that key 400s the whole publish (the bug this guards against).
        if YOAST_METADESC_KEY in keys:
            return "yoast"
        if RANKMATH_DESC_KEY in keys:
            return "rankmath"
        return None
    finally:
        if own:
            await client.aclose()


class SeoPluginResolver:
    """Resolve the active SEO plugin against the *live* WP target, on demand.

    Replaces the old once-at-startup detection that cached a single value for
    the whole process lifetime — a value that went stale if WP config changed
    or detection ran against the wrong instance at boot, and was the latent
    cause of sending a meta key the live target no longer accepts.

    - An explicit override (``WP_SEO_PLUGIN``) short-circuits all network I/O.
    - Otherwise detection runs per call, cached for a short TTL so dry-publish
      polling doesn't hammer the WP ``OPTIONS`` endpoint.
    - Detection failures degrade to ``None`` (publish without an SEO desc key)
      rather than raising into the publish path.
    """

    def __init__(
        self,
        wp_base_url: str,
        *,
        username: str = "",
        app_password: str = "",
        override: SeoPlugin | None = None,
        ttl_seconds: float = _DETECT_TTL_SECONDS,
    ) -> None:
        self._wp_base_url = wp_base_url
        self._username = username
        self._app_password = app_password
        self._override: SeoPlugin | None = override
        self._ttl = ttl_seconds
        self._cached: SeoPlugin | None = None
        self._cached_at: float | None = None

    async def resolve(self) -> SeoPlugin | None:
        if self._override is not None:
            return self._override
        if not self._wp_base_url:
            return None
        now = time.monotonic()
        if self._cached_at is not None and now - self._cached_at < self._ttl:
            return self._cached
        try:
            resolved = await detect_seo_plugin(
                self._wp_base_url,
                username=self._username,
                app_password=self._app_password,
            )
        except Exception:
            logger.warning(
                "SEO plugin detection failed; SEO meta will be skipped on publish",
                exc_info=True,
            )
            resolved = None
        self._cached = resolved
        self._cached_at = now
        return resolved
