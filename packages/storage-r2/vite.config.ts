import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'neutral',
    dts: true,
    // Workspace packages import the TypeScript source; `publishConfig`
    // points at `dist`.
    exports: { devExports: true },
  },
});
