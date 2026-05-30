import logging

from content_tool.desktop.config_store import DesktopConfigStore


def _store(tmp_path):
    return DesktopConfigStore(path=tmp_path / "config.json")


def test_save_load_roundtrip(tmp_path):
    store = _store(tmp_path)
    store.save({"postgres_url": "postgresql://u@h/db", "gemini_api_key": "k"})
    assert store.load() == {"postgres_url": "postgresql://u@h/db", "gemini_api_key": "k"}


def test_missing_file_returns_empty(tmp_path):
    assert _store(tmp_path).load() == {}


def test_invalid_json_returns_empty(tmp_path):
    p = tmp_path / "config.json"
    p.write_text("{not valid json", encoding="utf-8")
    assert DesktopConfigStore(path=p).load() == {}


def test_non_object_json_returns_empty(tmp_path):
    p = tmp_path / "config.json"
    p.write_text("[1, 2, 3]", encoding="utf-8")
    assert DesktopConfigStore(path=p).load() == {}


def test_file_written_owner_read_write_only(tmp_path):
    store = _store(tmp_path)
    store.save({"a": 1})
    mode = (tmp_path / "config.json").stat().st_mode & 0o777
    assert mode == 0o600


def test_save_creates_parent_dir(tmp_path):
    nested = tmp_path / "deep" / "nested"
    store = DesktopConfigStore(path=nested / "config.json")
    store.save({"a": 1})
    assert (nested / "config.json").is_file()


def test_save_does_not_log_secret(tmp_path, caplog):
    store = _store(tmp_path)
    secret = "super-secret-gemini-key-123"  # noqa: S105 — synthetic test value
    with caplog.at_level(logging.DEBUG):
        store.save({"gemini_api_key": secret})
        store.load()
    assert secret not in caplog.text
