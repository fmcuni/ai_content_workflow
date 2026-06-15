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
  countActivePersonas,
  duplicatePersona,
  PG_UNIQUE_VIOLATION,
  type CreatePersonaInput,
  type UpdatePersonaInput,
  type RawLocaleInput,
} from "../db/personas";
import { invalidate as invalidatePrompts } from "../prompts/store";
import { invalidate as invalidateSourcePolicy } from "../source_policy/store";

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

// HK-ZH defaults for the locale's snake_case raw shape — kept byte-identical to
// VoiceLocale's Python field defaults and `defaultVoiceLocale()` (agents/persona.ts).
const LOCALE_DEFAULTS: RawLocaleInput = {
  output_language: "香港繁體中文",
  brand_name: "Bowtie",
  market: "Google 香港繁中",
  sources_heading: null,
  faq_heading: "常見問題",
};

type LocaleParseResult =
  | { ok: true; value: RawLocaleInput }
  | { ok: false; detail: string };

/**
 * Validate + normalise an untrusted `locale` from a request body into the
 * snake_case `RawLocaleInput` stored verbatim in the JSONB column. Whole-object
 * replace: every field is filled from the raw input or the HK-ZH default. There
 * is no per-field enum to validate — every field is free text (the persona-block
 * label set is auto-derived from `output_language` at render time, not stored).
 */
function parseLocale(raw: unknown): LocaleParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "locale must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  return {
    ok: true,
    value: {
      output_language: str(r.output_language, LOCALE_DEFAULTS.output_language),
      brand_name: str(r.brand_name, LOCALE_DEFAULTS.brand_name),
      market: str(r.market, LOCALE_DEFAULTS.market),
      sources_heading:
        r.sources_heading === null || r.sources_heading === undefined
          ? null
          : str(r.sources_heading, ""),
      faq_heading: str(r.faq_heading, LOCALE_DEFAULTS.faq_heading),
    },
  };
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

  // locale is optional on create; when present it is validated + normalised to
  // the snake_case raw shape, else HK-ZH defaults are stored (byte-identical
  // no-op). A non-object locale → 422.
  const localeRaw = (body as { locale?: unknown }).locale;
  let locale: RawLocaleInput = LOCALE_DEFAULTS;
  if (localeRaw !== undefined) {
    const parsed = parseLocale(localeRaw);
    if (!parsed.ok) {
      return c.json({ detail: parsed.detail }, 422);
    }
    locale = parsed.value;
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
    locale,
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

// POST /personas/:slug/duplicate — create a new voice as a deep copy of :slug.
// Clones the persona row + the source voice's resolved agent/partial prompt
// templates + source policy (with seeded history rows) under the new slug, all
// in one transaction. 404 if the source voice is unknown; 409 if the target
// slug already exists. The prompt + policy caches are busted so the new voice's
// rows are immediately visible to /prompts and /source-policy.
//
// Registered BEFORE /:slug so Hono's matcher does not let a catch-all shadow it.
personasRouter.post("/:slug/duplicate", async (c) => {
  const sourceSlug = c.req.param("slug");
  const body = await c.req.json<{ slug?: unknown; name?: unknown }>().catch(() => null);
  if (body === null || typeof body.slug !== "string" || typeof body.name !== "string") {
    return c.json({ detail: "slug and name are required" }, 422);
  }
  const newSlug = body.slug;
  const newName = body.name;
  const ctx = c.executionCtx as ExecutionContext;
  try {
    const result = await withDb(c.env, ctx, (sql) =>
      duplicatePersona(sql, sourceSlug, newSlug, newName),
    );
    if (result.kind === "source_not_found") {
      return c.json({ detail: `persona '${sourceSlug}' not found` }, 404);
    }
    if (result.kind === "dup_slug") {
      return c.json({ detail: `slug '${newSlug}' already exists` }, 409);
    }
    invalidatePrompts();
    invalidateSourcePolicy();
    return c.json(result.record, 201);
  } catch (err) {
    // Race: the target slug was inserted between the pre-check and our INSERT.
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      return c.json({ detail: `slug '${newSlug}' already exists` }, 409);
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
  // Whole-object replace: present → validate + normalise to snake_case raw and
  // overwrite; absent → column untouched. A non-object locale → 422.
  if ("locale" in body) {
    const parsed = parseLocale((body as { locale?: unknown }).locale);
    if (!parsed.ok) {
      return c.json({ detail: parsed.detail }, 422);
    }
    patch.locale = parsed.value;
  }
  // Clearable: present-with-uuid assigns the target, present-with-null resets
  // to the default; absent preserves. Mirrors the Python exclude_unset path.
  if ("publish_target_id" in body) {
    patch.publish_target_id =
      typeof body.publish_target_id === "string" ? body.publish_target_id : null;
  }

  const ctx = c.executionCtx as ExecutionContext;
  const persona = await withDb(c.env, ctx, (sql) => updatePersona(sql, slug, patch));
  if (persona === null) {
    return c.json({ detail: "persona not found" }, 404);
  }
  return c.json(persona);
});

// POST /personas/:slug/archive — soft-delete (is_archived = true).
//
// 409 if it is the last non-archived voice — the app must always keep at least
// one usable voice. Archiving an already-archived voice is a no-op and skips the
// guard. Mirrors content_tool/api/routes/personas.py::archive_.
personasRouter.post("/:slug/archive", async (c) => {
  const slug = c.req.param("slug");
  const ctx = c.executionCtx as ExecutionContext;
  const result = await withDb(c.env, ctx, async (sql) => {
    const current = await getPersonaBySlug(sql, slug);
    if (current === null) return { kind: "not_found" as const };
    if (!current.is_archived && (await countActivePersonas(sql)) <= 1) {
      return { kind: "last_voice" as const };
    }
    const updated = await setArchived(sql, slug, true);
    if (updated === null) return { kind: "not_found" as const };
    return { kind: "ok" as const, persona: updated };
  });
  if (result.kind === "not_found") {
    return c.json({ detail: "persona not found" }, 404);
  }
  if (result.kind === "last_voice") {
    return c.json({ detail: "cannot archive the last remaining voice" }, 409);
  }
  return c.json(result.persona);
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
