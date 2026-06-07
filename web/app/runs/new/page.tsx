"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { AutoAcceptField } from "@/components/AutoAcceptField";
import { Button } from "@/components/ui/button";
import { RoleButton } from "@/components/RoleGate";
import { Textarea } from "@/components/ui/textarea";
import { SectionHead } from "@/components/SectionHead";
import { RefreshFindingsPanel } from "@/components/RefreshFindingsPanel";
import { ExternalLink } from "@/components/ExternalLink";
import { articlesApi, personasApi, refreshApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BriefForm } from "@/components/topics/BriefForm";
import { CreateLedger } from "@/components/topics/CreateLedger";
import {
  DEFAULT_PERSONA,
  type LedgerRow,
  LedgerDoneBanner,
  LedgerFooter,
  LedgerHeader,
  LedgerRowView,
  useLedgerRows,
  useLedgerSubmit,
} from "@/components/topics/ledger-row";

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
  const params = useSearchParams();
  const articleId = params.get("article_id");
  const evaluationId = params.get("evaluation_id");

  const [front, setFront] = useState<FrontKey>(() => parseFront(params.get("front")));
  const activeFront = FRONTS.find((f) => f.key === front) ?? FRONTS[0];
  const { rows, setRows, expanded, setExpanded, newRow, patchRow, addRow, removeRow } =
    useLedgerRows("r");
  const [autoAccept, setAutoAccept] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRaw, setBulkRaw] = useState("");
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
  }, [articleReady, evaluationReady, article, evaluation, setRows]);

  const personas = personasQ.data ?? [];

  const filledRows = useMemo(
    () => rows.filter((r) => r.article_url.trim() && r.topic.trim()),
    [rows],
  );
  const allDone = filledRows.length > 0 && filledRows.every((r) => r.status === "done");

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
        ...newRow(carriedPersona),
        article_url: url,
        topic,
        keywords: kws.replace(/;/g, ", "),
      };
    });
    setRows(parsed);
    setBulkRaw("");
    setBulkOpen(false);
  }

  const submitMut = useLedgerSubmit({
    rows,
    patchRow,
    isReady: (r) => Boolean(r.article_url.trim() && r.topic.trim()),
    buildRequest: (r) => ({
      article_url: r.article_url.trim(),
      topic: r.topic.trim(),
      keywords: r.keywords.split(",").map((s) => s.trim()).filter(Boolean),
      mode: r.mode,
      persona: r.persona || DEFAULT_PERSONA,
      edit_note: r.edit_note.trim() || null,
      acf_adv_id: r.acf_adv_id,
      acf_widget_id: r.acf_widget_id,
      topic_category: null,
      editor_email: "",
      auto_accept_hitl1: autoAccept,
      triggered_by_evaluation_id: evaluationId ?? undefined,
    }),
  });

  const filedCount = rows.filter((r) => r.status === "done").length;
  const pending = filledRows.filter((r) => r.status !== "done").length;
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
        dek={`Three fronts in the works. Today we file under Front ${activeFront.numeral} — ${activeFront.dek}`}
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
          <ExternalLink
            href={article.article_url}
            className="font-mono text-[11px] text-ink-faint underline-offset-2 hover:underline break-all line-clamp-1"
          >
            {article.article_url}
          </ExternalLink>
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
              <Button variant="ghost" size="sm" onClick={() => setBulkOpen((v) => !v)} type="button">
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
            <LedgerHeader variant="refresh" />

            {rows.map((row, idx) => (
              <LedgerRowView
                key={row.uid}
                row={row}
                index={idx}
                variant="refresh"
                personas={personas}
                personasLoading={personasQ.isLoading}
                isOpen={expanded === row.uid}
                onToggle={() => setExpanded(expanded === row.uid ? null : row.uid)}
                onPatch={(p) => patchRow(row.uid, p)}
                onRemove={() => removeRow(row.uid)}
              />
            ))}

            <LedgerFooter
              rowCount={rows.length}
              readyCount={filledRows.length}
              filedCount={filedCount}
              onAddRow={addRow}
            />
          </div>

          <AutoAcceptField checked={autoAccept} onChange={setAutoAccept} />

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
              <RoleButton
                need="create_run"
                deniedHint="Author role required to file new runs."
                onClick={() => submitMut.mutate()}
                disabled={submitMut.isPending || pending === 0}
                size="lg"
              >
                {submitMut.isPending
                  ? `Filing ${filledRows.length}…`
                  : `File ${pending} run${pending === 1 ? "" : "s"} →`}
              </RoleButton>
            </div>
          </div>

          {allDone && <LedgerDoneBanner note="Ledger filed. Tail the runs from the desk index." />}
        </section>
      )}
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
