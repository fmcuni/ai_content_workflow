# Plan 4 — Next.js UI Implementation Plan

**Prereq:** Plans 1, 2, 3 shipped — full backend runnable via API.

**Goal:** Build a Next.js (App Router, TypeScript) UI under `web/` that talks to the FastAPI backend. Pages: trigger form, run list, run detail with live SSE, HITL_1 (gap analysis + outline edit), HITL_2 (TipTap, diff view, WP metadata form, FAQ editor). Tailwind + shadcn/ui for components.

**Architecture:** Next.js sits in a sibling directory `web/`, runs on port 3000, talks to FastAPI on port 8000 via Next's API proxy (`/api/*` rewrites). All state for an in-flight run comes from SSE + REST polls; no shared state library, just React Query for fetches and an SSE hook.

**Tech Stack:**
- Next.js 15 + React 19 + TypeScript
- Tailwind CSS + shadcn/ui
- TanStack Query (`@tanstack/react-query`) for REST
- `@microsoft/fetch-event-source` for SSE
- TipTap for rich editor
- `diff` package for HTML diff

---

## File structure

```
web/
├── package.json
├── tsconfig.json
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
├── components.json                                # shadcn config
├── .env.local.example
├── app/
│   ├── layout.tsx
│   ├── globals.css
│   ├── page.tsx                                   # Run list (home)
│   ├── runs/
│   │   ├── new/page.tsx                           # Trigger form
│   │   └── [runId]/
│   │       ├── page.tsx                           # Run detail
│   │       ├── hitl1/page.tsx                     # Gap + outline review
│   │       └── hitl2/page.tsx                     # Final editor + WP form
│   └── api/
│       └── proxy/                                  # (used by next.config.mjs rewrite)
├── components/
│   ├── ui/                                         # shadcn-generated
│   ├── RunStatusBadge.tsx
│   ├── EventTimeline.tsx
│   ├── OutlineEditor.tsx
│   ├── GapAnalysisView.tsx
│   ├── HtmlDiffView.tsx
│   ├── CostMeter.tsx
│   ├── FaqEditor.tsx
│   ├── TipTapEditor.tsx
│   └── WordPressMetaForm.tsx
├── lib/
│   ├── api.ts                                      # fetch wrapper + types
│   ├── sse.ts                                      # SSE hook
│   ├── types.ts                                    # mirrors backend Pydantic
│   └── utils.ts
└── tests/
    └── e2e/                                        # Playwright (basic happy-path)
        └── run-creation.spec.ts
```

Backend changes also needed:
- CORS for `localhost:3000` in `content_tool/api/main.py`
- `GET /runs` list endpoint
- `GET /runs/{id}/gap-analysis`, `/runs/{id}/outline`, `/runs/{id}/drafts/latest`, `/runs/{id}/render` for HITL pages

---

### Task 1: Next.js scaffolding + Tailwind + shadcn

**Files:** Initialize `web/` directory.

- [ ] **Step 1: Create Next.js app**

```bash
cd /Users/franco.ma/Documents/App/ai_content_tool_2
npx create-next-app@latest web --typescript --tailwind --app --eslint --src-dir=false --import-alias='@/*' --no-turbopack
cd web
```

- [ ] **Step 2: Install runtime deps**

```bash
npm i @tanstack/react-query @microsoft/fetch-event-source diff @tiptap/react @tiptap/starter-kit @tiptap/extension-link clsx lucide-react
npm i -D @types/diff @playwright/test
```

- [ ] **Step 3: Init shadcn/ui**

```bash
npx shadcn@latest init -d
npx shadcn@latest add button input textarea form card badge dialog dropdown-menu select tabs label switch toast
```

- [ ] **Step 4: Configure `next.config.mjs` API proxy + `.env.local.example`**

`web/next.config.mjs`:
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/runs/:path*", destination: `${process.env.NEXT_PUBLIC_API_BASE}/runs/:path*` },
      { source: "/api/health", destination: `${process.env.NEXT_PUBLIC_API_BASE}/health` },
    ];
  },
};
export default nextConfig;
```

`web/.env.local.example`:
```
NEXT_PUBLIC_API_BASE=http://localhost:8000
NEXT_PUBLIC_DEFAULT_EDITOR_EMAIL=editor@bowtie.local
```

- [ ] **Step 5: Smoke test**

```bash
cp .env.local.example .env.local
npm run dev
# In another shell: curl http://localhost:3000 → 200
```

- [ ] **Step 6: Commit**

```bash
cd /Users/franco.ma/Documents/App/ai_content_tool_2
git add web/
git commit -m "feat(web): Next.js + Tailwind + shadcn scaffolding"
```

---

### Task 2: Backend CORS + list endpoint

**Files:**
- Modify: `content_tool/api/main.py`
- Modify: `content_tool/api/routes/runs.py`

- [ ] **Step 1: Add CORS to `content_tool/api/main.py`**

Replace `create_app` body's middleware section:

```python
from fastapi.middleware.cors import CORSMiddleware


def create_app() -> FastAPI:
    app = FastAPI(title="Bowtie AI Content Tool", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(runs_router)
    return app
```

- [ ] **Step 2: Add `GET /runs` list + detail-resource endpoints to `content_tool/api/routes/runs.py`**

```python
from typing import Optional


@router.get("")
async def list_runs(
    sf=Depends(get_session_factory),
    status: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    async with sf() as session:
        q = select(Run).order_by(Run.created_at.desc()).limit(limit)
        if status:
            q = q.where(Run.status == status)
        rows = (await session.execute(q)).scalars().all()
        return [
            {"run_id": str(r.run_id), "status": r.status, "topic": r.topic,
             "article_url": r.article_url, "mode": r.mode, "created_at": r.created_at.isoformat(),
             "chosen_route": r.chosen_route, "iteration_count": r.iteration_count}
            for r in rows
        ]


@router.get("/{run_id}/gap-analysis")
async def get_gap_analysis(run_id: UUID, sf=Depends(get_session_factory)) -> dict:
    from content_tool.db.models import GapAnalysisRow
    async with sf() as session:
        row = (await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return row.payload


@router.get("/{run_id}/outline")
async def get_outline(run_id: UUID, sf=Depends(get_session_factory)) -> dict:
    from content_tool.db.models import OutlineRow
    async with sf() as session:
        row = (await session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return {"payload": row.payload, "edited_by_human": row.edited_by_human}


@router.get("/{run_id}/drafts/latest")
async def get_latest_draft(run_id: UUID, sf=Depends(get_session_factory)) -> dict:
    from content_tool.db.models import Draft
    async with sf() as session:
        row = (await session.execute(
            select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        )).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return {
            "draft_id": str(row.draft_id), "iteration": row.iteration,
            "diagnose": row.diagnose, "markup_raw": row.markup_raw,
            "final_markup": row.final_markup,
        }


@router.get("/{run_id}/render")
async def get_latest_render(run_id: UUID, sf=Depends(get_session_factory)) -> dict:
    from content_tool.db.models import Draft, Render
    async with sf() as session:
        latest_draft = (await session.execute(
            select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        )).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(404, "no draft")
        render = (await session.execute(
            select(Render).where(Render.draft_id == latest_draft.draft_id)
        )).scalar_one_or_none()
        if not render:
            raise HTTPException(404, "no render")
        return {
            "seo_title": render.seo_title, "meta_description": render.meta_description,
            "html_body": render.html_body, "faq_schema_jsonld": render.faq_schema_jsonld,
            "excerpt_suggestion": render.excerpt_suggestion,
            "slug_suggestion": render.slug_suggestion,
        }


@router.get("/{run_id}/audit")
async def get_latest_audit(run_id: UUID, sf=Depends(get_session_factory)) -> dict:
    from content_tool.db.models import AuditRun, Draft
    async with sf() as session:
        latest_draft = (await session.execute(
            select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        )).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(404, "no draft")
        audit = (await session.execute(
            select(AuditRun).where(AuditRun.draft_id == latest_draft.draft_id)
        )).scalar_one_or_none()
        if not audit:
            raise HTTPException(404, "no audit")
        return {
            "overall_pass": audit.overall_pass,
            "severity_high": audit.severity_high,
            "severity_medium": audit.severity_medium,
            "severity_low": audit.severity_low,
            "llm_findings": audit.llm_findings,
            "deterministic_findings": audit.deterministic_findings,
        }
```

- [ ] **Step 3: Commit**

```bash
git add content_tool/api/main.py content_tool/api/routes/runs.py
git commit -m "feat(api): CORS + list runs + per-resource HITL endpoints"
```

---

### Task 3: TypeScript types + API client

**Files:** `web/lib/types.ts`, `web/lib/api.ts`

- [ ] **Step 1: Create `web/lib/types.ts`**

```typescript
export type RunStatus =
  | "pending" | "fetching" | "strategy" | "hitl_1"
  | "production" | "hitl_2" | "persisted" | "failed"
  | "cancelled" | "rejected" | "changes_requested";

export type Mode = "auto" | "small_refresh" | "full_rewrite";
export type Route = "small_refresh" | "full_rewrite";

export interface RunSummary {
  run_id: string;
  status: RunStatus;
  topic: string;
  article_url: string;
  mode: Mode;
  created_at: string;
  chosen_route: Route | null;
  iteration_count: number;
}

export interface CreateRunRequest {
  article_url: string;
  topic: string;
  keywords: string[];
  mode: Mode;
  edit_note?: string | null;
  acf_adv_id: number;
  acf_widget_id: number;
  persona: string;
  topic_category?: string | null;
  editor_email: string;
}

export interface GapAnalysis {
  target_query: string;
  top_pages: { url: string; title: string; rank: number }[];
  current_article_assessment: {
    strengths: string[];
    outdated_points: string[];
    weak_sections: string[];
    structure_status: "still_competitive" | "partly_outdated" | "outdated";
  };
  content_gaps: {
    missing_topics: string[];
    missing_intents: string[];
    freshness_gaps: string[];
    semantic_gaps: string[];
    source_trust_gaps: string[];
    ai_extractability_gaps: string[];
    hk_localization_gaps: string[];
    faq_gaps: string[];
  };
  recommended_outline: string;
  update_plan: {
    must_add: string[]; must_update: string[]; must_remove: string[];
    must_reorder: string[]; faq_to_add: string[]; facts_to_verify: string[];
  };
  chosen_route: Route;
  route_reason: string;
}

export interface OutlineSection {
  heading_level: 2 | 3;
  heading_text: string;
  action: "keep" | "update" | "add" | "remove" | "reorder";
  intent: string;
  key_points: string[];
  format_hint: "paragraph" | "bullet" | "numbered" | "table";
  source_note: string | null;
}

export interface Outline {
  h1: string;
  meta_description_hint: string;
  sections: OutlineSection[];
  faq_section: { question: string; answer_intent: string; action: "keep" | "update" | "add" | "remove" }[];
  shortcode_positions: { adv_panel_after_section_index: number; page_widget_before: "faq" };
}

export interface Render {
  seo_title: string;
  meta_description: string;
  html_body: string;
  faq_schema_jsonld: Record<string, unknown> | null;
  excerpt_suggestion: string;
  slug_suggestion: string;
}

export interface AuditFinding {
  id: string;
  category: "format" | "compliance" | "voice" | "coverage" | "safety" | "citation";
  severity: "high" | "medium" | "low";
  location: string;
  issue: string;
  suggested_fix: string;
  must_fix: boolean;
}

export interface Audit {
  overall_pass: boolean;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  llm_findings: { findings: AuditFinding[] };
  deterministic_findings: { findings: AuditFinding[] };
}

export interface SseEvent {
  event: string;
  run_id: string;
  iteration?: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface Hitl2Request {
  decision: "approve" | "request_changes" | "reject";
  notes?: string | null;
  edited_html_body?: string | null;
  edited_seo_title?: string | null;
  edited_meta_description?: string | null;
  wp_publish_status: "draft" | "future" | "publish";
  wp_author_id?: number | null;
  wp_category_ids?: number[] | null;
  wp_tag_ids?: number[] | null;
  wp_featured_media_id?: number | null;
  wp_slug?: string | null;
  wp_excerpt?: string | null;
  wp_publish_at?: string | null;
}
```

- [ ] **Step 2: Create `web/lib/api.ts`**

```typescript
import type {
  Audit, CreateRunRequest, GapAnalysis, Hitl2Request, Outline, Render, RunSummary,
} from "./types";

const BASE = "/api/runs";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

export const api = {
  listRuns: (status?: string) =>
    http<RunSummary[]>(`${BASE}${status ? `?status=${status}` : ""}`),
  getRun: (runId: string) => http<RunSummary>(`${BASE}/${runId}`),
  createRun: (req: CreateRunRequest) =>
    http<{ run_id: string; status: string }>(BASE, { method: "POST", body: JSON.stringify(req) }),
  getGapAnalysis: (runId: string) => http<GapAnalysis>(`${BASE}/${runId}/gap-analysis`),
  getOutline: (runId: string) =>
    http<{ payload: Outline; edited_by_human: boolean }>(`${BASE}/${runId}/outline`),
  getLatestRender: (runId: string) => http<Render>(`${BASE}/${runId}/render`),
  getLatestAudit: (runId: string) => http<Audit>(`${BASE}/${runId}/audit`),
  resumeHitl1: (
    runId: string,
    body: { decision: "approve" | "edit_outline" | "override_route" | "cancel";
            edited_outline?: Outline; new_route?: "small_refresh" | "full_rewrite"; notes?: string },
  ) => http(`${BASE}/${runId}/resume`, { method: "POST", body: JSON.stringify(body) }),
  resumeHitl2: (runId: string, body: Hitl2Request) =>
    http(`${BASE}/${runId}/hitl-2`, { method: "POST", body: JSON.stringify(body) }),
};
```

- [ ] **Step 3: Commit**

```bash
cd web && cd .. && git add web/lib/
git commit -m "feat(web): types + api client"
```

---

### Task 4: SSE hook

**Files:** `web/lib/sse.ts`

- [ ] **Step 1: Create `web/lib/sse.ts`**

```typescript
"use client";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useEffect, useRef, useState } from "react";

import type { SseEvent } from "./types";

export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) return;
    ctrl.current = new AbortController();
    fetchEventSource(`/api/runs/${runId}/events`, {
      signal: ctrl.current.signal,
      onmessage(ev) {
        try {
          const parsed: SseEvent = JSON.parse(ev.data);
          setEvents((prev) => [...prev, parsed]);
        } catch {
          // ignore malformed events
        }
      },
      onerror(err) {
        console.warn("SSE error", err);
        throw err; // back off and retry
      },
    });
    return () => ctrl.current?.abort();
  }, [runId]);

  return events;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/sse.ts && git commit -m "feat(web): SSE hook"
```

---

### Task 5: Run list page (home)

**Files:** `web/app/page.tsx`, `web/app/layout.tsx`, `web/components/RunStatusBadge.tsx`

- [ ] **Step 1: Update `web/app/layout.tsx`** to wrap with QueryClientProvider

```typescript
import "./globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-neutral-50 min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

"use client";
function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
```

(Note: `"use client"` must precede the Providers component. Split into `web/app/providers.tsx` if needed.)

- [ ] **Step 2: Create `web/components/RunStatusBadge.tsx`**

```typescript
import { Badge } from "@/components/ui/badge";

import type { RunStatus } from "@/lib/types";

const COLORS: Record<RunStatus, string> = {
  pending: "bg-neutral-200 text-neutral-800",
  fetching: "bg-blue-100 text-blue-800",
  strategy: "bg-blue-100 text-blue-800",
  hitl_1: "bg-amber-100 text-amber-800",
  production: "bg-indigo-100 text-indigo-800",
  hitl_2: "bg-amber-100 text-amber-800",
  persisted: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  cancelled: "bg-neutral-200 text-neutral-600",
  rejected: "bg-rose-100 text-rose-800",
  changes_requested: "bg-amber-100 text-amber-800",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge className={COLORS[status]}>{status}</Badge>;
}
```

- [ ] **Step 3: Create `web/app/page.tsx`**

```typescript
"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { api } from "@/lib/api";

export default function Home() {
  const { data, isLoading } = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns() });

  return (
    <div className="max-w-5xl mx-auto p-8">
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Bowtie AI Content Tool</h1>
        <Link href="/runs/new"><Button>New article update</Button></Link>
      </header>
      <Card className="divide-y">
        {isLoading && <p className="p-4">Loading…</p>}
        {data?.map((r) => (
          <Link key={r.run_id} href={`/runs/${r.run_id}`}
                className="p-4 flex justify-between hover:bg-neutral-50">
            <div>
              <p className="font-medium">{r.topic}</p>
              <p className="text-sm text-neutral-500">{r.article_url}</p>
            </div>
            <div className="flex items-center gap-3">
              <RunStatusBadge status={r.status} />
              <span className="text-xs text-neutral-500">{new Date(r.created_at).toLocaleString()}</span>
            </div>
          </Link>
        ))}
        {data?.length === 0 && <p className="p-4 text-neutral-500">No runs yet.</p>}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web/app/page.tsx web/app/layout.tsx web/components/RunStatusBadge.tsx
git commit -m "feat(web): run list home page"
```

---

### Task 6: Trigger form page

**Files:** `web/app/runs/new/page.tsx`

- [ ] **Step 1: Create the page**

```typescript
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { CreateRunRequest } from "@/lib/types";

export default function NewRunPage() {
  const router = useRouter();
  const [form, setForm] = useState<CreateRunRequest>({
    article_url: "", topic: "", keywords: [],
    mode: "auto", edit_note: null,
    acf_adv_id: 1, acf_widget_id: 1,
    persona: "bowtie-editor", topic_category: null,
    editor_email: process.env.NEXT_PUBLIC_DEFAULT_EDITOR_EMAIL ?? "",
  });
  const [keywordsRaw, setKeywordsRaw] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.createRun({ ...form, keywords: keywordsRaw.split(",").map(s => s.trim()).filter(Boolean) }),
    onSuccess: (r) => router.push(`/runs/${r.run_id}`),
  });

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-xl font-semibold mb-4">New article update</h1>
      <Card className="p-6 space-y-4">
        <div>
          <Label>Article URL</Label>
          <Input value={form.article_url} onChange={(e) => setForm({ ...form, article_url: e.target.value })}
                 placeholder="https://www.bowtie.com.hk/blog/zh/..." />
        </div>
        <div>
          <Label>Topic</Label>
          <Input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} />
        </div>
        <div>
          <Label>Focus keywords (comma-separated)</Label>
          <Input value={keywordsRaw} onChange={(e) => setKeywordsRaw(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Mode</Label>
            <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as CreateRunRequest["mode"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="small_refresh">Small refresh</SelectItem>
                <SelectItem value="full_rewrite">Full rewrite</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Persona</Label>
            <Input value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>acf_adv_id</Label>
            <Input type="number" value={form.acf_adv_id}
                   onChange={(e) => setForm({ ...form, acf_adv_id: parseInt(e.target.value || "0", 10) })} />
          </div>
          <div>
            <Label>acf_widget_id</Label>
            <Input type="number" value={form.acf_widget_id}
                   onChange={(e) => setForm({ ...form, acf_widget_id: parseInt(e.target.value || "0", 10) })} />
          </div>
        </div>
        <div>
          <Label>Topic category (optional, for community sources)</Label>
          <Input value={form.topic_category ?? ""} onChange={(e) => setForm({ ...form, topic_category: e.target.value || null })}
                 placeholder="community-response / patient-experience / social-discussion" />
        </div>
        <div>
          <Label>Edit note (optional)</Label>
          <Textarea value={form.edit_note ?? ""} onChange={(e) => setForm({ ...form, edit_note: e.target.value || null })} />
        </div>
        <div>
          <Label>Editor email</Label>
          <Input value={form.editor_email} onChange={(e) => setForm({ ...form, editor_email: e.target.value })} />
        </div>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Start run"}
        </Button>
        {mutation.isError && <p className="text-rose-600">{(mutation.error as Error).message}</p>}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/runs/new/page.tsx
git commit -m "feat(web): trigger form page"
```

---

### Task 7: Run detail page with live SSE timeline

**Files:** `web/app/runs/[runId]/page.tsx`, `web/components/EventTimeline.tsx`

- [ ] **Step 1: Create `web/components/EventTimeline.tsx`**

```typescript
import type { SseEvent } from "@/lib/types";

export function EventTimeline({ events }: { events: SseEvent[] }) {
  return (
    <ol className="space-y-2 border-l-2 border-neutral-200 pl-4">
      {events.map((e, i) => (
        <li key={i} className="text-sm">
          <span className="text-neutral-500 mr-2">{new Date(e.timestamp).toLocaleTimeString()}</span>
          <span className="font-mono">{e.event}</span>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: Create `web/app/runs/[runId]/page.tsx`**

```typescript
"use client";
import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { EventTimeline } from "@/components/EventTimeline";
import { useRunEvents } from "@/lib/sse";
import { api } from "@/lib/api";

export default function RunDetail({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const { data: run } = useQuery({
    queryKey: ["run", runId], queryFn: () => api.getRun(runId),
    refetchInterval: 3000,
  });
  const events = useRunEvents(runId);

  return (
    <div className="max-w-4xl mx-auto p-8">
      <Link href="/" className="text-sm text-neutral-500">← All runs</Link>
      <h1 className="text-xl font-semibold mt-2 mb-1">{run?.topic ?? "…"}</h1>
      <p className="text-neutral-500 text-sm">{run?.article_url}</p>
      <div className="flex gap-3 mt-3 mb-6">
        {run && <RunStatusBadge status={run.status} />}
        {run?.chosen_route && <span className="text-sm">Route: <b>{run.chosen_route}</b></span>}
        {run && <span className="text-sm">Iteration: {run.iteration_count}</span>}
      </div>
      <div className="grid grid-cols-2 gap-6">
        <Card className="p-4">
          <h2 className="font-medium mb-3">Live progress</h2>
          <EventTimeline events={events} />
        </Card>
        <Card className="p-4">
          <h2 className="font-medium mb-3">Actions</h2>
          {run?.status === "hitl_1" && (
            <Link href={`/runs/${runId}/hitl1`}><Button>Review gap analysis + outline</Button></Link>
          )}
          {run?.status === "hitl_2" && (
            <Link href={`/runs/${runId}/hitl2`}><Button>Review final draft</Button></Link>
          )}
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/runs/[runId]/page.tsx web/components/EventTimeline.tsx
git commit -m "feat(web): run detail page with SSE timeline"
```

---

### Task 8: HITL_1 page (gap analysis + outline editor)

**Files:** `web/app/runs/[runId]/hitl1/page.tsx`, `web/components/GapAnalysisView.tsx`, `web/components/OutlineEditor.tsx`

- [ ] **Step 1: Create `web/components/GapAnalysisView.tsx`**

```typescript
import type { GapAnalysis } from "@/lib/types";

export function GapAnalysisView({ ga }: { ga: GapAnalysis }) {
  return (
    <div className="space-y-4 text-sm">
      <section>
        <h3 className="font-medium mb-1">Target query</h3>
        <p>{ga.target_query}</p>
      </section>
      <section>
        <h3 className="font-medium mb-1">Top pages</h3>
        <ol className="list-decimal pl-5 space-y-0.5">
          {ga.top_pages.map((p) => (
            <li key={p.url}><a href={p.url} target="_blank" className="text-blue-700 underline">{p.title}</a></li>
          ))}
        </ol>
      </section>
      <section>
        <h3 className="font-medium mb-1">Chosen route: {ga.chosen_route}</h3>
        <p className="text-neutral-600">{ga.route_reason}</p>
      </section>
      <section>
        <h3 className="font-medium mb-1">Update plan</h3>
        <ul className="space-y-1">
          <li><b>must_add:</b> {ga.update_plan.must_add.join("; ") || "—"}</li>
          <li><b>must_update:</b> {ga.update_plan.must_update.join("; ") || "—"}</li>
          <li><b>must_remove:</b> {ga.update_plan.must_remove.join("; ") || "—"}</li>
          <li><b>faq_to_add:</b> {ga.update_plan.faq_to_add.join("; ") || "—"}</li>
          <li><b>facts_to_verify:</b> {ga.update_plan.facts_to_verify.join("; ") || "—"}</li>
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Create `web/components/OutlineEditor.tsx`**

```typescript
"use client";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import type { Outline } from "@/lib/types";

export function OutlineEditor({
  outline, onChange,
}: { outline: Outline; onChange: (o: Outline) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <label className="text-xs text-neutral-500">H1</label>
        <Input value={outline.h1} onChange={(e) => onChange({ ...outline, h1: e.target.value })} />
      </div>
      <div>
        <label className="text-xs text-neutral-500">Meta description hint</label>
        <Input value={outline.meta_description_hint}
               onChange={(e) => onChange({ ...outline, meta_description_hint: e.target.value })} />
      </div>
      {outline.sections.map((s, i) => (
        <div key={i} className="border p-3 rounded bg-neutral-50 space-y-2">
          <div className="flex gap-2">
            <span className="text-xs text-neutral-500">H{s.heading_level}</span>
            <Input value={s.heading_text}
                   onChange={(e) => {
                     const next = [...outline.sections]; next[i] = { ...s, heading_text: e.target.value };
                     onChange({ ...outline, sections: next });
                   }} />
            <select className="border rounded p-1 text-xs" value={s.action}
                    onChange={(e) => {
                      const next = [...outline.sections]; next[i] = { ...s, action: e.target.value as typeof s.action };
                      onChange({ ...outline, sections: next });
                    }}>
              {["keep","update","add","remove","reorder"].map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <Textarea value={s.key_points.join("\n")}
                    rows={3}
                    onChange={(e) => {
                      const next = [...outline.sections];
                      next[i] = { ...s, key_points: e.target.value.split("\n").filter(Boolean) };
                      onChange({ ...outline, sections: next });
                    }} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `web/app/runs/[runId]/hitl1/page.tsx`**

```typescript
"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GapAnalysisView } from "@/components/GapAnalysisView";
import { OutlineEditor } from "@/components/OutlineEditor";
import { api } from "@/lib/api";
import type { Outline } from "@/lib/types";

export default function Hitl1Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();
  const ga = useQuery({ queryKey: ["ga", runId], queryFn: () => api.getGapAnalysis(runId) });
  const ol = useQuery({ queryKey: ["outline", runId], queryFn: () => api.getOutline(runId) });
  const [edited, setEdited] = useState<Outline | null>(null);

  const approve = useMutation({
    mutationFn: () => api.resumeHitl1(runId, edited ? { decision: "edit_outline", edited_outline: edited } : { decision: "approve" }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });
  const overrideRoute = useMutation({
    mutationFn: (newRoute: "small_refresh" | "full_rewrite") =>
      api.resumeHitl1(runId, { decision: "override_route", new_route: newRoute }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });

  const outline = edited ?? ol.data?.payload ?? null;

  return (
    <div className="max-w-6xl mx-auto p-8 grid grid-cols-2 gap-6">
      <Card className="p-4">
        <h2 className="font-medium mb-3">Gap analysis</h2>
        {ga.data && <GapAnalysisView ga={ga.data} />}
      </Card>
      <Card className="p-4">
        <h2 className="font-medium mb-3">Outline (editable)</h2>
        {outline && <OutlineEditor outline={outline} onChange={setEdited} />}
        <div className="flex gap-2 mt-4">
          <Button onClick={() => approve.mutate()}>
            {edited ? "Approve with edits" : "Approve"}
          </Button>
          <Button variant="outline" onClick={() => overrideRoute.mutate("small_refresh")}>Force small_refresh</Button>
          <Button variant="outline" onClick={() => overrideRoute.mutate("full_rewrite")}>Force full_rewrite</Button>
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web/app/runs/[runId]/hitl1/ web/components/GapAnalysisView.tsx web/components/OutlineEditor.tsx
git commit -m "feat(web): HITL_1 page (gap analysis view + outline editor)"
```

---

### Task 9: TipTap editor component

**Files:** `web/components/TipTapEditor.tsx`

- [ ] **Step 1: Create the component**

```typescript
"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";

export function TipTapEditor({
  value, onChange,
}: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: [StarterKit, Link],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none min-h-[400px] focus:outline-none p-4 border rounded bg-white",
      },
    },
    immediatelyRender: false,
  });
  return <EditorContent editor={editor} />;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/TipTapEditor.tsx
git commit -m "feat(web): TipTap rich editor component"
```

---

### Task 10: HTML diff component

**Files:** `web/components/HtmlDiffView.tsx`

- [ ] **Step 1: Create the component**

```typescript
import { diffWords } from "diff";

export function HtmlDiffView({ original, updated }: { original: string; updated: string }) {
  const parts = diffWords(original, updated);
  return (
    <div className="text-sm leading-6 whitespace-pre-wrap font-mono">
      {parts.map((p, i) => (
        <span
          key={i}
          className={
            p.added ? "bg-emerald-100" : p.removed ? "bg-rose-100 line-through" : ""
          }
        >
          {p.value}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/HtmlDiffView.tsx
git commit -m "feat(web): HTML diff view (word-level)"
```

---

### Task 11: HITL_2 page (TipTap + diff + WP metadata + audit findings)

**Files:** `web/components/WordPressMetaForm.tsx`, `web/app/runs/[runId]/hitl2/page.tsx`

- [ ] **Step 1: Create `web/components/WordPressMetaForm.tsx`**

```typescript
"use client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type { Hitl2Request } from "@/lib/types";

export function WordPressMetaForm({
  form, onChange,
}: { form: Hitl2Request; onChange: (f: Hitl2Request) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <Label>SEO title</Label>
        <Input value={form.edited_seo_title ?? ""} onChange={(e) => onChange({ ...form, edited_seo_title: e.target.value })} />
      </div>
      <div>
        <Label>Meta description</Label>
        <Textarea value={form.edited_meta_description ?? ""} rows={2}
                  onChange={(e) => onChange({ ...form, edited_meta_description: e.target.value })} />
      </div>
      <div>
        <Label>Slug (leave blank to preserve)</Label>
        <Input value={form.wp_slug ?? ""} onChange={(e) => onChange({ ...form, wp_slug: e.target.value || null })} />
      </div>
      <div>
        <Label>Excerpt</Label>
        <Textarea value={form.wp_excerpt ?? ""} rows={2}
                  onChange={(e) => onChange({ ...form, wp_excerpt: e.target.value || null })} />
      </div>
      <div>
        <Label>Publish status</Label>
        <Select value={form.wp_publish_status} onValueChange={(v) => onChange({ ...form, wp_publish_status: v as Hitl2Request["wp_publish_status"] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft (recommended)</SelectItem>
            <SelectItem value="future">Schedule</SelectItem>
            <SelectItem value="publish">Publish now</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>Author (WP user id)</Label>
        <Input type="number" value={form.wp_author_id ?? ""} onChange={(e) => onChange({ ...form, wp_author_id: e.target.value ? parseInt(e.target.value, 10) : null })} />
      </div>
      <div>
        <Label>Category IDs (comma)</Label>
        <Input value={form.wp_category_ids?.join(",") ?? ""}
               onChange={(e) => onChange({ ...form, wp_category_ids: e.target.value ? e.target.value.split(",").map(s => parseInt(s.trim(), 10)) : null })} />
      </div>
      <div>
        <Label>Tag IDs (comma)</Label>
        <Input value={form.wp_tag_ids?.join(",") ?? ""}
               onChange={(e) => onChange({ ...form, wp_tag_ids: e.target.value ? e.target.value.split(",").map(s => parseInt(s.trim(), 10)) : null })} />
      </div>
      <div>
        <Label>Featured media id</Label>
        <Input type="number" value={form.wp_featured_media_id ?? ""}
               onChange={(e) => onChange({ ...form, wp_featured_media_id: e.target.value ? parseInt(e.target.value, 10) : null })} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `web/app/runs/[runId]/hitl2/page.tsx`**

```typescript
"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TipTapEditor } from "@/components/TipTapEditor";
import { HtmlDiffView } from "@/components/HtmlDiffView";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { api } from "@/lib/api";
import type { Hitl2Request } from "@/lib/types";

export default function Hitl2Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const router = useRouter();

  const render = useQuery({ queryKey: ["render", runId], queryFn: () => api.getLatestRender(runId) });
  const audit = useQuery({ queryKey: ["audit", runId], queryFn: () => api.getLatestAudit(runId) });

  const [html, setHtml] = useState<string>("");
  const [form, setForm] = useState<Hitl2Request>({
    decision: "approve", wp_publish_status: "draft",
  });
  const [originalHtml, setOriginalHtml] = useState("");

  useEffect(() => {
    if (render.data) {
      setHtml(render.data.html_body);
      setOriginalHtml(render.data.html_body);
      setForm((f) => ({
        ...f,
        edited_seo_title: render.data!.seo_title,
        edited_meta_description: render.data!.meta_description,
        wp_excerpt: render.data!.excerpt_suggestion,
      }));
    }
  }, [render.data]);

  const submit = useMutation({
    mutationFn: (decision: Hitl2Request["decision"]) =>
      api.resumeHitl2(runId, { ...form, decision, edited_html_body: html }),
    onSuccess: () => router.push(`/runs/${runId}`),
  });

  return (
    <div className="max-w-7xl mx-auto p-8 grid grid-cols-3 gap-6">
      <Card className="p-4 col-span-2">
        <Tabs defaultValue="edit">
          <TabsList>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="diff">Diff vs render</TabsTrigger>
            <TabsTrigger value="audit">Audit findings</TabsTrigger>
          </TabsList>
          <TabsContent value="edit"><TipTapEditor value={html} onChange={setHtml} /></TabsContent>
          <TabsContent value="diff"><HtmlDiffView original={originalHtml} updated={html} /></TabsContent>
          <TabsContent value="audit">
            {audit.data && (
              <div className="space-y-2 text-sm">
                <p><b>Overall pass:</b> {audit.data.overall_pass ? "✓" : "✗"}</p>
                <p>High: {audit.data.severity_high} · Medium: {audit.data.severity_medium} · Low: {audit.data.severity_low}</p>
                <ul className="space-y-2 mt-2">
                  {[...audit.data.llm_findings.findings, ...audit.data.deterministic_findings.findings].map((f) => (
                    <li key={f.id} className="border p-2 rounded">
                      <p className="font-medium">[{f.severity}] {f.category} — {f.location}</p>
                      <p className="text-neutral-700">{f.issue}</p>
                      <p className="text-neutral-500 text-xs">→ {f.suggested_fix}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </Card>
      <Card className="p-4">
        <h2 className="font-medium mb-3">WordPress metadata</h2>
        <WordPressMetaForm form={form} onChange={setForm} />
        <div className="flex flex-col gap-2 mt-4">
          <Button onClick={() => submit.mutate("approve")} disabled={submit.isPending}>
            Approve → push to WP as Draft
          </Button>
          <Button variant="outline" onClick={() => submit.mutate("request_changes")}>Request changes</Button>
          <Button variant="destructive" onClick={() => submit.mutate("reject")}>Reject</Button>
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/runs/[runId]/hitl2/ web/components/WordPressMetaForm.tsx
git commit -m "feat(web): HITL_2 page (TipTap + diff + audit findings + WP form)"
```

---

### Task 12: Playwright smoke test (happy path)

**Files:** `web/playwright.config.ts`, `web/tests/e2e/run-creation.spec.ts`

- [ ] **Step 1: Create `web/playwright.config.ts`**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: { command: "npm run dev", url: "http://localhost:3000", reuseExistingServer: true },
});
```

- [ ] **Step 2: Create `web/tests/e2e/run-creation.spec.ts`**

```typescript
import { expect, test } from "@playwright/test";

test("home → new run form is reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Bowtie AI Content Tool")).toBeVisible();
  await page.getByRole("link", { name: "New article update" }).click();
  await expect(page).toHaveURL(/\/runs\/new/);
  await expect(page.getByLabel("Article URL")).toBeVisible();
});
```

- [ ] **Step 3: Run**

```bash
cd web && npx playwright install chromium && npx playwright test
```

Expected: 1 passed (requires backend running on :8000 for full E2E in later iterations; this test only checks UI navigation).

- [ ] **Step 4: Commit**

```bash
git add web/playwright.config.ts web/tests/e2e/
git commit -m "test(web): playwright smoke test for navigation"
```

---

### Task 13: README update

**Files:** Modify root `README.md`

- [ ] **Step 1: Append to `README.md`**

```markdown
## Web UI

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev
# → http://localhost:3000
```

Backend must be running on http://localhost:8000.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: web UI run instructions"
```

---

## Self-review checklist

| Concern | Covered |
|---|---|
| Next.js scaffolding | Task 1 |
| Backend CORS + per-resource endpoints | Task 2 |
| Frontend types + API client | Task 3 |
| SSE hook | Task 4 |
| Run list page | Task 5 |
| Trigger form | Task 6 |
| Run detail with SSE | Task 7 |
| HITL_1 (gap + outline edit) | Task 8 |
| TipTap editor | Task 9 |
| HTML diff | Task 10 |
| HITL_2 (TipTap + diff + audit + WP form) | Task 11 |
| Playwright smoke | Task 12 |
| Docs | Task 13 |

After Plan 4 ships: full UI works end-to-end against the backend, with both HITL gates. The WP push is still a no-op in the backend — Plan 5 wires it.
