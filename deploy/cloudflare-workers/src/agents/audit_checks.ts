/**
 * Deterministic audit checks — TypeScript port of
 * `content_tool/agents/audit_checks.py` (`run_deterministic_checks`).
 *
 * These are the PIPELINE audit's format checks invoked by the audit node
 * (content_tool/agents/audit.py → run_deterministic_checks). They are NOT the
 * refresh scanner's published-HTML checks (det-link-broken / det-old-year).
 *
 * Each finding's id, category, severity, location, issue, suggested_fix and
 * must_fix are reproduced byte-for-byte from the Python source so the prompt
 * fed to Gemini and the persisted rows stay identical across runtimes.
 */

import type { AuditFinding } from "./schemas";

export interface DeterministicChecksInput {
  htmlBody: string;
  citationsDeniedDisplayed: boolean;
  schemaJsonld: object[] | null;
  /**
   * Whether the run carries an adv_panel / page_widget element. An acf id of 0
   * is the "no element" sentinel — the shortcode is intentionally absent, so its
   * presence check is skipped rather than flagged as a must-fix finding.
   * Defaults to true to preserve behaviour for callers that do not pass it.
   */
  advEnabled?: boolean;
  widgetEnabled?: boolean;
  /**
   * The voice's configured sources heading. `null`/undefined (zh voices)
   * accepts BOTH Chinese scripts exactly as before; a configured heading (e.g.
   * English "Sources") requires THAT heading's <h2> — render emitted it.
   */
  sourcesHeading?: string | null;
}

// Shortcode presence regexes — mirror the Python `re.search` patterns exactly.
const ADV_PANEL_RE = /\[adv_panel id="\d+"\]/;
const PAGE_WIDGET_RE = /\[page_widget id="\d+"\]/;

// HK-ZH default: accept either Chinese script — the sources heading follows the
// voice's script (see resolve_citations / citations.ts), so a zh-MY voice emits
// Simplified. A non-Chinese voice configures an explicit heading instead.
const SOURCES_MARKERS = ["<h2>資訊來源</h2>", "<h2>资讯来源</h2>"];
const FAQ_WIDGET_MARKER = 'class="editor__item editor__faq"';

/** Whether the rendered body carries the expected sources <h2> for the voice. */
function sourcesPresent(htmlBody: string, sourcesHeading: string | null): boolean {
  const markers =
    sourcesHeading === null ? SOURCES_MARKERS : [`<h2>${sourcesHeading}</h2>`];
  return markers.some((marker) => htmlBody.includes(marker));
}

/**
 * Run the pipeline format/citation deterministic checks against a rendered
 * draft. Returns the findings in the SAME ORDER the Python source appends them
 * (adv → widget → sources → faq → jsonld → cite-denied).
 */
export function runDeterministicChecks(input: DeterministicChecksInput): AuditFinding[] {
  const { htmlBody, citationsDeniedDisplayed, schemaJsonld } = input;
  const advEnabled = input.advEnabled ?? true;
  const widgetEnabled = input.widgetEnabled ?? true;
  const sourcesHeading = input.sourcesHeading ?? null;
  const findings: AuditFinding[] = [];

  if (advEnabled && !ADV_PANEL_RE.test(htmlBody)) {
    findings.push({
      id: "det-fmt-adv",
      category: "format",
      severity: "high",
      location: "body",
      issue: "缺少 [adv_panel id=...] shortcode",
      suggested_fix: "在首段後加入 adv_panel shortcode",
      must_fix: true,
    });
  }

  if (widgetEnabled && !PAGE_WIDGET_RE.test(htmlBody)) {
    findings.push({
      id: "det-fmt-widget",
      category: "format",
      severity: "high",
      location: "body",
      issue: "缺少 [page_widget id=...] shortcode",
      suggested_fix: "在常見問題前加入 page_widget shortcode",
      must_fix: true,
    });
  }

  if (!sourcesPresent(htmlBody, sourcesHeading)) {
    findings.push({
      id: "det-fmt-sources",
      category: "format",
      severity: "high",
      location: "tail",
      issue: "缺少 <h2>資訊來源</h2> section",
      suggested_fix: "確保 resolve_citations 已產生資訊來源 section",
      must_fix: true,
    });
  }

  if (!htmlBody.includes(FAQ_WIDGET_MARKER)) {
    findings.push({
      id: "det-fmt-faq",
      category: "format",
      severity: "high",
      location: "tail",
      issue: "缺少 Bowtie FAQ widget div",
      suggested_fix: "render_html 必須輸出 editor__faq 結構",
      must_fix: true,
    });
  }

  // FAQ JSON-LD is delivered OUT-OF-BAND (schema_jsonld → post meta → schema
  // filter → <head>), so we don't look for a <script> in the body. Instead:
  // whenever the visible FAQ widget is present, the schema graph must carry a
  // matching FAQPage piece.
  const hasFaqWidget = htmlBody.includes(FAQ_WIDGET_MARKER);
  const hasFaqPage = (schemaJsonld ?? []).some(
    (p) => isRecord(p) && p["@type"] === "FAQPage",
  );
  if (hasFaqWidget && !hasFaqPage) {
    findings.push({
      id: "det-fmt-jsonld",
      category: "format",
      severity: "high",
      location: "head",
      issue: "FAQ widget 存在但 schema_jsonld 缺少 FAQPage",
      suggested_fix:
        "render_html 必須輸出 FAQPage 至 schema_jsonld (經 post meta 交付, 不再注入 body)",
      must_fix: true,
    });
  }

  if (citationsDeniedDisplayed) {
    findings.push({
      id: "det-cite-denied",
      category: "citation",
      severity: "high",
      location: "資訊來源",
      issue: "顯示了被 policy 拒絕的來源",
      suggested_fix: "改用 GOV / EDU 等高可信來源",
      must_fix: true,
    });
  }

  return findings;
}

/** Narrow an unknown schema graph entry to a plain object before reading @type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
