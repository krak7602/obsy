import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['**/dist/**', 'main.js'],
    plugins: ['typescript', 'unicorn', 'oxc', 'import'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ['**/*.test.ts'],
        plugins: ['vitest'],
      },
    ],
  },
  fmt: {
    singleQuote: true,
    ignorePatterns: ['docs/**', '*.md'],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // Docker and live-bucket runs have their own configs; keep `pnpm test` hermetic.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
});
