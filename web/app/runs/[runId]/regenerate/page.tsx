import { redirect } from "next/navigation";

/**
 * /regenerate is retired — the standalone regenerate endpoint was never ported to
 * the Workers backend, and /edit already provides the same comment-driven inline
 * AI edits (per-comment "Apply" + "Apply to article") that work in production.
 * Redirect any remaining links/bookmarks to the edit page.
 */
export default async function RegenerateRedirect({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  redirect(`/runs/${runId}/edit`);
}
