import { defineConfig } from 'rolldown';
import type { Plugin } from 'rolldown';

// Obsidian loads one CommonJS `main.js` and provides these modules at runtime.
const external = ['obsidian', 'electron', /^@codemirror\//, /^@lezer\//];

/**
 * Copies the probe's manifest.json and styles.css next to its main.js. Paths
 * are relative to this package, where the build script runs.
 */
function probeAssets(): Plugin {
  return {
    name: 'obsy-probe-assets',
    async generateBundle() {
      for (const fileName of ['manifest.json', 'styles.css']) {
        const source = await this.fs.readFile(`probe/${fileName}`);
        this.emitFile({ type: 'asset', fileName, source });
      }
    },
  };
}

export default defineConfig([
  // The sync plugin. Its manifest is the root manifest.json.
  {
    input: 'src/main.ts',
    external,
    platform: 'browser',
    output: {
      file: 'dist/main.js',
      format: 'cjs',
      exports: 'default',
    },
  },
  // The platform probe, a separate plugin with the ID `obsy-probe`. Copy the
  // whole `dist/obsy-probe/` folder into a scratch vault's plugins folder.
  {
    input: 'src/probe/main.ts',
    external,
    platform: 'browser',
    plugins: [probeAssets()],
    output: {
      dir: 'dist/obsy-probe',
      entryFileNames: 'main.js',
      format: 'cjs',
      exports: 'default',
    },
  },
]);
