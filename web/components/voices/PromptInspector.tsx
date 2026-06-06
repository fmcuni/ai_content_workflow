"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { promptsApi } from "@/lib/api";
import type { GraphMode, PromptNode } from "@/lib/types";
import { UserExamplePicker } from "./UserExamplePicker";

type SchemaRow = { field: string; source: string };

// User-prompt field → data source, per pipeline mode. Each agent builds its
// user prompt at runtime from these inputs (see content_tool/agents/*.py).
const USER_PROMPT_SCHEMAS: Record<GraphMode, Record<string, SchemaRow[]>> = {
  refresh: {
    gap_analysis: [
      { field: "topic", source: "runs.topic" },
      { field: "focus_keywords", source: "runs.keywords" },
      { field: "existing_article", source: "runs.article_url" },
      { field: "acf_adv_id", source: "runs.acf_adv_id" },
      { field: "acf_widget_id", source: "runs.acf_widget_id" },
      { field: "route", source: "runs.mode" },
      { field: "article_edit_note", source: "runs.edit_note" },
    ],
    outline: [
      { field: "chosen_route", source: "runs.chosen_route" },
      { field: "acf_adv_id", source: "runs.acf_adv_id" },
      { field: "acf_widget_id", source: "runs.acf_widget_id" },
      { field: "gap_analysis", source: "gap_analyses.payload" },
      { field: "existing_article_markdown", source: "fetched_articles.markdown" },
    ],
    writer: [
      { field: "topic", source: "runs.topic" },
      { field: "focus_keywords", source: "runs.keywords" },
      { field: "existing_article_URL", source: "runs.article_url" },
      { field: "acf_adv_id", source: "runs.acf_adv_id" },
      { field: "acf_widget_id", source: "runs.acf_widget_id" },
      { field: "topic_category", source: "runs.topic_category" },
      { field: "outline", source: "outlines.payload" },
      { field: "gap_analysis", source: "gap_analyses.payload" },
      { field: "existing_article_markdown", source: "fetched_articles.markdown" },
      { field: "refine_notes", source: "audit_runs.findings (must_fix) + reviewer comments" },
    ],
    audit: [
      { field: "final_html", source: "renders.html_body" },
      { field: "gap_analysis.update_plan", source: "gap_analyses.payload.update_plan" },
      { field: "citation_intents", source: "drafts.citation_intents" },
      { field: "citations", source: "citations table (resolved)" },
      { field: "deterministic_findings", source: "audit_runs.deterministic_findings" },
    ],
  },
  create: {
    // Create-mode has no fetched article or gap analysis — the outline is
    // built straight from the operator's brief (build_user_prompt_create_mode).
    outline: [
      { field: "主題 (topic)", source: "runs.topic" },
      { field: "關鍵字 (keywords)", source: "runs.keywords" },
      { field: "目標讀者 (target_audience)", source: "runs.target_audience" },
      { field: "acf_adv_id", source: "runs.acf_adv_id" },
      { field: "acf_widget_id", source: "runs.acf_widget_id" },
    ],
    // Writer uses the dedicated create-mode template; gap_analysis + existing
    // markdown arrive empty (the writer is the first content node in create-mode).
    writer: [
      { field: "topic", source: "runs.topic" },
      { field: "focus_keywords", source: "runs.keywords" },
      { field: "acf_adv_id", source: "runs.acf_adv_id" },
      { field: "acf_widget_id", source: "runs.acf_widget_id" },
      { field: "topic_category", source: "runs.topic_category" },
      { field: "outline", source: "outlines.payload" },
      { field: "gap_analysis", source: "∅ empty in create-mode" },
      { field: "existing_article_markdown", source: "∅ empty in create-mode" },
      { field: "refine_notes", source: "audit_runs.findings (must_fix) + reviewer comments" },
    ],
    audit: [
      { field: "final_html", source: "renders.html_body" },
      { field: "gap_analysis.update_plan", source: "∅ empty in create-mode" },
      { field: "citation_intents", source: "drafts.citation_intents" },
      { field: "citations", source: "citations table (resolved)" },
      { field: "deterministic_findings", source: "audit_runs.deterministic_findings" },
    ],
  },
  topic_expansion: {
    topic_gen: [
      { field: "研究主題 (research_theme)", source: "topic_batches brief" },
      { field: "目標受眾 (target_audience)", source: "topic_batches brief" },
      { field: "主題數量 (topic_count)", source: "topic_batches brief" },
      { field: "每主題關鍵字數 (keywords_per_topic)", source: "topic_batches brief" },
      { field: "必須涵蓋 (must_cover)", source: "topic_batches brief" },
      { field: "避免主題 (must_avoid)", source: "topic_batches brief" },
      { field: "額外偏重 (priority_focus)", source: "topic_batches brief" },
      { field: "補充要求 (notes)", source: "topic_batches brief" },
    ],
    topic_dedup: [
      { field: "topic", source: "topic_candidates.topic" },
      { field: "focus_keywords", source: "topic_candidates.keywords" },
    ],
    topic_hot: [
      { field: "topic", source: "topic_candidates.topic" },
      { field: "focus_keywords", source: "topic_candidates.keywords" },
    ],
  },
};

// Run-based "load example" only applies to per-run agents (refresh + create).
const RUN_SCOPED_MODES: GraphMode[] = ["refresh", "create"];

interface PromptInspectorProps {
  node: PromptNode;
  mode: GraphMode;
  /** Voice (persona slug) whose template body to preview. Prompts are per-voice;
   * a voice without its own copy falls back to the shared seed server-side. */
  voice: string;
}

export function PromptInspector({ node, mode, voice }: PromptInspectorProps) {
  const templateIds = [
    node.system_prompt_template_id,
    ...(node.alt_template_ids ?? []),
  ].filter((x): x is string => Boolean(x));

  const [activeId, setActiveId] = useState(templateIds[0] ?? null);

  const tmpl = useQuery({
    enabled: activeId !== null,
    queryKey: ["prompt-template", voice, activeId],
    queryFn: () => promptsApi.template(activeId!, voice),
  });

  const schema = USER_PROMPT_SCHEMAS[mode]?.[node.id] ?? [];
  const schemaHint = (
    <dl className="grid grid-cols-[200px_1fr] gap-x-3 gap-y-1 text-[12px]">
      {schema.map((s) => (
        <Fragment key={s.field}>
          <dt className="font-mono uppercase tracking-wider text-ink-faint">{s.field}</dt>
          <dd className="text-ink-soft">{s.source}</dd>
        </Fragment>
      ))}
    </dl>
  );

  const runScoped = RUN_SCOPED_MODES.includes(mode);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-6 mt-2">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <p className="kicker">System prompt</p>
          {templateIds.length > 1 && (
            <div className="flex gap-1">
              {templateIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveId(id)}
                  className={`font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 border ${
                    id === activeId ? "border-accent text-accent" : "border-rule text-ink-faint"
                  }`}
                >
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
        {tmpl.isLoading && <p className="text-ink-faint text-[12px]">Loading…</p>}
        {tmpl.data && (
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-soft border border-rule p-3 max-h-[480px] overflow-auto">
            {tmpl.data.template.replace(
              "{persona_block}",
              "[ persona block — see Style Card above ]",
            )}
          </pre>
        )}
      </div>
      <div>
        <p className="kicker mb-2">User prompt</p>
        {runScoped ? (
          <UserExamplePicker agent={node.id} schemaHint={schemaHint} />
        ) : (
          <div className="space-y-3">
            {schemaHint}
            <p className="font-mono text-[10px] tracking-wider uppercase text-ink-faint">
              Per-batch / per-candidate input — no single run to sample.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
