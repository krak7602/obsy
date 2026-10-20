import {
  TransientStorageError,
  type ListResult,
  type PutResult,
  type Storage,
  type StoredObject,
} from '@obsy/protocol';

import type { Random, Scheduler } from './scheduler';

export interface FaultRates {
  /** The request fails before it reaches the bucket. */
  readonly beforeApply: number;
  /** A write applies, then the response is lost (`mayHaveApplied`). */
  readonly lostResponse: number;
  /** A write fails now (`mayHaveApplied`) and reaches the bucket later. */
  readonly delayed: number;
}

export const NO_FAULTS: FaultRates = { beforeApply: 0, lostResponse: 0, delayed: 0 };

/**
 * One owner's view of the shared bucket. Every request is a scheduler step,
 * and may fail in the ways a real network fails. Writes that are still in
 * flight when the owner crashes may reach the bucket.
 */
export class FaultyStorage implements Storage {
  constructor(
    readonly inner: Storage,
    readonly scheduler: Scheduler,
    readonly owner: string,
    readonly random: Random,
    readonly faults: { rates: FaultRates },
    /** Writes that reach the bucket at a later step. */
    readonly delayed: (() => Promise<void>)[],
  ) {}

  #fail(): never {
    throw new TransientStorageError('simulated network failure');
  }

  async get(key: string): Promise<StoredObject | null> {
    await this.scheduler.wait(this.owner, `get ${key}`);
    if (this.random.chance(this.faults.rates.beforeApply)) this.#fail();
    return this.inner.get(key);
  }

  async list(prefix: string, startAfter?: string, limit?: number): Promise<ListResult> {
    await this.scheduler.wait(this.owner, `list ${prefix}`);
    if (this.random.chance(this.faults.rates.beforeApply)) this.#fail();
    return this.inner.list(prefix, startAfter, limit);
  }

  async delete(key: string): Promise<void> {
    await this.scheduler.wait(this.owner, `delete ${key}`);
    if (this.random.chance(this.faults.rates.beforeApply)) this.#fail();
    return this.inner.delete(key);
  }

  putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    return this.#write(`putIfAbsent ${key}`, () => this.inner.putIfAbsent(key, body, contentType));
  }

  putIfMatch(key: string, body: Uint8Array, etag: string, contentType: string): Promise<PutResult> {
    return this.#write(`putIfMatch ${key}`, () =>
      this.inner.putIfMatch(key, body, etag, contentType),
    );
  }

  async #write(label: string, apply: () => Promise<PutResult>): Promise<PutResult> {
    const late = (): void => {
      this.delayed.push(async () => {
        await apply().catch(() => undefined);
      });
    };
    // If the owner crashes while this request waits, it reached the bucket or not.
    await this.scheduler.wait(this.owner, label, () => {
      if (this.random.chance(0.5)) late();
    });
    const rates = this.faults.rates;
    const roll = this.random.next();
    if (roll < rates.beforeApply) this.#fail();
    if (roll < rates.beforeApply + rates.delayed) {
      late();
      throw new TransientStorageError('simulated timeout', { mayHaveApplied: true });
    }
    const result = await apply();
    if (roll < rates.beforeApply + rates.delayed + rates.lostResponse) {
      throw new TransientStorageError('simulated lost response', { mayHaveApplied: true });
    }
    return result;
  }
}
