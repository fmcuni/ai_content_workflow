import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import {
  listPersonas,
  getPersonaBySlug,
  getPersonaUsage,
  createPersona,
  updatePersona,
  setArchived,
  PG_UNIQUE_VIOLATION,
  type CreatePersonaInput,
  type UpdatePersonaInput,
} from "../db/personas";

const personasRouter = new Hono<{ Bindings: Env }>();

// Request body shapes (mirror web/lib/types.ts PersonaIn / PersonaPatch and the
// Python PersonaIn / PersonaPatch Pydantic models).
type PersonaInBody = CreatePersonaInput;
type PersonaPatchBody = UpdatePersonaInput;

// Slug format enforced by the Python `PersonaIn` model
// (pattern ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$).
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** Narrow an unknown thrown value to a postgres error carrying a SQLSTATE code. */
function pgErrorCode(err: unknown): string | null {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

// GET /personas
// Returns a bare JSON array of personas ordered by created_at ASC.
// Query param `include_archived=true` includes archived rows; default excludes them.
personasRouter.get("/", async (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  // c.executionCtx from Hono has a compatible shape but a different TS type;
  // cast to the CF workers ExecutionContext that withDb expects.
  const ctx = c.executionCtx as ExecutionContext;
  const personas = await withDb(c.env, ctx, (sql) =>
    listPersonas(sql, includeArchived),
  );
  return c.json(personas);
});

// GET /personas/:slug/usage
// Per-status run counts for the persona, mirroring the Python PersonaUsage
// model: { slug, by_status, total }. 404 (persona not found) if the slug does
// not resolve — matching Python, which loads the persona first.
//
// Registered BEFORE /:slug so Hono's order-sensitive matcher does not let the
// /:slug catch-all shadow this more specific route.
personasRouter.get("/:slug/usage", async (c) => {
  const slug = c.req.param("slug");
  const ctx = c.executionCtx as ExecutionContext;
  const usage = await withDb(c.env, ctx, async (sql) => {
    const persona = await getPersonaBySlug(sql, slug);
    if (persona === null) {
      return null;
    }
    return getPersonaUsage(sql, slug);
  });
  if (usage === null) {
    return c.json({ detail: "persona not found" }, 404);
  }
  return c.json(usage);
});

// GET /personas/:slug
// Returns a single persona object, or 404 with FastAPI-compatible detail body.
personasRouter.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const ctx = c.executionCtx as ExecutionContext;
  const persona = await withDb(c.env, ctx, (sql) =>
    getPersonaBySlug(sql, slug),
  );
  if (persona === null) {
    return c.json({ detail: "persona not found" }, 404);
  }
  return c.json(persona);
});

// POST /personas — create a persona.
// 422 on a malformed slug/name (mirrors the Python PersonaIn validators);
// 409 when the slug already exists (DB unique violation); 201 on success.
personasRouter.post("/", async (c) => {
  const body = await c.req.json<PersonaInBody>().catch(() => null);
  if (body === null) {
    return c.json({ detail: "invalid JSON body" }, 422);
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!SLUG_RE.test(slug)) {
    return c.json({ detail: "slug must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$" }, 422);
  }
  if (name.length < 1 || name.length > 128) {
    return c.json({ detail: "name must be 1–128 characters" }, 422);
  }

  const input: CreatePersonaInput = {
    slug,
    name,
    voice_rules: Array.isArray(body.voice_rules) ? body.voice_rules : [],
    banned_terms: Array.isArray(body.banned_terms) ? body.banned_terms : [],
    required_phrasings: Array.isArray(body.required_phrasings) ? body.required_phrasings : [],
    disclaimer_templates:
      body.disclaimer_templates !== null && typeof body.disclaimer_templates === "object"
        ? body.disclaimer_templates
        : {},
    tone_examples:
      body.tone_examples !== null && typeof body.tone_examples === "object"
        ? body.tone_examples
        : {},
    glossary: Array.isArray(body.glossary) ? body.glossary : [],
  };

  const ctx = c.executionCtx as ExecutionContext;
  try {
    const persona = await withDb(c.env, ctx, (sql) => createPersona(sql, input));
    return c.json(persona, 201);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      return c.json({ detail: `slug '${slug}' already exists` }, 409);
    }
    throw err;
  }
});

// PUT /personas/:slug — partial update (only provided fields change).
// 404 when the slug does not resolve (mirrors the Python LookupError → 404).
personasRouter.put("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json<PersonaPatchBody>().catch(() => null);
  if (body === null) {
    return c.json({ detail: "invalid JSON body" }, 422);
  }

  // Mirror Pydantic's exclude_unset: only carry fields the caller supplied.
  const patch: UpdatePersonaInput = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (Array.isArray(body.voice_rules)) patch.voice_rules = body.voice_rules;
  if (Array.isArray(body.banned_terms)) patch.banned_terms = body.banned_terms;
  if (Array.isArray(body.required_phrasings)) patch.required_phrasings = body.required_phrasings;
  if (body.disclaimer_templates !== null && typeof body.disclaimer_templates === "object") {
    patch.disclaimer_templates = body.disclaimer_templates;
  }
  if (body.tone_examples !== null && typeof body.tone_examples === "object") {
    patch.tone_examples = body.tone_examples;
  }
  if (Array.isArray(body.glossary)) patch.glossary = body.glossary;

  const ctx = c.executionCtx as ExecutionContext;
  const persona = await withDb(c.env, ctx, (sql) => updatePersona(sql, slug, patch));
  if (persona === null) {
    return c.json({ detail: "persona not found" }, 404);
  }
  return c.json(persona);
});

// POST /personas/:slug/archive — soft-delete (is_archived = true).
personasRouter.post("/:slug/archive", async (c) => {
  const slug = c.req.param("slug");
  const ctx = c.executionCtx as ExecutionContext;
  const persona = await withDb(c.env, ctx, (sql) => setArchived(sql, slug, true));
  if (persona === null) {
    return c.json({ detail: "persona not found" }, 404);
  }
  return c.json(persona);
});

// POST /personas/:slug/restore — un-archive (is_archived = false).
personasRouter.post("/:slug/restore", async (c) => {
  const slug = c.req.param("slug");
  const ctx = c.executionCtx as ExecutionContext;
  const persona = await withDb(c.env, ctx, (sql) => setArchived(sql, slug, false));
  if (persona === null) {
    return c.json({ detail: "persona not found" }, 404);
  }
  return c.json(persona);
});

export { personasRouter };
export default personasRouter;
