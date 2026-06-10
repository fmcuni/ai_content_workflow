"""Unit tests for the SSRF URL guard.

DNS resolution is patched so the tests are hermetic and offline: we control the
IP that each host "resolves" to instead of touching the network.
"""

import socket

import pytest

from content_tool.net.url_guard import (
    BOWTIE_HOST_ALLOWLIST,
    UrlNotAllowedError,
    assert_url_is_safe,
    validate_url_scheme,
)


def _fake_getaddrinfo(ip: str):
    """Build a getaddrinfo stand-in that always resolves to ``ip``."""

    def _inner(host, port, *args, **kwargs):
        family = socket.AF_INET6 if ":" in ip else socket.AF_INET
        return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 0))]

    return _inner


# --- scheme validation (no DNS) ------------------------------------------------


def test_validate_url_scheme_accepts_http_and_https():
    assert validate_url_scheme("http://example.com") == "http://example.com"
    assert validate_url_scheme("https://example.com") == "https://example.com"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://x",
        "file:///etc/passwd",
        "gopher://x",
        "data:text/plain,hi",
    ],
)
def test_validate_url_scheme_rejects_non_http(url):
    with pytest.raises(UrlNotAllowedError):
        validate_url_scheme(url)


# --- runtime IP gate -----------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "ftp://internal",
        "file:///etc/passwd",
    ],
)
def test_assert_url_is_safe_rejects_bad_scheme(url):
    with pytest.raises(UrlNotAllowedError):
        assert_url_is_safe(url)


def test_blocks_cloud_metadata_ip_literal():
    # Literal IP — no DNS needed.
    with pytest.raises(UrlNotAllowedError):
        assert_url_is_safe("http://169.254.169.254/latest/meta-data/")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1",
        "http://127.0.0.1:8000/admin",
        "http://10.0.0.1",
        "http://192.168.1.1",
        "http://172.16.0.5",
        "http://169.254.169.254",
        "http://[::1]/",
        "http://0.0.0.0",
    ],
)
def test_blocks_private_and_internal_ip_literals(url):
    with pytest.raises(UrlNotAllowedError):
        assert_url_is_safe(url)


@pytest.mark.parametrize("blocked_ip", ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254"])
def test_blocks_public_host_that_resolves_to_private_ip(monkeypatch, blocked_ip):
    # A public-looking hostname whose DNS points at an internal IP must block
    # (DNS-rebinding / malicious-DNS defense).
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo(blocked_ip))
    with pytest.raises(UrlNotAllowedError):
        assert_url_is_safe("http://attacker-controlled.example.com/path")


def test_allows_normal_public_host(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("93.184.216.34"))
    # Should not raise.
    assert_url_is_safe("https://www.gobowtie.com/my/cn/blog/some-article/")


def test_allows_another_public_host(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("104.16.123.96"))
    assert_url_is_safe("https://example.org/article")


def test_allows_public_ipv6(monkeypatch):
    public_v6 = "2606:2800:220:1:248:1893:25c8:1946"
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo(public_v6))
    assert_url_is_safe("https://ipv6.example.com/")


def test_unresolvable_host_blocks(monkeypatch):
    def _boom(*args, **kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(socket, "getaddrinfo", _boom)
    with pytest.raises(UrlNotAllowedError):
        assert_url_is_safe("https://does-not-resolve.invalid/")


# --- optional allowlist --------------------------------------------------------


def test_allowlist_permits_bowtie_host(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("93.184.216.34"))
    assert_url_is_safe(
        "https://www.gobowtie.com/my/article",
        allowlist=BOWTIE_HOST_ALLOWLIST,
    )


def test_allowlist_blocks_non_bowtie_host(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("93.184.216.34"))
    with pytest.raises(UrlNotAllowedError):
        assert_url_is_safe(
            "https://www.example.com/article",
            allowlist=BOWTIE_HOST_ALLOWLIST,
        )


def test_default_is_permissive_for_public_hosts(monkeypatch):
    # The DEFAULT (no allowlist) must permit arbitrary public hosts so the
    # external-source fallback keeps working.
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo("151.101.1.69"))
    assert_url_is_safe("https://some-random-public-blog.net/post")
