import { test, expect } from "@playwright/test";

test("library page renders and trigger button links to /runs/new with query params", async ({ page }) => {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";
  const url = `https://bowtie.com.hk/playwright/${Date.now()}/`;
  const createRes = await page.request.post(`${apiBase}/runs`, {
    data: {
      article_url: url, topic: "Playwright Library", keywords: [], mode: "small_refresh",
      acf_adv_id: 0, acf_widget_id: 0, persona: "bowtie-editor",
      today_date: new Date().toISOString().slice(0, 10), editor_email: "playwright@bowtie",
    },
  });
  expect(createRes.ok()).toBeTruthy();

  const scanRes = await page.request.post(`${apiBase}/refresh/scan`, { data: {} });
  expect(scanRes.ok()).toBeTruthy();

  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await page.getByText("Needs refresh").click();
  await page.getByRole("option", { name: "All articles" }).click();
  await expect(page.locator("table")).toContainText("Playwright Library");
});
