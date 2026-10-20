import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/cli.ts'],
    format: ['esm'],
    platform: 'node',
    dts: false,
    // One self-contained file, so that worker threads can load it with plain Node.
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
  },
});
