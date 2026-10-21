import { decodeUtf8Strict, encodeUtf8, type Storage } from '@obsy/protocol';
import { MemoryStorage } from '@obsy/storage-testkit';
import { describe, expect, it } from 'vite-plus/test';

import { SafetyRailError, SyncEngine, SyncStopped, type SafetyRails } from './engine';
import type { DeviceState, StateStore } from './host';
import { MemoryLocalFiles, MemoryStateStore, SeededEnvironment } from './memory';
import { initVault } from './vault';
import { verifyLocal } from './verify';

interface Device {
  files: MemoryLocalFiles;
  engine: SyncEngine;
}

async function setup(
  names: string[],
  rails?: SafetyRails,
): Promise<{ storage: Storage; env: SeededEnvironment; devices: Device[] }> {
  const storage = new MemoryStorage();
  const env = new SeededEnvironment(42);
  await initVault(storage, env);
  const devices = names.map((name) => {
    const files = new MemoryLocalFiles();
    const engine = new SyncEngine({
      storage,
      local: files,
      state: new MemoryStateStore(),
      env,
      actorId: name,
      deviceName: name,
      ...(rails === undefined ? {} : { rails }),
    });
    return { files, engine };
  });
  return { storage, env, devices };
}

const text = (files: MemoryLocalFiles, path: string): string | undefined => {
  const bytes = files.get(path);
  return bytes === undefined ? undefined : decodeUtf8Strict(bytes);
};
const write = (files: MemoryLocalFiles, path: string, content: string): Promise<void> =>
  files.userWrite(path, encodeUtf8(content));
const paths = (files: MemoryLocalFiles): string[] => [...files.snapshot().keys()];

async function syncAll(devices: Device[], rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++)
    for (const d of devices) expect((await d.engine.sync()).settled).toBe(true);
}

describe('SyncEngine', () => {
  it('copies a new file to another device', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'notes/a.md', 'hello\n');
    await syncAll(devices);
    expect(text(phone.files, 'notes/a.md')).toBe('hello\n');
  });

  it('merges edits to different lines', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'one\ntwo\nthree\nfour\n');
    await syncAll(devices);
    await write(mac.files, 'a.md', 'ONE\ntwo\nthree\nfour\n');
    await write(phone.files, 'a.md', 'one\ntwo\nthree\nFOUR\n');
    await syncAll(devices);
    expect(text(mac.files, 'a.md')).toBe('ONE\ntwo\nthree\nFOUR\n');
    expect(text(phone.files, 'a.md')).toBe('ONE\ntwo\nthree\nFOUR\n');
  });

  it('keeps a byte order mark through a merge', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', '\uFEFFone\ntwo\nthree\n');
    await syncAll(devices);
    await write(mac.files, 'a.md', '\uFEFFONE\ntwo\nthree\n');
    await write(phone.files, 'a.md', '\uFEFFone\ntwo\nTHREE\n');
    await syncAll(devices);
    for (const d of devices) {
      expect(Array.from(d.files.get('a.md') ?? []).slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
      expect(text(d.files, 'a.md')).toBe('\uFEFFONE\ntwo\nTHREE\n');
    }
  });

  it('keeps both versions when the same line changes on both sides', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'line\n');
    await syncAll(devices);
    await write(mac.files, 'a.md', 'mac line\n');
    await write(phone.files, 'a.md', 'phone line\n');
    await syncAll(devices);
    for (const d of devices) {
      expect(paths(d.files)).toEqual(['a (conflict phone 202610200900).md', 'a.md']);
      expect(text(d.files, 'a.md')).toBe('mac line\n');
      expect(text(d.files, 'a (conflict phone 202610200900).md')).toBe('phone line\n');
    }
  });

  it('lets an edit beat a concurrent delete', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'v1\n');
    await syncAll(devices);
    mac.files.userRemove('a.md');
    await write(phone.files, 'a.md', 'v2\n');
    await mac.engine.sync();
    await syncAll(devices);
    expect(text(mac.files, 'a.md')).toBe('v2\n');
    expect(text(phone.files, 'a.md')).toBe('v2\n');
  });

  it('restores a file deleted on the device when it was edited remotely', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'v1\n');
    await syncAll(devices);
    await write(mac.files, 'a.md', 'v2\n');
    await mac.engine.sync();
    phone.files.userRemove('a.md');
    await syncAll(devices);
    expect(text(phone.files, 'a.md')).toBe('v2\n');
  });

  it('applies a rename on one side and an edit on the other', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'one\n');
    await syncAll(devices);
    mac.files.userMove('a.md', 'b.md');
    await write(phone.files, 'a.md', 'one\ntwo\n');
    await syncAll(devices, 3);
    for (const d of devices) {
      expect(paths(d.files)).toEqual(['b.md']);
      expect(text(d.files, 'b.md')).toBe('one\ntwo\n');
    }
  });

  it('keeps both files when two devices create the same path', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'daily.md', 'from mac\n');
    await write(phone.files, 'daily.md', 'from phone\n');
    await syncAll(devices);
    for (const d of devices) {
      expect(paths(d.files)).toEqual(['daily (conflict phone 202610200900).md', 'daily.md']);
    }
  });

  it('merges two creations when one extends the other', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'daily.md', '# Today\n');
    await write(phone.files, 'daily.md', '# Today\n- coffee\n');
    await syncAll(devices);
    for (const d of devices) {
      expect(paths(d.files)).toEqual(['daily.md']);
      expect(text(d.files, 'daily.md')).toBe('# Today\n- coffee\n');
    }
  });

  it('treats case twins as one path', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'Note.md', 'same\n');
    await write(phone.files, 'note.md', 'same\n');
    await syncAll(devices);
    expect(paths(mac.files)).toEqual(['Note.md']);
    expect(paths(phone.files)).toEqual(['Note.md']);
  });

  it('swaps two files by renames', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'A\n');
    await write(mac.files, 'b.md', 'B\n');
    await syncAll(devices);
    mac.files.userMove('a.md', 'tmp.md');
    mac.files.userMove('b.md', 'a.md');
    mac.files.userMove('tmp.md', 'b.md');
    await syncAll(devices);
    expect(text(phone.files, 'a.md')).toBe('B\n');
    expect(text(phone.files, 'b.md')).toBe('A\n');
    expect(paths(phone.files)).toEqual(['a.md', 'b.md']);
  });

  it('restores an edited file even when the device renamed another file onto its path', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'A\n');
    await write(mac.files, 'b.md', 'B\n');
    await syncAll(devices);
    await write(phone.files, 'a.md', 'A edited\n');
    await phone.engine.sync();
    mac.files.userRemove('a.md');
    mac.files.userMove('b.md', 'a.md');
    await syncAll(devices);
    for (const d of devices) {
      expect(text(d.files, 'a.md')).toBe('A edited\n');
      expect(paths(d.files)).toEqual(['a (conflict mac 202610200900).md', 'a.md']);
      expect(text(d.files, 'a (conflict mac 202610200900).md')).toBe('B\n');
    }
  });

  it('removes a file deleted on another device', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'x\n');
    await syncAll(devices);
    mac.files.userRemove('a.md');
    await syncAll(devices);
    expect(paths(phone.files)).toEqual([]);
  });

  it('gives a binary file a conflict copy instead of merging', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await mac.files.userWrite('img.png', new Uint8Array([1, 2, 3]));
    await syncAll(devices);
    await mac.files.userWrite('img.png', new Uint8Array([1, 2, 4]));
    await phone.files.userWrite('img.png', new Uint8Array([1, 2, 5]));
    await syncAll(devices);
    expect(paths(mac.files)).toEqual(['img (conflict phone 202610200900).png', 'img.png']);
  });

  it('settles a local write that stopped before it was recorded', async () => {
    const storage = new MemoryStorage();
    const env = new SeededEnvironment(7);
    await initVault(storage, env);
    const store = new MemoryStateStore();
    // While armed, throws on the first save after the Mac's file changed: a
    // crash between the local write and its record.
    let armed = false;
    const crashing: StateStore = {
      load: () => store.load(),
      save: async (state: DeviceState) => {
        if (armed && text(macFiles, 'a.md') === 'one\ntwo\n') throw new Error('crash');
        await store.save(state);
      },
    };
    const macFiles = new MemoryLocalFiles();
    const engine = (state: StateStore): SyncEngine =>
      new SyncEngine({ storage, local: macFiles, state, env, actorId: 'mac', deviceName: 'mac' });
    const phoneFiles = new MemoryLocalFiles();
    const phoneEngine = new SyncEngine({
      storage,
      local: phoneFiles,
      state: new MemoryStateStore(),
      env,
      actorId: 'phone',
      deviceName: 'phone',
    });

    await write(macFiles, 'a.md', 'one\n');
    await engine(crashing).sync();
    await phoneEngine.sync();
    await write(phoneFiles, 'a.md', 'one\ntwo\n');
    await phoneEngine.sync();

    armed = true;
    await expect(engine(crashing).sync()).rejects.toThrow('crash');
    armed = false;
    expect(text(macFiles, 'a.md')).toBe('one\ntwo\n');

    // The phone goes back to the first content; the Mac user edits the file.
    await write(phoneFiles, 'a.md', 'one\n');
    await phoneEngine.sync();
    await write(macFiles, 'a.md', 'one\ntwo\nmac\n');

    await engine(store).sync();
    await engine(store).sync();
    await phoneEngine.sync();
    // The Mac version is kept as a conflict copy; the head stays at the path.
    expect(paths(macFiles)).toEqual(['a (conflict mac 202610200900).md', 'a.md']);
    expect(text(macFiles, 'a.md')).toBe('one\n');
    expect(text(macFiles, 'a (conflict mac 202610200900).md')).toBe('one\ntwo\nmac\n');
    expect(paths(phoneFiles)).toEqual(paths(macFiles));
  });
});

async function logLength(storage: Storage): Promise<number> {
  return (await storage.list('log/')).keys.length;
}

describe('SyncEngine pull-only', () => {
  it('applies remote changes and sends nothing', async () => {
    const { storage, devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'from mac\n');
    await syncAll([mac]);
    await write(phone.files, 'b.md', 'from phone\n');
    const report = await phone.engine.sync({ pullOnly: true });
    expect(report).toMatchObject({ commits: 0, unsent: 1, settled: false });
    expect(text(phone.files, 'a.md')).toBe('from mac\n');
    expect(await logLength(storage)).toBe(1);
    await mac.engine.sync();
    expect(paths(mac.files)).toEqual(['a.md']);

    await syncAll(devices);
    expect(paths(mac.files)).toEqual(['a.md', 'b.md']);
  });

  it('merges a remote edit into a local edit without sending the result', async () => {
    const { storage, devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'a.md', 'one\ntwo\nthree\n');
    await syncAll(devices);
    await write(mac.files, 'a.md', 'ONE\ntwo\nthree\n');
    await mac.engine.sync();
    await write(phone.files, 'a.md', 'one\ntwo\nTHREE\n');
    const before = await logLength(storage);
    const report = await phone.engine.sync({ pullOnly: true });
    expect(report.unsent).toBe(1);
    expect(text(phone.files, 'a.md')).toBe('ONE\ntwo\nTHREE\n');
    expect(await logLength(storage)).toBe(before);
    await syncAll(devices);
    expect(text(mac.files, 'a.md')).toBe('ONE\ntwo\nTHREE\n');
  });

  it('keeps a differing local file as a conflict copy on a first pull', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    await write(mac.files, 'same.md', 'same\n');
    await write(mac.files, 'diff.md', 'mac\n');
    await syncAll([mac]);
    await write(phone.files, 'same.md', 'same\n');
    await write(phone.files, 'diff.md', 'phone\n');
    const report = await phone.engine.sync({ pullOnly: true });
    expect(report).toMatchObject({ conflictCopies: 1, unsent: 1 });
    expect(paths(phone.files)).toEqual([
      'diff (conflict phone 202610200900).md',
      'diff.md',
      'same.md',
    ]);
    expect(text(phone.files, 'diff.md')).toBe('mac\n');
  });
});

describe('SyncEngine safety rails', () => {
  async function twelveFiles(): Promise<{ storage: Storage; devices: [Device, Device] }> {
    const { storage, devices } = await setup(['mac', 'phone'], {});
    const [mac] = devices as [Device, Device];
    for (let i = 0; i < 12; i++)
      await write(mac.files, `n${String(i).padStart(2, '0')}.md`, `${i}\n`);
    await syncAll(devices);
    return { storage, devices: devices as [Device, Device] };
  }

  it('stops before deleting many files in the bucket, and continues when allowed', async () => {
    const { storage, devices } = await twelveFiles();
    const [mac, phone] = devices;
    for (let i = 0; i < 10; i++) mac.files.userRemove(`n${String(i).padStart(2, '0')}.md`);
    const before = await logLength(storage);
    const error = await mac.engine.sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SafetyRailError);
    expect(error).toMatchObject({ rail: 'remote-deletes', count: 10, total: 12 });
    expect(await logLength(storage)).toBe(before);
    // Pull-only sends no deletes, so it does not trip.
    expect((await mac.engine.sync({ pullOnly: true })).unsent).toBe(10);

    expect((await mac.engine.sync({ allowMassDelete: true })).settled).toBe(true);
    await expect(phone.engine.sync()).rejects.toMatchObject({
      rail: 'local-deletes',
      count: 10,
      total: 12,
    });
    expect(paths(phone.files)).toHaveLength(12);
    expect((await phone.engine.sync({ allowMassDelete: true })).settled).toBe(true);
    expect(paths(phone.files)).toEqual(['n10.md', 'n11.md']);
  });

  it('lets a few deletes through', async () => {
    const { devices } = await twelveFiles();
    const [mac, phone] = devices;
    for (let i = 0; i < 9; i++) mac.files.userRemove(`n0${i}.md`);
    await syncAll(devices);
    expect(paths(phone.files)).toEqual(['n09.md', 'n10.md', 'n11.md']);
  });

  it('applies the file limit to any vault size', async () => {
    const { devices } = await setup(['mac'], { maxFiles: 3, minFiles: 100 });
    const [mac] = devices as [Device];
    for (let i = 0; i < 8; i++) await write(mac.files, `n${i}.md`, `${i}\n`);
    await syncAll(devices);
    for (let i = 0; i < 4; i++) mac.files.userRemove(`n${i}.md`);
    await expect(mac.engine.sync()).rejects.toMatchObject({ rail: 'remote-deletes', count: 4 });
  });

  it('stops when the device has no files left', async () => {
    const { storage, devices } = await setup(['mac'], {});
    const [mac] = devices as [Device];
    await write(mac.files, 'a.md', 'a\n');
    await syncAll(devices);
    mac.files.userRemove('a.md');
    await expect(mac.engine.sync()).rejects.toMatchObject({ rail: 'empty-vault', count: 1 });
    expect(await logLength(storage)).toBe(1);
  });
});

describe('verifyLocal', () => {
  it('reports missing, extra, changed, and case-changed files', async () => {
    const { storage, env, devices } = await setup(['mac']);
    const [mac] = devices as [Device];
    await write(mac.files, 'a.md', 'a\n');
    await write(mac.files, 'b.md', 'b\n');
    await write(mac.files, 'c.md', 'c\n');
    await write(mac.files, 'd.md', 'd\n');
    await syncAll(devices);
    const clean = await verifyLocal(storage, env, mac.files);
    expect(clean).toEqual({ seq: 1, headFiles: 4, localFiles: 4, problems: [], skipped: 0 });

    mac.files.userRemove('a.md');
    await write(mac.files, 'b.md', 'changed\n');
    mac.files.userRemove('c.md');
    await write(mac.files, 'C.md', 'c\n');
    await write(mac.files, 'e.md', 'e\n');
    const report = await verifyLocal(storage, env, mac.files);
    expect(report.problems).toEqual([
      { path: 'a.md', problem: 'missing' },
      { path: 'b.md', problem: 'content' },
      { path: 'c.md', problem: 'path' },
      { path: 'e.md', problem: 'extra' },
    ]);
  });
});

describe('SyncEngine size limit', () => {
  async function capped(
    max: number,
  ): Promise<{ storage: Storage; env: SeededEnvironment; mac: Device; phone: Device }> {
    const storage = new MemoryStorage();
    const env = new SeededEnvironment(9);
    await initVault(storage, env);
    const make = (name: string, maxFileSize?: number): Device => {
      const files = new MemoryLocalFiles();
      const engine = new SyncEngine({
        storage,
        local: files,
        state: new MemoryStateStore(),
        env,
        actorId: name,
        deviceName: name,
        ...(maxFileSize === undefined ? {} : { maxFileSize }),
      });
      return { files, engine };
    };
    return { storage, env, mac: make('mac'), phone: make('phone', max) };
  }

  it('does not download a new file over the limit, but sends its own', async () => {
    const { storage, env, mac, phone } = await capped(10);
    await write(mac.files, 'small.md', 'tiny\n');
    await write(mac.files, 'big.md', 'x'.repeat(50));
    await mac.engine.sync();
    await write(phone.files, 'local-big.md', 'y'.repeat(50));
    const report = await phone.engine.sync();
    expect(report).toMatchObject({ settled: true, skipped: 1 });
    expect(paths(phone.files)).toEqual(['local-big.md', 'small.md']);
    await mac.engine.sync();
    expect(paths(mac.files)).toEqual(['big.md', 'local-big.md', 'small.md']);
    const verify = await verifyLocal(storage, env, phone.files, { maxFileSize: 10 });
    expect(verify).toMatchObject({ problems: [], skipped: 1 });
  });

  it('keeps syncing a file it holds after it grows over the limit', async () => {
    const { mac, phone } = await capped(10);
    await write(mac.files, 'a.md', 'one\n');
    await mac.engine.sync();
    await phone.engine.sync();
    await write(mac.files, 'a.md', 'one\n' + 'x'.repeat(40) + '\n');
    await mac.engine.sync();
    await phone.engine.sync();
    expect(text(phone.files, 'a.md')).toBe('one\n' + 'x'.repeat(40) + '\n');
    await write(phone.files, 'a.md', 'one\n' + 'x'.repeat(40) + '\nphone\n');
    await phone.engine.sync();
    await mac.engine.sync();
    expect(text(mac.files, 'a.md')).toContain('phone');
  });

  it('moves a local file away from the path of a skipped head file, and sends it', async () => {
    const { mac, phone } = await capped(10);
    await write(mac.files, 'n.md', 'x'.repeat(50));
    await mac.engine.sync();
    await write(phone.files, 'n.md', 'mine\n');
    expect((await phone.engine.sync()).skipped).toBe(1);
    expect(paths(phone.files)).toEqual(['n (conflict phone 202610200900).md']);
    await mac.engine.sync();
    expect(paths(mac.files)).toEqual(['n (conflict phone 202610200900).md', 'n.md']);
    expect(text(mac.files, 'n (conflict phone 202610200900).md')).toBe('mine\n');
    // Once the head file is small, the phone downloads it.
    await write(mac.files, 'n.md', 'mac\n');
    await mac.engine.sync();
    await phone.engine.sync();
    expect(paths(phone.files)).toEqual(paths(mac.files));
  });

  it('moves a large local file out of the way when the head needs its path', async () => {
    const { mac, phone } = await capped(10);
    await write(mac.files, 'a.md', 'a\n');
    await mac.engine.sync();
    await phone.engine.sync();
    await write(phone.files, 'b.md', 'y'.repeat(50));
    mac.files.userMove('a.md', 'b.md');
    await mac.engine.sync();
    await phone.engine.sync();
    expect(paths(phone.files)).toEqual(['b (conflict phone 202610200900).md', 'b.md']);
    expect(text(phone.files, 'b.md')).toBe('a\n');
    expect(text(phone.files, 'b (conflict phone 202610200900).md')).toBe('y'.repeat(50));
  });
});

describe('SyncEngine stop', () => {
  it('stops at a safe point and finishes on the next sync', async () => {
    const { devices } = await setup(['mac', 'phone']);
    const [mac, phone] = devices as [Device, Device];
    for (let i = 0; i < 5; i++) await write(mac.files, `n${i}.md`, `${i}\n`);
    await mac.engine.sync();
    let downloads = 0;
    await expect(phone.engine.sync({ shouldStop: () => ++downloads > 3 })).rejects.toBeInstanceOf(
      SyncStopped,
    );
    expect(paths(phone.files).length).toBeLessThan(5);
    expect((await phone.engine.sync()).settled).toBe(true);
    expect(paths(phone.files)).toHaveLength(5);
  });

  it('stops before a claim and sends the commit on the next sync', async () => {
    const { storage, devices } = await setup(['mac']);
    const [mac] = devices as [Device];
    await write(mac.files, 'a.md', 'a\n');
    // Checks: the pass, the upload, then the claim.
    let checks = 0;
    await expect(mac.engine.sync({ shouldStop: () => ++checks === 3 })).rejects.toBeInstanceOf(
      SyncStopped,
    );
    expect(checks).toBe(3);
    expect(await logLength(storage)).toBe(0);
    expect((await storage.list('blobs/')).keys).toHaveLength(1);
    await mac.engine.sync();
    expect(await logLength(storage)).toBe(1);
  });
});
