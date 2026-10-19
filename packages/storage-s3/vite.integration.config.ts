import { defineConfig } from 'vite-plus';

// Integration tests against a local Docker server or a live bucket. They are
// not part of the default `pnpm test`. See docs/runbooks/storage-conformance.md.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 600_000,
    // One file at a time, so that races do not compete with each other.
    fileParallelism: false,
  },
});
