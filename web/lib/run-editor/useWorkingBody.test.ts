import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import * as Y from "yjs";

import { useWorkingBody } from "@/lib/run-editor/useWorkingBody";
import { flattenCollabDoc, seedCollabDocIfEmpty } from "@/lib/run-editor/collab-html";

/**
 * Verifies the collab-aware working-body writer:
 * - collab OFF → behaves exactly like setHtml (updater passed through, no ydoc touched).
 * - collab ON → dual-writes: React setHtml gets `next` AND the shared Yjs doc is mutated.
 * - collab ON no-op → setHtml still runs, but the CRDT is NOT mutated (no spurious delta).
 *
 * Uses a real Y.Doc (yjs is a dependency) and the same headless-editor primitives
 * the production helpers use, so the assertions exercise the real CRDT path.
 */

const SEED_HTML = "<p>hello</p>";
const NEXT_HTML = "<p>goodbye</p>";

describe("useWorkingBody", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("collab OFF: passes the updater straight to setHtml and never touches a ydoc", () => {
    const setHtml = vi.fn<(updater: (html: string) => string) => void>();
    const { result } = renderHook(() =>
      useWorkingBody({ collabActive: false, ydoc: null, html: "<p>a</p>", setHtml }),
    );

    const updater = (prev: string) => prev + "x";
    result.current(updater);

    // The updater is forwarded as-is (identical to today's setHtml behaviour).
    expect(setHtml).toHaveBeenCalledTimes(1);
    const forwarded = setHtml.mock.calls[0][0];
    expect(forwarded("<p>a</p>")).toBe("<p>a</p>x");
  });

  it("collab ON: dual-writes — mutates the ydoc to the next HTML AND calls setHtml with next", () => {
    const ydoc = new Y.Doc();
    seedCollabDocIfEmpty(ydoc, SEED_HTML);
    expect(flattenCollabDoc(ydoc)).toBe(SEED_HTML);

    const setHtml = vi.fn<(updater: (html: string) => string) => void>();
    const { result } = renderHook(() =>
      useWorkingBody({ collabActive: true, ydoc, html: SEED_HTML, setHtml }),
    );

    result.current(() => NEXT_HTML);

    // CRDT now reflects the replacement.
    expect(flattenCollabDoc(ydoc)).toBe(NEXT_HTML);
    // React state was also updated with the resolved `next`.
    expect(setHtml).toHaveBeenCalledTimes(1);
    const forwarded = setHtml.mock.calls[0][0];
    expect(forwarded("ignored-prev")).toBe(NEXT_HTML);
  });

  it("collab ON no-op: setHtml still runs but the ydoc is NOT mutated (no spurious delta)", () => {
    const ydoc = new Y.Doc();
    seedCollabDocIfEmpty(ydoc, SEED_HTML);
    const before = Y.encodeStateVector(ydoc);

    const setHtml = vi.fn<(updater: (html: string) => string) => void>();
    const { result } = renderHook(() =>
      useWorkingBody({ collabActive: true, ydoc, html: SEED_HTML, setHtml }),
    );

    // Updater returns content that flattens to the SAME HTML the doc already holds.
    result.current(() => SEED_HTML);

    // setHtml dual-write still fires.
    expect(setHtml).toHaveBeenCalledTimes(1);
    // But the CRDT state vector is unchanged — no replace happened.
    const after = Y.encodeStateVector(ydoc);
    expect(after).toEqual(before);
    expect(flattenCollabDoc(ydoc)).toBe(SEED_HTML);
  });

  it("collab ON: computes next from the latest html via the internal ref (no stale closure)", () => {
    const ydoc = new Y.Doc();
    seedCollabDocIfEmpty(ydoc, SEED_HTML);

    const setHtml = vi.fn<(updater: (html: string) => string) => void>();
    const { result, rerender } = renderHook(
      ({ html }) => useWorkingBody({ collabActive: true, ydoc, html, setHtml }),
      { initialProps: { html: SEED_HTML } },
    );

    // Simulate html state advancing before applyWorking is called.
    rerender({ html: NEXT_HTML });

    // updater appends to the CURRENT html, proving the ref tracks the latest value.
    result.current((prev) => prev.replace("</p>", " more</p>"));

    expect(flattenCollabDoc(ydoc)).toBe("<p>goodbye more</p>");
  });
});
