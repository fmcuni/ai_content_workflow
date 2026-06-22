import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUnsavedGuard } from "@/lib/voice-studio/use-unsaved-guard";

function Harness({ count }: { count: number }) {
  useUnsavedGuard(count);
  return (
    <div>
      {/* Plain anchor on purpose: the guard intercepts raw <a> clicks, which is
          exactly what we are exercising here. */}
      <a href="/other-place">Leave</a>
      <a href={typeof window !== "undefined" ? window.location.pathname : "/"}>Same page</a>
    </div>
  );
}

// The guard registers a capture-phase click listener on `document`. Capture it
// so tests can invoke it with a synthetic event whose `isTrusted` they control —
// jsdom defines `isTrusted` as a non-configurable `false` own property on real
// events, so a dispatched MouseEvent can never simulate a genuine user click.
let captureListener: ((e: MouseEvent) => void) | null = null;
const realAddEventListener = document.addEventListener.bind(document);

beforeEach(() => {
  // jsdom default path is "/"; the same-page link points there.
  window.history.replaceState(null, "", "/voices/bowtie-editor");
  captureListener = null;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "click" && options === true) {
      captureListener = listener as (e: MouseEvent) => void;
    }
    return realAddEventListener(type, listener as EventListener, options);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface SyntheticClickOptions {
  isTrusted?: boolean;
  href?: string;
}

/**
 * Drive the captured capture-phase click listener with a synthetic event over a
 * given anchor. `isTrusted` defaults to true (a genuine user click); pass false
 * to exercise the programmatic-click guard. Returns whether the click was
 * cancelled (preventDefault called).
 */
function fireGuardedClick(anchor: Element, opts: SyntheticClickOptions = {}): boolean {
  let prevented = false;
  const event = {
    isTrusted: opts.isTrusted ?? true,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: anchor,
    preventDefault(): void {
      prevented = true;
      event.defaultPrevented = true;
    },
    stopPropagation(): void {
      throw new Error("stopPropagation must not be called by the guard");
    },
  };
  captureListener?.(event as unknown as MouseEvent);
  return prevented;
}

describe("useUnsavedGuard", () => {
  it("does not arm beforeunload when there are no unsaved changes", () => {
    const event = new Event("beforeunload", { cancelable: true });
    const prevent = vi.spyOn(event, "preventDefault");
    render(<Harness count={0} />);
    window.dispatchEvent(event);
    expect(prevent).not.toHaveBeenCalled();
  });

  it("arms beforeunload while there are unsaved changes, and disarms on unmount", () => {
    const { unmount } = render(<Harness count={2} />);

    const armed = new Event("beforeunload", { cancelable: true });
    const armedPrevent = vi.spyOn(armed, "preventDefault");
    window.dispatchEvent(armed);
    expect(armedPrevent).toHaveBeenCalled();

    unmount();
    const after = new Event("beforeunload", { cancelable: true });
    const afterPrevent = vi.spyOn(after, "preventDefault");
    window.dispatchEvent(after);
    expect(afterPrevent).not.toHaveBeenCalled();
  });

  it("confirms before an in-app navigation away and cancels the click when declined", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByText } = render(<Harness count={1} />);

    const leave = getByText("Leave");
    const prevented = fireGuardedClick(leave);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain("1 unsaved change");
    expect(prevented).toBe(true);
  });

  it("lets the navigation proceed when the confirm is accepted", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { getByText } = render(<Harness count={3} />);

    const leave = getByText("Leave");
    const prevented = fireGuardedClick(leave);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain("3 unsaved changes");
    expect(prevented).toBe(false);
  });

  it("ignores programmatic (untrusted) clicks — only genuine user clicks are guarded", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByText } = render(<Harness count={1} />);

    const leave = getByText("Leave");
    const prevented = fireGuardedClick(leave, { isTrusted: false });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("ignores clicks on a link to the current path (not a navigation away)", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByText } = render(<Harness count={1} />);

    const same = getByText("Same page");
    const prevented = fireGuardedClick(same);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });
});
