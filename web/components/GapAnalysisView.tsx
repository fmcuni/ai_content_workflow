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
