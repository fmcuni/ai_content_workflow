import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { resolvePublishTarget, buildTargetEnv } from "../publishers/wp_factory";
import { WordPressClient } from "../wordpress/client";
import { GhostPublisher, buildGhostCreds } from "../publishers/ghost";

// Kind-aware image upload for the HITL_2 metadata form. Proxies a multipart
// file to the run's resolved CMS — WordPress (/wp/v2/media → numeric id +
// source_url) or Ghost (/images/upload/ → hosted URL) — using the target's
// credentials read inside the Worker (never exposed to the browser). The form
// stores the result (WP: wp_featured_media_id; Ghost: feature_image_url).
// Gated to author+ in index.ts (it writes to the CMS media library).
const mediaRouter = new Hono<{ Bindings: Env }>();

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// POST /media/upload?run_id=&persona=  (multipart form field: file)
mediaRouter.post("/upload", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ detail: "expected multipart/form-data with a 'file' field" }, 422);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ detail: "field 'file' (a file upload) is required" }, 422);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ detail: "file exceeds the 15MB upload limit" }, 413);
  }

  const runId = c.req.query("run_id");
  const persona = c.req.query("persona");
  const ctx = c.executionCtx as ExecutionContext;
  const target = await withDb(c.env, ctx, async (sql) => {
    let slug = persona;
    if (!slug && runId !== undefined && runId !== "") {
      const rows = await sql<{ persona: string | null }[]>`
        SELECT persona FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
      `;
      slug = rows[0]?.persona ?? undefined;
    }
    return resolvePublishTarget(sql, slug ?? "", c.env.WP_TARGET ?? "");
  });

  try {
    if (target.kind === "ghost") {
      const creds = buildGhostCreds(
        c.env as unknown as Record<string, string | undefined>,
        target.authRef,
      );
      const url = await new GhostPublisher(creds).uploadImage(file);
      return c.json({ kind: "ghost", id: null, url });
    }
    const targetEnv = buildTargetEnv(c.env, target);
    const media = await new WordPressClient(targetEnv).uploadMedia(file);
    return c.json({ kind: "wordpress", id: media.id, url: media.source_url });
  } catch (e) {
    return c.json({ detail: e instanceof Error ? e.message : "upload failed" }, 502);
  }
});

export { mediaRouter };
export default mediaRouter;
