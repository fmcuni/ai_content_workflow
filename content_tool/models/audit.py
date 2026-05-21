from typing import Literal

from pydantic import BaseModel

AuditCategory = Literal["format", "compliance", "voice", "coverage", "safety", "citation"]
Severity = Literal["high", "medium", "low"]


class AuditFinding(BaseModel):
    id: str
    category: AuditCategory
    severity: Severity
    location: str
    issue: str
    suggested_fix: str
    must_fix: bool


class SeveritySummary(BaseModel):
    high: int
    medium: int
    low: int


class AuditOutput(BaseModel):
    overall_pass: bool
    severity_summary: SeveritySummary
    findings: list[AuditFinding]

    def has_blocking(self) -> bool:
        return self.severity_summary.high > 0 or any(f.must_fix for f in self.findings)
