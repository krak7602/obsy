import { SeededEnvironment } from '@obsy/core';
import { MemoryStorage } from '@obsy/storage-testkit/portable';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vite-plus/test';

import { DEFAULT_SETTINGS, type DeviceSettings, type ObsySettings } from '../settings';
import { FakeVault } from '../testing/fake-vault';
import { IdbKeyValue, IdbStateStore } from './idb-store';
import { SyncService, type Question, type ServiceHost, type SyncStatus } from './service';
import { VaultLocalFiles } from './vault-files';

interface Device {
  vault: FakeVault;
  service: SyncService;
  host: ServiceHost & {
    questions: Question[];
    answers: boolean[];
    notices: string[];
    statuses: SyncStatus[];
    current: { settings: ObsySettings; device: DeviceSettings };
  };
}

async function device(storage: MemoryStorage, name: string, factory: IDBFactory): Promise<Device> {
  const vault = new FakeVault();
  const store = new IdbStateStore(await IdbKeyValue.open(factory), `local${name}`);
  const current = {
    settings: {
      ...DEFAULT_SETTINGS,
      endpoint: 'https://bucket.example',
      bucket: 'b',
      accessKeyIdSecret: 'obsy-key',
      secretAccessKeySecret: 'obsy-secret',
    },
    device: {
      localId: `local${name}`,
      deviceName: name,
      mode: 'off',
      autoSync: true,
    } as DeviceSettings,
  };
  const host: Device['host'] = {
    questions: [],
    answers: [],
    notices: [],
    statuses: [],
    current,
    settings: () => current.settings,
    saveSettings: (settings) => {
      current.settings = settings;
      return Promise.resolve();
    },
    device: () => current.device,
    saveDevice: (d) => {
      current.device = d;
    },
    storage: () => storage,
    files: new VaultLocalFiles(vault),
    store,
    env: new SeededEnvironment(name.length),
    saveOpenNotes: () => Promise.resolve(),
    ask(question) {
      this.questions.push(question);
      return Promise.resolve(this.answers.shift() ?? false);
    },
    notify(message) {
      this.notices.push(message);
    },
    status(status) {
      this.statuses.push(status);
    },
  };
  return { vault, service: new SyncService(host), host };
}

async function twoDevices(): Promise<{ mac: Device; phone: Device; storage: MemoryStorage }> {
  const storage = new MemoryStorage();
  const factory = new IDBFactory();
  return {
    storage,
    mac: await device(storage, 'mac', factory),
    phone: await device(storage, 'phone', factory),
  };
}

describe('SyncService', () => {
  it('creates a vault on the first device and joins pull-only on the second', async () => {
    const { mac, phone, storage } = await twoDevices();
    mac.vault.userWrite('a.md', 'a\n');
    mac.vault.userWrite('notes/b.md', 'b\n');
    mac.host.answers.push(true);
    await mac.service.connect();
    expect(mac.host.questions[0]?.title).toBe('Create a vault in the bucket?');
    expect(mac.host.current.device.mode).toBe('full');
    expect(mac.service.status.state).toBe('idle');
    expect(mac.host.current.settings.vaultId).toMatch(/^v_/);

    phone.vault.userWrite('a.md', 'a\n');
    phone.vault.userWrite('notes/b.md', 'phone version\n');
    phone.vault.userWrite('phone-only.md', 'p\n');
    phone.host.answers.push(true);
    await phone.service.connect();
    expect(phone.host.questions[0]?.title).toBe('Join the vault in the bucket?');
    expect(phone.host.current.device.mode).toBe('pull-only');
    expect(phone.vault.paths()).toEqual([
      'a.md',
      'notes/b (conflict phone 202610200900).md',
      'notes/b.md',
      'phone-only.md',
    ]);
    expect(phone.vault.text('notes/b.md')).toBe('b\n');
    expect(phone.service.status.unsent).toBe(2);
    const logBefore = (await storage.list('log/')).keys.length;
    expect(logBefore).toBe(1);

    const verify = await phone.service.verify();
    expect(verify.problems).toEqual([
      { path: 'notes/b (conflict phone 202610200900).md', problem: 'extra' },
      { path: 'phone-only.md', problem: 'extra' },
    ]);

    await phone.service.startFullSync();
    expect(phone.host.current.device.mode).toBe('full');
    expect((await phone.service.verify()).problems).toEqual([]);
    await mac.service.run();
    expect(mac.vault.paths()).toEqual(phone.vault.paths());
    expect((await mac.service.verify()).problems).toEqual([]);
  });

  it('stops at a mass delete, pauses, and deletes only when the user agrees', async () => {
    const { mac, phone, storage } = await twoDevices();
    for (let i = 0; i < 20; i++) mac.vault.userWrite(`n${i}.md`, `${i}\n`);
    mac.host.answers.push(true);
    await mac.service.connect();
    phone.host.answers.push(true);
    await phone.service.connect();
    await phone.service.startFullSync();
    for (let i = 0; i < 12; i++) mac.vault.userRemove(`n${i}.md`);

    mac.host.answers.push(false);
    await mac.service.run();
    expect(mac.host.questions.at(-1)?.title).toBe('Obsy stopped a sync');
    expect(mac.host.current.device.autoSync).toBe(false);
    expect(mac.service.status.state).toBe('paused');
    const log = (await storage.list('log/')).keys.length;
    // Paused: an automatic run does nothing.
    expect(await mac.service.run()).toBeNull();
    expect((await storage.list('log/')).keys.length).toBe(log);

    mac.host.answers.push(true);
    await mac.service.run({ manual: true });
    expect(mac.host.current.device.autoSync).toBe(true);
    expect((await storage.list('log/')).keys.length).toBe(log + 1);

    phone.host.answers.push(true);
    await phone.service.run();
    expect(phone.vault.paths()).toHaveLength(8);
    expect(phone.vault.trashed).toHaveLength(12);
  });

  it('asks before syncing a folder that lost its vault marker', async () => {
    const { mac } = await twoDevices();
    mac.vault.userWrite('a.md', 'a\n');
    mac.host.answers.push(true);
    await mac.service.connect();
    mac.host.current.settings = { ...mac.host.current.settings, vaultId: null };
    mac.host.answers.push(false);
    await mac.service.run();
    expect(mac.host.questions.at(-1)?.title).toBe('Is this the same vault folder?');
    expect(mac.service.status.state).toBe('paused');
    mac.host.answers.push(true);
    await mac.service.run({ manual: true });
    expect(mac.service.status.state).toBe('idle');
    expect(mac.host.current.settings.vaultId).toMatch(/^v_/);
  });

  it('does nothing until connected, and reports missing settings', async () => {
    const { mac } = await twoDevices();
    expect(await mac.service.run()).toBeNull();
    expect(mac.service.status.state).toBe('off');
    mac.host.current.settings = { ...mac.host.current.settings, bucket: '' };
    await mac.service.connect();
    expect(mac.host.notices.at(-1)).toContain('bucket');
  });
});

describe('SyncService queue', () => {
  it('runs operations one at a time', async () => {
    const { mac } = await twoDevices();
    mac.vault.userWrite('a.md', 'a\n');
    mac.host.answers.push(true);
    await mac.service.connect();
    let active = 0;
    let most = 0;
    const store = mac.host.store;
    const load = store.load.bind(store);
    store.load = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return load();
    };
    await Promise.all([mac.service.run(), mac.service.run({ manual: true }), mac.service.verify()]);
    expect(most).toBe(1);
  });
});
