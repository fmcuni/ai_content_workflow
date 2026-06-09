import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { flattenCollabDoc, seedCollabDocIfEmpty } from "@/lib/run-editor/collab-html";
import type { CollabStatus } from "@/lib/run-editor/useCollabDoc";
import { useSeedCollabDoc, type UseSeedCollabDocArgs } from "@/lib/run-editor/useSeedCollabDoc";

const DRAFT_BODY = "draft body";
const DRAFT_HTML = `<p>${DRAFT_BODY}</p>`;

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function args(overrides: Partial<UseSeedCollabDocArgs>): UseSeedCollabDocArgs {
  return {
    ydoc: new Y.Doc(),
    status: "connected" satisfies CollabStatus,
    draftHtml: DRAFT_HTML,
    enabled: true,
    isSeedAuthority: true,
    ...overrides,
  };
}

describe("useSeedCollabDoc", () => {
  it("seeds an empty doc once when connected, and does not re-seed on rerender", async () => {
    const ydoc = new Y.Doc();
    const initial = args({ ydoc });
    const { result, rerender } = renderHook((props: UseSeedCollabDocArgs) => useSeedCollabDoc(props), {
      initialProps: initial,
    });

    await waitFor(() => expect(result.current.seeded).toBe(true));

    const html = flattenCollabDoc(ydoc);
    expect(html).toContain(DRAFT_BODY);
    expect(countOccurrences(html, DRAFT_BODY)).toBe(1);

    // Re-render with identical args — the per-ydoc guard must block re-seeding.
    rerender(initial);
    await waitFor(() => expect(result.current.seeded).toBe(true));
    expect(countOccurrences(flattenCollabDoc(ydoc), DRAFT_BODY)).toBe(1);
  });

  it("does NOT seed before status is connected, then seeds once connected", async () => {
    const ydoc = new Y.Doc();
    const { result, rerender } = renderHook(
      (props: UseSeedCollabDocArgs) => useSeedCollabDoc(props),
      { initialProps: args({ ydoc, status: "connecting" }) },
    );

    expect(result.current.seeded).toBe(false);
    expect(flattenCollabDoc(ydoc)).not.toContain(DRAFT_BODY);

    rerender(args({ ydoc, status: "connected" }));
    await waitFor(() => expect(result.current.seeded).toBe(true));
    expect(flattenCollabDoc(ydoc)).toContain(DRAFT_BODY);
  });

  it("does NOT seed when disabled, even if connected", () => {
    const ydoc = new Y.Doc();
    const { result } = renderHook(() =>
      useSeedCollabDoc(args({ ydoc, enabled: false, status: "connected" })),
    );

    expect(result.current.seeded).toBe(false);
    expect(flattenCollabDoc(ydoc)).not.toContain(DRAFT_BODY);
  });

  it("does NOT re-seed a doc that already has content (returning run)", async () => {
    const ydoc = new Y.Doc();
    // Pre-seed via the real seed path — models a persisted, non-empty RunDoc.
    expect(seedCollabDocIfEmpty(ydoc, "<p>existing</p>")).toBe(true);

    const { result } = renderHook(() =>
      useSeedCollabDoc(args({ ydoc, draftHtml: "<p>new</p>", status: "connected" })),
    );

    // Give any effect a chance to run, then assert it found the doc non-empty.
    await waitFor(() => expect(result.current.seeded).toBe(false));
    const html = flattenCollabDoc(ydoc);
    expect(html).toContain("existing");
    expect(html).not.toContain("new");
  });

  it("does NOT seed when not the seed authority, even if connected + empty", async () => {
    const ydoc = new Y.Doc();
    const { result } = renderHook(() =>
      useSeedCollabDoc(args({ ydoc, isSeedAuthority: false })),
    );

    // Let any effect run, then assert the non-authority never seeded.
    await waitFor(() => expect(result.current.seeded).toBe(false));
    expect(flattenCollabDoc(ydoc)).not.toContain(DRAFT_BODY);
  });

  it("two first-joiners on the SAME shared doc: only the seed authority seeds (no duplication)", async () => {
    // The RunDoc DO designates exactly one connection as the seed authority
    // (isSeedAuthority=true); the other is told false. Even racing on one shared
    // doc, only the authority writes, so content is never duplicated.
    const sharedDoc = new Y.Doc();

    const authority = renderHook(() =>
      useSeedCollabDoc(args({ ydoc: sharedDoc, isSeedAuthority: true })),
    );
    const follower = renderHook(() =>
      useSeedCollabDoc(args({ ydoc: sharedDoc, isSeedAuthority: false })),
    );

    await waitFor(() => expect(authority.result.current.seeded).toBe(true));

    const html = flattenCollabDoc(sharedDoc);
    expect(html).toContain(DRAFT_BODY);
    // Exactly one copy, written by the authority only.
    expect(countOccurrences(html, DRAFT_BODY)).toBe(1);
    expect(authority.result.current.seeded).toBe(true);
    expect(follower.result.current.seeded).toBe(false);
  });
});
