// Starts Obsidian desktop with its own profile folder, so that it never
// sees the user's vaults, and opens scratch vaults in it. Test-only code.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Page, listPages } from './cdp';

export const DEFAULT_BINARY = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';

/** Copies the built plugin into a vault and sets the vault's deletes to its `.trash` folder. */
export function prepareVault(vault: string, pluginFiles: readonly string[]): void {
  const pluginDir = join(vault, '.obsidian', 'plugins', 'obsy');
  mkdirSync(pluginDir, { recursive: true });
  for (const file of pluginFiles) copyFileSync(file, join(pluginDir, basename(file)));
  // Test deletes go to the vault's .trash folder, never to the system trash.
  writeFileSync(join(vault, '.obsidian', 'app.json'), JSON.stringify({ trashOption: 'local' }));
}

export interface LaunchOptions {
  /** Work folder for the profile and the log. */
  readonly root: string;
  /** Absolute vault folders. Each opens in its own window. */
  readonly vaults: readonly string[];
  readonly port: number;
  readonly binary?: string;
}

/** An Obsidian process with one window per vault. */
export class Desktop {
  private constructor(
    readonly process: ChildProcess,
    readonly pages: ReadonlyMap<string, Page>,
  ) {}

  static async launch(options: LaunchOptions): Promise<Desktop> {
    const profile = join(options.root, 'profile');
    mkdirSync(profile, { recursive: true });
    // A relaunch keeps the vault list, so each vault keeps its app ID, its
    // local storage, and so its obsy state.
    if (!existsSync(join(profile, 'obsidian.json'))) {
      const vaults: Record<string, { path: string; ts: number; open: boolean }> = {};
      for (const path of options.vaults) {
        vaults[randomBytes(8).toString('hex')] = { path, ts: Date.now(), open: true };
      }
      writeFileSync(join(profile, 'obsidian.json'), JSON.stringify({ vaults }));
    }
    const log = openSync(join(options.root, 'obsidian.log'), 'a');
    const child = spawn(
      options.binary ?? DEFAULT_BINARY,
      [`--user-data-dir=${profile}`, `--remote-debugging-port=${options.port}`],
      { stdio: ['ignore', log, log] },
    );

    const pages = new Map<string, Page>();
    const deadline = Date.now() + 60_000;
    while (pages.size < options.vaults.length) {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`Obsidian opened ${pages.size} of ${options.vaults.length} vault windows`);
      }
      await sleep(500);
      let targets: Awaited<ReturnType<typeof listPages>>;
      try {
        targets = await listPages(options.port);
      } catch {
        continue; // not listening yet
      }
      for (const target of targets) {
        if ([...pages.values()].some((p) => p.ws.url === target.webSocketDebuggerUrl)) continue;
        const page = await Page.open(target.webSocketDebuggerUrl);
        const path = await page
          .evaluate<string | null>(
            'return globalThis.app?.workspace?.layoutReady ? app.vault.adapter.basePath : null;',
          )
          .catch(() => null);
        if (path === null || !options.vaults.includes(path)) {
          page.close();
          continue;
        }
        pages.set(path, page);
      }
    }
    return new Desktop(child, pages);
  }

  page(vault: string): Page {
    const page = this.pages.get(vault);
    if (page === undefined) throw new Error(`No window for ${vault}`);
    return page;
  }

  /** Kills Obsidian at once, as a crash or an iOS kill would. */
  async kill(): Promise<void> {
    for (const page of this.pages.values()) page.close();
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise((resolve) => this.process.once('exit', resolve));
    this.process.kill('SIGKILL');
    await exited;
  }

  async stop(): Promise<void> {
    for (const page of this.pages.values()) page.close();
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise((resolve) => this.process.once('exit', resolve));
    this.process.kill('SIGTERM');
    await Promise.race([exited, sleep(10_000)]);
    if (this.process.exitCode === null) this.process.kill('SIGKILL');
  }
}

/** Turns community plugins on in a vault window and enables obsy. */
export async function enablePlugin(page: Page): Promise<void> {
  await page.evaluate(`
    if (app.plugins.getPlugin('obsy')) return;
    await app.plugins.setEnable(true);
    await app.plugins.loadManifests();
    await app.plugins.enablePluginAndSave('obsy');
    for (let i = 0; i < 100 && !app.plugins.getPlugin('obsy'); i++) await new Promise((r) => setTimeout(r, 100));
    if (!app.plugins.getPlugin('obsy')) throw new Error('obsy did not load');
  `);
}
