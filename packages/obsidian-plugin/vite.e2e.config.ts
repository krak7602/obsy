import { defineConfig } from 'vite-plus';

// The desktop test in a real Obsidian app. It is not part of the default
// `pnpm test`. See docs/runbooks/desktop-plugin-test.md.
export default defineConfig({
  test: {
    include: ['e2e/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
