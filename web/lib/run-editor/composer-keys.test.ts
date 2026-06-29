import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";

import { onComposerKeyDown } from "./composer-keys";

function evt(part: Partial<KeyboardEvent>): KeyboardEvent {
  return { preventDefault: vi.fn(), metaKey: false, ctrlKey: false, ...part } as KeyboardEvent;
}

describe("onComposerKeyDown", () => {
  it("submits on ⌘↵ and ctrl+↵", () => {
    const submit = vi.fn();
    onComposerKeyDown(evt({ key: "Enter", metaKey: true }), submit);
    onComposerKeyDown(evt({ key: "Enter", ctrlKey: true }), submit);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("does not submit on bare Enter", () => {
    const submit = vi.fn();
    onComposerKeyDown(evt({ key: "Enter" }), submit);
    expect(submit).not.toHaveBeenCalled();
  });

  it("cancels on Escape only when a cancel handler is given", () => {
    const submit = vi.fn();
    const cancel = vi.fn();
    onComposerKeyDown(evt({ key: "Escape" }), submit, cancel);
    expect(cancel).toHaveBeenCalledTimes(1);
    // No cancel handler → Escape is a no-op (does not throw).
    expect(() => onComposerKeyDown(evt({ key: "Escape" }), submit)).not.toThrow();
  });
});
