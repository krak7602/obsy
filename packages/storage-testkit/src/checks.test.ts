import { PreconditionFailed } from '@obsy/protocol';
import type { ListResult, PutResult, Storage, StoredObject } from '@obsy/protocol';
import { describe, expect, it } from 'vite-plus/test';

import { DEFAULT_RACE, conformanceChecks, runConformanceChecks } from './checks';
import type { CheckResult } from './checks';
import { MemoryStorage } from './memory-storage';

/** Delegates to `MemoryStorage`, with one behaviour changed per test. */
class AlteredStorage implements Storage {
  readonly inner = new MemoryStorage();
  constructor(readonly change: 'blind-create' | 'utf16-list' | 'quoted-etag' | 'hang') {}

  get(key: string): Promise<StoredObject | null> {
    if (this.change === 'hang') return new Promise(() => {});
    return this.inner.get(key);
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    if (this.change === 'blind-create') {
      // Not conditional: overwrites an existing key.
      await this.inner.delete(key);
    }
    const result = await this.inner.putIfAbsent(key, body, contentType);
    return this.change === 'quoted-etag' ? { etag: `"${result.etag}"` } : result;
  }

  putIfMatch(key: string, body: Uint8Array, etag: string, contentType: string): Promise<PutResult> {
    return this.inner.putIfMatch(key, body, etag.replaceAll('"', ''), contentType);
  }

  async list(prefix: string, startAfter?: string, limit?: number): Promise<ListResult> {
    const page = await this.inner.list(prefix, startAfter, limit);
    // UTF-16 code unit order instead of code point order.
    return this.change === 'utf16-list' ? { ...page, keys: [...page.keys].sort() } : page;
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

const SMALL_RACE = { ...DEFAULT_RACE, createRounds: 3, commitsPerWriter: 3 };

async function run(create: () => Storage, timeoutMs?: number): Promise<CheckResult[]> {
  return runConformanceChecks({
    checks: conformanceChecks(SMALL_RACE),
    create,
    race: SMALL_RACE,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function failed(results: CheckResult[]): string[] {
  return results.filter((result) => !result.passed).map((result) => result.label);
}

describe('runConformanceChecks', () => {
  it('passes every check on MemoryStorage', async () => {
    const results = await run(() => new MemoryStorage());
    expect(results.length).toBe(conformanceChecks(SMALL_RACE).length);
    expect(failed(results)).toEqual([]);
    expect(results.every((result) => result.durationMs >= 0)).toBe(true);
  });

  it('catches a create that is not conditional', async () => {
    const results = await run(() => new AlteredStorage('blind-create'));
    expect(failed(results)).toContain('create-exists');
    const result = results.find((entry) => entry.label === 'create-exists');
    expect(result?.error).toMatch(
      /^ConformanceFailure: second putIfAbsent: expected PreconditionFailed/,
    );
  });

  it('catches a list in UTF-16 order', async () => {
    const results = await run(() => new AlteredStorage('utf16-list'));
    expect(failed(results)).toEqual(['unusual-keys']);
  });

  it('catches a quoted etag', async () => {
    expect(failed(await run(() => new AlteredStorage('quoted-etag')))).toContain('create-read');
  });

  it('fails a check that exceeds its time limit, and continues', async () => {
    const checks = conformanceChecks(SMALL_RACE).filter((check) =>
      ['get-missing', 'delete-recreate'].includes(check.label),
    );
    const results = await runConformanceChecks({
      checks,
      create: (label) =>
        label === 'get-missing' ? new AlteredStorage('hang') : new MemoryStorage(),
      race: SMALL_RACE,
      timeoutMs: 20,
    });
    expect(results.map((result) => [result.label, result.passed])).toEqual([
      ['get-missing', false],
      ['delete-recreate', true],
    ]);
    expect(results[0]?.error).toMatch(/^Timeout/);
  });

  it('reports a storage factory failure as a failed check', async () => {
    const results = await runConformanceChecks({
      checks: conformanceChecks(SMALL_RACE).slice(0, 1),
      create: () => {
        throw new PreconditionFailed('factory failed');
      },
      race: SMALL_RACE,
    });
    expect(results[0]).toMatchObject({
      passed: false,
      error: 'PreconditionFailed: factory failed',
    });
  });

  it('keeps the suite titles and order', () => {
    const checks = conformanceChecks(DEFAULT_RACE);
    expect(checks.map((check) => check.group)).toEqual([
      ...Array<string>(3).fill('get and putIfAbsent'),
      ...Array<string>(5).fill('putIfMatch'),
      ...Array<string>(2).fill('delete'),
      ...Array<string>(6).fill('list'),
      ...Array<string>(4).fill('keys and bodies'),
      ...Array<string>(2).fill('races'),
    ]);
    expect(new Set(checks.map((check) => check.label)).size).toBe(checks.length);
    expect(checks.filter((check) => check.race).map((check) => check.name)).toEqual([
      'conditional create: 8 writers x 20 rounds, one winner per round',
      'commit log: 4 writers x 10 commits, no gaps or duplicates',
    ]);
  });
});
