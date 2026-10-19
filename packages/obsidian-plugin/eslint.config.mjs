// Obsidian community review rules. Everything else is linted by `vp check`.
// Runs on TypeScript 6 until typescript-eslint supports TypeScript 7.
import obsidianmd from 'eslint-plugin-obsidianmd';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Keep equal to `minAppVersion` in probe/manifest.json.
const PROBE_MIN_APP_VERSION = '1.13.2';

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
    // The probe is a separate plugin with its own manifest and minimum app version.
    files: ['packages/obsidian-plugin/src/probe/**/*.ts'],
    rules: {
      'obsidianmd/no-unsupported-api': ['error', { minAppVersion: PROBE_MIN_APP_VERSION }],
      'obsidianmd/settings-tab/require-display': ['warn', { minAppVersion: PROBE_MIN_APP_VERSION }],
      'obsidianmd/settings-tab/no-deprecated-display': [
        'warn',
        { minAppVersion: PROBE_MIN_APP_VERSION },
      ],
      'obsidianmd/settings-tab/prefer-update-over-display': [
        'warn',
        { minAppVersion: PROBE_MIN_APP_VERSION },
      ],
    },
  },
  {
    // The recommended config does not match these manifests; lint them explicitly.
    files: ['manifest.json', 'packages/obsidian-plugin/probe/manifest.json'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { extraFileExtensions: ['.json'], projectService: false, project: null },
    },
    plugins: { obsidianmd },
    rules: { 'obsidianmd/validate-manifest': 'error' },
  },
);
