// Read-only COMPLIANCE route, ported from content_tool/api/routes/compliance.py.
// Mounted at `/compliance` by src/index.ts (do NOT prefix routes here).
//
//   GET /export.csv  ?start=YYYY-MM-DD&end=YYYY-MM-DD  (both required)
//
// Mirrors the Python `GET /compliance/export.csv` byte-for-byte: same column
// set + order, same date window (persisted_at within [start 00:00:00,
// end 23:59:59.999999]), same `text/csv` media type, and the same
// `attachment; filename="compliance_<start>_to_<end>.csv"` disposition.
//
// CSV is hand-rolled here (no pandas equivalent). The escaping helper matches
// Python's `csv.writer` defaults: fields containing a comma, double-quote, CR,
// or LF are wrapped in double-quotes with internal quotes doubled, and rows are
// terminated with CRLF.

import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { getSql } from "../db/client";
import { pgJson } from "../db/serialize";

const complianceRouter = new Hono<{ Bindings: Env }>();

// FastAPI coerces `start: date` / `end: date` query params and returns 422 on a
// missing or unparseable value. Mirror that: require both, accept only a strict
// `YYYY-MM-DD` that is a real calendar date (same logic as costs.ts).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString().slice(0, 10) === value;
}

// CSV column order — EXACT mirror of compliance.py's header row. The jsonb
// `audit_severity_summary` is flattened into three integer columns.
const CSV_HEADER: readonly string[] = [
  "run_id",
  "persisted_at",
  "persona",
  "article_url",
  "wp_pushed_post_id",
  "chosen_route",
  "sources_cited",
  "sources_denied",
  "audit_overall_pass",
  "audit_severity_high",
  "audit_severity_medium",
  "audit_severity_low",
  "approver_email",
  "iteration_count",
  "gemini_model",
  "total_tokens",
  "est_cost_usd_cents",
];

const CSV_NEWLINE = "\r\n";

/**
 * Escape a single CSV field to match Python `csv.writer` defaults
 * (QUOTE_MINIMAL): quote only when the field contains the delimiter (`,`), a
 * double-quote, CR, or LF; inside a quoted field, internal `"` are doubled.
 */
export function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** Join already-stringified fields into one CSV row (no trailing newline). */
export function csvRow(fields: readonly string[]): string {
  return fields.map(csvEscape).join(",");
}

/**
 * Serialize a full CSV document (header + rows) with a trailing CRLF after every
 * record, matching Python `csv.writer`'s line terminator.
 */
export function buildCsv(header: readonly string[], rows: readonly string[][]): string {
  const lines = [csvRow(header), ...rows.map((r) => csvRow(r))];
  return lines.map((line) => `${line}${CSV_NEWLINE}`).join("");
}

// Raw postgres.js row shape. `persisted_at` is RAW Postgres text (see getSql);
// jsonb arrives as a native object OR a legacy JSON string (normalised via
// pgJson). Numeric/text columns map directly; nullables stay nullable.
interface ComplianceRow {
  run_id: string;
  persisted_at: string;
  persona: string;
  article_url: string;
  wp_pushed_post_id: number | null;
  chosen_route: string;
  sources_cited: string;
  sources_denied: string | null;
  audit_overall_pass: boolean;
  audit_severity_summary: unknown;
  approver_email: string;
  iteration_count: number;
  gemini_model: string;
  total_tokens: number | null;
  est_cost_usd_cents: number | null;
}

/** Parsed `audit_severity_summary` jsonb: high/medium/low counts (default 0). */
interface SeveritySummary {
  high?: number;
  medium?: number;
  low?: number;
}

/**
 * Format a raw Postgres timestamptz text value to match Python
 * `datetime.isoformat()` on a UTC-aware datetime: space→`T`, and a trailing
 * `+00` short offset expanded to `+00:00`. Unlike `pgTimestampToIso`, this
 * preserves the numeric offset (Python does NOT emit `Z`).
 *
 * Examples: "2026-05-26 04:12:15.007466+00" → "2026-05-26T04:12:15.007466+00:00".
 */
function formatPersistedAt(raw: string): string {
  const withT = raw.replace(" ", "T");
  // Expand a short `+00` / `-00` offset to `+00:00`; leave `+00:00` untouched.
  return withT.replace(/([+-]\d{2})$/, "$1:00");
}

/** Mirror Python `csv.writer`'s rendering of a Python bool: "True" / "False". */
function pyBool(value: boolean): string {
  return value ? "True" : "False";
}

/** Read a severity count, mirroring Python `s.get(key, 0)`. */
function severityCount(summary: SeveritySummary, key: keyof SeveritySummary): string {
  const value = summary[key];
  return String(typeof value === "number" ? value : 0);
}

/**
 * Build the CSV body for the [start, end] window. The date window mirrors the
 * Python `persisted_at >= start 00:00:00` .. `<= end 23:59:59.999999` via
 * `< end + 1 day`, ordered by `persisted_at` ascending.
 */
async function getComplianceCsv(
  sql: ReturnType<typeof getSql>,
  start: string,
  end: string,
): Promise<string> {
  const rows = await sql<ComplianceRow[]>`
    SELECT
      run_id,
      persisted_at,
      persona,
      article_url,
      wp_pushed_post_id,
      chosen_route,
      sources_cited,
      sources_denied,
      audit_overall_pass,
      audit_severity_summary,
      approver_email,
      iteration_count,
      gemini_model,
      total_tokens,
      est_cost_usd_cents
    FROM content_tool.compliance_log
    WHERE persisted_at >= ${start}::date
      AND persisted_at < (${end}::date + INTERVAL '1 day')
    ORDER BY persisted_at ASC
  `;

  const dataRows: string[][] = rows.map((r) => {
    const summary = pgJson<SeveritySummary>(r.audit_severity_summary) ?? {};
    return [
      String(r.run_id),
      formatPersistedAt(r.persisted_at),
      r.persona,
      r.article_url,
      r.wp_pushed_post_id === null ? "" : String(r.wp_pushed_post_id),
      r.chosen_route,
      r.sources_cited,
      r.sources_denied === null ? "" : r.sources_denied,
      pyBool(r.audit_overall_pass),
      severityCount(summary, "high"),
      severityCount(summary, "medium"),
      severityCount(summary, "low"),
      r.approver_email,
      String(r.iteration_count),
      r.gemini_model,
      String(r.total_tokens ?? 0),
      String(r.est_cost_usd_cents ?? 0),
    ];
  });

  return buildCsv(CSV_HEADER, dataRows);
}

complianceRouter.get("/export.csv", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");

  if (!isValidDate(start) || !isValidDate(end)) {
    return c.json(
      {
        detail: [
          {
            loc: ["query", !isValidDate(start) ? "start" : "end"],
            msg: "invalid or missing date; expected YYYY-MM-DD",
            type: "value_error.date",
          },
        ],
      },
      422,
    );
  }

  const csv = await withDb(c.env, c.executionCtx, (sql) => getComplianceCsv(sql, start, end));

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="compliance_${start}_to_${end}.csv"`,
    },
  });
});

export { complianceRouter };
export default complianceRouter;
