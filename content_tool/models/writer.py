from pydantic import BaseModel


class CitationIntent(BaseModel):
    claim: str
    why_cited: str


class WriterOutput(BaseModel):
    diagnose: str
    markup: str
    citation_intents: list[CitationIntent]
