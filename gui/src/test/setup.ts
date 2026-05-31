import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// gui component tests mock `@tauri-apps/api` and assume the Tauri transport.
// rpc.ts picks the transport via `isTauriRuntime()`, which checks
// `window.__TAURI_INTERNALS__`. Without the flag the HTTP transport is
// selected, the invoke() mocks never fire, and every rpc_call-driven test
// (Dashboard, schedule, catalog, mcp-clients, <App/> …) fails. The web-mode
// tests construct `createHttpTransport()` directly (bypassing the runtime
// check) and login/register tests render their pages directly — none rely on
// the flag being absent, so setting it globally is safe.
beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime flag
  (window as any).__TAURI_INTERNALS__ = { metadata: {} };
});

afterEach(() => {
  cleanup();
});
