// The phase 2 desktop test: two scratch vaults in a real Obsidian desktop
// app, synced through a local S3 server. Run it with `pnpm run test:desktop`;
// see docs/runbooks/desktop-plugin-test.md. It never opens a real vault: it
// copies a generated vault, or the folder in OBSY_E2E_SOURCE, into a new
// temporary folder, and Obsidian runs with its own profile folder.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { RemoteVault, webEnvironment, type SyncReport, type VerifyReport } from '@obsy/core';
import { LOG_PREFIX, Manifest, type Storage } from '@obsy/protocol';
import { S3Storage } from '@obsy/storage-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import type { Page } from './cdp';
import { copyVault, generateVault, readTree, trashed } from './corpus';
import { DEFAULT_BINARY, Desktop, enablePlugin, prepareVault } from './obsidian';

const envFile = fileURLToPath(new URL('../../storage-s3/.env.s3-local', import.meta.url));
const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const pluginFiles = [
  join(pluginDir, 'dist', 'main.js'),
  join(pluginDir, '..', '..', 'manifest.json'),
];
const binary = process.env['OBSY_E2E_OBSIDIAN'] ?? DEFAULT_BINARY;
const ready = existsSync(envFile) && existsSync(binary) && existsSync(pluginFiles[0] as string);

/** Helpers available to every page script. `p` is the obsy plugin. */
const PRELUDE = `
  const p = app.plugins.getPlugin('obsy');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const file = (path) => {
    const f = app.vault.getAbstractFileByPath(path);
    if (!f) throw new Error('no file ' + path);
    return f;
  };
  const click = async (text, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const b = [...document.querySelectorAll('.modal-container button')].find((b) => b.textContent.trim() === text);
      if (b) { b.click(); return; }
      await sleep(100);
    }
    const open = [...document.querySelectorAll('.modal-container')].map((m) => m.textContent.trim()).join(' | ');
    throw new Error('no button: ' + text + '; open dialogs: ' + (open || 'none') + '; status: ' + p.service.status.detail);
  };
  const view = (path) => app.workspace.getLeavesOfType('markdown').map((l) => l.view).find((v) => v.file && v.file.path === path);
`;

function run<T>(page: Page, body: string, args: unknown = null): Promise<T> {
  return page.evaluate<T>(PRELUDE + body, args);
}

const sync = (page: Page): Promise<SyncReport | null> =>
  run(page, 'return await p.service.run({ manual: true });');
const verify = (page: Page): Promise<VerifyReport> => run(page, 'return await p.service.verify();');
const status = (page: Page): Promise<{ state: string; detail: string; unsent: number }> =>
  run(page, 'return p.service.status;');
const edit = (page: Page, path: string, from: string, to: string): Promise<void> =>
  run(page, 'await app.vault.process(file(args.path), (t) => t.replace(args.from, args.to));', {
    path,
    from,
    to,
  });
const read = (page: Page, path: string): Promise<string> =>
  run(page, 'return await app.vault.read(file(args.path));', { path });

/** Starts an operation that asks a question, answers it with `button`, and waits for it. */
async function answer<T>(page: Page, start: string, button: string): Promise<T> {
  await run(page, `window.__obsyOp = ${start}; return null;`);
  await run(page, 'await click(args.button); return null;', { button });
  return run<T>(page, 'return await window.__obsyOp;');
}

async function head(storage: Storage): Promise<Map<string, string>> {
  const remote = new RemoteVault(storage, webEnvironment());
  const vault = await remote.getVault();
  if (vault === null) throw new Error('no vault.json');
  const checkpoint = await remote.latestCheckpoint();
  const manifest =
    checkpoint === null ? new Manifest(vault.epoch) : Manifest.fromCheckpoint(checkpoint);
  await remote.catchUp(manifest);
  const files = [...manifest.liveFiles()].map(
    ([, e]) => [e.path, e.hash.slice('sha256:'.length)] as const,
  );
  return new Map(files.sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function logLength(storage: Storage): Promise<number> {
  let count = 0;
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list(LOG_PREFIX, startAfter, 1000);
    count += page.keys.length;
    if (!page.truncated) return count;
    startAfter = page.keys.at(-1);
  }
}

/**
 * The scenario's files. With OBSY_E2E_SOURCE, the generated files go into
 * this folder of the copy, so that every step finds its notes.
 */
const scenario = process.env['OBSY_E2E_SOURCE'] === undefined ? '' : 'obsy-e2e-scenario/';
const at = (path: string): string => `${scenario}${path}`;

const report: string[] = [];
const note = (line: string): void => {
  report.push(line);
};

describe.skipIf(!ready)('desktop plugin in Obsidian', () => {
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const root = mkdtempSync(join(tmpdir(), 'obsy-e2e-'));
  const vaultA = join(root, 'vault-a');
  const vaultB = join(root, 'vault-b');
  const vaultC = join(root, 'vault-c');
  const prefix = `obsy-e2e/${runId}/`;
  let desktop: Desktop;
  let a: Page;
  let b: Page;
  let c: Page;
  let storage: S3Storage;
  let fileCount = 0;
  let credentials: string[] = [];

  beforeAll(async () => {
    process.loadEnvFile(envFile);
    const env = process.env;
    const settings = {
      endpoint: env['OBSY_S3_LOCAL_ENDPOINT'] as string,
      bucket: env['OBSY_S3_LOCAL_BUCKET'] as string,
      region: 'us-east-1',
      accessKeyId: env['OBSY_S3_LOCAL_ACCESS_KEY_ID'] as string,
      secretAccessKey: env['OBSY_S3_LOCAL_SECRET_ACCESS_KEY'] as string,
    };
    storage = new S3Storage({ ...settings, prefix });
    credentials = [settings.accessKeyId, settings.secretAccessKey];

    const source = process.env['OBSY_E2E_SOURCE'] ?? join(root, 'source');
    if (process.env['OBSY_E2E_SOURCE'] === undefined) generateVault(source);
    copyVault(source, vaultA);
    if (scenario !== '') generateVault(join(vaultA, scenario));
    copyVault(vaultA, vaultB);
    fileCount = readTree(vaultA).size;
    note(
      `- Source: ${process.env['OBSY_E2E_SOURCE'] === undefined ? 'generated scratch vault' : 'copy of a vault'}, ${fileCount} files`,
    );
    mkdirSync(vaultC);
    for (const vault of [vaultA, vaultB, vaultC]) prepareVault(vault, pluginFiles);

    desktop = await Desktop.launch({
      root,
      vaults: [vaultA, vaultB, vaultC],
      port: 19_223,
      binary,
    });
    a = desktop.page(vaultA);
    b = desktop.page(vaultB);
    c = desktop.page(vaultC);
    const version = await a.evaluate<string>(
      'return /obsidian\\/([\\d.]+)/i.exec(navigator.userAgent)?.[1] ?? "unknown";',
    );
    note(`- Obsidian ${version} desktop, three vault windows, own profile folder`);
    for (const [page, name] of [
      [a, 'desktop-a'],
      [b, 'desktop-b'],
      [c, 'desktop-c'],
    ] as const) {
      await enablePlugin(page);
      await run(
        page,
        `
        app.secretStorage.setSecret(args.name + '-key', args.accessKeyId);
        app.secretStorage.setSecret(args.name + '-secret', args.secretAccessKey);
        await p.saveSettings({ ...p.config, endpoint: args.endpoint, bucket: args.bucket,
          region: args.region, addressing: 'path', prefix: args.prefix,
          accessKeyIdSecret: args.name + '-key', secretAccessKeySecret: args.name + '-secret' });
        p.saveDevice({ ...p.device, deviceName: args.name });
        return null;`,
        { ...settings, prefix, name },
      );
    }
  }, 180_000);

  afterAll(async () => {
    await desktop?.stop();
    const out = process.env['OBSY_E2E_REPORT_FILE'];
    const text = ['## Desktop plugin test', '', ...report, ''].join('\n');
    console.log(text);
    if (out !== undefined) writeFileSync(out, text);
    if (process.env['OBSY_E2E_KEEP'] === undefined) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('creates the vault from the first device and uploads every file', async () => {
    const started = Date.now();
    await answer(a, 'p.service.connect()', 'Create and upload');
    expect(await status(a)).toMatchObject({ state: 'idle' });
    expect((await head(storage)).size).toBe(fileCount);
    expect(await head(storage)).toEqual(readTree(vaultA));
    note(
      `- Create and upload: ${fileCount} files, ${await logLength(storage)} commits, ${Date.now() - started} ms`,
    );
  });

  it('joins a copy pull-only: the copy converges and verify shows no differences', async () => {
    const before = await logLength(storage);
    const started = Date.now();
    await answer(b, 'p.service.connect()', 'Join in pull-only mode');
    const pulled = Date.now() - started;
    expect(await run(b, 'return p.device.mode;')).toBe('pull-only');
    expect(await logLength(storage)).toBe(before);
    const report = await verify(b);
    expect(report.problems).toEqual([]);
    expect(report.localFiles).toBe(fileCount);
    expect(readTree(vaultB)).toEqual(readTree(vaultA));
    note(
      `- Pull-only join of the copy: ${pulled} ms; verify: ${report.problems.length} differences, ${report.localFiles} files; nothing sent`,
    );
    await run(b, 'await p.service.startFullSync(); return null;');
    expect(await run(b, 'return p.device.mode;')).toBe('full');
    expect(await logLength(storage)).toBe(before);
    for (const page of [a, b]) await run(page, 'p.service.setAutoSync(false); return null;');
  });

  it('joins from an empty vault pull-only: every file downloads and verify shows no differences', async () => {
    const before = await logLength(storage);
    const started = Date.now();
    await answer(c, 'p.service.connect()', 'Join in pull-only mode');
    const pulled = Date.now() - started;
    expect(await logLength(storage)).toBe(before);
    expect((await verify(c)).problems).toEqual([]);
    expect(readTree(vaultC)).toEqual(readTree(vaultA));
    expect([...readTree(vaultC).keys()].filter((path) => path.endsWith('.obsy-tmp'))).toEqual([]);
    note(
      `- Pull-only join from an empty vault: ${fileCount} files downloaded in ${pulled} ms; verify: no differences`,
    );
    await run(c, 'await p.service.disconnect(); return null;');
  });

  it('merges edits to different lines of one note', async () => {
    await edit(a, at('Projects/Alpha/plan.md'), '# Alpha plan', '# Alpha plan (edited on A)');
    await edit(b, at('Projects/Alpha/plan.md'), '3. ', '3. (edited on B) ');
    await sync(a);
    expect((await sync(b))?.conflictCopies).toBe(0);
    await sync(a);
    const text = await read(a, at('Projects/Alpha/plan.md'));
    expect(text).toContain('(edited on A)');
    expect(text).toContain('(edited on B)');
    expect(await read(b, at('Projects/Alpha/plan.md'))).toBe(text);
    note('- Edits to different lines on both devices: merged, no conflict copy');
  });

  it('keeps both versions as a conflict copy when the same line changes on both', async () => {
    await edit(a, at('Inbox/idea 1.md'), '# Idea 1', '# Idea 1 from A');
    await edit(b, at('Inbox/idea 1.md'), '# Idea 1', '# Idea 1 from B');
    const png = (n: number): number[] => [0x89, 0x50, 0x4e, 0x47, n];
    await run(
      a,
      'await app.vault.modifyBinary(file(args.path), new Uint8Array(args.bytes).buffer); return null;',
      { path: at('Attachments/pixel.png'), bytes: png(1) },
    );
    await run(
      b,
      'await app.vault.modifyBinary(file(args.path), new Uint8Array(args.bytes).buffer); return null;',
      { path: at('Attachments/pixel.png'), bytes: png(2) },
    );
    await sync(a);
    expect((await sync(b))?.conflictCopies).toBe(2);
    await sync(a);
    const copies = [...readTree(vaultB).keys()].filter((path) =>
      path.includes('(conflict desktop-b '),
    );
    expect(copies).toHaveLength(2);
    const noteCopy = copies.find((path) =>
      path.startsWith(at('Inbox/idea 1 (conflict desktop-b ')),
    ) as string;
    const pngCopy = copies.find((path) =>
      path.startsWith(at('Attachments/pixel (conflict desktop-b ')),
    ) as string;
    expect(noteCopy.slice(scenario.length)).toMatch(
      /^Inbox\/idea 1 \(conflict desktop-b \d{12}\)\.md$/,
    );
    expect(pngCopy).toMatch(/\.png$/);
    for (const page of [a, b]) {
      expect(await read(page, at('Inbox/idea 1.md'))).toContain('# Idea 1 from A');
      expect(await read(page, noteCopy)).toContain('# Idea 1 from B');
      expect(
        await run(
          page,
          'return [...new Uint8Array(await app.vault.readBinary(file(args.path)))];',
          { path: pngCopy },
        ),
      ).toEqual(png(2));
    }
    expect(readTree(vaultA)).toEqual(readTree(vaultB));
    note(
      "- Same line changed on both devices, and a binary changed on both: the second device to sync kept its versions as conflict copies on both devices; the first device's versions kept the paths",
    );
  });

  it('applies a remote change to an open note through the editor, keeping the cursor', async () => {
    const path = at('Notes/long.md');
    await run(
      b,
      'const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(file(args.path)); await sleep(500); view(args.path).editor.setCursor({ line: 2, ch: 3 }); return null;',
      { path },
    );
    await edit(a, path, 'Line 300:', 'Line 300 (edited on A):');
    await sync(a);
    await sync(b);
    const state = await run<{ text: string; disk: string; cursor: { line: number; ch: number } }>(
      b,
      'const v = view(args.path); return { text: v.editor.getValue(), disk: await app.vault.read(file(args.path)), cursor: v.editor.getCursor() };',
      { path },
    );
    expect(state.text).toContain('Line 300 (edited on A):');
    expect(state.text).toBe(state.disk);
    expect(state.cursor).toEqual({ line: 2, ch: 3 });
    note('- Remote edit to a note open in an editor: applied in the editor, cursor kept');
  });

  it('keeps unsaved typing in an open note and merges it', async () => {
    const path = at('Notes/long.md');
    await edit(a, path, 'Line 5:', 'Line 5 (edited on A):');
    await sync(a);
    await run(
      b,
      'const e = view(args.path).editor; e.replaceRange("typed on B before saving\\n", { line: 0, ch: 0 }); return null;',
      { path },
    );
    await sync(b);
    await sync(a);
    for (const page of [a, b]) {
      const text = await read(page, path);
      expect(text.startsWith('typed on B before saving\n')).toBe(true);
      expect(text).toContain('Line 5 (edited on A):');
    }
    note('- Typing not yet saved in an open note: kept and merged with a remote edit');
  });

  it('syncs renames, deletes, and a change made outside Obsidian', async () => {
    await run(
      a,
      'await app.vault.rename(file(args.from), args.to); await app.fileManager.trashFile(file(args.gone)); return null;',
      {
        from: at('Inbox/idea 2.md'),
        to: at('Projects/Beta/idea 2.md'),
        gone: at('Inbox/idea 3.md'),
      },
    );
    writeFileSync(join(vaultA, at('Inbox/outside.md')), '# Written by another program\n');
    await run(
      a,
      'for (let i = 0; i < 100 && !app.vault.getAbstractFileByPath(args.path); i++) await sleep(100); file(args.path); return null;',
      { path: at('Inbox/outside.md') },
    );
    await sync(a);
    await sync(b);
    const tree = readTree(vaultB);
    expect(tree.has(at('Projects/Beta/idea 2.md'))).toBe(true);
    expect(tree.has(at('Inbox/idea 2.md'))).toBe(false);
    expect(tree.has(at('Inbox/idea 3.md'))).toBe(false);
    expect(tree.has(at('Inbox/outside.md'))).toBe(true);
    expect(trashed(vaultB)).toContain('idea 3.md');
    note(
      '- Rename, delete, and a file written by another program: synced; the delete went to the vault trash',
    );
  });

  it('syncs automatically after an edit', async () => {
    for (const page of [a, b]) await run(page, 'p.service.setAutoSync(true); return null;');
    const before = await logLength(storage);
    await edit(a, at('Welcome.md'), '# Welcome', '# Welcome (automatic)');
    const started = Date.now();
    while ((await logLength(storage)) === before && Date.now() - started < 20_000) await sleep(250);
    const sent = Date.now() - started;
    expect(await logLength(storage)).toBeGreaterThan(before);
    while (
      !(await read(b, at('Welcome.md'))).includes('(automatic)') &&
      Date.now() - started < 45_000
    )
      await sleep(500);
    expect(await read(b, at('Welcome.md'))).toContain('(automatic)');
    note(
      `- Automatic sync: the edit was committed ${sent} ms after it was saved and reached the other device within ${Date.now() - started} ms`,
    );
    for (const page of [a, b]) await run(page, 'p.service.setAutoSync(false); return null;');
    while (await run<boolean>(a, 'return p.service.status.state === "syncing";')) await sleep(100);
    while (await run<boolean>(b, 'return p.service.status.state === "syncing";')) await sleep(100);
  });

  it('stops before a mass delete, and deletes only when the user agrees', async () => {
    // Scenario notes first; in a copy of a vault, other files after them.
    const all = [...readTree(vaultA).keys()];
    const preferred = all.filter(
      (path) => path.startsWith(at('Daily/')) || path.startsWith(at('Inbox/idea')),
    );
    const others = all.filter((path) => !path.startsWith(scenario === '' ? '\0' : scenario));
    const live = [...preferred, ...others.filter((path) => !preferred.includes(path))];
    const total = all.length;
    const count = total > 60 ? 51 : Math.max(10, Math.ceil(total * 0.25));
    const victims = live.slice(0, count);
    expect(victims).toHaveLength(count);
    await run(
      a,
      'for (const path of args.paths) await app.fileManager.trashFile(file(path)); return null;',
      { paths: victims },
    );
    const before = await logLength(storage);
    await answer(a, 'p.service.run({ manual: true })', 'Cancel');
    expect(await logLength(storage)).toBe(before);
    expect(await status(a)).toMatchObject({ state: 'paused' });
    await answer(a, 'p.service.run({ manual: true })', `Delete ${count} files`);
    expect(await logLength(storage)).toBeGreaterThan(before);
    await answer(b, 'p.service.run({ manual: true })', `Delete ${count} files`);
    expect(readTree(vaultB)).toEqual(readTree(vaultA));
    note(
      `- Mass delete of ${count} of ${total} files: the sync stopped and asked on both devices; Cancel sent nothing; confirming deleted them`,
    );
  });

  it('ends with both vaults equal to the head', async () => {
    for (const page of [a, b]) {
      await sync(page);
      expect((await verify(page)).problems).toEqual([]);
    }
    const headTree = await head(storage);
    expect(readTree(vaultA)).toEqual(headTree);
    expect(readTree(vaultB)).toEqual(headTree);
    for (const vault of [vaultA, vaultB, vaultC]) {
      const data = readFileSync(join(vault, '.obsidian', 'plugins', 'obsy', 'data.json'), 'utf8');
      for (const value of credentials) expect(data.includes(value)).toBe(false);
      expect(JSON.parse(data)).toMatchObject({ accessKeyIdSecret: expect.stringMatching(/-key$/) });
    }
    note('- No credential value is in any data.json; it holds only the secret names');
    note(
      `- End: verify shows no differences on either device; both folders equal the head (${headTree.size} files, ${await logLength(storage)} commits)`,
    );
  });
});
