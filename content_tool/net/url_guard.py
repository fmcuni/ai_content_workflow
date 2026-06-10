"""SSRF guard for operator-supplied / redirect-followed outbound URLs.

The content tool legitimately fetches arbitrary *public* article URLs (the
"external-source fallback" lets a refresh run pull a non-WordPress page), so the
guard is deliberately PERMISSIVE for public hosts by default. The hard,
non-optional gate is the private/internal-IP block: an operator (or a malicious
HTTP redirect) must never be able to point an outbound fetch at internal
services or the cloud metadata endpoint (169.254.169.254).

Two layers:

* :func:`validate_url_scheme` — cheap, no DNS. Rejects anything that is not
  ``http``/``https``. Suitable for format-level validation (e.g. a Pydantic
  field validator) where DNS resolution does not belong.
* :func:`assert_url_is_safe` — runtime gate. Validates the scheme, resolves the
  host to IP address(es) and blocks any that are private, loopback, link-local,
  reserved, multicast, or otherwise non-global. An optional ``allowlist`` of
  host suffix patterns can further restrict which public hosts are permitted;
  it defaults to ``None`` (permit any public host).

Both raise :class:`UrlNotAllowedError` on rejection. Callers that must degrade
gracefully (never raise) should catch that exception.
"""

from __future__ import annotations

import ipaddress
import socket
from fnmatch import fnmatch
from urllib.parse import urlsplit

# Schemes we are ever willing to fetch over. Everything else (ftp, file, gopher,
# data, ...) is rejected outright — these are classic SSRF / local-file vectors.
_ALLOWED_SCHEMES = frozenset({"http", "https"})

# Convenience suffix-allowlist for the Bowtie-owned public properties. NOT applied
# by default (the product fetches arbitrary public article URLs); pass it
# explicitly to lock a call path down to first-party hosts.
BOWTIE_HOST_ALLOWLIST: tuple[str, ...] = ("*.bowtie.com.hk", "*.gobowtie.com")


class UrlNotAllowedError(ValueError):
    """Raised when a URL is rejected by the SSRF guard."""


def validate_url_scheme(url: str) -> str:
    """Return ``url`` unchanged if its scheme is http/https, else raise.

    Format-level only: performs NO DNS resolution. Use this where IP resolution
    is inappropriate (e.g. a Pydantic field validator running at request parse
    time). The runtime IP gate lives in :func:`assert_url_is_safe`.
    """
    scheme = urlsplit(url).scheme.lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise UrlNotAllowedError(
            f"URL scheme {scheme!r} is not allowed; only http/https are permitted"
        )
    return url


def _host_matches_allowlist(host: str, allowlist: tuple[str, ...]) -> bool:
    host = host.lower()
    return any(fnmatch(host, pattern.lower()) for pattern in allowlist)


def _resolve_host(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Resolve ``host`` to every IP it maps to.

    A literal IP is returned directly (no DNS). A hostname is resolved via
    ``getaddrinfo`` so that EVERY A/AAAA record is checked — a host that
    resolves to one public and one private IP must still be blocked.
    """
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UrlNotAllowedError(f"host {host!r} could not be resolved") from exc

    addrs: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        try:
            addrs.append(ipaddress.ip_address(ip_str))
        except ValueError:
            continue
    if not addrs:
        raise UrlNotAllowedError(f"host {host!r} resolved to no usable address")
    return addrs


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True if ``ip`` is in a private/internal/otherwise non-routable range.

    Covers RFC-1918 (10/8, 172.16/12, 192.168/16) and IPv6 ULA via ``is_private``,
    loopback (127/8, ::1), link-local (169.254/16 incl. the 169.254.169.254
    cloud-metadata IP, and fe80::/10), reserved and multicast ranges. The final
    ``not is_global`` catches anything else not publicly routable (e.g.
    0.0.0.0/8, IPv4-mapped private addresses). IPv4-mapped IPv6 addresses are
    unwrapped first so an attacker cannot smuggle a private v4 inside a v6.
    """
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or not ip.is_global
    )


def assert_url_is_safe(
    url: str,
    *,
    allowlist: tuple[str, ...] | None = None,
) -> None:
    """Raise :class:`UrlNotAllowedError` if ``url`` is unsafe to fetch.

    Checks, in order:

    1. Scheme is http/https (see :func:`validate_url_scheme`).
    2. A host is present.
    3. If ``allowlist`` is given, the host matches one of its suffix patterns.
       Default ``None`` permits any public host (the product fetches arbitrary
       external article URLs — the IP block below is the real gate).
    4. The host resolves only to globally-routable IPs — every resolved address
       is checked; any private/internal/link-local/reserved address blocks.
    """
    validate_url_scheme(url)

    host = urlsplit(url).hostname
    if not host:
        raise UrlNotAllowedError("URL has no host")

    if allowlist is not None and not _host_matches_allowlist(host, allowlist):
        raise UrlNotAllowedError(f"host {host!r} is not in the allowlist")

    for ip in _resolve_host(host):
        if _is_blocked_ip(ip):
            raise UrlNotAllowedError(
                f"host {host!r} resolves to blocked address {ip} "
                "(private/internal/link-local)"
            )
