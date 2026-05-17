import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/index.ts',
        'src/**/*.d.ts',
        // CLI commands + presenters are commander glue. They are
        // verified via real-binary smoke tests (documented in each
        // phase's commit/todo retrospective), not via vitest. Adding
        // unit tests would require mocking commander + process.exit
        // and would test the mock more than the wire.
        'src/cli/**',
        // keyring-store wraps @napi-rs/keyring (native module). The
        // factory's encrypted-file fallback path is fully covered;
        // exercising the real keyring needs an OS-specific service
        // setup and is gated behind the Phase 3d smoke test.
        'src/domains/secrets/keyring-store.ts',
        // Phase 4f placeholder until the Phase 6 catalog-sidecar
        // pulls real plugin-update logic into it.
        'src/domains/update-orchestrator/plugins.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@core': resolve(here, 'src/core'),
      '@domains': resolve(here, 'src/domains'),
      '@shared': resolve(here, 'src/shared'),
      '@cli': resolve(here, 'src/cli'),
    },
  },
});
