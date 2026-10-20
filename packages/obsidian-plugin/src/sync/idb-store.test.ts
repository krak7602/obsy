import { IDBFactory } from 'fake-indexeddb';
import type { DeviceState } from '@obsy/core';
import { describe, expect, it } from 'vite-plus/test';

import { IdbKeyValue, IdbStateStore } from './idb-store';

const state: DeviceState = {
  vaultId: 'v_aaaaaaaaaaaaaaaaaaaaaaaa',
  epoch: 1,
  head: { seq: 0, files: {} },
  synced: {},
  pending: null,
  intents: {},
};

describe('IdbStateStore', () => {
  it('saves and loads the state per local vault', async () => {
    const factory = new IDBFactory();
    const kv = await IdbKeyValue.open(factory);
    const one = new IdbStateStore(kv, 'one');
    const two = new IdbStateStore(kv, 'two');
    expect(await one.load()).toBeNull();
    await one.save(state);
    expect(await one.load()).toEqual(state);
    expect(await two.load()).toBeNull();
    await one.save({ ...state, epoch: 2 });
    kv.close();

    const reopened = new IdbStateStore(await IdbKeyValue.open(factory), 'one');
    expect((await reopened.load())?.epoch).toBe(2);
    await reopened.clear();
    expect(await reopened.load()).toBeNull();
  });

  it('keeps file hashes apart from the state', async () => {
    const store = new IdbStateStore(await IdbKeyValue.open(new IDBFactory()), 'one');
    expect(await store.loadHashes()).toEqual({});
    const hashes = { 'a.md': { size: 2, mtime: 5, hash: `sha256:${'0'.repeat(64)}` as const } };
    await store.saveHashes(hashes);
    expect(await store.loadHashes()).toEqual(hashes);
    expect(await store.load()).toBeNull();
  });
});
