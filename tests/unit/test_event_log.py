"""Unit tests for the verbose per-step event-log derivation helpers.

These exercise the PURE helpers in ``content_tool.observability.event_log``
against the shared data contract (the Workers backend implements the same
derivation, so these cases also pin the cross-runtime behaviour).
"""

import json

import pytest

from content_tool.observability.event_log import (
    cap_payload,
    derive_duration_ms,
    derive_level,
    derive_step,
)


@pytest.mark.parametrize(
    ("event", "expected_step"),
    [
        ("strategy.fetch_article.start", "fetch_article"),
        ("production.writer.done", "writer"),
        ("writer.thinking", "writer"),
        ("hitl.interrupted", "hitl"),
        ("graph.completed", "graph"),
        ("graph.error", "graph"),
        # Single segment, not a verb -> the segment itself is the step.
        ("publish", "publish"),
        # Verb-only single segment -> no step.
        ("done", None),
    ],
)
def test_derive_step(event: str, expected_step: str | None) -> None:
    assert derive_step(event) == expected_step


@pytest.mark.parametrize(
    ("event", "expected_level"),
    [
        ("writer.thinking", "thinking"),
        ("production.writer.thinking", "thinking"),
        ("production.writer.error", "error"),
        ("graph.error", "error"),
        ("hitl.interrupted", "gate"),
        ("strategy.outline.gate", "gate"),
        ("production.writer.done", "info"),
        ("strategy.fetch_article.start", "info"),
        ("graph.completed", "info"),
    ],
)
def test_derive_level(event: str, expected_level: str) -> None:
    assert derive_level(event) == expected_level


def test_cap_payload_small_unchanged() -> None:
    payload = {"a": 1, "b": "short"}
    assert cap_payload(payload) == payload


def test_cap_payload_truncates_large_field() -> None:
    # Total exceeds MAX_BYTES (16384) so the per-field truncation tier fires;
    # the oversize string field collapses to a stub while small fields survive.
    big = "x" * 20000
    payload = {"keep": "small", "huge": big}
    capped = cap_payload(payload)
    assert capped["keep"] == "small"
    assert capped["huge"] == {"_truncated": True, "_bytes": len(big.encode())}
    # Result must fit under the cap.
    assert len(json.dumps(capped).encode()) <= 16384


def test_cap_payload_oversize_summary() -> None:
    # Many fields each just UNDER MAX_FIELD (so per-field truncation leaves them
    # untouched) but collectively over MAX_BYTES — the summary tier must fire.
    payload = {f"k{i:04d}": "y" * 2000 for i in range(20)}
    capped = cap_payload(payload)
    assert capped["_truncated"] is True
    assert capped["_bytes"] == len(json.dumps(payload).encode())
    assert capped["_keys"] == sorted(payload.keys())


def test_derive_duration_ms_start_done_match() -> None:
    # 1500 ms apart, same (stream, step).
    last_starts = {("s1", "writer"): 1_000.0}
    assert derive_duration_ms(
        event="production.writer.done",
        step="writer",
        recorded_at_ms=2_500.0,
        last_start_ms=last_starts.get(("s1", "writer")),
    ) == 1500


def test_derive_duration_ms_no_matching_start() -> None:
    assert derive_duration_ms(
        event="production.writer.done",
        step="writer",
        recorded_at_ms=2_500.0,
        last_start_ms=None,
    ) is None


def test_derive_duration_ms_non_done_event_is_none() -> None:
    # ".thinking" and ".start" never carry a duration even with a matching start.
    assert derive_duration_ms(
        event="writer.thinking",
        step="writer",
        recorded_at_ms=2_500.0,
        last_start_ms=1_000.0,
    ) is None
