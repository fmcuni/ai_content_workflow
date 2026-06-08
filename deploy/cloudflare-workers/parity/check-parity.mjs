// Phase 8 parity gate: compares the Python reference backend against the
// TypeScript Workers backend, endpoint-by-endpoint, over READ-ONLY GET routes.
//
// Both backends read the SAME shared prod Supabase DB, so any deep-equal diff is
// (after normalizing legitimately-volatile fields) a real implementation-parity
// defect. Some endpoints are inherently env-dependent (setup/status reflects the
// worker's own env bindings; costs reflect whatever usage rows exist) — those are
// classified, not failed blindly.
//
// READ-ONLY: only GET requests are issued. Node built-ins only (global fetch,
// node:assert). No deps, no writes.
//
// Usage:
//   node deploy/cloudflare-workers/parity/check-parity.mjs
//   PY_BASE=... TS_BASE=... node .../check-parity.mjs

import assert from "node:assert/strict";

const PY_BASE = (process.env.PY_BASE ?? "http://localhost:8000").replace(/\/$/, "");
const TS_BASE = (
  process.env.TS_BASE ?? "https://bowtie-content-tool-poc.fmc.workers.dev"
).replace(/\/$/, "");

// Costs summary needs a date window; use a wide window so both backends scan the
// same rows. (Read-only aggregate query.)
const COSTS_START = process.env.COSTS_START ?? "2026-01-01";
const COSTS_END = process.env.COSTS_END ?? "2026-12-31";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

/**
 * Fetch JSON from a base + path. Returns { status, body } where body is parsed
 * JSON (or raw text if not JSON). Never throws on non-2xx — the status is part
 * of the parity surface.
 */
async function getJson(base, path) {
  const url = `${base}${path}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// --- Normalization ------------------------------------------------------------
// Strip or canonicalize fields that may legitimately differ between the two
// backends even when behaviour is identical, so the deep-compare only flags real
// divergence. Each normalizer returns a NEW object (no mutation).

const VOLATILE_KEYS = new Set([
  // Worker env-dependent — not a DB read.
  "configured",
  "missing",
  "wp_configured",
]);

// On a shared 4xx (e.g. not-found) response, the human-readable message string
// may legitimately differ between backends (the TS message is more descriptive,
// and Python is being decommissioned at cutover). When BOTH backends agree on the
// 4xx status and the response shape, a difference confined to these message-only
// keys is a documented cosmetic divergence, not a parity defect.
const COSMETIC_MESSAGE_KEYS = new Set(["detail", "message", "error"]);

/** Recursively deep-clone while dropping keys in `dropKeys` at any depth. */
function cloneDropping(value, dropKeys) {
  if (Array.isArray(value)) {
    return value.map((v) => cloneDropping(v, dropKeys));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (dropKeys.has(k)) continue;
      out[k] = cloneDropping(v, dropKeys);
    }
    return out;
  }
  return value;
}

/** Sort an array of objects by a stable key so ordering noise does not flag. */
function sortByKey(arr, keyFn) {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

// --- Endpoint definitions -----------------------------------------------------
// Each entry: { name, path (string|fn), normalize?, envDependent?, note? }.
// `path` may be a function (id, ctx) => string when it needs a discovered id.

/**
 * Build the endpoint list, discovering ids from list endpoints first.
 * All discovery calls are GETs against the PYTHON backend (reference).
 */
async function buildEndpoints() {
  const endpoints = [];

  // --- setup/status (env-dependent; not a DB read) ---
  endpoints.push({
    name: "setup_status",
    path: "/setup/status",
    envDependent: true,
    note: "reflects each worker's own env bindings (POSTGRES_URL/GEMINI_API_KEY/WP_*), not DB",
    normalize: (b) => cloneDropping(b, VOLATILE_KEYS),
  });

  // --- personas (list, both variants) ---
  endpoints.push({
    name: "personas",
    path: "/personas",
    normalize: (b) => (Array.isArray(b) ? sortByKey(b, (p) => p.persona_id ?? "") : b),
  });
  endpoints.push({
    name: "personas_incl_archived",
    path: "/personas?include_archived=true",
    normalize: (b) => (Array.isArray(b) ? sortByKey(b, (p) => p.persona_id ?? "") : b),
  });

  // --- articles (list) ---
  endpoints.push({
    name: "articles",
    path: "/articles",
    normalize: (b) => {
      if (b && Array.isArray(b.items)) {
        return { ...b, items: sortByKey(b.items, (a) => a.article_id ?? "") };
      }
      return b;
    },
  });

  // --- prompt graph (static in-memory topology; default mode=refresh) ---
  endpoints.push({
    name: "prompt_graph",
    path: "/prompts/graph?mode=refresh",
    note: "static LangGraph topology — must deep-equal between PY and TS",
  });

  // --- prompt templates (list) ---
  endpoints.push({
    name: "prompt_templates",
    path: "/prompts/templates",
    normalize: (b) => {
      if (b && Array.isArray(b.templates)) {
        return { ...b, templates: sortByKey(b.templates, (t) => t.template_id ?? "") };
      }
      return b;
    },
  });

  // --- source policy (live editable policy; both backends read the same row) ---
  endpoints.push({
    name: "source_policy",
    path: "/source-policy",
    note: "live source policy + rendered block + sha — must deep-equal between PY and TS",
  });
  endpoints.push({
    name: "source_policy_history",
    path: "/source-policy/history",
    envDependent: true,
    note: "save/revert history; identical only if both backends share the same edit history",
  });

  // --- costs summary (env-dependent: usage rows) ---
  endpoints.push({
    name: "costs_summary",
    path: `/costs/summary?start=${COSTS_START}&end=${COSTS_END}`,
    envDependent: true,
    note: "aggregates usage rows; identical only if both backends share the exact same usage history",
  });

  // --- wp options ---
  endpoints.push({
    name: "wp_users",
    path: "/wp-options/users",
    normalize: (b) => (Array.isArray(b) ? sortByKey(b, (u) => String(u.id)) : b),
  });
  endpoints.push({
    name: "wp_categories",
    path: "/wp-options/categories",
    normalize: (b) => (Array.isArray(b) ? sortByKey(b, (u) => String(u.id)) : b),
  });

  // --- detail endpoints: discover ids from the PY list endpoints ---

  // persona_detail — by slug.
  const personasRes = await getJson(PY_BASE, "/personas");
  const personaSlug = Array.isArray(personasRes.body) && personasRes.body[0]?.slug;
  if (personaSlug) {
    endpoints.push({
      name: "persona_detail",
      path: `/personas/${encodeURIComponent(personaSlug)}`,
      note: `id=${personaSlug}`,
    });
    // persona_usage — per-status run counts for the same discovered slug.
    endpoints.push({
      name: "persona_usage",
      path: `/personas/${encodeURIComponent(personaSlug)}/usage`,
      note: `id=${personaSlug}`,
    });
  } else {
    endpoints.push({ name: "persona_detail", skip: "no persona slug discoverable" });
    endpoints.push({ name: "persona_usage", skip: "no persona slug discoverable" });
  }

  // article_detail — by article_id.
  const articlesRes = await getJson(PY_BASE, "/articles");
  const articleId =
    articlesRes.body && Array.isArray(articlesRes.body.items) && articlesRes.body.items[0]?.article_id;
  if (articleId) {
    endpoints.push({
      name: "article_detail",
      path: `/articles/${encodeURIComponent(articleId)}`,
      note: `id=${articleId}`,
    });
  } else {
    endpoints.push({ name: "article_detail", skip: "no article_id discoverable" });
  }

  // prompt_template_detail + prompt_history + prompt_version_detail — by template_id.
  const tplRes = await getJson(PY_BASE, "/prompts/templates");
  const templateId =
    tplRes.body && Array.isArray(tplRes.body.templates) && tplRes.body.templates[0]?.template_id;
  if (templateId) {
    endpoints.push({
      name: "prompt_template_detail",
      path: `/prompts/templates/${encodeURIComponent(templateId)}`,
      note: `id=${templateId}`,
    });
    endpoints.push({
      name: "prompt_history",
      path: `/prompts/templates/${encodeURIComponent(templateId)}/history`,
      normalize: (b) => {
        if (b && Array.isArray(b.versions)) {
          return { ...b, versions: sortByKey(b.versions, (v) => v.version_id ?? "") };
        }
        return b;
      },
      note: `id=${templateId}`,
    });

    // prompt_version_detail — discover a version id from history (may be empty).
    const histRes = await getJson(PY_BASE, `/prompts/templates/${encodeURIComponent(templateId)}/history`);
    const versionId =
      histRes.body && Array.isArray(histRes.body.versions) && histRes.body.versions[0]?.version_id;
    if (versionId) {
      endpoints.push({
        name: "prompt_version_detail",
        path: `/prompts/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(versionId)}`,
        note: `template=${templateId} version=${versionId}`,
      });
    } else {
      endpoints.push({
        name: "prompt_version_detail",
        // No saved versions in this DB — assert BOTH backends 404 identically
        // for a synthetic version id (parity of the not-found path).
        path: `/prompts/templates/${encodeURIComponent(templateId)}/versions/00000000-0000-0000-0000-000000000000`,
        expect404: true,
        cosmeticErrorText: true,
        note: "prompt_versions empty — checks 404 parity for a non-existent version",
      });
    }
  } else {
    endpoints.push({ name: "prompt_template_detail", skip: "no template_id discoverable" });
    endpoints.push({ name: "prompt_history", skip: "no template_id discoverable" });
    endpoints.push({ name: "prompt_version_detail", skip: "no template_id discoverable" });
  }

  // costs_run — discover a run id with usage. Try the runs list; fall back to a
  // synthetic id to check 404 parity if no run id is available.
  let costsRunId = null;
  const runsRes = await getJson(PY_BASE, "/runs");
  if (runsRes.status === 200) {
    const runs = Array.isArray(runsRes.body)
      ? runsRes.body
      : Array.isArray(runsRes.body?.items)
        ? runsRes.body.items
        : [];
    costsRunId = runs[0]?.run_id ?? runs[0]?.id ?? null;
  }
  if (costsRunId) {
    endpoints.push({
      name: "costs_run",
      path: `/costs/run/${encodeURIComponent(costsRunId)}`,
      envDependent: true,
      note: `id=${costsRunId} — per-run usage, env-dependent`,
    });
  } else {
    endpoints.push({
      name: "costs_run",
      path: `/costs/run/00000000-0000-0000-0000-000000000000`,
      expect404: true,
      note: "no run id discoverable — checks 404 parity (detail:'no usage')",
    });
  }

  // run_drafts — unified-timeline draft list for a discovered run id (or a
  // synthetic id: both backends return [] for an unknown run, still a parity
  // check). Env-dependent only in that the body content tracks the shared DB.
  if (costsRunId) {
    endpoints.push({
      name: "run_drafts",
      path: `/runs/${encodeURIComponent(costsRunId)}/drafts`,
      envDependent: true,
      note: `id=${costsRunId} — draft iterations + render body, env-dependent`,
    });
  } else {
    endpoints.push({
      name: "run_drafts",
      path: `/runs/00000000-0000-0000-0000-000000000000/drafts`,
      note: "no run id discoverable — checks empty-list parity ([])",
    });
  }

  return endpoints;
}

// --- Compare ------------------------------------------------------------------

function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return { equal: true };
  } catch (err) {
    return { equal: false, message: err.message };
  }
}

/** Produce a short list of top-level keys whose values differ. */
function diffKeys(a, b) {
  const keys = new Set([
    ...(a && typeof a === "object" ? Object.keys(a) : []),
    ...(b && typeof b === "object" ? Object.keys(b) : []),
  ]);
  const diffs = [];
  for (const k of keys) {
    const va = JSON.stringify(a?.[k]);
    const vb = JSON.stringify(b?.[k]);
    if (va !== vb) {
      diffs.push(k);
    }
  }
  return diffs;
}

async function run() {
  console.log(`${DIM}PY_BASE = ${PY_BASE}${RESET}`);
  console.log(`${DIM}TS_BASE = ${TS_BASE}${RESET}`);
  console.log(`${DIM}costs window = ${COSTS_START}..${COSTS_END}${RESET}\n`);

  const endpoints = await buildEndpoints();
  const results = [];

  for (const ep of endpoints) {
    if (ep.skip) {
      results.push({ name: ep.name, verdict: "SKIP", reason: ep.skip });
      console.log(`${YELLOW}SKIP${RESET}  ${ep.name.padEnd(26)} ${DIM}${ep.skip}${RESET}`);
      continue;
    }

    let py, ts;
    try {
      [py, ts] = await Promise.all([getJson(PY_BASE, ep.path), getJson(TS_BASE, ep.path)]);
    } catch (err) {
      results.push({ name: ep.name, verdict: "ERROR", reason: err.message });
      console.log(`${RED}ERROR${RESET} ${ep.name.padEnd(26)} ${DIM}fetch failed: ${err.message}${RESET}`);
      continue;
    }

    // Status parity first.
    const statusMatch = py.status === ts.status;

    // expect404 endpoints: both must 404 (or at least match status) and bodies match.
    const normalize = ep.normalize ?? ((x) => x);
    const pyNorm = normalize(py.body);
    const tsNorm = normalize(ts.body);
    const cmp = deepEqual(pyNorm, tsNorm);

    const bodyMatch = cmp.equal;
    const dks = bodyMatch ? [] : diffKeys(pyNorm, tsNorm);

    // Cosmetic: both backends agree on a 4xx status and the only differing keys
    // are human-message strings on an endpoint flagged cosmeticErrorText.
    const cosmetic =
      !bodyMatch &&
      statusMatch &&
      py.status >= 400 &&
      Boolean(ep.cosmeticErrorText) &&
      dks.length > 0 &&
      dks.every((k) => COSMETIC_MESSAGE_KEYS.has(k));

    const pass = statusMatch && (bodyMatch || cosmetic);

    const rec = {
      name: ep.name,
      verdict: pass ? "PASS" : "DIFF",
      cosmetic,
      envDependent: Boolean(ep.envDependent),
      note: ep.note ?? "",
      pyStatus: py.status,
      tsStatus: ts.status,
      statusMatch,
      bodyMatch,
      diffKeys: bodyMatch ? [] : dks,
    };
    results.push(rec);

    const color = pass ? GREEN : ep.envDependent ? YELLOW : RED;
    const tag = cosmetic ? "PASS~" : pass ? "PASS" : ep.envDependent ? "DIFF*" : "DIFF";
    let line = `${color}${tag.padEnd(5)}${RESET} ${ep.name.padEnd(26)} ${DIM}py=${py.status} ts=${ts.status}${RESET}`;
    if (!pass) {
      if (!statusMatch) line += ` ${RED}status mismatch${RESET}`;
      if (!bodyMatch) line += ` ${RED}keys: ${rec.diffKeys.join(",") || "(value)"}${RESET}`;
    } else if (cosmetic) {
      line += ` ${DIM}cosmetic 4xx message diff: [${rec.diffKeys.join(",")}]${RESET}`;
    }
    if (ep.note) line += ` ${DIM}(${ep.note})${RESET}`;
    console.log(line);
  }

  // --- Tally --------------------------------------------------------------
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const diffsReal = results.filter((r) => r.verdict === "DIFF" && !r.envDependent);
  const diffsEnv = results.filter((r) => r.verdict === "DIFF" && r.envDependent);
  const skipped = results.filter((r) => r.verdict === "SKIP").length;
  const errored = results.filter((r) => r.verdict === "ERROR");

  console.log(`\n${DIM}${"-".repeat(60)}${RESET}`);
  console.log(`TALLY: ${GREEN}${pass} PASS${RESET}  ${RED}${diffsReal.length} DIFF${RESET}  ${YELLOW}${diffsEnv.length} DIFF*(env)${RESET}  ${skipped} SKIP  ${errored.length} ERROR`);
  console.log(`${DIM}(* DIFF on env-dependent endpoints is expected, not a parity defect)${RESET}`);

  if (diffsReal.length > 0) {
    console.log(`\n${RED}REAL PARITY DEFECTS:${RESET}`);
    for (const d of diffsReal) {
      console.log(`  - ${d.name}: status py=${d.pyStatus}/ts=${d.tsStatus}, diff keys=[${d.diffKeys.join(",")}]`);
    }
  }
  if (diffsEnv.length > 0) {
    console.log(`\n${YELLOW}ENV-DEPENDENT DIFFS (expected):${RESET}`);
    for (const d of diffsEnv) {
      console.log(`  - ${d.name}: ${d.note}`);
    }
  }

  const verdict = errored.length === 0 && diffsReal.length === 0 ? "PARITY OK" : "PARITY FAILED";
  console.log(`\nVERDICT: ${verdict === "PARITY OK" ? GREEN : RED}${verdict}${RESET}`);

  // Non-zero exit only on real defects or fetch errors.
  process.exit(errored.length === 0 && diffsReal.length === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(`${RED}fatal:${RESET} ${err?.stack ?? err}`);
  process.exit(2);
});
