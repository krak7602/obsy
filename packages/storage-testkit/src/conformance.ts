import { isPreconditionFailed, isStorageError } from '@obsy/protocol';
import type { Storage } from '@obsy/protocol';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import { runCommitLogRace, runCreateRace } from './race';
import type { CommitLogRaceResult, CreateRaceResult, RetryPolicy } from './race';
import { fromUtf8, seededRandom, utf8 } from './runtime';

export interface RaceParameters {
  /** Concurrent writers in the conditional-create race. */
  createWriters: number;
  createRounds: number;
  /** Concurrent writers in the commit-log race. */
  logWriters: number;
  commitsPerWriter: number;
  /** `limit` for the commit-log race's catch-up lists. */
  listLimit: number;
  retry?: RetryPolicy;
}

export const DEFAULT_RACE: RaceParameters = {
  createWriters: 8,
  createRounds: 20,
  logWriters: 4,
  commitsPerWriter: 10,
  listLimit: 5,
};

export interface ConformanceTarget {
  /** The name of the provider under test, used in test titles. */
  name: string;
  /**
   * Returns a `Storage` for one test. Each call must return storage whose keys
   * do not overlap with earlier calls: a new instance or a fresh sub-prefix.
   */
  create(label: string): Storage | Promise<Storage>;
  /** Runs once after all tests, for example to delete the run's keys. */
  cleanup?(): Promise<void>;
  race?: Partial<RaceParameters>;
  /** Timeout for one test. Default 30 s; races get ten times this. */
  timeoutMs?: number;
  /** Receives race results, for example to print a summary. */
  report?(label: string, result: CreateRaceResult | CommitLogRaceResult): void;
}

/** Keys with characters that need care in URLs, XML, and list order. */
export const UNUSUAL_KEYS: readonly string[] = [
  'unusual/space in name.md',
  'unusual/plus+sign.md',
  'unusual/percent%20literal.md',
  'unusual/amp&lt;not-an-entity.md',
  'unusual/<angle>"quote"\'apos\'.md',
  'unusual/hash#question?equals=.md',
  'unusual/tilde~bang!star*paren().md',
  'unusual/colon:at@dollar$comma,semi;.md',
  'unusual/brackets[]braces{}pipe|caret^backtick`.md',
  'unusual/back\\slash.md',
  'unusual/café-nfc.md',
  'unusual/café-nfd.md',
  'unusual/日本語.md',
  'unusual/emoji-\u{1F600}.md',
  'unusual/fullwidth-～.md',
  'unusual/trailing-dot.',
];

function body(text: string): Uint8Array {
  return utf8(text);
}

async function expectPreconditionFailed(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isPreconditionFailed(caught), `expected PreconditionFailed, got ${String(caught)}`).toBe(
    true,
  );
}

/** Lists every key under `prefix` by following `truncated`. */
async function listAll(
  storage: Storage,
  prefix: string,
  limit?: number,
  from?: string,
): Promise<string[]> {
  const keys: string[] = [];
  let startAfter = from;
  for (let pages = 0; pages < 10_000; pages += 1) {
    const page = await storage.list(prefix, startAfter, limit);
    keys.push(...page.keys);
    if (!page.truncated) return keys;
    startAfter = page.keys.at(-1) ?? startAfter;
  }
  throw new Error('list did not finish');
}

/** Registers the storage conformance suite for `target` with Vitest. */
export function describeStorageConformance(target: ConformanceTarget): void {
  const race: RaceParameters = { ...DEFAULT_RACE, ...target.race };
  const timeout = target.timeoutMs ?? 30_000;
  const raceTimeout = timeout * 10;

  describe(`Storage conformance: ${target.name}`, () => {
    if (target.cleanup !== undefined) {
      const cleanup = target.cleanup.bind(target);
      afterAll(async () => {
        await cleanup();
      }, raceTimeout);
    }

    describe('get and putIfAbsent', () => {
      it('returns null for a missing key', { timeout }, async () => {
        const storage = await target.create('get-missing');
        expect(await storage.get('missing/key.json')).toBeNull();
      });

      it('creates a key and reads it back with the same etag', { timeout }, async () => {
        const storage = await target.create('create-read');
        const created = await storage.putIfAbsent('a.json', body('{"a":1}'), 'application/json');
        expect(typeof created.etag).toBe('string');
        expect(created.etag.length).toBeGreaterThan(0);
        expect(created.etag.startsWith('"')).toBe(false);
        const read = await storage.get('a.json');
        expect(read).not.toBeNull();
        expect(fromUtf8(read?.body ?? new Uint8Array())).toBe('{"a":1}');
        expect(read?.etag).toBe(created.etag);
      });

      it('fails with PreconditionFailed when the key exists', { timeout }, async () => {
        const storage = await target.create('create-exists');
        await storage.putIfAbsent('k', body('first'), 'text/plain');
        await expectPreconditionFailed(storage.putIfAbsent('k', body('second'), 'text/plain'));
        const read = await storage.get('k');
        expect(fromUtf8(read?.body ?? new Uint8Array())).toBe('first');
      });
    });

    describe('putIfMatch', () => {
      it('replaces the key when the etag matches', { timeout }, async () => {
        const storage = await target.create('match-ok');
        const created = await storage.putIfAbsent('vault.json', body('v1'), 'application/json');
        const updated = await storage.putIfMatch(
          'vault.json',
          body('v2'),
          created.etag,
          'application/json',
        );
        expect(updated.etag).not.toBe(created.etag);
        const read = await storage.get('vault.json');
        expect(fromUtf8(read?.body ?? new Uint8Array())).toBe('v2');
        expect(read?.etag).toBe(updated.etag);
      });

      it('fails with PreconditionFailed for a stale etag', { timeout }, async () => {
        const storage = await target.create('match-stale');
        const first = await storage.putIfAbsent('vault.json', body('v1'), 'application/json');
        await storage.putIfMatch('vault.json', body('v2'), first.etag, 'application/json');
        await expectPreconditionFailed(
          storage.putIfMatch('vault.json', body('v3'), first.etag, 'application/json'),
        );
        const read = await storage.get('vault.json');
        expect(fromUtf8(read?.body ?? new Uint8Array())).toBe('v2');
      });

      it('fails with PreconditionFailed for a made-up etag', { timeout }, async () => {
        const storage = await target.create('match-wrong');
        await storage.putIfAbsent('vault.json', body('v1'), 'application/json');
        await expectPreconditionFailed(
          storage.putIfMatch(
            'vault.json',
            body('v2'),
            '0123456789abcdef0123456789abcdef',
            'application/json',
          ),
        );
      });

      it('fails with PreconditionFailed when the key does not exist', { timeout }, async () => {
        const storage = await target.create('match-missing');
        const other = await storage.putIfAbsent('other.json', body('x'), 'application/json');
        await expectPreconditionFailed(
          storage.putIfMatch('missing.json', body('x'), other.etag, 'application/json'),
        );
        expect(await storage.get('missing.json')).toBeNull();
      });

      it('lets exactly one of concurrent matching writers win', { timeout }, async () => {
        const storage = await target.create('match-race');
        for (let round = 0; round < 5; round += 1) {
          const key = `devices/d${round}.json`;
          const created = await storage.putIfAbsent(key, body('base'), 'application/json');
          const writers = race.createWriters;
          const results = await Promise.allSettled(
            Array.from({ length: writers }, (_, writer) =>
              storage.putIfMatch(key, body(`writer ${writer}`), created.etag, 'application/json'),
            ),
          );
          const winners = results.flatMap((result, writer) =>
            result.status === 'fulfilled' ? [writer] : [],
          );
          const transient = results.filter(
            (result) => result.status === 'rejected' && isStorageError(result.reason, 'transient'),
          ).length;
          const others = results.filter(
            (result) =>
              result.status === 'rejected' &&
              !isPreconditionFailed(result.reason) &&
              !isStorageError(result.reason, 'transient'),
          );
          expect(others).toEqual([]);
          if (transient === 0) expect(winners).toHaveLength(1);
          else expect(winners.length).toBeLessThanOrEqual(1);
          const read = await storage.get(key);
          const stored = fromUtf8(read?.body ?? new Uint8Array());
          if (winners.length === 1) expect(stored).toBe(`writer ${winners[0]}`);
        }
      });
    });

    describe('delete', () => {
      it('deletes a key, and deleting a missing key succeeds', { timeout }, async () => {
        const storage = await target.create('delete');
        await storage.putIfAbsent('presence/d.json', body('x'), 'application/json');
        await storage.delete('presence/d.json');
        expect(await storage.get('presence/d.json')).toBeNull();
        expect((await storage.list('presence/')).keys).toEqual([]);
        await storage.delete('presence/d.json');
        await storage.delete('never/existed.json');
      });

      it('allows putIfAbsent again after delete', { timeout }, async () => {
        const storage = await target.create('delete-recreate');
        await storage.putIfAbsent('k', body('one'), 'text/plain');
        await storage.delete('k');
        await storage.putIfAbsent('k', body('two'), 'text/plain');
        const read = await storage.get('k');
        expect(fromUtf8(read?.body ?? new Uint8Array())).toBe('two');
      });
    });

    describe('list', () => {
      it('lists in code point order, with prefix filtering', { timeout }, async () => {
        const storage = await target.create('list-order');
        const keys = [
          'log/0000000000000010.json',
          'log/0000000000000002.json',
          'log/0000000000000001.json',
          'log/0000000000000100.json',
          'logs/other.json',
          'log.json',
          'blobs/sha256/ff',
        ];
        for (const key of keys) await storage.putIfAbsent(key, body(key), 'text/plain');
        expect(await listAll(storage, 'log/')).toEqual([
          'log/0000000000000001.json',
          'log/0000000000000002.json',
          'log/0000000000000010.json',
          'log/0000000000000100.json',
        ]);
        expect(await listAll(storage, '')).toEqual([
          'blobs/sha256/ff',
          'log.json',
          'log/0000000000000001.json',
          'log/0000000000000002.json',
          'log/0000000000000010.json',
          'log/0000000000000100.json',
          'logs/other.json',
        ]);
        expect((await storage.list('nothing/')).keys).toEqual([]);
      });

      it('excludes startAfter and continues after it', { timeout }, async () => {
        const storage = await target.create('list-start-after');
        for (const name of ['a', 'b', 'c', 'd']) {
          await storage.putIfAbsent(`p/${name}`, body(name), 'text/plain');
        }
        expect(await listAll(storage, 'p/', undefined, 'p/b')).toEqual(['p/c', 'p/d']);
        expect(await listAll(storage, 'p/', undefined, 'p/bb')).toEqual(['p/c', 'p/d']);
        expect(await storage.list('p/', 'p/d')).toEqual({ keys: [], truncated: false });
        expect(await listAll(storage, 'p/', undefined, 'a')).toEqual(['p/a', 'p/b', 'p/c', 'p/d']);
      });

      it('honours limit and reports truncated', { timeout }, async () => {
        const storage = await target.create('list-limit');
        for (const name of ['a', 'b', 'c']) {
          await storage.putIfAbsent(`p/${name}`, body(name), 'text/plain');
        }
        const first = await storage.list('p/', undefined, 2);
        expect(first).toEqual({ keys: ['p/a', 'p/b'], truncated: true });
        const second = await storage.list('p/', 'p/b', 2);
        expect(second).toEqual({ keys: ['p/c'], truncated: false });
        const exact = await storage.list('p/', undefined, 3);
        expect(exact).toEqual({ keys: ['p/a', 'p/b', 'p/c'], truncated: false });
      });

      it('rejects a limit that is not a positive integer', { timeout }, async () => {
        const storage = await target.create('list-bad-limit');
        await expect(storage.list('p/', undefined, 0)).rejects.toThrow(RangeError);
        await expect(storage.list('p/', undefined, 1.5)).rejects.toThrow(RangeError);
      });

      it('pages through many keys without gaps or duplicates', { timeout }, async () => {
        const storage = await target.create('list-pages');
        const expected = Array.from(
          { length: 25 },
          (_, index) => `log/${String(index + 1).padStart(16, '0')}.json`,
        );
        await Promise.all(
          [...expected].reverse().map((key) => storage.putIfAbsent(key, body(key), 'text/plain')),
        );
        expect(await listAll(storage, 'log/', 7)).toEqual(expected);
        expect(await listAll(storage, 'log/')).toEqual(expected);
      });

      it('shows a write and a delete in the next list', { timeout }, async () => {
        const storage = await target.create('list-after-write');
        for (let index = 1; index <= 5; index += 1) {
          const key = `log/${String(index).padStart(16, '0')}.json`;
          await storage.putIfAbsent(key, body(key), 'application/json');
          const keys = await listAll(storage, 'log/');
          expect(keys.at(-1)).toBe(key);
          expect(keys).toHaveLength(index);
        }
        await storage.delete('log/0000000000000005.json');
        expect(await listAll(storage, 'log/')).toHaveLength(4);
      });
    });

    describe('keys and bodies', () => {
      it('round-trips unusual keys through put, get, and list', { timeout }, async () => {
        const storage = await target.create('unusual-keys');
        for (const key of UNUSUAL_KEYS) {
          await storage.putIfAbsent(key, body(key), 'text/plain');
        }
        for (const key of UNUSUAL_KEYS) {
          const read = await storage.get(key);
          expect(read, key).not.toBeNull();
          expect(fromUtf8(read?.body ?? new Uint8Array()), key).toBe(key);
        }
        const listed = await listAll(storage, 'unusual/', 4);
        // The order is computed independently of compareKeys.
        expect(listed).toEqual(sortByCodePoint(UNUSUAL_KEYS));
        // NFC and NFD forms are different keys.
        expect(listed).toContain('unusual/café-nfc.md');
        expect(listed).toContain('unusual/café-nfd.md');
        // A prefix with special characters filters exactly.
        expect((await storage.list('unusual/plus+')).keys).toEqual(['unusual/plus+sign.md']);
        expect((await storage.list('unusual/space ')).keys).toEqual(['unusual/space in name.md']);
      });

      it('rejects unsafe keys with InvalidKey', { timeout }, async () => {
        const storage = await target.create('invalid-keys');
        for (const key of ['', '/abs', 'a//b', 'dir/', 'a/../b', 'a/./b', 'ctl\u0001']) {
          let caught: unknown;
          try {
            await storage.putIfAbsent(key, body('x'), 'text/plain');
          } catch (error) {
            caught = error;
          }
          expect(isStorageError(caught, 'invalid-key'), JSON.stringify(key)).toBe(true);
        }
      });

      it('stores binary bodies exactly', { timeout }, async () => {
        const storage = await target.create('binary');
        const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
        const random = seededRandom(42);
        const large = Uint8Array.from({ length: 1024 * 1024 }, () => Math.floor(random() * 256));
        const cases: [string, Uint8Array][] = [
          ['blobs/empty', new Uint8Array()],
          ['blobs/all-bytes', allBytes],
          ['blobs/large', large],
          ['blobs/subarray', allBytes.subarray(10, 20)],
        ];
        for (const [key, bytes] of cases) {
          await storage.putIfAbsent(key, bytes, 'application/octet-stream');
          const read = await storage.get(key);
          expect(read?.body.length, key).toBe(bytes.length);
          expect(read !== null && equalBytes(read.body, bytes), key).toBe(true);
        }
      });

      it('does not keep a reference to the caller buffer', { timeout }, async () => {
        const storage = await target.create('copy');
        const bytes = body('original');
        await storage.putIfAbsent('k', bytes, 'text/plain');
        bytes.fill(0);
        const read = await storage.get('k');
        expect(fromUtf8(read?.body ?? new Uint8Array())).toBe('original');
      });
    });

    describe('races', () => {
      it(
        `conditional create: ${race.createWriters} writers x ${race.createRounds} rounds, one winner per round`,
        { timeout: raceTimeout },
        async () => {
          const storage = await target.create('race-create');
          const result = await runCreateRace(storage, {
            writers: race.createWriters,
            rounds: race.createRounds,
            prefix: '',
            ...(race.retry === undefined ? {} : { retry: race.retry }),
          });
          target.report?.('conditional-create race', result);
          expect(result.violations).toEqual([]);
          expect(result.roundsPassed).toBe(race.createRounds);
        },
      );

      it(
        `commit log: ${race.logWriters} writers x ${race.commitsPerWriter} commits, no gaps or duplicates`,
        { timeout: raceTimeout },
        async () => {
          const storage = await target.create('race-log');
          const result = await runCommitLogRace(storage, {
            writers: race.logWriters,
            commitsPerWriter: race.commitsPerWriter,
            prefix: '',
            listLimit: race.listLimit,
            ...(race.retry === undefined ? {} : { retry: race.retry }),
          });
          target.report?.('commit-log race', result);
          expect(result.violations).toEqual([]);
          expect(result.logEntries).toBe(race.logWriters * race.commitsPerWriter);
        },
      );
    });
  });
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function sortByCodePoint(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => {
    const left = codePoints(a);
    const right = codePoints(b);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return left.length - right.length;
  });
}

function codePoints(value: string): number[] {
  const points: number[] = [];
  for (const char of value) points.push(char.codePointAt(0) ?? 0);
  return points;
}
