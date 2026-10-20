import type { DeviceState, StateStore } from '@obsy/core';

import type { HashCacheEntry } from './vault-files';

const DB_NAME = 'obsy';
const STORE = 'kv';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * One IndexedDB object store of values by key. Each call is one
 * transaction: a transaction does not survive an `await` on other work
 * (see docs/learning/iphone-probe.md), so callers never hold one open.
 */
export class IdbKeyValue {
  private constructor(readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IdbKeyValue> {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    return new IdbKeyValue(await request(req));
  }

  async get<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction(STORE, 'readonly');
    return (await request(tx.objectStore(STORE).get(key))) as T | undefined;
  }

  /** Resolves when the value is durable. */
  async put(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite', { durability: 'strict' });
    tx.objectStore(STORE).put(value, key);
    await done(tx);
  }

  async delete(key: string): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite', { durability: 'strict' });
    tx.objectStore(STORE).delete(key);
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The engine's device state for one local vault, in IndexedDB. `localId`
 * is unique per vault and device, so two vaults in one app never share
 * state. A save is one transaction, so it is atomic.
 */
export class IdbStateStore implements StateStore {
  constructor(
    readonly kv: IdbKeyValue,
    readonly localId: string,
  ) {}

  get #key(): string {
    return `state/${this.localId}`;
  }

  async load(): Promise<DeviceState | null> {
    const text = await this.kv.get<string>(this.#key);
    return text === undefined ? null : (JSON.parse(text) as DeviceState);
  }

  async save(state: DeviceState): Promise<void> {
    // A JSON string keeps the stored value exactly what the engine saved.
    await this.kv.put(this.#key, JSON.stringify(state));
  }

  async clear(): Promise<void> {
    await this.kv.delete(this.#key);
  }

  async loadHashes(): Promise<Record<string, HashCacheEntry>> {
    return (await this.kv.get<Record<string, HashCacheEntry>>(`hashes/${this.localId}`)) ?? {};
  }

  async saveHashes(hashes: Record<string, HashCacheEntry>): Promise<void> {
    await this.kv.put(`hashes/${this.localId}`, hashes);
  }
}
