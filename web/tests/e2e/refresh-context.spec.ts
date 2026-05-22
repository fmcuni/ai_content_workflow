import { test, expect } from "@playwright/test";

test("/runs/new with article_id + evaluation_id shows Refresh context card", async ({ page }) => {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  const list = await (await page.request.get(`${apiBase}/articles?needs_refresh=true&limit=1`)).json();
  if (list.total === 0) test.skip(true, "no needs-refresh article available; run library.spec.ts first");
  const article = list.items[0];
  const evaluationId = article.latest_evaluation.evaluation_id;

  await page.goto(`/runs/new?article_id=${article.article_id}&evaluation_id=${evaluationId}`);
  await expect(page.getByText("Refresh context")).toBeVisible();
  await expect(page.getByText(article.article_url)).toBeVisible();
});
