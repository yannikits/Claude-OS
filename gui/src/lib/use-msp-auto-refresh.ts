/**
 * Generic auto-refresh hook used by the MSP-Health dashboard.
 *
 * Pass an interval in seconds (null disables). The hook keeps a fresh
 * reference to `loader` via a ref so re-renders don't reset the timer,
 * and cleans up on unmount + interval-change.
 *
 * @module gui/lib/use-msp-auto-refresh
 */
import { useEffect, useRef } from 'react';

export function useAutoRefresh(loader: () => void, intervalSec: number | null): void {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (intervalSec === null || intervalSec <= 0) return;
    const handle = setInterval(() => {
      loaderRef.current();
    }, intervalSec * 1000);
    return () => clearInterval(handle);
  }, [intervalSec]);
}
