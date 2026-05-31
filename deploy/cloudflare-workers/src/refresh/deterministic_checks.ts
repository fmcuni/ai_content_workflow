/**
 * Deterministic checks against currently-published HTML — Workers-native port
 * of `content_tool/refresh/deterministic_checks.py`.
 *
 * Mirrors the Python behaviour exactly: broken-link detection (HEAD then GET,
 * bounded concurrency, timeout, ignore-domains), dated-phrasing, missing FAQ
 * JSON-LD, and coarse heading-skip drift. `passed` is
 *   severity_high === 0 && severity_medium <= audit_det_medium_threshold.
 *
 * No `bs4`/DOM is available in the Worker runtime, so HTML parsing is done with
 * the same regex-driven approach used elsewhere in the Workers backend
 * (`src/agents/audit_checks.ts`): anchors, headings and visible text are
 * extracted with small, well-scoped regexes. The behavioural outcome (which
 * findings fire, at what severity) is preserved.
 */

import type { Sql } from "postgres";
import { getRefreshConfig } from "../config/refresh";
import { toJsonb } from "../db/serialize";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "high" | "medium" | "low";

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  context: Record<string, unknown> | null;
}

/** JSONB shape written to `refresh_evaluations.deterministic_findings`. */
export interface DeterministicJsonb {
  findings: Finding[];
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  passed: boolean;
}

// ---------------------------------------------------------------------------
// DeterministicResult — mirrors the Python dataclass + .passed + .to_jsonb()
// ---------------------------------------------------------------------------

export class DeterministicResult {
  readonly findings: Finding[] = [];
  severityHigh = 0;
  severityMedium = 0;
  severityLow = 0;

  add(f: Finding): void {
    this.findings.push(f);
    if (f.severity === "high") {
      this.severityHigh += 1;
    } else if (f.severity === "medium") {
      this.severityMedium += 1;
    } else {
      this.severityLow += 1;
    }
  }

  /** severity_high == 0 && severity_medium <= audit_det_medium_threshold. */
  get passed(): boolean {
    const cfg = getRefreshConfig().deterministic;
    return this.severityHigh === 0 && this.severityMedium <= cfg.audit_det_medium_threshold;
  }

  /** Native jsonb bind param for the deterministic_findings column. */
  toJsonb(sql: Sql): ReturnType<typeof toJsonb> {
    return toJsonb(sql, this.toObject());
  }

  /** Plain object form (used by toJsonb and by tests). */
  toObject(): DeterministicJsonb {
    return {
      findings: this.findings,
      severity_high: this.severityHigh,
      severity_medium: this.severityMedium,
      severity_low: this.severityLow,
      passed: this.passed,
    };
  }
}

// ---------------------------------------------------------------------------
// HTML extraction helpers (regex-based; no DOM in the Worker runtime)
// ---------------------------------------------------------------------------

const ANCHOR_HREF_RE = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;
const HEADING_RE = /<h([1-6])\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;

/** Collect all `href` values from anchor tags. */
function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const m of html.matchAll(ANCHOR_HREF_RE)) {
    const href = m[2] ?? m[3];
    if (href !== undefined) {
      hrefs.push(href);
    }
  }
  return hrefs;
}

/** Ordered list of heading levels (1..6) in document order. */
function extractHeadingLevels(html: string): number[] {
  const levels: number[] = [];
  for (const m of html.matchAll(HEADING_RE)) {
    levels.push(parseInt(m[1]!, 10));
  }
  return levels;
}

/**
 * Visible text with tags stripped and whitespace collapsed to single spaces —
 * mirrors BeautifulSoup `.get_text(" ")` closely enough for the phrasing regexes.
 */
function visibleText(html: string): string {
  return html.replace(TAG_RE, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// check_broken_links
// ---------------------------------------------------------------------------

/**
 * HEAD each external link (falling back to GET on >=400), with bounded
 * concurrency and a per-request timeout. Links on ignore-domains are skipped.
 * Each failure → one medium `det-link-broken` finding (mirrors the Python).
 */
export async function checkBrokenLinks(html: string): Promise<Finding[]> {
  const cfg = getRefreshConfig().deterministic;

  const urls = extractHrefs(html).filter(
    (href) =>
      href.startsWith("http") &&
      !cfg.link_check_ignore_domains.some((dom) => href.includes(dom)),
  );

  if (urls.length === 0) {
    return [];
  }

  const findings: Finding[] = [];
  const timeoutMs = cfg.link_check_timeout_ms;

  async function fetchStatus(url: string, method: "HEAD" | "GET"): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method, redirect: "follow", signal: controller.signal });
      return resp.status;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkOne(url: string): Promise<void> {
    try {
      let status = await fetchStatus(url, "HEAD");
      if (status >= 400) {
        // Retry as GET — some servers reject HEAD.
        status = await fetchStatus(url, "GET");
      }
      if (status >= 400) {
        findings.push({
          id: "det-link-broken",
          severity: "medium",
          message: `Broken link: ${url} (${status})`,
          context: { url, status },
        });
      }
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "Error";
      const detail = err instanceof Error ? err.message : String(err);
      findings.push({
        id: "det-link-broken",
        severity: "medium",
        message: `Broken link: ${url} (${name})`,
        context: { url, error: detail.slice(0, 200) },
      });
    }
  }

  // Bounded concurrency — mirrors asyncio.Semaphore(link_check_concurrency).
  const limit = Math.max(1, cfg.link_check_concurrency);
  for (let i = 0; i < urls.length; i += limit) {
    const chunk = urls.slice(i, i + limit);
    await Promise.all(chunk.map((u) => checkOne(u)));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// check_dated_phrasing
// ---------------------------------------------------------------------------

const AS_OF_RE = /\bas of (\w+ )?(\d{4})\b/gi;
const YEAR_RE = /\b(20\d{2})\b/g;

/** Flag "as of <year>" and bare old-year references below the threshold year. */
export function checkDatedPhrasing(html: string, now: Date = new Date()): Finding[] {
  const cfg = getRefreshConfig().deterministic;
  const lookback = cfg.dated_phrasing_year_lookback;
  const thresholdYear = now.getFullYear() - lookback;
  const findings: Finding[] = [];
  const text = visibleText(html);

  for (const m of text.matchAll(AS_OF_RE)) {
    const year = parseInt(m[2]!, 10);
    if (year < thresholdYear) {
      findings.push({
        id: "det-dated-phrasing",
        severity: "low",
        message: `Dated phrasing: '${m[0]}'`,
        context: { year },
      });
    }
  }

  for (const m of text.matchAll(YEAR_RE)) {
    const year = parseInt(m[1]!, 10);
    const start = m.index ?? 0;
    const prefix = text.slice(Math.max(0, start - 8), start);
    if (year < thresholdYear && !/as of/i.test(prefix)) {
      findings.push({
        id: "det-old-year",
        severity: "low",
        message: `Old year reference: ${year}`,
        context: { year },
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// check_missing_faq_jsonld
// ---------------------------------------------------------------------------

const ACF_WIDGET_RE = /\[acf_widget [^\]]*\]/;

/** FAQ widget present but FAQPage JSON-LD missing → one high finding. */
export function checkMissingFaqJsonld(html: string): Finding[] {
  const hasFaqShortcode = ACF_WIDGET_RE.test(html) || html.includes("bowtie-faq");
  const hasFaqJsonld = html.includes("FAQPage");
  if (hasFaqShortcode && !hasFaqJsonld) {
    return [
      {
        id: "det-missing-faq-jsonld",
        severity: "high",
        message: "FAQ widget present but FAQPage JSON-LD missing",
        context: null,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// check_html_drift
// ---------------------------------------------------------------------------

/** Coarse heading-hierarchy drift: first skip (cur > prev + 1) → one medium finding. */
export function checkHtmlDrift(html: string): Finding[] {
  const findings: Finding[] = [];
  const headings = extractHeadingLevels(html);
  for (let i = 1; i < headings.length; i += 1) {
    const prev = headings[i - 1]!;
    const cur = headings[i]!;
    if (cur > prev + 1) {
      findings.push({
        id: "det-heading-skip",
        severity: "medium",
        message: `Heading skip: h${prev} → h${cur}`,
        context: { prev, cur },
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// deterministic_audit_published_html
// ---------------------------------------------------------------------------

/**
 * Run all deterministic checks against published HTML and accumulate them into
 * a {@link DeterministicResult}. `modifiedGmt` / `lastPersistedAt` are accepted
 * for parity with the Python signature; they are not consumed by any check yet.
 */
export async function deterministicAuditPublishedHtml(
  html: string,
  _modifiedGmt: string | null = null,
  _lastPersistedAt: Date | string | null = null,
): Promise<DeterministicResult> {
  const result = new DeterministicResult();
  for (const f of await checkBrokenLinks(html)) {
    result.add(f);
  }
  for (const f of checkDatedPhrasing(html)) {
    result.add(f);
  }
  for (const f of checkMissingFaqJsonld(html)) {
    result.add(f);
  }
  for (const f of checkHtmlDrift(html)) {
    result.add(f);
  }
  return result;
}
