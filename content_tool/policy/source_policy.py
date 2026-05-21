from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

import tldextract
import yaml

Decision = Literal["allowed", "denied", "community_exception"]
DeniedReason = Literal["bowtie_owned", "competitor", "other"]


@dataclass
class PolicyDecision:
    decision: Decision
    reason: DeniedReason | None = None
    matched_rule: str | None = None


_BOWTIE_DOMAINS = {"bowtie.com.hk", "bowtie.com"}


def _str_list(mapping: dict[str, object], key: str) -> list[str]:
    val = mapping.get(key, [])
    if isinstance(val, list):
        return [str(item) for item in cast(list[object], val)]
    return []


def _section(raw: dict[str, object], key: str) -> dict[str, object]:
    val = raw.get(key, {})
    if isinstance(val, dict):
        return val  # type: ignore[return-value]
    return {}


class SourcePolicy:
    def __init__(self, raw: dict[str, object]) -> None:
        deny = _section(raw, "deny")
        prefer = _section(raw, "prefer")
        ce = _section(raw, "community_exception")
        self.deny_domains: set[str] = set(_str_list(deny, "domains"))
        self.prefer_tlds: list[str] = _str_list(prefer, "tlds")
        self.prefer_domains: set[str] = set(_str_list(prefer, "domains"))
        self.community_topic_categories: set[str] = set(_str_list(ce, "topic_categories"))
        self.community_allowed_domains: set[str] = set(_str_list(ce, "allowed_domains"))

    @classmethod
    def load_from(cls, path: str | Path) -> "SourcePolicy":
        with open(path, encoding="utf-8") as f:
            raw = yaml.safe_load(f)
        return cls(raw)

    @staticmethod
    def _apex(domain: str) -> str:
        ext = tldextract.extract(domain)
        if not ext.suffix:
            return domain.lower()
        return f"{ext.domain}.{ext.suffix}".lower()

    def evaluate(self, domain: str, topic_category: str | None) -> PolicyDecision:
        apex = self._apex(domain)

        if apex in self.community_allowed_domains:
            if topic_category in self.community_topic_categories:
                return PolicyDecision("community_exception", matched_rule=apex)
            return PolicyDecision("denied", reason="other", matched_rule="community-not-applicable")

        if apex in _BOWTIE_DOMAINS:
            return PolicyDecision("denied", reason="bowtie_owned", matched_rule=apex)

        if apex in self.deny_domains:
            return PolicyDecision("denied", reason="competitor", matched_rule=apex)

        return PolicyDecision("allowed", matched_rule=apex)
