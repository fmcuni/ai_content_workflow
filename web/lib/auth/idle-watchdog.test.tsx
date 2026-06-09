import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { useIdleWatchdog } from "./idle-watchdog";

function Harness({ onExpire, enabled }: { onExpire: () => void; enabled?: boolean }) {
  useIdleWatchdog({ onExpire, timeoutMs: 1000, enabled });
  return null;
}

describe("useIdleWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("fires onExpire after the idle timeout elapses", () => {
    const onExpire = vi.fn();
    render(<Harness onExpire={onExpire} />);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("resets the timer on user activity so it does not expire early", () => {
    const onExpire = vi.fn();
    render(<Harness onExpire={onExpire} />);

    vi.advanceTimersByTime(900);
    // Activity just before expiry should reset the countdown.
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(900);
    expect(onExpire).not.toHaveBeenCalled();

    // After a fresh full interval with no activity, it fires.
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled", () => {
    const onExpire = vi.fn();
    render(<Harness onExpire={onExpire} enabled={false} />);
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("clears the timer on unmount", () => {
    const onExpire = vi.fn();
    const { unmount } = render(<Harness onExpire={onExpire} />);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
