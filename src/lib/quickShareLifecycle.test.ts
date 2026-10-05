import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickShareLifecycle } from "./quickShareLifecycle";

afterEach(() => vi.useRealTimers());

describe("Quick Share dismissal", () => {
  it("disables native hit testing as soon as closing starts", () => {
    vi.useFakeTimers();
    const nativeVisibility = vi.fn();
    const shelf = new QuickShareLifecycle(vi.fn(), vi.fn(), nativeVisibility);
    shelf.open();
    expect(nativeVisibility).toHaveBeenLastCalledWith(true);
    shelf.close();
    expect(nativeVisibility).toHaveBeenLastCalledWith(false);
    shelf.open();
    expect(nativeVisibility).toHaveBeenLastCalledWith(true);
  });
  it("distinguishes hiding a staged shelf from discarding its contents", () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    const shelf = new QuickShareLifecycle(vi.fn(), hide);
    shelf.close(false);
    vi.advanceTimersByTime(120);
    expect(hide).toHaveBeenLastCalledWith(false);
    shelf.open();
    shelf.close(true);
    vi.advanceTimersByTime(120);
    expect(hide).toHaveBeenLastCalledWith(true);
  });
  it("waits for the exit animation before hiding the native window", () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    const visibility = vi.fn();
    const shelf = new QuickShareLifecycle(visibility, hide);
    shelf.open();
    shelf.close();
    expect(visibility).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(119);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();
  });

  it("keeps a reopened shelf visible when an earlier close was pending", () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    const shelf = new QuickShareLifecycle(vi.fn(), hide);
    shelf.close();
    vi.advanceTimersByTime(60);
    shelf.open();
    vi.runAllTimers();
    expect(hide).not.toHaveBeenCalled();
  });

  it("cancels the success dismissal when a new payload arrives", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const shelf = new QuickShareLifecycle(vi.fn(), vi.fn());
    shelf.afterSuccess(dismiss);
    vi.advanceTimersByTime(900);
    shelf.open();
    vi.runAllTimers();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("cancels callbacks when the window component unmounts", () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    const shelf = new QuickShareLifecycle(vi.fn(), hide);
    shelf.close();
    shelf.dispose();
    vi.runAllTimers();
    expect(hide).not.toHaveBeenCalled();
  });
});
