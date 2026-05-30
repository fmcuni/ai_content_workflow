import { test, expect, type Page } from "@playwright/test";

// The dev backend is already configured, so we mock /api/setup/* at the browser
// layer (before Next's rewrite) to exercise first-run states deterministically.

type Json = Record<string, unknown>;

async function mockStatus(page: Page, body: Json) {
  await page.route("**/api/setup/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

const UNCONFIGURED = {
  configured: false,
  missing: ["postgres_url", "gemini_api_key"],
  wp_configured: false,
};

async function fillRequiredFields(page: Page) {
  await page.getByLabel("Gemini API key").fill("AIza-test-key");
  await page
    .getByLabel("Supabase / Postgres URL")
    .fill("postgresql+asyncpg://u:p@localhost:5432/postgres");
}

test("unconfigured backend shows the setup screen and hides app nav", async ({ page }) => {
  await mockStatus(page, UNCONFIGURED);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Connect your services" })).toBeVisible();
  // App chrome (masthead nav) must not render before configuration.
  await expect(page.getByRole("link", { name: "Library" })).toHaveCount(0);
});

test("test connection surfaces per-check results", async ({ page }) => {
  await mockStatus(page, UNCONFIGURED);
  await page.route("**/api/setup/verify", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ postgres: true, gemini: false }),
    }),
  );
  await page.goto("/");

  await fillRequiredFields(page);
  await page.getByRole("button", { name: "Test connection" }).click();

  await expect(page.getByText("Postgres", { exact: true })).toBeVisible();
  await expect(page.getByText("✓ reachable")).toBeVisible();
  await expect(page.getByText("✗ failed")).toBeVisible();
});

test("verification failure on save does not advance", async ({ page }) => {
  await mockStatus(page, UNCONFIGURED);
  await page.route("**/api/setup", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        detail: "verification_failed",
        checks: { postgres: false, gemini: true },
      }),
    }),
  );
  await page.goto("/");

  await fillRequiredFields(page);
  await page.getByRole("button", { name: "Save & continue" }).click();

  // Still on the setup screen; the check panel reflects the failure.
  await expect(page.getByRole("heading", { name: "Connect your services" })).toBeVisible();
  await expect(page.getByText("✗ failed")).toBeVisible();
});

test("successful save advances into the app without reload", async ({ page }) => {
  let configured = false;
  await page.route("**/api/setup/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        configured
          ? { configured: true, missing: [], wp_configured: false }
          : UNCONFIGURED,
      ),
    }),
  );
  await page.route("**/api/setup", (route) => {
    configured = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true }),
    });
  });
  // The app's own data calls (runs/topic-batches) hit the live dev backend;
  // that's fine — we only assert the app chrome appears.
  await page.goto("/");

  await fillRequiredFields(page);
  await page.getByRole("button", { name: "Save & continue" }).click();

  await expect(page.getByRole("link", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your services" })).toHaveCount(0);
});

test("configured backend boots straight into the app", async ({ page }) => {
  await mockStatus(page, { configured: true, missing: [], wp_configured: false });
  await page.goto("/");

  await expect(page.getByRole("link", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your services" })).toHaveCount(0);
});
