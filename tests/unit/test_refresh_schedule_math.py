from datetime import datetime, timedelta, timezone
import pytest
from content_tool.refresh.inventory import (
    advance_schedule, schedule_after_retry, schedule_after_dismiss,
)

NOW = datetime(2026, 5, 22, 12, 0, tzinfo=timezone.utc)

def test_advance_schedule_refresh_returns_none():
    assert advance_schedule(action="refresh", now=NOW) is None

def test_advance_schedule_monitor_returns_now_plus_14_days():
    assert advance_schedule(action="monitor", now=NOW) == NOW + timedelta(days=14)

def test_advance_schedule_ok_returns_now_plus_30_days():
    assert advance_schedule(action="ok", now=NOW) == NOW + timedelta(days=30)

def test_advance_schedule_unknown_raises():
    with pytest.raises(ValueError):
        advance_schedule(action="bogus", now=NOW)

def test_schedule_after_retry_is_one_day():
    assert schedule_after_retry(now=NOW) == NOW + timedelta(days=1)

def test_schedule_after_dismiss_is_dismissed_until():
    until = NOW + timedelta(days=7)
    assert schedule_after_dismiss(until) == until
