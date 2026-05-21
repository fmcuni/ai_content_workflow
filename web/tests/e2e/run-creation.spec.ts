import { expect, test } from "@playwright/test";

test("home → new run form is reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Bowtie AI Content Tool")).toBeVisible();
  await page.getByRole("link", { name: "New article update" }).click();
  await expect(page).toHaveURL(/\/runs\/new/);
  await expect(page.getByPlaceholder("https://www.bowtie.com.hk/blog/zh/...")).toBeVisible();
});
