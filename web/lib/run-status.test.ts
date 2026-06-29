import { describe, expect, it } from "vitest";

import {
  statusHasDraft,
  statusIsTransient,
  statusLabel,
  statusPill,
  statusStampTone,
  statusTone,
  type StatusTone,
} from "@/lib/run-status";

import type { RunStatus } from "@/lib/types";

// The full live RunStatus union — the matrix below must cover every member so a
// new status can't silently land unmapped (regression ae44135: no run invisible).
const ALL_STATUSES: RunStatus[] = [
  "pending",
  "fetching",
  "strategy",
  "hitl_1",
  "production",
  "hitl_2",
  "publishing",
  "revising",
  "persisted",
  "published",
  "failed",
  "cancelled",
  "rejected",
  "changes_requested",
];

describe("statusLabel", () => {
  it("maps hitl_2 → 'drafted'", () => {
    expect(statusLabel("hitl_2")).toBe("drafted");
  });

  it("maps hitl_1 → 'outlined'", () => {
    expect(statusLabel("hitl_1")).toBe("outlined");
  });

  it.each([
    ["published", "published"],
    ["failed", "failed"],
    ["rejected", "rejected"],
    ["publishing", "publishing"],
    ["revising", "revising"],
    ["changes_requested", "changes_requested"],
  ])("renders %s under its literal name", (status, expected) => {
    expect(statusLabel(status)).toBe(expected);
  });

  it("returns the raw string for an unknown status (never empty)", () => {
    expect(statusLabel("some_future_state")).toBe("some_future_state");
  });

  it("never yields an empty label for any live status", () => {
    for (const s of ALL_STATUSES) {
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
  });
});

describe("statusTone", () => {
  const cases: Array<[RunStatus, StatusTone]> = [
    ["hitl_1", "amber"],
    ["hitl_2", "amber"],
    ["changes_requested", "amber"],
    ["pending", "blue"],
    ["fetching", "blue"],
    ["strategy", "blue"],
    ["production", "blue"],
    ["publishing", "blue"],
    ["revising", "blue"],
    ["persisted", "green"],
    ["published", "green"],
    ["failed", "red"],
    ["cancelled", "gray"],
    ["rejected", "gray"],
  ];

  it.each(cases)("maps %s → %s", (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });

  it("covers the entire RunStatus union", () => {
    // Sanity: the case table is the union, with no gaps.
    expect(new Set(cases.map(([s]) => s))).toEqual(new Set(ALL_STATUSES));
  });

  it("falls back to blue (in-progress) for an unknown status", () => {
    expect(statusTone("some_future_state")).toBe("blue");
  });
});

describe("statusPill", () => {
  it("returns non-empty pill + dot classes for every live status", () => {
    for (const s of ALL_STATUSES) {
      const { pill, dot } = statusPill(s);
      expect(pill).toMatch(/\S/);
      expect(dot).toMatch(/\S/);
    }
  });

  it("colours transient/pending states blue (info)", () => {
    expect(statusPill("publishing")).toEqual({ pill: "bg-info/10 text-info", dot: "bg-info" });
  });

  it("colours gates amber (warn)", () => {
    expect(statusPill("hitl_2")).toEqual({ pill: "bg-warn/10 text-warn", dot: "bg-warn" });
  });

  it("colours failures red and falls back safely for unknowns", () => {
    expect(statusPill("failed")).toEqual({ pill: "bg-accent/10 text-accent-deep", dot: "bg-accent-deep" });
    // unknown → blue tone → never an empty pill
    expect(statusPill("mystery").pill).toMatch(/\S/);
  });
});

describe("statusIsTransient", () => {
  it.each(["fetching", "strategy", "production", "publishing", "revising"])(
    "%s is transient (pulses)",
    (s) => {
      expect(statusIsTransient(s)).toBe(true);
    },
  );

  it.each(["pending", "hitl_1", "hitl_2", "published", "failed", "rejected", "cancelled"])(
    "%s is not transient",
    (s) => {
      expect(statusIsTransient(s)).toBe(false);
    },
  );
});

describe("statusHasDraft", () => {
  // Regression: a published run with no SEO meta must still be treated as having
  // a draft, so the drawer preview never shows "agents still working" for it.
  it.each(["hitl_2", "publishing", "revising", "persisted", "published", "changes_requested"])(
    "%s has a draft",
    (s) => {
      expect(statusHasDraft(s)).toBe(true);
    },
  );

  it.each(["pending", "fetching", "strategy", "hitl_1", "production", "failed", "cancelled", "rejected"])(
    "%s has no draft",
    (s) => {
      expect(statusHasDraft(s)).toBe(false);
    },
  );

  it("covers the entire RunStatus union (no status left unclassified)", () => {
    for (const s of ALL_STATUSES) {
      expect(typeof statusHasDraft(s)).toBe("boolean");
    }
  });

  it("treats an unknown status as no-draft (conservative)", () => {
    expect(statusHasDraft("some_future_state")).toBe(false);
  });
});

describe("statusStampTone (PaperStamp bridge)", () => {
  it("bridges every tone bucket to a PaperStamp tone", () => {
    expect(statusStampTone("hitl_2")).toBe("warn");
    expect(statusStampTone("publishing")).toBe("info");
    expect(statusStampTone("published")).toBe("ok");
    expect(statusStampTone("failed")).toBe("danger");
    expect(statusStampTone("rejected")).toBe("neutral");
    expect(statusStampTone("unknown")).toBe("info");
  });
});
