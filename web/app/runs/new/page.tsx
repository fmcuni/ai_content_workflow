"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionHead } from "@/components/SectionHead";
import { RefreshFindingsPanel } from "@/components/RefreshFindingsPanel";
import { api, articlesApi, personasApi, refreshApi } from "@/lib/api";
import type { CreateRunRequest, Mode, Persona } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BriefForm } from "@/components/topics/BriefForm";
import { CreateLedger } from "@/components/topics/CreateLedger";

type RowStatus = "idle" | "submitting" | "done" | "error";

interface LedgerRow {
  uid: string;
  article_url: string;
  topic: string;
  keywords: string;
  mode: Mode;
  persona: string;
  edit_note: string;
  acf_adv_id: number;
  acf_widget_id: number;
  status: RowStatus;
  result: { run_id?: string; error?: string } | null;
}

const DEFAULT_PERSONA = "bowtie-editor";

let _uid = 0;
const nextUid = () => `r${++_uid}-${Date.now().toString(36)}`;

function blankRow(persona = DEFAULT_PERSONA): LedgerRow {
  return {
    uid: nextUid(),
    article_url: "",
    topic: "",
    keywords: "",
    mode: "auto",
    persona,
    edit_note: "",
    acf_adv_id: 1,
    acf_widget_id: 1,
    status: "idle",
    result: null,
  };
}

type FrontKey = "articles" | "topics" | "create";

const FRONT_KEYS: ReadonlySet<FrontKey> = new Set<FrontKey>(["articles", "topics", "create"]);

function parseFront(raw: string | null): FrontKey {
  return raw && FRONT_KEYS.has(raw as FrontKey) ? (raw as FrontKey) : "articles";
}

const FRONTS: { key: FrontKey; numeral: string; kicker: string; title: string; dek: string; active: boolean }[] = [
  {
    key: "articles",
    numeral: "I",
    kicker: "Front One · Live",
    title: "Add articles to be updated",
    dek: "Brief the desk on existing pieces that need a refresh pass.",
    active: true,
  },
  {
    key: "topics",
    numeral: "II",
    kicker: "Front Two · Live",
    title: "Expand Topics",
    dek: "Brief the desk on a research theme; it returns a vetted batch of candidates.",
    active: true,
  },
  {
    key: "create",
    numeral: "III",
    kicker: "Front Three · Live",
    title: "Create New Articles",
    dek: "Commission fresh pieces. Each row becomes a create-mode run, published as a draft.",
    active: true,
  },
];

function NewRunForm() {
  const router = useRouter();
  const params = useSearchParams();
  const articleId = params.get("article_id");
  const evaluationId = params.get("evaluation_id");

  const [front, setFront] = useState<FrontKey>(() => parseFront(params.get("front")));
  const [rows, setRows] = useState<LedgerRow[]>(() => [blankRow(), blankRow(), blankRow()]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRaw, setBulkRaw] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const seeded = useRef(false);

  const personasQ = useQuery({
    queryKey: ["personas-active"],
    queryFn: () => personasApi.list(false),
  });

  const { data: article } = useQuery({
    queryKey: ["article", articleId],
    queryFn: () => (articleId ? articlesApi.detail(articleId) : Promise.resolve(null)),
    enabled: !!articleId,
  });

  const { data: evaluation } = useQuery({
    queryKey: ["evaluation", evaluationId],
    queryFn: () => (evaluationId ? refreshApi.getEvaluation(evaluationId) : Promise.resolve(null)),
    enabled: !!evaluationId,
  });

  const articleReady = !articleId || article !== undefined;
  const evaluationReady = !evaluationId || evaluation !== undefined;
  useEffect(() => {
    if (seeded.current) return;
    if (!articleReady || !evaluationReady) return;
    if (!article && !evaluation) return;
    seeded.current = true;
    setRows((prev) => {
      const next = [...prev];
      const head = { ...next[0] };
      if (article) {
        head.article_url = article.article_url;
        head.persona = article.persona ?? DEFAULT_PERSONA;
        head.topic = article.topic ?? "";
      }
      if (evaluation) {
        head.mode =
          evaluation.deterministic_findings.severity_high > 0 ? "full_rewrite" : "small_refresh";
      }
      next[0] = head;
      return next;
    });
  }, [articleReady, evaluationReady, article, evaluation]);

  const personas = personasQ.data ?? [];

  const filledRows = useMemo(
    () => rows.filter((r) => r.article_url.trim() && r.topic.trim()),
    [rows],
  );
  const allDone =
    filledRows.length > 0 && filledRows.every((r) => r.status === "done");

  function patchRow(uid: string, patch: Partial<LedgerRow>) {
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((rs) => [...rs, blankRow(rs[rs.length - 1]?.persona ?? DEFAULT_PERSONA)]);
  }

  function removeRow(uid: string) {
    setRows((rs) => (rs.length === 1 ? [blankRow()] : rs.filter((r) => r.uid !== uid)));
    if (expanded === uid) setExpanded(null);
  }

  function applyBulk() {
    const carriedPersona = rows[0]?.persona ?? DEFAULT_PERSONA;
    const lines = bulkRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const parsed: LedgerRow[] = lines.map((line) => {
      const cells = line.includes("\t") ? line.split("\t") : line.split(",");
      const [url = "", topic = "", kws = ""] = cells.map((c) => c.trim());
      return {
        ...blankRow(carriedPersona),
        article_url: url,
        topic,
        keywords: kws.replace(/;/g, ", "),
      };
    });
    setRows(parsed);
    setBulkRaw("");
    setBulkOpen(false);
  }

  const submitMut = useMutation({
    mutationFn: async () => {
      const targets = rows.filter(
        (r) => r.article_url.trim() && r.topic.trim() && r.status !== "done",
      );
      const results: { uid: string; run_id?: string; error?: string }[] = [];
      for (const r of targets) {
        patchRow(r.uid, { status: "submitting", result: null });
        try {
          const req: CreateRunRequest = {
            article_url: r.article_url.trim(),
            topic: r.topic.trim(),
            keywords: r.keywords.split(",").map((s) => s.trim()).filter(Boolean),
            mode: r.mode,
            persona: r.persona || DEFAULT_PERSONA,
            edit_note: r.edit_note.trim() || null,
            acf_adv_id: r.acf_adv_id || 1,
            acf_widget_id: r.acf_widget_id || 1,
            topic_category: null,
            editor_email: "",
            triggered_by_evaluation_id: evaluationId ?? undefined,
          };
          const res = await api.createRun(req);
          patchRow(r.uid, { status: "done", result: { run_id: res.run_id } });
          results.push({ uid: r.uid, run_id: res.run_id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          patchRow(r.uid, { status: "error", result: { error: msg } });
          results.push({ uid: r.uid, error: msg });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.run_id);
      if (ok.length === 1 && results.length === 1) {
        router.push(`/runs/${ok[0].run_id}`);
      }
    },
  });

  const filedCount = rows.filter((r) => r.status === "done").length;
  const issueDate = new Date().toISOString().slice(0, 10);
  const issueNumber = useMemo(
    () => Math.floor(Date.now() / 86_400_000).toString().slice(-4),
    [],
  );

  return (
    <div className="mx-auto max-w-[1240px] px-5 md:px-10 py-10 space-y-10">
      <header className="border-y-2 border-ink/90 py-4">
        <div className="flex items-end justify-between gap-6">
          <p className="kicker">Bowtie Desk · Assignment Ledger</p>
          <p className="font-mono text-[11px] text-ink-faint tabular-nums">
            ISSUE №<span className="text-ink">{issueNumber}</span> · {issueDate}
          </p>
        </div>
      </header>

      <SectionHead
        kicker="The Desk · New Briefs"
        hed="The Assignment Desk"
        dek="Three fronts in the works. Today we file under Front I — refreshes of articles already in print."
      />

      <nav
        aria-label="Available fronts"
        className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-rule"
      >
        {FRONTS.map((f, i) => {
          const selected = front === f.key;
          return (
            <button
              key={f.key}
              type="button"
              disabled={!f.active}
              onClick={() => f.active && setFront(f.key)}
              className={cn(
                "relative text-left px-5 py-5 transition-colors group",
                i > 0 && "md:border-l border-rule",
                "border-t md:border-t-0 first:border-t-0",
                selected && f.active && "bg-paper-deep",
                f.active ? "cursor-pointer hover:bg-paper-deep" : "cursor-not-allowed opacity-65",
              )}
              aria-pressed={selected}
            >
              <div className="flex items-baseline gap-3">
                <span
                  className="font-display text-[44px] leading-none text-ink-faint tabular-nums"
                  style={{ fontVariationSettings: '"opsz" 144, "SOFT" 80', fontStyle: "italic" }}
                >
                  {f.numeral}
                </span>
                <span className="kicker">{f.kicker}</span>
              </div>
              <h3
                className="hed mt-2 text-[20px]"
                style={{ fontVariationSettings: '"opsz" 36, "SOFT" 60' }}
              >
                {f.title}
              </h3>
              <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">{f.dek}</p>
              {!f.active && (
                <span className="absolute top-3 right-3 font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint border border-rule px-1.5 py-[1px]">
                  In setting
                </span>
              )}
              {selected && f.active && (
                <span
                  aria-hidden
                  className="absolute -bottom-[1px] left-0 right-0 h-[3px] bg-accent"
                />
              )}
            </button>
          );
        })}
      </nav>

      {front === "topics" && <BriefForm />}
      {front === "create" && <CreateLedger />}

      {front === "articles" && evaluation && <RefreshFindingsPanel ev={evaluation} />}
      {front === "articles" && article && !evaluation && (
        <blockquote className="border-l-2 border-accent pl-5 space-y-1.5 text-[13px]">
          <p className="kicker">Brief from Archive · Row 1 pre-filled</p>
          <p className="font-display text-[18px] text-ink leading-snug">
            {article.topic ?? "(no topic)"}
          </p>
          <a
            href={article.article_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-ink-faint underline-offset-2 hover:underline break-all line-clamp-1"
          >
            {article.article_url}
          </a>
        </blockquote>
      )}

      {front === "articles" && (
      <section aria-labelledby="ledger-title" className="space-y-4">
        <div className="flex items-end justify-between gap-4 border-b border-ink pb-3">
          <div>
            <p className="kicker">Front I · Assignment Ledger</p>
            <h2
              id="ledger-title"
              className="hed text-[28px] mt-1"
              style={{ fontVariationSettings: '"opsz" 36, "SOFT" 60' }}
            >
              Add articles to be updated
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBulkOpen((v) => !v)}
              type="button"
            >
              {bulkOpen ? "Close paste tray" : "Paste rows…"}
            </Button>
            <Button variant="secondary" size="sm" onClick={addRow} type="button">
              + Add row
            </Button>
          </div>
        </div>

        {bulkOpen && (
          <div className="bg-paper-deep border border-rule p-4 space-y-3">
            <div className="flex items-baseline justify-between">
              <p className="kicker">Bulk paste · one row per line</p>
              <p className="font-mono text-[10.5px] text-ink-faint">
                url, topic, keyword;keyword;keyword
              </p>
            </div>
            <Textarea
              value={bulkRaw}
              onChange={(e) => setBulkRaw(e.target.value)}
              rows={6}
              placeholder="https://bowtie.com.hk/blog/zh/example, Topic in plain English, kw1;kw2"
              className="font-mono text-[12px] bg-paper"
            />
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setBulkRaw("");
                  setBulkOpen(false);
                }}
                className="text-[12px] text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
              <Button size="sm" onClick={applyBulk} disabled={!bulkRaw.trim()}>
                Replace rows with paste
              </Button>
            </div>
          </div>
        )}

        <div className="border border-rule overflow-hidden">
          <div className="hidden md:grid grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_108px_minmax(0,1.1fr)_64px_64px_36px_36px] bg-paper-deep border-b border-rule">
            {(["№", "Article URL", "Topic", "Focus keywords", "Mode", "Voice", "ADV", "Widget", "", ""] as const).map(
              (t, i) => (
                <div
                  key={i}
                  className={cn(
                    "px-3 py-2 kicker border-r border-rule last:border-r-0",
                    i === 0 && "text-center",
                  )}
                >
                  {t}
                </div>
              ),
            )}
          </div>

          {rows.map((row, idx) => {
            const isOpen = expanded === row.uid;
            return (
              <LedgerRowView
                key={row.uid}
                row={row}
                index={idx}
                personas={personas}
                personasLoading={personasQ.isLoading}
                isOpen={isOpen}
                onToggle={() => setExpanded(isOpen ? null : row.uid)}
                onPatch={(p) => patchRow(row.uid, p)}
                onRemove={() => removeRow(row.uid)}
              />
            );
          })}

          <div className="flex items-center justify-between gap-4 px-3 py-2 bg-paper-deep/60 border-t border-rule">
            <p className="font-mono text-[11px] text-ink-faint">
              {rows.length} row{rows.length === 1 ? "" : "s"} · {filledRows.length} ready to file
              {filedCount > 0 && (
                <>
                  {" "}
                  · <span className="text-ok">{filedCount} filed</span>
                </>
              )}
            </p>
            <button
              type="button"
              onClick={addRow}
              className="font-mono text-[11px] text-ink-soft hover:text-ink underline underline-offset-2"
            >
              + new row
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 pt-2">
          <Link href="/" className="text-[12px] text-ink-soft hover:text-ink">
            ↩ Back to the desk
          </Link>
          <div className="flex items-center gap-4">
            {submitMut.isError && (
              <p className="text-accent-deep text-[12px] font-mono">
                {(submitMut.error as Error).message}
              </p>
            )}
            <Button
              onClick={() => submitMut.mutate()}
              disabled={
                submitMut.isPending || filledRows.filter((r) => r.status !== "done").length === 0
              }
              size="lg"
            >
              {submitMut.isPending
                ? `Filing ${filledRows.length}…`
                : `File ${filledRows.filter((r) => r.status !== "done").length} run${
                    filledRows.filter((r) => r.status !== "done").length === 1 ? "" : "s"
                  } →`}
            </Button>
          </div>
        </div>

        {allDone && (
          <div className="flex flex-col items-center gap-1 pt-6 pb-2">
            <p
              className="font-display text-[22px] tracking-[0.4em] text-ink-faint"
              style={{ fontStyle: "italic" }}
            >
              — 30 —
            </p>
            <p className="font-mono text-[10.5px] text-ink-faint">
              Ledger filed. Tail the runs from the desk index.
            </p>
          </div>
        )}
      </section>
      )}
    </div>
  );
}

interface LedgerRowProps {
  row: LedgerRow;
  index: number;
  personas: Persona[];
  personasLoading: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<LedgerRow>) => void;
  onRemove: () => void;
}

function LedgerRowView({
  row,
  index,
  personas,
  personasLoading,
  isOpen,
  onToggle,
  onPatch,
  onRemove,
}: LedgerRowProps) {
  const status = row.status;
  const statusDot =
    status === "done"
      ? "bg-ok"
      : status === "submitting"
        ? "bg-warn animate-pulse"
        : status === "error"
          ? "bg-accent-deep"
          : "bg-rule";

  const selectClasses =
    "h-9 w-full bg-transparent text-[13px] text-ink border-0 border-b border-rule rounded-none px-0 py-1.5 outline-none focus-visible:border-b-2 focus-visible:border-accent appearance-none cursor-pointer";

  return (
    <div
      className={cn(
        "border-b border-rule last:border-b-0",
        status === "done" && "bg-ok/[0.04]",
        status === "error" && "bg-accent/[0.05]",
      )}
    >
      <div className="grid grid-cols-1 md:grid-cols-[40px_minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_108px_minmax(0,1.1fr)_64px_64px_36px_36px]">
        <div className="flex items-center justify-center md:border-r border-rule px-2 py-2 relative">
          <span
            className="font-display text-[20px] text-ink-faint tabular-nums leading-none"
            style={{ fontVariationSettings: '"opsz" 36' }}
          >
            {String(index + 1).padStart(2, "0")}
          </span>
          <span
            aria-hidden
            className={cn("absolute right-1 top-1 size-1.5 rounded-full", statusDot)}
            title={status}
          />
        </div>

        <Cell label="Article URL">
          <Input
            value={row.article_url}
            onChange={(e) => onPatch({ article_url: e.target.value })}
            placeholder="https://www.bowtie.com.hk/blog/zh/…"
            className="font-mono text-[12px]"
          />
        </Cell>

        <Cell label="Topic">
          <Input
            value={row.topic}
            onChange={(e) => onPatch({ topic: e.target.value })}
            placeholder="Topic in plain English"
          />
        </Cell>

        <Cell label="Focus keywords">
          <Input
            value={row.keywords}
            onChange={(e) => onPatch({ keywords: e.target.value })}
            placeholder="kw1, kw2, kw3"
          />
        </Cell>

        <Cell label="Mode">
          <select
            value={row.mode}
            onChange={(e) => onPatch({ mode: e.target.value as Mode })}
            className={selectClasses}
          >
            <option value="auto">Auto</option>
            <option value="small_refresh">Small refresh</option>
            <option value="full_rewrite">Full rewrite</option>
          </select>
        </Cell>

        <Cell label="Voice">
          <select
            value={row.persona}
            onChange={(e) => onPatch({ persona: e.target.value })}
            className={selectClasses}
            disabled={personasLoading}
          >
            {personasLoading && <option>Loading voices…</option>}
            {!personasLoading && personas.length === 0 && (
              <option value={DEFAULT_PERSONA}>{DEFAULT_PERSONA}</option>
            )}
            {personas.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
            {!personasLoading &&
              personas.length > 0 &&
              !personas.some((p) => p.slug === row.persona) && (
                <option value={row.persona}>{row.persona} (unknown)</option>
              )}
          </select>
        </Cell>

        <Cell label="ADV">
          <Input
            type="number"
            value={row.acf_adv_id}
            onChange={(e) => onPatch({ acf_adv_id: parseInt(e.target.value || "0", 10) })}
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_adv_id"
          />
        </Cell>

        <Cell label="Widget">
          <Input
            type="number"
            value={row.acf_widget_id}
            onChange={(e) => onPatch({ acf_widget_id: parseInt(e.target.value || "0", 10) })}
            className="font-mono text-[12px] tabular-nums"
            aria-label="acf_widget_id"
          />
        </Cell>

        <div className="md:border-l border-rule flex items-center justify-center px-1 py-2">
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              "size-6 inline-flex items-center justify-center font-mono text-[14px] text-ink-soft hover:text-ink hover:bg-paper-deep transition-colors",
              isOpen && "bg-paper-deep text-ink",
            )}
            aria-label="More fields"
            title="Edit note"
          >
            {isOpen ? "−" : "+"}
          </button>
        </div>

        <div className="md:border-l border-rule flex items-center justify-center px-1 py-2">
          <button
            type="button"
            onClick={onRemove}
            className="size-6 inline-flex items-center justify-center font-mono text-[13px] text-ink-faint hover:text-accent-deep transition-colors"
            aria-label="Remove row"
            title="Strike row"
          >
            ×
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="grid grid-cols-1 md:grid-cols-[40px_1fr] border-t border-rule bg-paper-deep/40">
          <div className="hidden md:block md:border-r border-rule" />
          <div className="px-4 py-4">
            <label className="flex flex-col gap-1">
              <span className="kicker">Edit note</span>
              <Textarea
                value={row.edit_note}
                onChange={(e) => onPatch({ edit_note: e.target.value })}
                rows={2}
                placeholder="What the desk wants on this run."
                className="bg-paper"
              />
            </label>
          </div>
        </div>
      )}

      {row.result && (
        <div
          className={cn(
            "px-3 py-1.5 font-mono text-[11px] flex items-center justify-between gap-3 border-t border-rule",
            status === "done" && "bg-ok/[0.08] text-ok",
            status === "error" && "bg-accent/[0.08] text-accent-deep",
          )}
        >
          {status === "done" && row.result.run_id && (
            <>
              <span>FILED · run_id {row.result.run_id.slice(0, 8)}…</span>
              <Link
                href={`/runs/${row.result.run_id}`}
                className="underline underline-offset-2 hover:text-ink"
              >
                Open run →
              </Link>
            </>
          )}
          {status === "error" && row.result.error && <span>ERROR · {row.result.error}</span>}
        </div>
      )}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="md:border-r border-rule px-3 py-2">
      <span className="md:hidden kicker mb-1 block">{label}</span>
      {children}
    </div>
  );
}

export default function NewRunPage() {
  return (
    <Suspense fallback={null}>
      <NewRunForm />
    </Suspense>
  );
}
