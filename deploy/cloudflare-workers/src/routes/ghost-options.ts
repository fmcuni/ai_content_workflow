import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { getPublishTargetForVoice } from "../db/publish_targets";
import { GhostPublisher, buildGhostCreds } from "../publishers/ghost";
import type { GhostAuthorOption, GhostTagOption } from "../publishers/ghost";

// Live author/tag option lists for the HITL_2 metadata pickers when a run
// targets a Ghost CMS. Mirrors /wp-options (run_id|persona → publish target →
// auth_ref) but resolves Ghost creds and calls the Ghost Admin API directly
// rather than reading synced WordPress tables. Like /wp-options, this is not
// admin-gated — any authenticated editor may read the option lists. Credential
// VALUES never leave the Worker; only ids/names/slugs are returned. Anything
// that fails to resolve (non-ghost target, unprovisioned creds, Ghost error)
// degrades to an empty list so the picker renders without throwing.
const ghostOptionsRouter = new Hono<{ Bindings: Env }>();

/** Resolve a run/persona to a Ghost publisher, or null when not a ghost target
 *  / creds are unprovisioned. */
async function ghostPublisherFor(
  env: Env,
  ctx: ExecutionContext,
  runId?: string,
  persona?: string,
): Promise<GhostPublisher | null> {
  const authRef = await withDb(env, ctx, async (sql) => {
    let slug = persona;
    if (!slug && runId !== undefined && runId !== "") {
      const rows = await sql<{ persona: string | null }[]>`
        SELECT persona FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
      `;
      slug = rows[0]?.persona ?? undefined;
    }
    if (slug === undefined || slug === "") return null;
    const target = await getPublishTargetForVoice(sql, slug);
    if (target === null || target.kind !== "ghost") {
      console.warn(
        `[ghost-options] no ghost target for slug=${slug}: target=${target === null ? "null" : `kind=${target.kind} ref=${target.auth_ref}`}`,
      );
      return null;
    }
    return target.auth_ref;
  });
  if (authRef === null) return null;
  try {
    const creds = buildGhostCreds(env as unknown as Record<string, string | undefined>, authRef);
    return new GhostPublisher(creds);
  } catch (e) {
    // Creds not provisioned for this target — the readiness badge surfaces this.
    console.warn(`[ghost-options] creds unresolved for ref=${authRef}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Case-insensitive substring filter, mirroring /wp-options `?q=`. */
function matchesQuery(haystack: string, q?: string): boolean {
  if (q === undefined || q === "") return true;
  return haystack.toLowerCase().includes(q.toLowerCase());
}

// GET /ghost-options/authors?q=&run_id=&persona=
ghostOptionsRouter.get("/authors", async (c) => {
  const ctx = c.executionCtx as ExecutionContext;
  const pub = await ghostPublisherFor(c.env, ctx, c.req.query("run_id"), c.req.query("persona"));
  if (pub === null) return c.json<GhostAuthorOption[]>([]);
  const q = c.req.query("q");
  try {
    const authors = await pub.listAuthors();
    return c.json(authors.filter((a) => matchesQuery(a.name, q) || matchesQuery(a.slug, q)));
  } catch (e) {
    // A genuine Ghost Admin API failure must not masquerade as "no authors"
    // (200 []) — that hid the misconfiguration. Surface it so the picker can
    // show an error + retry instead of an empty, silently-wrong list.
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[ghost-options] listAuthors failed: ${detail}`);
    return c.json({ detail }, 502);
  }
});

// GET /ghost-options/tags?q=&run_id=&persona=
ghostOptionsRouter.get("/tags", async (c) => {
  const ctx = c.executionCtx as ExecutionContext;
  const pub = await ghostPublisherFor(c.env, ctx, c.req.query("run_id"), c.req.query("persona"));
  if (pub === null) return c.json<GhostTagOption[]>([]);
  const q = c.req.query("q");
  try {
    const tags = await pub.listTags();
    return c.json(tags.filter((t) => matchesQuery(t.name, q) || matchesQuery(t.slug, q)));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[ghost-options] listTags failed: ${detail}`);
    return c.json({ detail }, 502);
  }
});

export { ghostOptionsRouter };
export default ghostOptionsRouter;
