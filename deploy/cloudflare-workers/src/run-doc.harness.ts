// Minimal worker entry for the RunDoc workers-pool tests (vitest.workers.config.ts).
// Routes `GET /runs/:id/doc` (WebSocket upgrade) to the per-run RunDoc DO.
// NOT a production entry — the real app exports RunDoc from src/index.ts (Phase 1).
import { RunDoc, type RunDocEnv } from "./run-doc";

export { RunDoc };

export default {
  async fetch(request: Request, env: RunDocEnv): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/runs\/([^/]+)\/doc$/);
    if (!match) return new Response("not found", { status: 404 });
    const stub = env.RUN_DOC.get(env.RUN_DOC.idFromName(match[1]!));
    return stub.fetch(request);
  },
};
