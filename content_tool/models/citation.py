from typing import Literal

from pydantic import BaseModel

PolicyDecision = Literal["allowed", "denied", "community_exception"]


class ResolvedCitation(BaseModel):
    chunk_idx: int
    vertex_uri: str
    final_url: str | None
    domain: str | None
    title: str | None
    policy_decision: PolicyDecision
    denied_reason: str | None = None
    was_displayed: bool = False
    resolution_error: str | None = None
