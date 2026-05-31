// Read-only COSTS routes, ported from content_tool/api/routes/costs.py.
// Mounted at `/costs` by src/index.ts (do NOT prefix routes here).
//
//   GET /summary    ?start=YYYY-MM-DD&end=YYYY-MM-DD  (both required)
//   GET /run/:runId
//
// Cost math + rounding live in src/db/costs.ts (truncating int cents at the
// gemini-3.5-flash rate, matching the Python `CostCalculator`).

import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { getCostSummary, getRunCost } from "../db/costs";

const costsRouter = new Hono<{ Bindings: Env }>();

// FastAPI coerces `start: date` / `end: date` query params and returns 422 on a
// missing or unparseable value. We mirror that: require both, accept only a
// strict `YYYY-MM-DD` that is a real calendar date.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) {
    return false;
  }
  // Reject impossible dates (e.g. 2026-02-30) by round-tripping through Date.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString().slice(0, 10) === value;
}

costsRouter.get("/summary", async (c) => {
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

  const summary = await withDb(c.env, c.executionCtx, (sql) => getCostSummary(sql, start, end));
  return c.json(summary);
});

costsRouter.get("/run/:runId", async (c) => {
  const runId = c.req.param("runId");
  const result = await withDb(c.env, c.executionCtx, (sql) => getRunCost(sql, runId));
  if (result === null) {
    return c.json({ detail: "no usage" }, 404);
  }
  return c.json(result);
});

export { costsRouter };
export default costsRouter;
