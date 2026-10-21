import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { obsy: 'src/bin.ts' },
    format: ['esm'],
    platform: 'node',
    dts: false,
    // One self-contained file that runs with plain Node.
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
  },
});
