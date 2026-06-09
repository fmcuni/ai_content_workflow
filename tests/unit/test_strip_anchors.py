"""Parity with the Workers ``stripAnchorSpans`` (strip_anchors.test.ts)."""

from content_tool.wordpress.strip_anchors import strip_anchor_spans


def test_unwraps_comment_anchor() -> None:
    assert (
        strip_anchor_spans(
            '<p>a <span class="comment-anchor" data-comment-id="c1">b</span> c</p>'
        )
        == "<p>a b c</p>"
    )


def test_unwraps_review_anchor() -> None:
    assert (
        strip_anchor_spans('<p><span data-review-id="r1" class="review-anchor">note</span></p>')
        == "<p>note</p>"
    )


def test_removes_multiple_back_to_back_anchors() -> None:
    html = (
        '<p><span data-comment-id="c1" class="comment-anchor">x</span>'
        '<span class="review-anchor" data-review-id="r2" data-resolved="true">y</span></p>'
    )
    assert strip_anchor_spans(html) == "<p>xy</p>"


def test_leaves_non_anchor_spans_untouched() -> None:
    html = '<p><span class="e-faq__list">keep</span></p>'
    assert strip_anchor_spans(html) == html


def test_no_op_on_clean_content() -> None:
    assert strip_anchor_spans("<h2>Title</h2><p>body</p>") == "<h2>Title</h2><p>body</p>"
