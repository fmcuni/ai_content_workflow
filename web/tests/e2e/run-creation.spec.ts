import { expect, test } from "@playwright/test";

test("home → new run form is reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Bowtie · Content Desk")).toBeVisible();
  await page.getByRole("link", { name: "Start a new run →" }).click();
  await expect(page).toHaveURL(/\/runs\/new/);
  await expect(page.getByRole("heading", { name: "Article Assignment" })).toBeVisible();
  await expect(page.getByPlaceholder("https://www.bowtie.com.hk/blog/zh/...")).toBeVisible();
});
