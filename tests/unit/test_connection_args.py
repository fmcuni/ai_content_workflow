"""Guards for the asyncpg connect-args builder (content_tool/db/connection.py).

The statement_timeout assertions protect against the resolve_citations stall
(prod run a6e897e1): a query with no server-side timeout can hang a run forever.
"""

from content_tool.db.connection import _build_connect_args


def test_sets_statement_timeout_under_ten_minutes() -> None:
    # Arrange / Act
    _clean_url, connect_args = _build_connect_args("postgresql+asyncpg://u:p@h:5432/db")

    # Assert
    server_settings = connect_args["server_settings"]
    assert isinstance(server_settings, dict)
    timeout_ms = int(server_settings["statement_timeout"])
    assert 0 < timeout_ms < 600_000  # well under Workers' 10-min step default


def test_strips_sslmode_and_maps_require_to_ssl() -> None:
    clean_url, connect_args = _build_connect_args(
        "postgresql+asyncpg://u:p@h:5432/db?sslmode=require"
    )

    assert "sslmode" not in clean_url
    assert connect_args["ssl"] == "require"
    # statement_timeout is always present regardless of ssl.
    assert "statement_timeout" in connect_args["server_settings"]  # type: ignore[operator]


def test_disable_sslmode_does_not_set_ssl() -> None:
    _clean_url, connect_args = _build_connect_args(
        "postgresql+asyncpg://u:p@h:5432/db?sslmode=disable"
    )

    assert "ssl" not in connect_args
