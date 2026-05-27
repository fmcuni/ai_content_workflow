# ruff: noqa: RUF001
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

import tldextract
import yaml

Decision = Literal["allowed", "denied", "community_exception"]
DeniedReason = Literal["bowtie_owned", "competitor", "other"]

DEFAULT_POLICY_PATH = Path(__file__).resolve().parents[2] / "config" / "source_policy.yaml"


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

    def to_prompt_block(self) -> str:
        """Render the source-selection rules as a 繁體中文 prompt block.

        Single source of truth: the writer prompts inject this so their
        guidance can never drift from ``config/source_policy.yaml``.
        """
        tlds = " / ".join(self.prefer_tlds) if self.prefer_tlds else "（未設定）"
        domains = "、".join(sorted(self.prefer_domains)) if self.prefer_domains else "（未設定）"
        cats = "、".join(sorted(self.community_topic_categories)) or "（未設定）"
        comm_domains = "、".join(sorted(self.community_allowed_domains)) or "（未設定）"
        return "\n".join(
            [
                "引用與資料來源規則（由 source_policy 統一管理）：",
                "- 主動使用 googleSearch 與 urlContext 工具核實時間敏感資訊（年份、收費、政策、"
                "法規、資格、流程、醫療或保險條款）。",
                "- 你需要自行判斷並篩選「真確、權威」的資料來源，而不是機械式比對清單。"
                "評估每個來源時，請依下列原則排序取捨：",
                "  1. 權威性：官方、政府、學術、法定機構或國際衛生組織等具公信力的一手來源優先。",
                "  2. 一手原則：盡量引用發出資訊的原始機構，而非二手轉述或內容農場。",
                "  3. 香港相關性與時效：優先採用適用於香港、且為最新版本的資料。",
                "  4. 可信中立：避免無署名、無法核實、明顯 SEO 拼湊或商業推銷性質的來源。",
                f"- 高度建議優先採用（例子，非窮舉清單）：TLD {tlds}；機構 {domains}。"
                "若有更權威、更貼題的官方一手來源，亦可採用。",
                "- 硬性禁止：不可引用 bowtie.com.hk 或任何保險公司網站作為資料來源。",
                f"- 社區來源例外：只有當 topic_category 屬於「{cats}」時，"
                f"方可引用社區／論壇來源（例如 {comm_domains}）；其他題材一律不可引用社區來源。",
                "- 引用必須在文中自然 ground 到具體段落，不可堆砌或泛泛而引。",
                "- 不要在 markup 中手寫 `## 資訊來源` 區塊；該區塊由後處理流程根據 grounding "
                "metadata 自動生成。",
            ]
        )
