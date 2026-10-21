// The sync engine on the vault adapter: a Mac with an Obsidian vault (fake)
// and a phone with files in memory, with user edits that land in the middle
// of a sync and notes open in editors.
import {
  MemoryLocalFiles,
  MemoryStateStore,
  SeededEnvironment,
  SyncEngine,
  initVault,
} from '@obsy/core';
import { decodeUtf8Strict, encodeUtf8, pathKey } from '@obsy/protocol';
import { MemoryStorage, seededRandom } from '@obsy/storage-testkit/portable';
import { describe, expect, it } from 'vite-plus/test';

import { FakeVault } from '../testing/fake-vault';
import { VaultLocalFiles } from './vault-files';

/**
 * OBSY_VAULT_SYNC_SEEDS sets the number of random runs (default 400);
 * OBSY_VAULT_SYNC_SEED replays one seed and prints its trace. The plugin
 * compiles without Node types, so the environment is read untyped.
 */
const env: Readonly<Record<string, string | undefined>> =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

async function setup(seed = 1): Promise<{
  vault: FakeVault;
  mac: SyncEngine;
  phoneFiles: MemoryLocalFiles;
  phone: SyncEngine;
}> {
  const storage = new MemoryStorage();
  const env = new SeededEnvironment(seed);
  await initVault(storage, env);
  const vault = new FakeVault();
  const mac = new SyncEngine({
    storage,
    // Even seeds write in tiny pieces, as on mobile, through temporary files.
    local: new VaultLocalFiles(vault, seed % 2 === 0 ? { chunkBytes: 6 } : {}),
    state: new MemoryStateStore(),
    env,
    actorId: 'mac',
    deviceName: 'mac',
  });
  const phoneFiles = new MemoryLocalFiles();
  const phone = new SyncEngine({
    storage,
    local: phoneFiles,
    state: new MemoryStateStore(),
    env,
    actorId: 'phone',
    deviceName: 'phone',
  });
  return { vault, mac, phoneFiles, phone };
}

const phoneText = (files: MemoryLocalFiles, path: string): string | undefined => {
  const bytes = files.get(path);
  return bytes === undefined ? undefined : decodeUtf8Strict(bytes);
};

describe('sync through the vault adapter', () => {
  it('merges a remote edit into an open note through the editor', async () => {
    const { vault, mac, phoneFiles, phone } = await setup();
    vault.userWrite('a.md', 'one\ntwo\nthree\n');
    await mac.sync();
    await phone.sync();
    const editor = vault.open('a.md');
    editor.text = 'ONE\ntwo\nthree\n';
    await editor.save();
    await phoneFiles.userWrite('a.md', encodeUtf8('one\ntwo\nTHREE\n'));
    await phone.sync();
    const before = editor.transactions;
    expect((await mac.sync()).settled).toBe(true);
    expect(editor.transactions).toBe(before + 1);
    expect(editor.text).toBe('ONE\ntwo\nTHREE\n');
    expect(vault.text('a.md')).toBe('ONE\ntwo\nTHREE\n');
    await phone.sync();
    expect(phoneText(phoneFiles, 'a.md')).toBe('ONE\ntwo\nTHREE\n');
  });

  it('waits for unsaved edits instead of overwriting them', async () => {
    const { vault, mac, phoneFiles, phone } = await setup();
    vault.userWrite('a.md', 'one\n');
    await mac.sync();
    await phone.sync();
    const editor = vault.open('a.md');
    editor.text = 'one\ntyping';
    await phoneFiles.userWrite('a.md', encodeUtf8('one\nphone\n'));
    await phone.sync();
    const report = await mac.sync();
    expect(report.settled).toBe(false);
    expect(editor.text).toBe('one\ntyping');
    expect(vault.text('a.md')).toBe('one\n');
    // Once saved, the edit merges with the remote one.
    await editor.save();
    expect((await mac.sync()).settled).toBe(true);
    expect(vault.text('a.md')).toBe('one\nphone\ntyping');
  });

  it('moves a remotely deleted file to the trash and creates remote files', async () => {
    const { vault, mac, phoneFiles, phone } = await setup();
    vault.userWrite('a.md', 'a\n');
    await mac.sync();
    await phone.sync();
    phoneFiles.userRemove('a.md');
    await phoneFiles.userWrite('folder/b.md', encodeUtf8('b\n'));
    await phone.sync();
    await mac.sync();
    expect(vault.paths()).toEqual(['folder/b.md']);
    expect(vault.trashed).toEqual(['a.md']);
  });

  it('keeps every line under random edits that land during syncs', async () => {
    const failures: string[] = [];
    const only = env['OBSY_VAULT_SYNC_SEED'];
    const seeds = Number(env['OBSY_VAULT_SYNC_SEEDS'] ?? 400);
    const first = only === undefined ? 1 : Number(only);
    const last = only === undefined ? seeds : Number(only);
    for (let seed = first; seed <= last; seed++) {
      const trace: string[] = [];
      const failure = await randomRun(seed, trace);
      if (failure !== null) failures.push(`seed ${seed}: ${failure}`);
      if (only !== undefined) console.log(trace.join('\n'));
    }
    expect(failures, `${failures.length} of ${last - first + 1} seeds failed`).toEqual([]);
  }, 600_000);
});

const PATHS = ['a.md', 'b.md', 'notes/c.md', 'notes/C.md', 'img.png'];

/**
 * One random run. Users edit, create, delete, and rename on both devices;
 * the Mac user also types into open notes and saves. Some Mac edits land
 * during a sync, between the adapter's reads and writes. After a quiet
 * phase both devices must hold the same files, and every line that no user
 * removed must still exist.
 */
async function randomRun(seed: number, trace: string[]): Promise<string | null> {
  const random = seededRandom(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const { vault, mac, phoneFiles, phone } = await setup(seed);
  const removed = new Set<string>();
  const tokens = new Set<string>();
  let counter = 0;
  const token = (): string => {
    counter++;
    const t = `t${counter}`;
    tokens.add(t);
    return t;
  };
  const forget = (text: string): void => {
    for (const t of text.match(/t\d+/g) ?? []) removed.add(t);
  };

  const macAction = (): void => {
    const paths = vault.paths();
    const kind = int(8);
    if (paths.length === 0 || kind === 0) {
      const path = PATHS[int(PATHS.length)] as string;
      if (vault.text(path) === undefined) {
        vault.userWrite(path, `${token()}\n`);
        trace.push(`mac create ${path} ${JSON.stringify(vault.text(path))}`);
      }
      return;
    }
    const path = paths[int(paths.length)] as string;
    const editor = vault.editors.get(pathKey(path));
    trace.push(`mac action ${kind} ${path}`);
    switch (kind) {
      case 1:
        if (!path.endsWith('.png') && editor === undefined) vault.open(path);
        break;
      case 2:
        // Typing a line into an open note at a random line, saved later.
        if (editor !== undefined) {
          const lines = editor.text.split('\n');
          lines.splice(int(lines.length), 0, token());
          editor.text = lines.join('\n');
        }
        break;
      case 3:
        if (editor !== undefined) void editor.save();
        break;
      case 4: {
        if (editor !== undefined && editor.text !== vault.text(path)) break;
        const text = vault.text(path) ?? '';
        vault.userWrite(path, `${text}${token()}\n`);
        break;
      }
      case 5: {
        if (editor !== undefined && editor.text !== vault.text(path)) break;
        forget(vault.text(path) ?? '');
        vault.userRemove(path);
        vault.editors.delete(pathKey(path));
        break;
      }
      case 6: {
        const to = PATHS[int(PATHS.length)] as string;
        if (to.endsWith('.png') !== path.endsWith('.png') || vault.text(to) !== undefined) break;
        vault.userRename(path, to);
        break;
      }
      default:
        // Closing a note saves it, as in Obsidian.
        if (editor !== undefined) {
          void editor.save();
          vault.editors.delete(pathKey(path));
        }
    }
  };

  const phoneAction = async (): Promise<void> => {
    const paths = [...phoneFiles.snapshot().keys()];
    const kind = int(5);
    if (paths.length === 0 || kind === 0) {
      const path = PATHS[int(PATHS.length)] as string;
      if (phoneFiles.get(path) === undefined) {
        await phoneFiles.userWrite(path, encodeUtf8(`${token()}\n`));
        trace.push(`phone create ${path}`);
      }
      return;
    }
    const path = paths[int(paths.length)] as string;
    trace.push(`phone action ${kind} ${path}`);
    const text = phoneText(phoneFiles, path) ?? '';
    if (kind <= 2) await phoneFiles.userWrite(path, encodeUtf8(`${token()}\n${text}`));
    else if (kind === 3) {
      forget(text);
      phoneFiles.userRemove(path);
    } else {
      const to = PATHS[int(PATHS.length)] as string;
      if (to.endsWith('.png') === path.endsWith('.png')) phoneFiles.userMove(path, to);
    }
  };

  // Mac edits land between the adapter's calls during a sync.
  let interfere = true;
  vault.before = (call) => {
    if (interfere && !call.endsWith(':atomic') && random() < 0.4) macAction();
  };

  try {
    for (let step = 0; step < 80; step++) {
      const roll = random();
      if (roll < 0.35) macAction();
      else if (roll < 0.6) await phoneAction();
      else if (roll < 0.8) trace.push(`mac sync ${JSON.stringify(await mac.sync())}`);
      else trace.push(`phone sync ${JSON.stringify(await phone.sync())}`);
      trace.push(
        `  mac files ${JSON.stringify(Object.fromEntries(vault.paths().map((p) => [p, vault.text(p)])))}`,
      );
    }
    interfere = false;
    for (const editor of vault.editors.values()) await editor.save();
    vault.editors.clear();
    for (let round = 0; round < 4; round++) {
      await mac.sync();
      await phone.sync();
    }
    const macReport = await mac.sync();
    const phoneReport = await phone.sync();
    trace.push(`final ${JSON.stringify(macReport)} ${JSON.stringify(phoneReport)}`);
    trace.push(
      `  mac files ${JSON.stringify(Object.fromEntries(vault.paths().map((p) => [p, vault.text(p)])))}`,
    );
    trace.push(
      `  phone files ${JSON.stringify(Object.fromEntries([...phoneFiles.snapshot()].map(([p, b]) => [p, decodeUtf8Strict(b)])))}`,
    );
    if (!macReport.settled || !phoneReport.settled) return 'did not settle';

    const macFiles = new Map(vault.paths().map((p) => [p, vault.text(p) ?? '']));
    const phoneMap = phoneFiles.snapshot();
    const macPaths = [...macFiles.keys()].sort();
    const phonePaths = [...phoneMap.keys()].sort();
    if (JSON.stringify(macPaths) !== JSON.stringify(phonePaths)) {
      return `mac ${JSON.stringify(macPaths)} phone ${JSON.stringify(phonePaths)}`;
    }
    for (const [path, bytes] of phoneMap) {
      if (decodeUtf8Strict(bytes) !== macFiles.get(path)) return `differs at ${path}`;
    }
    const live = [...macFiles.values()].join('\n');
    for (const t of tokens) {
      if (!removed.has(t) && !new RegExp(`\\b${t}\\b`).test(live)) return `lost ${t}`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}
