from pydantic import BaseModel


class ApplyEditsOutput(BaseModel):
    """Structured reply from the inline article-editor agent.

    ``html_body`` is the full revised HTML; ``diagnose`` is a one-line summary of
    what the model changed (kept for logging / parity, not surfaced in the UI).
    """

    html_body: str
    diagnose: str = ""
