from content_tool.utils.html_comments import strip_comment_anchors


def test_strips_single_mark():
    html = '<p>foo <span data-comment-id="abc">bar</span> baz</p>'
    assert strip_comment_anchors(html) == '<p>foo bar baz</p>'


def test_strips_nested_marks():
    html = '<p><span data-comment-id="a">x <span data-comment-id="b">y</span></span></p>'
    assert strip_comment_anchors(html) == '<p>x y</p>'


def test_preserves_other_attributes_and_other_spans():
    html = '<p><span class="kept">x</span><span data-comment-id="a">y</span></p>'
    assert strip_comment_anchors(html) == '<p><span class="kept">x</span>y</p>'


def test_idempotent_on_clean_html():
    html = '<p>hello <strong>world</strong></p>'
    assert strip_comment_anchors(html) == html


def test_malformed_html_does_not_crash():
    html = '<p>oops<span data-comment-id="x">no close'
    out = strip_comment_anchors(html)
    assert "data-comment-id" not in out
