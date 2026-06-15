/**
 * Phase A — per-voice locale on the persona CRUD routes (TypeScript backend).
 *
 * Exercises the real Hono persona handlers against a stateful fake `sql`
 * (vi.mock on ../db/client), asserting:
 *   - POST create with a snake_case `locale` persists it as snake_case JSONB and
 *     round-trips it in the 201 response.
 *   - PUT update with `locale` replaces the whole object (snake_case round-trip).
 *   - PUT update WITHOUT `locale` leaves the column untouched (COALESCE → the
 *     locale bound param is null, so the stored value survives).
 *   - A bad `ui_lang` (outside {zh-Hant,en}) → 422 on both create and update.
 *   - POST create without `locale` stores the HK-ZH defaults (no-op).
 *
 * Plus a unit check that `voiceLocaleFromRaw` maps the stored snake_case raw to
 * the internal camelCase VoiceLocale (the camel↔snake boundary), and that
 * `defaultVoiceLocale` is the byte-identical HK-ZH no-op.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface PersonaRowLite {
  persona_id: string;
  slug: string;
  name: string;
  voice_rules: unknown;
  banned_terms: unknown;
  required_phrasings: unknown;
  disclaimer_templates: unknown;
  tone_examples: unknown;
  glossary: unknown;
  locale: unknown;
  publish_target_id: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

const LOCALE_MY_EN = {
  output_language: "English",
  brand_name: "Bowtie MY",
  market: "Google Malaysia EN",
  sources_heading: "Sources",
  faq_heading: "Frequently Asked Questions",
  ui_lang: "en",
};

const HK_ZH_DEFAULTS = {
  output_language: "香港繁體中文",
  brand_name: "Bowtie",
  market: "Google 香港繁中",
  sources_heading: null,
  faq_heading: "常見問題",
  ui_lang: "zh-Hant",
};

const state: { userRole: string | null; persona: PersonaRowLite | null } = {
  userRole: "admin",
  persona: null,
};

interface Fragment {
  __frag: true;
  text: string;
}
interface JsonParam {
  __json: true;
  value: unknown;
}
function isFragment(v: unknown): v is Fragment {
  return typeof v === "object" && v !== null && "__frag" in v;
}
function isJson(v: unknown): v is JsonParam {
  return typeof v === "object" && v !== null && "__json" in v;
}
function renderText(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    if (isFragment(values[i])) out += (values[i] as Fragment).text;
    out += strings[i + 1] ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

function baseRow(): PersonaRowLite {
  return {
    persona_id: "00000000-0000-0000-0000-0000000000aa",
    slug: "v",
    name: "V",
    voice_rules: [],
    banned_terms: [],
    required_phrasings: [],
    disclaimer_templates: {},
    tone_examples: { good: [], bad: [] },
    glossary: [],
    locale: {},
    publish_target_id: null,
    is_archived: false,
    created_at: "2026-06-15 00:00:00+00",
    updated_at: "2026-06-15 00:00:00+00",
    created_by: null,
    updated_by: null,
  };
}

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = renderText(strings, values);
    const lower = text.toLowerCase();
    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }
    const params = values.filter((v) => !isFragment(v));

    if (lower.startsWith("select")) {
      if (lower.includes("from content_tool.app_user")) {
        return [{ role: state.userRole }];
      }
      if (lower.includes("from content_tool.personas")) {
        return state.persona === null ? [] : [state.persona];
      }
      return [];
    }

    if (lower.startsWith("insert")) {
      // createPersona param order: slug, name, voice_rules, banned_terms,
      // required_phrasings, disclaimer_templates, tone_examples, glossary, locale.
      const localeParam = params[8];
      const locale = isJson(localeParam) ? localeParam.value : {};
      state.persona = {
        ...baseRow(),
        slug: String(params[0]),
        name: String(params[1]),
        locale,
      };
      return [state.persona];
    }

    if (lower.startsWith("update")) {
      if (state.persona === null) return [];
      // updatePersona SET ... locale = COALESCE(${null | jsonparam}, locale).
      // The locale bind is the 7th jsonb-or-null param (name, voice_rules,
      // banned_terms, required_phrasings, disclaimer_templates, tone_examples,
      // glossary, locale). Find the locale COALESCE arg: it is the param that is
      // either a JsonParam or null sitting in the "locale =" position. We locate
      // it structurally by scanning for the json param whose value has ui_lang.
      const jsonLocale = params.find(
        (p) => isJson(p) && typeof (p as JsonParam).value === "object" &&
          (p as JsonParam).value !== null &&
          "ui_lang" in ((p as JsonParam).value as Record<string, unknown>),
      );
      const nameParam = params[0];
      state.persona = {
        ...state.persona,
        name: typeof nameParam === "string" ? nameParam : state.persona.name,
        locale: jsonLocale ? (jsonLocale as JsonParam).value : state.persona.locale,
      };
      return [state.persona];
    }
    return [];
  };
  (sql as unknown as { json: (v: unknown) => JsonParam }).json = (v: unknown) => ({
    __json: true,
    value: v,
  });
  (sql as unknown as { unsafe: (s: string) => Fragment }).unsafe = (s: string) => ({
    __frag: true,
    text: s,
  });
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));

import { Hono } from "hono";
import { requireRole } from "../auth/authz";
import personasRouter from "./personas";
import type { AuthVars } from "../auth/middleware";
import { defaultVoiceLocale, voiceLocaleFromRaw } from "../agents/persona";

function buildApp(): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", "admin@bowtie.com.hk");
    await next();
  });
  app.post("/personas", requireRole("admin"));
  app.put("/personas/:slug", requireRole("admin"));
  app.route("/personas", personasRouter);
  return app;
}

function makeEnv(): Record<string, unknown> {
  return {
    AUTH_DISABLED: "false",
    FRONTEND_ORIGIN: "https://example.test",
    BOOTSTRAP_ADMIN_EMAILS: "",
  };
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

async function req(path: string, init: RequestInit): Promise<Response> {
  return buildApp().request(path, init, makeEnv(), ctx);
}

const JSON_HEADERS = { "content-type": "application/json" };
const CREATE_BASE = {
  voice_rules: [],
  banned_terms: [],
  required_phrasings: [],
  disclaimer_templates: {},
  tone_examples: { good: [], bad: [] },
};

beforeEach(() => {
  state.userRole = "admin";
  state.persona = null;
});

describe("persona locale CRUD (snake_case wire contract)", () => {
  it("POST create persists + round-trips a snake_case locale", async () => {
    const res = await req("/personas", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: "loc-create", name: "Loc", ...CREATE_BASE, locale: LOCALE_MY_EN }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { locale: typeof LOCALE_MY_EN };
    expect(json.locale).toEqual(LOCALE_MY_EN);
    // Stored value is snake_case.
    expect(state.persona?.locale).toEqual(LOCALE_MY_EN);
  });

  it("POST create without locale stores HK-ZH defaults (no-op)", async () => {
    const res = await req("/personas", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: "loc-default", name: "Loc", ...CREATE_BASE }),
    });
    expect(res.status).toBe(201);
    expect(state.persona?.locale).toEqual(HK_ZH_DEFAULTS);
  });

  it("PUT update replaces the whole locale (snake_case round-trip)", async () => {
    state.persona = { ...baseRow(), slug: "loc-edit", name: "Loc", locale: {} };
    const res = await req("/personas/loc-edit", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ locale: LOCALE_MY_EN }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { locale: typeof LOCALE_MY_EN };
    expect(json.locale).toEqual(LOCALE_MY_EN);
    expect(state.persona?.locale).toEqual(LOCALE_MY_EN);
  });

  it("PUT update without locale leaves the column untouched", async () => {
    state.persona = { ...baseRow(), slug: "loc-keep", name: "Loc", locale: LOCALE_MY_EN };
    const res = await req("/personas/loc-keep", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string; locale: typeof LOCALE_MY_EN };
    expect(json.name).toBe("Renamed");
    expect(json.locale).toEqual(LOCALE_MY_EN);
  });

  it("POST create with a bad ui_lang → 422", async () => {
    const res = await req("/personas", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: "loc-bad",
        name: "Bad",
        ...CREATE_BASE,
        locale: { ...LOCALE_MY_EN, ui_lang: "fr" },
      }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT update with a bad ui_lang → 422", async () => {
    state.persona = { ...baseRow(), slug: "loc-bad", name: "Bad", locale: {} };
    const res = await req("/personas/loc-bad", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ locale: { ...LOCALE_MY_EN, ui_lang: "zh-Hans" } }),
    });
    expect(res.status).toBe(422);
  });
});

describe("voiceLocaleFromRaw camel↔snake mapping", () => {
  it("maps stored snake_case raw to the internal camelCase VoiceLocale", () => {
    const got = voiceLocaleFromRaw(LOCALE_MY_EN);
    expect(got).toEqual({
      outputLanguage: "English",
      brandName: "Bowtie MY",
      market: "Google Malaysia EN",
      sourcesHeading: "Sources",
      faqHeading: "Frequently Asked Questions",
      uiLang: "en",
    });
  });

  it("empty {} raw → HK-ZH defaults (byte-identical no-op)", () => {
    expect(voiceLocaleFromRaw({})).toEqual(defaultVoiceLocale());
    expect(defaultVoiceLocale()).toEqual({
      outputLanguage: "香港繁體中文",
      brandName: "Bowtie",
      market: "Google 香港繁中",
      sourcesHeading: null,
      faqHeading: "常見問題",
      uiLang: "zh-Hant",
    });
  });
});
