// IndexedDB: throughput for many small records and some large blobs,
// transaction behaviour, storage estimate and persistence, and a marker that
// the next plugin load checks. Uses only the probe database `obsy-probe`.
import type { Log, SectionOutput, Step } from '../section';
import { statusOf, step } from '../section';
import {
  MIB,
  describeError,
  equalBytes,
  mbPerSecond,
  now,
  randomBytes,
  randomHex,
  round1,
  sizeLabel,
} from '../util';

export const PROBE_DATABASE = 'obsy-probe';
const VERSION = 1;
const RECORDS = 'records';
const BLOBS = 'blobs';
const MARKERS = 'markers';
export const MARKER_KEY = 'restart-marker';

export interface IndexedDbSectionInput {
  smallRecords?: number;
  separateTransactions?: number;
  blobSizes?: number[];
  log: Log;
}

export interface StoredMarker {
  token: string;
  writtenAt: string;
}

function factory(): IDBFactory | undefined {
  return (window as { indexedDB?: IDBFactory }).indexedDB;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/** Resolves on `complete`; rejects on `abort` or `error` with the transaction's error. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    };
    tx.onerror = () => {
      // `abort` follows; let it decide.
    };
  });
}

export function openProbeDatabase(): Promise<IDBDatabase> {
  const idb = factory();
  if (idb === undefined) return Promise.reject(new Error('indexedDB is not available'));
  return new Promise((resolve, reject) => {
    const open = idb.open(PROBE_DATABASE, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of [RECORDS, BLOBS, MARKERS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    open.onsuccess = () => {
      resolve(open.result);
    };
    open.onerror = () => {
      reject(open.error ?? new Error('indexedDB.open failed'));
    };
    open.onblocked = () => {
      reject(new Error('indexedDB.open is blocked by another connection'));
    };
  });
}

/** Reads the restart marker. Resolves `undefined` when the database or marker is missing. */
export async function readIndexedDbMarker(): Promise<StoredMarker | undefined> {
  const idb = factory();
  if (idb === undefined) return undefined;
  // Do not create the database just to look for a marker.
  if (typeof idb.databases === 'function') {
    const names = (await idb.databases()).map((info) => info.name);
    if (!names.includes(PROBE_DATABASE)) return undefined;
  }
  const db = await openProbeDatabase();
  try {
    const tx = db.transaction(MARKERS, 'readonly');
    const value = (await request(tx.objectStore(MARKERS).get(MARKER_KEY))) as
      | StoredMarker
      | undefined;
    return value;
  } finally {
    db.close();
  }
}

export async function writeIndexedDbMarker(marker: StoredMarker): Promise<void> {
  const db = await openProbeDatabase();
  try {
    const tx = db.transaction(MARKERS, 'readwrite');
    tx.objectStore(MARKERS).put(marker, MARKER_KEY);
    await done(tx);
  } finally {
    db.close();
  }
}

/** Deletes the probe database. Resolves with what happened. */
export function deleteProbeDatabase(): Promise<'deleted' | 'blocked' | 'unavailable'> {
  const idb = factory();
  if (idb === undefined) return Promise.resolve('unavailable');
  return new Promise((resolve, reject) => {
    const req = idb.deleteDatabase(PROBE_DATABASE);
    req.onsuccess = () => {
      resolve('deleted');
    };
    req.onerror = () => {
      reject(req.error ?? new Error('deleteDatabase failed'));
    };
    req.onblocked = () => {
      resolve('blocked');
    };
  });
}

function smallRecord(index: number): Record<string, unknown> {
  return {
    path: `notes/folder-${index % 20}/note-${index}.md`,
    size: 1000 + index,
    mtime: 1_760_000_000_000 + index,
    hash: randomHex(32),
    remoteSeq: index,
  };
}

export async function runIndexedDbSection(input: IndexedDbSectionInput): Promise<SectionOutput> {
  if (factory() === undefined) {
    return { status: 'unavailable', data: { indexedDB: false }, errors: [] };
  }
  const steps: Step[] = [];
  const openStarted = now();
  const db = await openProbeDatabase();
  const openMs = round1(now() - openStarted);
  try {
    const count = input.smallRecords ?? 2000;
    input.log(`IndexedDB: ${count} small records`);
    steps.push(
      await step(`write ${count} small records in one transaction`, async () => {
        const records = Array.from({ length: count }, (_, index) => smallRecord(index));
        const started = now();
        const tx = db.transaction(RECORDS, 'readwrite');
        const store = tx.objectStore(RECORDS);
        records.forEach((record, index) => store.put(record, `r${index}`));
        await done(tx);
        const ms = now() - started;
        return {
          passed: true,
          records: count,
          totalMs: round1(ms),
          recordsPerSecond: Math.round(count / (ms / 1000)),
        };
      }),
    );
    steps.push(
      await step(`read ${count} small records with getAll`, async () => {
        const started = now();
        const tx = db.transaction(RECORDS, 'readonly');
        const all = await request(tx.objectStore(RECORDS).getAll());
        const ms = now() - started;
        return { passed: all.length === count, read: all.length, totalMs: round1(ms) };
      }),
    );
    const separate = input.separateTransactions ?? 200;
    steps.push(
      await step(`write ${separate} records, one transaction each`, async () => {
        const started = now();
        for (let index = 0; index < separate; index += 1) {
          const tx = db.transaction(RECORDS, 'readwrite');
          tx.objectStore(RECORDS).put(smallRecord(index), `s${index}`);
          await done(tx);
        }
        const ms = now() - started;
        return { passed: true, totalMs: round1(ms), meanMsPerTransaction: round1(ms / separate) };
      }),
    );

    for (const size of input.blobSizes ?? [MIB, 8 * MIB, 32 * MIB]) {
      input.log(`IndexedDB: ${sizeLabel(size)} blob`);
      steps.push(await blobStep(db, size, 'Uint8Array'));
    }
    const blobSize = (input.blobSizes ?? [8 * MIB]).at(-1) ?? 8 * MIB;
    steps.push(await blobStep(db, Math.min(blobSize, 8 * MIB), 'Blob'));

    input.log('IndexedDB: transaction behaviour');
    steps.push(...(await transactionSteps(db)));

    // Remove the bulk data; keep the marker store.
    const clear = db.transaction([RECORDS, BLOBS], 'readwrite');
    clear.objectStore(RECORDS).clear();
    clear.objectStore(BLOBS).clear();
    await done(clear);
  } finally {
    db.close();
  }

  const storage = await storageManagerInfo();
  return { status: statusOf(steps), data: { openMs, steps, storage }, errors: [] };
}

async function blobStep(db: IDBDatabase, size: number, form: 'Uint8Array' | 'Blob'): Promise<Step> {
  return step(`write and read a ${sizeLabel(size)} ${form}`, async () => {
    const bytes = randomBytes(size);
    const value = form === 'Blob' ? new Blob([bytes as BlobPart]) : bytes;
    const key = `${form}-${size}`;
    const writeStarted = now();
    const write = db.transaction(BLOBS, 'readwrite');
    write.objectStore(BLOBS).put(value, key);
    await done(write);
    const writeMs = now() - writeStarted;
    const readStarted = now();
    const read = db.transaction(BLOBS, 'readonly');
    const stored: unknown = await request(read.objectStore(BLOBS).get(key));
    const readMs = now() - readStarted;
    let back: Uint8Array | undefined;
    if (stored instanceof Uint8Array) back = stored;
    else if (stored instanceof Blob) back = new Uint8Array(await stored.arrayBuffer());
    const remove = db.transaction(BLOBS, 'readwrite');
    remove.objectStore(BLOBS).delete(key);
    await done(remove);
    return {
      passed: back !== undefined && equalBytes(back, bytes),
      bytes: size,
      readType: stored === undefined ? 'undefined' : Object.prototype.toString.call(stored),
      writeMs: round1(writeMs),
      readMs: round1(readMs),
      writeMBps: mbPerSecond(size, writeMs),
      readMBps: mbPerSecond(size, readMs),
    };
  });
}

async function transactionSteps(db: IDBDatabase): Promise<Step[]> {
  const exists = async (key: string): Promise<boolean> => {
    const tx = db.transaction(RECORDS, 'readonly');
    return (await request(tx.objectStore(RECORDS).getKey(key))) !== undefined;
  };
  return [
    await step('abort() rolls back a put', async () => {
      const tx = db.transaction(RECORDS, 'readwrite');
      tx.objectStore(RECORDS).put({ x: 1 }, 'abort-probe');
      const finished = done(tx).then(
        () => 'complete',
        (error: unknown) => (error instanceof DOMException ? error.name : describeError(error)),
      );
      tx.abort();
      const outcome = await finished;
      return { passed: !(await exists('abort-probe')), outcome };
    }),
    await step('a failed add() aborts the whole transaction', async () => {
      const setup = db.transaction(RECORDS, 'readwrite');
      setup.objectStore(RECORDS).put({ x: 1 }, 'constraint-existing');
      await done(setup);
      const tx = db.transaction(RECORDS, 'readwrite');
      const store = tx.objectStore(RECORDS);
      store.put({ x: 2 }, 'constraint-new');
      store.add({ x: 3 }, 'constraint-existing');
      const outcome = await done(tx).then(
        () => 'complete',
        (error: unknown) => (error instanceof DOMException ? error.name : describeError(error)),
      );
      return { passed: !(await exists('constraint-new')), outcome };
    }),
    await step('a transaction is inactive after awaiting crypto.subtle', async () => {
      const tx = db.transaction(RECORDS, 'readwrite');
      // Listen before the await: the transaction may complete during it.
      const finished = done(tx).catch(() => {});
      const store = tx.objectStore(RECORDS);
      store.put({ x: 1 }, 'await-before');
      await window.crypto.subtle.digest('SHA-256', new Uint8Array(16));
      let observed = 'put after await succeeded';
      try {
        store.put({ x: 2 }, 'await-after');
      } catch (error) {
        observed = error instanceof DOMException ? error.name : describeError(error);
      }
      await finished;
      // Expected by the IndexedDB spec: TransactionInactiveError.
      return { passed: true, observed, firstPutKept: await exists('await-before') };
    }),
    await step('a transaction is inactive after a timer', async () => {
      const tx = db.transaction(RECORDS, 'readwrite');
      // Listen before the await: the transaction may complete during it.
      const finished = done(tx).catch(() => {});
      const store = tx.objectStore(RECORDS);
      store.put({ x: 1 }, 'timer-before');
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });
      let observed = 'put after timer succeeded';
      try {
        store.put({ x: 2 }, 'timer-after');
      } catch (error) {
        observed = error instanceof DOMException ? error.name : describeError(error);
      }
      await finished;
      return { passed: true, observed };
    }),
  ];
}

async function storageManagerInfo(): Promise<Record<string, unknown>> {
  const manager = (window.navigator as { storage?: StorageManager }).storage;
  if (manager === undefined) return { storageManager: false };
  const out: Record<string, unknown> = { storageManager: true };
  try {
    if (typeof manager.estimate === 'function') {
      const estimate = await manager.estimate();
      out['usageBytes'] = estimate.usage ?? null;
      out['quotaBytes'] = estimate.quota ?? null;
    } else {
      out['estimate'] = 'not a function';
    }
  } catch (error) {
    out['estimateError'] = describeError(error);
  }
  try {
    out['persistedBefore'] =
      typeof manager.persisted === 'function' ? await manager.persisted() : 'not a function';
  } catch (error) {
    out['persistedError'] = describeError(error);
  }
  try {
    out['persistResult'] =
      typeof manager.persist === 'function' ? await manager.persist() : 'not a function';
  } catch (error) {
    out['persistError'] = describeError(error);
  }
  return out;
}
