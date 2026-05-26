"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { promptsApi } from "@/lib/api";
import type { PromptNode } from "@/lib/types";
import { UserExamplePicker } from "./UserExamplePicker";

const USER_PROMPT_SCHEMAS: Record<string, { field: string; source: string }[]> = {
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
};

interface PromptInspectorProps {
  node: PromptNode;
}

export function PromptInspector({ node }: PromptInspectorProps) {
  const templateIds = [
    node.system_prompt_template_id,
    ...(node.alt_template_ids ?? []),
  ].filter((x): x is string => Boolean(x));

  const [activeId, setActiveId] = useState(templateIds[0] ?? null);

  const tmpl = useQuery({
    enabled: activeId !== null,
    queryKey: ["prompt-template", activeId],
    queryFn: () => promptsApi.template(activeId!),
  });

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
        <UserExamplePicker
          agent={node.id}
          schemaHint={
            <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1 text-[12px]">
              {(USER_PROMPT_SCHEMAS[node.id] ?? []).map((s) => (
                <Fragment key={s.field}>
                  <dt className="font-mono uppercase tracking-wider text-ink-faint">{s.field}</dt>
                  <dd className="text-ink-soft">{s.source}</dd>
                </Fragment>
              ))}
            </dl>
          }
        />
      </div>
    </div>
  );
}
