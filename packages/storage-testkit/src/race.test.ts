import { PreconditionFailed, TransientStorageError } from '@obsy/protocol';
import type { ListResult, PutResult, Storage, StoredObject } from '@obsy/protocol';
import { describe, expect, it } from 'vite-plus/test';

import { MemoryStorage } from './memory-storage';
import { logKey, runCommitLogRace, runCreateRace } from './race';
import { formatRaceResult } from './report';
import { randomYieldScheduler, seededRandom } from './runtime';

/**
 * A storage whose putIfAbsent checks, yields, then overwrites: not atomic.
 * This is the bug that the race harness must detect.
 */
class CheckThenWriteStorage implements Storage {
  readonly #objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<StoredObject | null> {
    await Promise.resolve();
    const body = this.#objects.get(key);
    return body === undefined ? null : { body: body.slice(), etag: String(body.length) };
  }

  async putIfAbsent(key: string, body: Uint8Array): Promise<PutResult> {
    if (this.#objects.has(key)) throw new PreconditionFailed('exists');
    await Promise.resolve();
    this.#objects.set(key, body.slice());
    return { etag: String(body.length) };
  }

  putIfMatch(): Promise<PutResult> {
    return Promise.reject(new Error('not used'));
  }

  async list(prefix: string, startAfter?: string, limit = 1000): Promise<ListResult> {
    await Promise.resolve();
    const keys = [...this.#objects.keys()]
      .filter((key) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
      .sort();
    return { keys: keys.slice(0, limit), truncated: keys.length > limit };
  }

  async delete(key: string): Promise<void> {
    await Promise.resolve();
    this.#objects.delete(key);
  }
}

/**
 * Wraps a storage and makes some writes fail with transient errors. Some of
 * them apply the write first and then fail, like a lost response.
 */
class FlakyStorage implements Storage {
  readonly #inner: Storage;
  readonly #random: () => number;

  constructor(inner: Storage, seed: number) {
    this.#inner = inner;
    this.#random = seededRandom(seed);
  }

  get(key: string): Promise<StoredObject | null> {
    if (this.#random() < 0.05) return Promise.reject(new TransientStorageError('flaky get'));
    return this.#inner.get(key);
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    const roll = this.#random();
    if (roll < 0.1) throw new TransientStorageError('rate limited', { status: 429 });
    const result = await this.#inner.putIfAbsent(key, body, contentType);
    if (roll < 0.2) throw new TransientStorageError('lost response', { mayHaveApplied: true });
    return result;
  }

  putIfMatch(key: string, body: Uint8Array, etag: string, contentType: string): Promise<PutResult> {
    return this.#inner.putIfMatch(key, body, etag, contentType);
  }

  list(prefix: string, startAfter?: string, limit?: number): Promise<ListResult> {
    if (this.#random() < 0.05) return Promise.reject(new TransientStorageError('flaky list'));
    return this.#inner.list(prefix, startAfter, limit);
  }

  delete(key: string): Promise<void> {
    return this.#inner.delete(key);
  }
}

const fastRetry = { maxAttempts: 50, baseDelayMs: 0, maxDelayMs: 0 };

describe('race harness', () => {
  it('formats log keys with 16 digits', () => {
    expect(logKey('v/', 42)).toBe('v/log/0000000000000042.json');
  });

  it('detects a storage whose conditional create is not atomic', async () => {
    const result = await runCreateRace(new CheckThenWriteStorage(), {
      writers: 8,
      rounds: 10,
      prefix: '',
    });
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.roundsPassed).toBeLessThan(10);
  });

  it('detects lost commits on a storage whose conditional create is not atomic', async () => {
    const result = await runCommitLogRace(new CheckThenWriteStorage(), {
      writers: 4,
      commitsPerWriter: 5,
      prefix: '',
    });
    expect(result.violations.some((violation) => violation.includes('missing'))).toBe(true);
  });

  it('passes through transient errors and lost responses', async () => {
    const inner = new MemoryStorage({ scheduler: randomYieldScheduler(7) });
    const create = await runCreateRace(new FlakyStorage(inner, 1), {
      writers: 8,
      rounds: 30,
      prefix: 'c/',
      retry: fastRetry,
    });
    expect(create.violations).toEqual([]);
    expect(create.outcomes['transient:429']).toBeGreaterThan(0);
    expect(create.outcomes['transient']).toBeGreaterThan(0);

    const log = await runCommitLogRace(new FlakyStorage(inner, 2), {
      writers: 6,
      commitsPerWriter: 15,
      prefix: 'l/',
      listLimit: 3,
      retry: fastRetry,
    });
    expect(log.violations).toEqual([]);
    expect(log.logEntries).toBe(90);
    expect(log.outcomes['transient']).toBeGreaterThan(0);
  });

  it('reports results as Markdown', async () => {
    const result = await runCommitLogRace(new MemoryStorage(), {
      writers: 2,
      commitsPerWriter: 2,
      prefix: '',
    });
    const text = formatRaceResult('commit-log race', result);
    expect(text).toContain('Log entries: 4');
    expect(text).toContain('Violations: none');
  });
});
