// ruff: noqa: RUF001 (source wording kept in 繁體中文 — do not auto-correct quotes)
// Ported verbatim from config/source_policy.yaml + content_tool/policy/source_policy.py.
// Single source of truth for source-selection rules on the Workers side.

// ---------------------------------------------------------------------------
// Raw constant
// ---------------------------------------------------------------------------

export const SOURCE_POLICY_RAW = {
  deny: {
    domains: [
      "bowtie.com.hk",
      "bowtie.com",
      "manulife.com.hk",
      "axa.com.hk",
      "prudential.com.hk",
      "aia.com.hk",
      "china-life.com.hk",
      "blueocean.com.hk",
      "chubb.com.hk",
      "zurich.com.hk",
      "hsbclife.com.hk",
      "fwd.com.hk",
    ],
  },
  prefer: {
    tlds: [".gov.hk", ".gov", ".edu", ".edu.hk"],
    domains: [
      "ia.org.hk",
      "ifec.org.hk",
      "hkma.gov.hk",
      "dh.gov.hk",
      "chp.gov.hk",
      "ha.org.hk",
      "mpfa.org.hk",
      "vhis.gov.hk",
      "who.int",
    ],
  },
  community_exception: {
    topic_categories: ["community-response", "patient-experience", "social-discussion"],
    allowed_domains: ["reddit.com", "hk.discuss.com", "lihkg.com", "baby-kingdom.com"],
  },
} as const;

// ---------------------------------------------------------------------------
// Types — mirror the Python PolicyDecision dataclass
// ---------------------------------------------------------------------------

export type Decision = "allowed" | "denied" | "community_exception";
export type DeniedReason = "bowtie_owned" | "competitor" | "other";

export interface PolicyDecision {
  decision: Decision;
  reason: DeniedReason | null;
  matchedRule: string | null;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Bowtie-owned domains that get the "bowtie_owned" denial reason. */
const BOWTIE_DOMAINS: ReadonlySet<string> = new Set(["bowtie.com.hk", "bowtie.com"]);

// ---------------------------------------------------------------------------
// Apex-domain extraction (mirrors tldextract logic for the domains we handle)
// ---------------------------------------------------------------------------

/**
 * Extract the registrable apex domain (domain + public suffix) from a URL or
 * bare hostname string.  Mirrors the Python `SourcePolicy._apex()` which
 * delegates to `tldextract`.
 *
 * For Workers we implement a lightweight version:
 *  - Strip scheme, path, port, query.
 *  - Lowercase.
 *  - Take the last two labels (covers .com/.net/.org/etc.) UNLESS the second-
 *    to-last label is a well-known second-level registry segment (e.g. "com",
 *    "org", "gov", "edu") that is part of a country-code TLD like .com.hk or
 *    .gov.hk — in which case take the last three labels.
 *
 * This is sufficient for the domains actually present in the policy.
 */
function apexDomain(raw: string): string {
  // Strip scheme
  let host = raw.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, "");
  // Strip path/query/fragment and port
  host = (host.split(/[/?#]/)[0] ?? "").split(":")[0] ?? "";
  host = host.toLowerCase().trim();
  if (!host) return raw.toLowerCase();

  const labels = host.split(".");
  if (labels.length <= 2) return host;

  // Known second-level segments used in ccTLD compound suffixes
  const secondLevelSegments = new Set(["com", "org", "gov", "edu", "net", "ac", "sch"]);
  const tld = labels[labels.length - 1] ?? ""; // e.g. "hk", "com", "org"
  const secondLabel = labels[labels.length - 2] ?? "";

  // If the TLD is a ccTLD (2-letter) and the second-to-last label is a registry
  // segment (e.g. "com", "gov"), the public suffix is 2 labels deep → apex = 3 labels.
  if (tld.length === 2 && secondLevelSegments.has(secondLabel)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

// ---------------------------------------------------------------------------
// SourcePolicy class
// ---------------------------------------------------------------------------

export class SourcePolicy {
  readonly denyDomains: ReadonlySet<string>;
  readonly preferTlds: readonly string[];
  readonly preferDomains: ReadonlySet<string>;
  readonly communityTopicCategories: ReadonlySet<string>;
  readonly communityAllowedDomains: ReadonlySet<string>;

  constructor() {
    this.denyDomains = new Set(SOURCE_POLICY_RAW.deny.domains);
    this.preferTlds = SOURCE_POLICY_RAW.prefer.tlds;
    this.preferDomains = new Set(SOURCE_POLICY_RAW.prefer.domains);
    this.communityTopicCategories = new Set(SOURCE_POLICY_RAW.community_exception.topic_categories);
    this.communityAllowedDomains = new Set(SOURCE_POLICY_RAW.community_exception.allowed_domains);
  }

  /**
   * Evaluate whether a domain is allowed as a citation source.
   *
   * Logic mirrors `SourcePolicy.evaluate()` in source_policy.py exactly:
   *  1. If apex is a community-allowed domain AND topic_category is in the
   *     community categories → "community_exception" (reason: null).
   *  2. If apex is a community-allowed domain but topic_category is NOT in the
   *     community categories → "denied" (reason: "other").
   *  3. If apex is a Bowtie-owned domain → "denied" (reason: "bowtie_owned").
   *  4. If apex is in denyDomains (competitors) → "denied" (reason: "competitor").
   *  5. Otherwise → "allowed" (reason: null).
   */
  evaluate(domain: string, topicCategory: string | null): PolicyDecision {
    const apex = apexDomain(domain);

    if (this.communityAllowedDomains.has(apex)) {
      if (topicCategory !== null && this.communityTopicCategories.has(topicCategory)) {
        return { decision: "community_exception", reason: null, matchedRule: apex };
      }
      return { decision: "denied", reason: "other", matchedRule: "community-not-applicable" };
    }

    if (BOWTIE_DOMAINS.has(apex)) {
      return { decision: "denied", reason: "bowtie_owned", matchedRule: apex };
    }

    if (this.denyDomains.has(apex)) {
      return { decision: "denied", reason: "competitor", matchedRule: apex };
    }

    return { decision: "allowed", reason: null, matchedRule: apex };
  }

  /**
   * Render the source-selection rules as a 繁體中文 prompt block.
   *
   * Mirrors `SourcePolicy.to_prompt_block()` in source_policy.py verbatim so
   * that writer-prompt output stays in parity between the Python backend and
   * the Workers backend.  Single source of truth: update here when
   * config/source_policy.yaml changes.
   */
  toPromptBlock(): string {
    const tlds =
      this.preferTlds.length > 0 ? this.preferTlds.join(" / ") : "（未設定）";
    const domains =
      this.preferDomains.size > 0
        ? [...this.preferDomains].sort().join("、")
        : "（未設定）";
    const cats =
      this.communityTopicCategories.size > 0
        ? [...this.communityTopicCategories].sort().join("、")
        : "（未設定）";
    const commDomains =
      this.communityAllowedDomains.size > 0
        ? [...this.communityAllowedDomains].sort().join("、")
        : "（未設定）";

    return [
      "引用與資料來源規則（由 source_policy 統一管理）：",
      "- 主動使用 googleSearch 與 urlContext 工具核實時間敏感資訊（年份、收費、政策、" +
        "法規、資格、流程、醫療或保險條款）。",
      "- 你需要自行判斷並篩選「真確、權威」的資料來源，而不是機械式比對清單。" +
        "評估每個來源時，請依下列原則排序取捨：",
      "  1. 權威性：官方、政府、學術、法定機構或國際衛生組織等具公信力的一手來源優先。",
      "  2. 一手原則：盡量引用發出資訊的原始機構，而非二手轉述或內容農場，或任何保險機構。",
      "  3. 香港相關性與時效：優先採用適用於香港、且為最新版本的資料。",
      "  4. 可信中立：避免無署名、無法核實、明顯 SEO 拼湊或商業推銷性質的來源。",
      `- 高度建議優先採用（例子，非窮舉清單）：TLD ${tlds}；機構 ${domains}。` +
        "若有更權威、更貼題的官方一手來源，亦可採用。",
      "- 硬性禁止：不可引用 bowtie.com.hk 或任何保險公司網站作為資料來源。",
      `- 社區來源例外：只有當 topic_category 屬於「${cats}」時，` +
        `方可引用社區／論壇來源（例如 ${commDomains}）；其他題材一律不可引用社區來源。`,
      "- 引用必須在文中自然 ground 到具體段落，不可堆砌或泛泛而引。",
      "- 不要在 markup 中手寫 `## 資訊來源` 區塊；該區塊由後處理流程根據 grounding " +
        "metadata 自動生成。",
    ].join("\n");
  }
}

/** Singleton instance — import this for normal use. */
export const sourcePolicyInstance = new SourcePolicy();
