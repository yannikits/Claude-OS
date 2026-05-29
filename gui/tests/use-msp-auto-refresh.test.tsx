import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoRefresh } from '../src/lib/use-msp-auto-refresh';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useAutoRefresh', () => {
  it('does NOT fire when intervalSec is null', () => {
    const fn = vi.fn();
    renderHook(() => useAutoRefresh(fn, null));
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('does NOT fire when intervalSec is 0 or negative', () => {
    const fn = vi.fn();
    renderHook(() => useAutoRefresh(fn, 0));
    vi.advanceTimersByTime(5_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires every intervalSec', () => {
    const fn = vi.fn();
    renderHook(() => useAutoRefresh(fn, 1));
    vi.advanceTimersByTime(3_500);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses the LATEST loader on each tick (closure-stale-fix)', () => {
    let counter = 0;
    const a = vi.fn(() => {
      counter = 1;
    });
    const b = vi.fn(() => {
      counter = 2;
    });
    const { rerender } = renderHook(
      ({ loader }: { loader: () => void }) => useAutoRefresh(loader, 1),
      {
        initialProps: { loader: a },
      },
    );
    vi.advanceTimersByTime(1_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(counter).toBe(1);
    rerender({ loader: b });
    vi.advanceTimersByTime(1_000);
    expect(b).toHaveBeenCalledTimes(1);
    expect(counter).toBe(2);
    // a was called once initially, b once after rerender — same timer, different loader
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('resets timer when intervalSec changes', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(({ s }: { s: number | null }) => useAutoRefresh(fn, s), {
      initialProps: { s: 1 as number | null },
    });
    vi.advanceTimersByTime(500);
    rerender({ s: 2 });
    // No timer should be still pending from the 1s schedule
    vi.advanceTimersByTime(900);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cleans up on unmount (no calls after unmount)', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => useAutoRefresh(fn, 1));
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops firing when intervalSec switches to null', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(({ s }: { s: number | null }) => useAutoRefresh(fn, s), {
      initialProps: { s: 1 as number | null },
    });
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    rerender({ s: null });
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
