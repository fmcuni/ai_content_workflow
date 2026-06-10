// Guarded headless browser driver for the DEV web app (Claude debug).
//
//   node scripts/claude-debug/browse.mjs <steps.json | inline-JSON-array>
//
// Loads the storage state minted by login.mjs and executes a small step list,
// e.g.:
//   [
//     {"goto": "/runs"},
//     {"waitFor": "main"},
//     {"dump": "main"},
//     {"click": "text=Some run"},
//     {"shot": "runs.png"}
//   ]
// Steps: goto, waitFor (selector), waitMs, click, clickText, fill [sel, text],
//        press, shot (file under .out/), dump (selector innerText, clipped),
//        dumpLinks (list <a> href+text under optional selector).
//
// GUARDRAILS (dev shares the live WordPress with prod — see CLAUDE.md):
//   - Navigation only to the dev Workers hosts.
//   - Any non-GET request whose path mentions resume/publish/republish is
//     aborted at the network layer (HITL approval/publish can never fire).
//   - Any non-GET request to a host outside {dev web, dev api, dev Supabase}
//     is aborted (no accidental writes to prod or WordPress).
//   - click/clickText refuse elements whose text matches approve/publish/reject.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  DEV_API_HOST,
  DEV_SUPABASE_REF,
  DEV_WEB_HOST,
  DEV_WEB_URL,
  OUT_DIR,
  REPO_ROOT,
  STATE_FILE,
} from "./dev-env.mjs";

const requireWeb = createRequire(path.join(REPO_ROOT, "web", "package.json"));
const { chromium } = requireWeb("@playwright/test");

const NAV_HOSTS = new Set([DEV_WEB_HOST, DEV_API_HOST]);
const WRITE_HOSTS = new Set([DEV_WEB_HOST, DEV_API_HOST, `${DEV_SUPABASE_REF}.supabase.co`]);
const FORBIDDEN_PATH = /(resume|publish|republish)/i;
// Gate-level reject/request-changes go through POST …/resume, which the route
// blocker aborts — so the click guard only needs approve/publish wording.
// Tracked-change accept/reject spans ("activate to accept or reject") stay usable.
const FORBIDDEN_CLICK = /(approve|publish)/i;
const DUMP_CLIP = 6000;

function fail(msg) {
  process.stderr.write(`browse: ${msg}\n`);
  process.exit(1);
}

function resolveUrl(target) {
  const url = new URL(target, DEV_WEB_URL);
  if (!NAV_HOSTS.has(url.hostname)) {
    fail(`navigation to non-dev host refused: ${url.hostname}`);
  }
  return url.toString();
}

const arg = process.argv[2];
if (!arg) fail("usage: node browse.mjs <steps.json | inline JSON array>");
const steps = JSON.parse(arg.trimStart().startsWith("[") ? arg : fs.readFileSync(arg, "utf8"));
if (!Array.isArray(steps)) fail("steps must be a JSON array");
if (!fs.existsSync(STATE_FILE)) fail("no session state — run login.mjs first");

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: STATE_FILE,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

const blocked = [];
await context.route("**/*", (route) => {
  const req = route.request();
  const method = req.method();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue();
  const url = new URL(req.url());
  if (FORBIDDEN_PATH.test(url.pathname) || !WRITE_HOSTS.has(url.hostname)) {
    blocked.push(`${method} ${url.hostname}${url.pathname}`);
    return route.abort();
  }
  return route.continue();
});

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 300)}`));

async function guardedClick(locator, label) {
  const el = locator.first();
  const text = ((await el.textContent()) ?? "") + " " + ((await el.getAttribute("aria-label")) ?? "");
  if (FORBIDDEN_CLICK.test(text)) {
    fail(`refusing to click "${label}" — matches forbidden action (${text.trim().slice(0, 80)})`);
  }
  await el.click();
}

for (const step of steps) {
  const [op, val] = Object.entries(step)[0];
  process.stdout.write(`step: ${op} ${typeof val === "string" ? val : JSON.stringify(val)}\n`);
  if (op === "goto") {
    await page.goto(resolveUrl(val), { waitUntil: "networkidle", timeout: 45_000 });
  } else if (op === "waitFor") {
    await page.waitForSelector(val, { timeout: 30_000 });
  } else if (op === "waitMs") {
    await page.waitForTimeout(val);
  } else if (op === "click") {
    await guardedClick(page.locator(val), val);
  } else if (op === "clickText") {
    await guardedClick(page.getByText(val, { exact: false }), val);
  } else if (op === "fill") {
    await page.locator(val[0]).first().fill(val[1]);
  } else if (op === "press") {
    await page.keyboard.press(val);
  } else if (op === "shot") {
    const file = path.join(OUT_DIR, path.basename(val));
    await page.screenshot({ path: file, fullPage: true });
    process.stdout.write(`shot saved: ${file}\n`);
  } else if (op === "shotView") {
    const file = path.join(OUT_DIR, path.basename(val));
    await page.screenshot({ path: file, fullPage: false });
    process.stdout.write(`shot saved: ${file}\n`);
  } else if (op === "shotEl") {
    const file = path.join(OUT_DIR, path.basename(val[1]));
    await page.locator(val[0]).first().screenshot({ path: file });
    process.stdout.write(`shot saved: ${file}\n`);
  } else if (op === "dump") {
    const text = await page.locator(val).first().innerText({ timeout: 15_000 });
    process.stdout.write(`--- dump ${val} ---\n${text.slice(0, DUMP_CLIP)}\n--- end dump ---\n`);
  } else if (op === "dumpLinks") {
    const links = await page
      .locator(`${val ?? "body"} a[href]`)
      .evaluateAll((as) =>
        as.map((a) => `${a.getAttribute("href")}  ${a.textContent?.trim().slice(0, 60) ?? ""}`),
      );
    process.stdout.write(`--- links ---\n${links.slice(0, 80).join("\n")}\n--- end links ---\n`);
  } else {
    fail(`unknown step op: ${op}`);
  }
}

process.stdout.write(`final url: ${page.url()}\n`);
if (page.url().includes("/login")) {
  process.stdout.write("WARNING: landed on /login — session missing or expired (re-run login.mjs)\n");
}
if (blocked.length) process.stdout.write(`blocked requests:\n${blocked.join("\n")}\n`);
if (consoleErrors.length) {
  process.stdout.write(`console errors (${consoleErrors.length}):\n${consoleErrors.slice(0, 10).join("\n")}\n`);
}
await browser.close();
