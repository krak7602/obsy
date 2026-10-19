// Obsidian community review rules. Everything else is linted by `vp check`.
// Runs on TypeScript 6 until typescript-eslint supports TypeScript 7.
import obsidianmd from 'eslint-plugin-obsidianmd';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Run from the repository root (see the `lint:obsidian` script): the rules
  // read `manifest.json` from the working directory.
  // Tests and test support run in Node and are not part of any bundle.
  globalIgnores([
    '**/dist',
    '**/node_modules',
    'packages/obsidian-plugin/src/**/*.test.ts',
    'packages/obsidian-plugin/src/testing/**',
  ]),
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    // The recommended config does not match the root manifest; lint it explicitly.
    files: ['manifest.json'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { extraFileExtensions: ['.json'], projectService: false, project: null },
    },
    plugins: { obsidianmd },
    rules: { 'obsidianmd/validate-manifest': 'error' },
  },
);
