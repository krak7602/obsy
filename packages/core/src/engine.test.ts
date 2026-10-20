import { decodeUtf8Strict, encodeUtf8, type Storage } from '@obsy/protocol';
import { MemoryStorage } from '@obsy/storage-testkit';
import { describe, expect, it } from 'vite-plus/test';

import { SyncEngine } from './engine';
import { MemoryLocalFiles, MemoryStateStore, SeededEnvironment } from './memory';
import { initVault } from './vault';

interface Device {
  files: MemoryLocalFiles;
  engine: SyncEngine;
}

async function setup(names: string[]): Promise<{ storage: Storage; devices: Device[] }> {
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
    });
    return { files, engine };
  });
  return { storage, devices };
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
});
