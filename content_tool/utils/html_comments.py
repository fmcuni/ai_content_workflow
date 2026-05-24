from bs4 import BeautifulSoup


def strip_comment_anchors(html: str) -> str:
    """Remove <span data-comment-id="..."> wrappers, keeping their inner content.

    Used to clean reviewer-comment markup before HTML is persisted to a Draft
    row or sent to WordPress. Other spans and attributes are preserved.
    """
    soup = BeautifulSoup(html, "html.parser")
    for span in soup.find_all("span", attrs={"data-comment-id": True}):
        span.unwrap()
    return str(soup)
