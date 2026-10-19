import { defineConfig } from 'rolldown';

// Obsidian loads one CommonJS `main.js` and provides these modules at runtime.
const external = ['obsidian', 'electron', /^@codemirror\//, /^@lezer\//];

export default defineConfig({
  input: 'src/main.ts',
  external,
  platform: 'browser',
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    exports: 'default',
  },
});
