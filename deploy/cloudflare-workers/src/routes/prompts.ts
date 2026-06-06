// Prompt-template routes — ported from content_tool/api/routes/prompts.py.
//
// Mounted at /prompts in src/index.ts. All paths here are RELATIVE to that mount.
//
// Implemented:
//   GET  /graph                  — static LangGraph topology by entry mode
//   GET  /user-example           — example user prompt for a run + agent
//   GET  /templates              — list editable templates (agent + partial), no body
//   GET  /templates/:id          — full template detail
//   GET  /templates/:id/schema   — required/found placeholders + includes
//   GET  /templates/:id/consumers — agent templates that include this template
//   PUT  /templates/:id          — save an edit (optimistic-concurrency, versioned)
//   POST /templates/:id/preview  — render the assembled prompt for an unsaved draft
//   POST /templates/:id/revert   — restore a past version (versioned)
//   GET  /templates/:id/history  — version history, newest-first, body omitted
//   GET  /templates/:id/versions/:versionId — single version with body

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { pgTimestampToIso } from "../db/serialize";
import { getPromptGraph } from "../config/prompt_graph";
import { getTemplateHistory, getVersion } from "../db/prompts";
import type { PromptTemplateRow } from "../db/schema";
import {
  snapshot,
  voiceView,
  invalidate,
  resolveBody,
  assembleWithOverride,
  PromptTemplateNotFound,
  SHARED_VOICE,
} from "../prompts/store";
import {
  EDITABLE_CATEGORIES,
  MAX_TEMPLATE_BYTES,
  REQUIRED_PLACEHOLDERS,
  sha256Hex,
  utf8ByteLength,
  findPlaceholders,
  findIncludes,
  partialIds,
  agentIds,
  consumersOf,
  partialsReferencedBy,
  substitutePreview,
} from "../prompts/editor";
import {
  renderUserPrompt,
  USER_PROMPT_AGENTS,
  MissingInputs,
} from "../prompts/user_example";

const DEFAULT_GRAPH_MODE = "refresh";

const DEFAULT_HISTORY_LIMIT = 50;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 200;

const EXPECTED_SHA_LENGTH = 64;

// Default voice for every template endpoint when the caller omits `?voice=`.
// Mirrors the seeded persona slug; per-voice rows fall back to `__shared__`
// (SHARED_VOICE) for any template the voice has not customised. Judges are
// always global and resolve under `__shared__` regardless of `voice`.
const DEFAULT_VOICE = "bowtie-editor";

/** Read `?voice=`, mirroring FastAPI `voice: str = Query(DEFAULT_VOICE)`: an
 * absent param defaults to `bowtie-editor`; an explicit empty `?voice=` is the
 * empty string (no row → resolves to `__shared__`). */
function resolveVoice(c: Context<{ Bindings: Env }>): string {
  const v = c.req.query("voice");
  return v === undefined ? DEFAULT_VOICE : v;
}

/** Sort comparator replicating the Python route ordering:
 *   items.sort(key=lambda i: (i["category"] == "partial", i["template_id"]))
 * Agents before partials; alphabetical within each group. */
function compareTemplateItems(
  a: { category: string; template_id: string },
  b: { category: string; template_id: string },
): number {
  const aIsPartial = a.category === "partial" ? 1 : 0;
  const bIsPartial = b.category === "partial" ? 1 : 0;
  if (aIsPartial !== bIsPartial) return aIsPartial - bIsPartial;
  return a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0;
}

export const promptsRouter = new Hono<{ Bindings: Env }>();

/**
 * Resolve the editor identity from the trusted `X-Editor-Email` header. Mirrors
 * Python's `_require_editor` DEV-MODE default: a missing header falls back to
 * `dev@local` (the Workers backend ships no editor allowlist — the SSO proxy in
 * front of the frontend is the gate). The frontend injects this header for all
 * /api/prompts/* requests.
 */
function resolveEditor(c: Context<{ Bindings: Env }>): string {
  const email = (c.req.header("X-Editor-Email") ?? "").trim().toLowerCase();
  return email.length > 0 ? email : "dev@local";
}

// ---------------------------------------------------------------------------
// GET /graph?mode=<mode>
//
// Returns the static LangGraph topology for the given entry mode. `mode`
// defaults to "refresh"; an unknown mode mirrors Python's 404 with the
// `unknown graph mode '<mode>'` detail message. No DB access — the registry is
// an in-memory constant (src/config/prompt_graph.ts).
// ---------------------------------------------------------------------------
promptsRouter.get("/graph", (c) => {
  const mode = c.req.query("mode") ?? DEFAULT_GRAPH_MODE;
  const graph = getPromptGraph(mode);
  if (graph === null) {
    return c.json({ detail: `unknown graph mode '${mode}'` }, 404);
  }
  return c.json(graph);
});

// ---------------------------------------------------------------------------
// GET /templates?voice=<slug>
//
// One voice's editable prompts (agent + partial) plus the shared judges. Each
// `templates` entry carries `voice_slug` (the resolved row's voice — voice-owned
// vs `__shared__` fallback); each `judges` entry is `voice_slug: "__shared__"` +
// `read_only: true`. Mirrors content_tool/api/routes/prompts.py::list_templates.
// ---------------------------------------------------------------------------
interface TemplateEntry {
  template_id: string;
  filename: string;
  category: string;
  sha256: string;
  bytes: number;
  voice_slug: string;
}

promptsRouter.get("/templates", async (c) => {
  const voice = resolveVoice(c);
  const { templates, judges } = await withDb(c.env, c.executionCtx, async (sql) => {
    const view = voiceView(await snapshot(sql), voice);
    const items: TemplateEntry[] = [];
    const judgeItems: (TemplateEntry & { read_only: true })[] = [];
    for (const [templateId, row] of view) {
      const entry: TemplateEntry = {
        template_id: templateId,
        filename: row.filename,
        category: row.category,
        sha256: row.sha256,
        bytes: row.bytes,
        voice_slug: row.voice_slug,
      };
      if (EDITABLE_CATEGORIES.has(row.category)) {
        items.push(entry);
      } else if (row.category === "judge") {
        judgeItems.push({ ...entry, read_only: true });
      }
    }
    items.sort(compareTemplateItems);
    judgeItems.sort((a, b) => (a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0));
    return { templates: items, judges: judgeItems };
  });
  return c.json({ voice, templates, judges });
});

// ---------------------------------------------------------------------------
// GET /templates/:id?voice=<slug>
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id", async (c) => {
  const templateId = c.req.param("id");
  const voice = resolveVoice(c);
  const detail = await withDb(c.env, c.executionCtx, async (sql) => {
    const view = voiceView(await snapshot(sql), voice);
    const row = view.get(templateId);
    if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) return null;
    return {
      template_id: templateId,
      voice,
      voice_slug: row.voice_slug,
      filename: row.filename,
      category: row.category,
      template: row.body,
      sha256: row.sha256,
    };
  });
  if (!detail) {
    return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
  }
  return c.json(detail);
});

// ---------------------------------------------------------------------------
// GET /templates/:id/history?voice=<slug>&limit=50
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/history", async (c) => {
  const templateId = c.req.param("id");
  const voice = resolveVoice(c);

  const rawLimit = c.req.query("limit");
  let limit = DEFAULT_HISTORY_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isInteger(parsed) || parsed < MIN_HISTORY_LIMIT || parsed > MAX_HISTORY_LIMIT) {
      return c.json(
        { detail: `limit must be an integer between ${MIN_HISTORY_LIMIT} and ${MAX_HISTORY_LIMIT}` },
        422,
      );
    }
    limit = parsed;
  }

  const versions = await withDb(c.env, c.executionCtx, (sql) =>
    getTemplateHistory(sql, templateId, voice, limit),
  );
  if (!versions) {
    return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
  }
  return c.json({ template_id: templateId, voice, versions });
});

// ---------------------------------------------------------------------------
// GET /templates/:id/versions/:versionId?voice=<slug>
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/versions/:versionId", async (c) => {
  const templateId = c.req.param("id");
  const versionId = c.req.param("versionId");
  const voice = resolveVoice(c);

  const version = await withDb(c.env, c.executionCtx, (sql) =>
    getVersion(sql, templateId, voice, versionId),
  );
  if (!version) {
    return c.json({ detail: `unknown version_id '${versionId}'` }, 404);
  }
  return c.json(version);
});

// ---------------------------------------------------------------------------
// GET /user-example?run_id=<uuid>&agent=<agent>
//
// Render an example USER prompt for the given run + agent, reusing the same
// builders the production workflow uses. 400 for an unknown agent, 404 if the
// run is absent, 422 if a required derived row is missing.
// ---------------------------------------------------------------------------
promptsRouter.get("/user-example", async (c) => {
  const runId = c.req.query("run_id");
  const agent = c.req.query("agent");
  if (runId === undefined || runId === "") {
    return c.json({ detail: "run_id is required" }, 422);
  }
  if (agent === undefined || !USER_PROMPT_AGENTS.has(agent)) {
    const allowed = [...USER_PROMPT_AGENTS].sort().join(", ");
    return c.json({ detail: `agent must be one of [${allowed}]` }, 400);
  }
  try {
    const prompt = await withDb(c.env, c.executionCtx, (sql) =>
      renderUserPrompt(sql, runId, agent),
    );
    if (prompt === null) {
      return c.json({ detail: "run not found" }, 404);
    }
    return c.json({ run_id: runId, agent, prompt });
  } catch (err) {
    if (err instanceof MissingInputs) {
      return c.json({ detail: `missing inputs: ${err.message}` }, 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /templates/:id/schema
//
// Required placeholders (validation chips) + the placeholders/includes the
// current body references (preview tabs). 404 if the template is not editable.
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/schema", async (c) => {
  const templateId = c.req.param("id");
  const voice = resolveVoice(c);
  return withDb(c.env, c.executionCtx, async (sql) => {
    const view = voiceView(await snapshot(sql), voice);
    const row = view.get(templateId);
    if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    }
    const required = [...(REQUIRED_PLACEHOLDERS[templateId] ?? [])].sort();
    const foundIncludes = findIncludes(row.body);
    const partials = partialIds(view);
    const unknownIncludes = foundIncludes.filter((n) => !partials.has(n)).sort();
    return c.json({
      template_id: templateId,
      voice,
      required_placeholders: required,
      found_placeholders: findPlaceholders(row.body),
      found_includes: foundIncludes,
      unknown_includes: unknownIncludes,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /templates/:id/consumers?voice=<slug>
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/consumers", async (c) => {
  const templateId = c.req.param("id");
  const voice = resolveVoice(c);
  return withDb(c.env, c.executionCtx, async (sql) => {
    const view = voiceView(await snapshot(sql), voice);
    const row = view.get(templateId);
    if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    }
    return c.json({ template_id: templateId, voice, consumers: consumersOf(templateId, view) });
  });
});

// ---------------------------------------------------------------------------
// PUT /templates/:id — validate + persist a template edit, stamping a version.
//
// Optimistic concurrency: the row is locked FOR UPDATE inside a transaction and
// its sha must still equal expected_sha256 (else 409). 404 unknown/uneditable,
// 413 over the byte cap, 400 missing required placeholder / unknown include.
// ---------------------------------------------------------------------------
type SaveResult =
  | { kind: "ok"; savedAt: string | null }
  | { kind: "not_found" }
  | { kind: "stale"; currentSha: string }
  | { kind: "too_large"; bytes: number }
  | { kind: "missing_placeholders"; missing: string[] }
  | { kind: "unknown_includes"; unknown: string[] };

promptsRouter.put("/templates/:id", async (c) => {
  const templateId = c.req.param("id");
  const voice = resolveVoice(c);
  const editor = resolveEditor(c);
  const body = await c.req
    .json<{ template?: unknown; expected_sha256?: unknown }>()
    .catch(() => null);
  if (
    body === null ||
    typeof body.template !== "string" ||
    typeof body.expected_sha256 !== "string"
  ) {
    return c.json({ detail: "template and expected_sha256 are required" }, 422);
  }
  if (body.expected_sha256.length !== EXPECTED_SHA_LENGTH) {
    return c.json({ detail: "expected_sha256 must be 64 hex characters" }, 422);
  }

  const template = body.template;
  const expectedSha = body.expected_sha256;
  const newBytes = utf8ByteLength(template);
  const newSha = await sha256Hex(template);
  const versionId = crypto.randomUUID();

  const result = await withDb(c.env, c.executionCtx, (sql) =>
    sql.begin(async (tx): Promise<SaveResult> => {
      const rows = await tx<Pick<PromptTemplateRow, "category" | "sha256">[]>`
        SELECT category, sha256 FROM content_tool.prompt_templates
        WHERE voice_slug = ${voice} AND template_id = ${templateId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
        return { kind: "not_found" };
      }
      const currentSha = row.sha256;
      if (currentSha !== expectedSha) {
        return { kind: "stale", currentSha };
      }
      if (newBytes > MAX_TEMPLATE_BYTES) {
        return { kind: "too_large", bytes: newBytes };
      }
      const required = REQUIRED_PLACEHOLDERS[templateId] ?? [];
      const present = new Set(findPlaceholders(template));
      const missing = required.filter((p) => !present.has(p)).slice().sort();
      if (missing.length > 0) {
        return { kind: "missing_placeholders", missing };
      }
      // Includes may reference the voice's own partials OR the shared seed set.
      const partialRows = await tx<{ template_id: string }[]>`
        SELECT template_id FROM content_tool.prompt_templates
        WHERE category = 'partial' AND voice_slug IN (${voice}, ${SHARED_VOICE})
      `;
      const partials = new Set(partialRows.map((r) => r.template_id));
      const badIncludes = findIncludes(template).filter((n) => !partials.has(n)).sort();
      if (badIncludes.length > 0) {
        return { kind: "unknown_includes", unknown: badIncludes };
      }

      await tx`
        UPDATE content_tool.prompt_templates
        SET body = ${template}, sha256 = ${newSha}, bytes = ${newBytes},
            updated_by = ${editor}, updated_at = now()
        WHERE voice_slug = ${voice} AND template_id = ${templateId}
      `;
      const ins = await tx<{ saved_at: string }[]>`
        INSERT INTO content_tool.prompt_versions
          (version_id, voice_slug, template_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${versionId}, ${voice}, ${templateId}, ${newSha}, ${currentSha}, ${template}, ${newBytes}, ${editor}, 'save')
        RETURNING saved_at
      `;
      return { kind: "ok", savedAt: ins[0]?.saved_at ?? null };
    }),
  );

  switch (result.kind) {
    case "not_found":
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    case "stale":
      return c.json(
        {
          detail: {
            error: "stale_sha",
            message: "template was changed since you loaded it",
            current_sha256: result.currentSha,
          },
        },
        409,
      );
    case "too_large":
      return c.json(
        { detail: `template exceeds ${MAX_TEMPLATE_BYTES} bytes (got ${result.bytes})` },
        413,
      );
    case "missing_placeholders":
      return c.json(
        {
          detail: {
            error: "missing_placeholders",
            message: "template removed required placeholders",
            missing: result.missing,
          },
        },
        400,
      );
    case "unknown_includes":
      return c.json(
        {
          detail: {
            error: "unknown_includes",
            message: "template references partials that do not exist",
            unknown: result.unknown,
          },
        },
        400,
      );
    case "ok":
      invalidate();
      return c.json({
        template_id: templateId,
        voice,
        sha256: newSha,
        bytes: newBytes,
        version_id: versionId,
        saved_at: pgTimestampToIso(result.savedAt),
        saved_by: editor,
      });
  }
});

// ---------------------------------------------------------------------------
// POST /templates/:id/preview — render the assembled prompt for an unsaved draft.
//
// For a partial, `route` selects the consumer agent to preview against (the
// draft body is slotted into the consumer). For an agent prompt, `route` must
// equal the template_id and the submitted body is resolved directly.
// ---------------------------------------------------------------------------
promptsRouter.post("/templates/:id/preview", async (c) => {
  const templateId = c.req.param("id");
  const voice = resolveVoice(c);
  const body = await c.req
    .json<{ template?: unknown; route?: unknown; context?: unknown }>()
    .catch(() => null);
  if (body === null || typeof body.template !== "string") {
    return c.json({ detail: "template is required" }, 422);
  }
  const template = body.template;
  const route = typeof body.route === "string" ? body.route : null;
  const context: Record<string, string> =
    body.context !== null && typeof body.context === "object"
      ? (body.context as Record<string, string>)
      : {};

  return withDb(c.env, c.executionCtx, async (sql) => {
    const view = voiceView(await snapshot(sql), voice);
    const row = view.get(templateId);
    if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    }

    let assembled: string;
    let routeId: string;
    const unknownIncludesError = (e: PromptTemplateNotFound) =>
      c.json(
        {
          detail: {
            error: "unknown_includes",
            message: "template references partials that do not exist",
            detail: e.message,
          },
        },
        400,
      );

    if (row.category === "partial") {
      if (route === null) {
        return c.json({ detail: "route is required when previewing a partial" }, 400);
      }
      if (!agentIds(view).has(route)) {
        return c.json({ detail: `unknown route '${route}'` }, 400);
      }
      if (!partialsReferencedBy(route, view).has(templateId)) {
        return c.json(
          { detail: `route '${route}' does not include partial '${templateId}'` },
          400,
        );
      }
      routeId = route;
      try {
        assembled = assembleWithOverride(routeId, view, {
          overrideName: templateId,
          overrideBody: template,
        });
      } catch (e) {
        if (e instanceof PromptTemplateNotFound) return unknownIncludesError(e);
        throw e;
      }
    } else {
      routeId = route ?? templateId;
      if (routeId !== templateId) {
        return c.json({ detail: "route must equal template_id for agent prompts" }, 400);
      }
      try {
        assembled = resolveBody(template, view);
      } catch (e) {
        if (e instanceof PromptTemplateNotFound) return unknownIncludesError(e);
        throw e;
      }
    }

    const resolved = await substitutePreview(sql, assembled, context, view, voice);
    return c.json({ resolved, route: routeId, voice });
  });
});

// ---------------------------------------------------------------------------
// POST /templates/:id/revert — restore a past version's body, versioned as a
// kind='revert' row. Same optimistic-concurrency gate as PUT.
// ---------------------------------------------------------------------------
type RevertResult =
  | { kind: "ok"; savedAt: string | null; newSha: string; newBytes: number }
  | { kind: "not_found" }
  | { kind: "stale"; currentSha: string }
  | { kind: "unknown_version" }
  | { kind: "too_large" };

promptsRouter.post("/templates/:id/revert", async (c) => {
  const templateId = c.req.param("id");
  const voice = resolveVoice(c);
  const editor = resolveEditor(c);
  const body = await c.req
    .json<{ target_version_id?: unknown; expected_sha256?: unknown }>()
    .catch(() => null);
  if (
    body === null ||
    typeof body.target_version_id !== "string" ||
    typeof body.expected_sha256 !== "string" ||
    body.expected_sha256.length !== EXPECTED_SHA_LENGTH
  ) {
    return c.json(
      { detail: "target_version_id and a 64-char expected_sha256 are required" },
      422,
    );
  }
  const targetVersionId = body.target_version_id;
  const expectedSha = body.expected_sha256;
  const versionId = crypto.randomUUID();

  const result = await withDb(c.env, c.executionCtx, (sql) =>
    sql.begin(async (tx): Promise<RevertResult> => {
      const rows = await tx<Pick<PromptTemplateRow, "category" | "sha256">[]>`
        SELECT category, sha256 FROM content_tool.prompt_templates
        WHERE voice_slug = ${voice} AND template_id = ${templateId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
        return { kind: "not_found" };
      }
      const currentSha = row.sha256;
      if (currentSha !== expectedSha) {
        return { kind: "stale", currentSha };
      }

      const targetRows = await tx<{ body: string }[]>`
        SELECT body FROM content_tool.prompt_versions
        WHERE version_id = ${targetVersionId}
          AND voice_slug = ${voice}
          AND template_id = ${templateId}
        LIMIT 1
      `;
      const target = targetRows[0];
      if (target === undefined) {
        return { kind: "unknown_version" };
      }

      const newText = target.body;
      const newBytes = utf8ByteLength(newText);
      if (newBytes > MAX_TEMPLATE_BYTES) {
        return { kind: "too_large" };
      }
      const newSha = await sha256Hex(newText);

      await tx`
        UPDATE content_tool.prompt_templates
        SET body = ${newText}, sha256 = ${newSha}, bytes = ${newBytes},
            updated_by = ${editor}, updated_at = now()
        WHERE voice_slug = ${voice} AND template_id = ${templateId}
      `;
      const ins = await tx<{ saved_at: string }[]>`
        INSERT INTO content_tool.prompt_versions
          (version_id, voice_slug, template_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${versionId}, ${voice}, ${templateId}, ${newSha}, ${currentSha}, ${newText}, ${newBytes}, ${editor}, 'revert')
        RETURNING saved_at
      `;
      return { kind: "ok", savedAt: ins[0]?.saved_at ?? null, newSha, newBytes };
    }),
  );

  switch (result.kind) {
    case "not_found":
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    case "stale":
      return c.json(
        {
          detail: {
            error: "stale_sha",
            message: "template was changed since you loaded it",
            current_sha256: result.currentSha,
          },
        },
        409,
      );
    case "unknown_version":
      return c.json({ detail: `unknown version_id '${targetVersionId}'` }, 404);
    case "too_large":
      return c.json({ detail: `target version exceeds ${MAX_TEMPLATE_BYTES} bytes` }, 413);
    case "ok":
      invalidate();
      return c.json({
        template_id: templateId,
        voice,
        sha256: result.newSha,
        bytes: result.newBytes,
        version_id: versionId,
        saved_at: pgTimestampToIso(result.savedAt),
        saved_by: editor,
        reverted_from_version_id: targetVersionId,
      });
  }
});

export default promptsRouter;
