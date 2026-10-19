// The storage conformance checks, without a test framework.
//
// `describeStorageConformance` registers these checks with Vitest. The
// platform probe runs the same checks inside Obsidian with
// `runConformanceChecks`. This file must not import Vitest.
import { isPreconditionFailed, isStorageError } from '@obsy/protocol';
import type { Storage } from '@obsy/protocol';

import { runCommitLogRace, runCreateRace } from './race';
import type { CommitLogRaceResult, CreateRaceResult, RetryPolicy } from './race';
import { cancellableSleep, fromUtf8, now, seededRandom, utf8 } from './runtime';

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
  'unusual/café-nfd.md',
  'unusual/日本語.md',
  'unusual/emoji-\u{1F600}.md',
  'unusual/fullwidth-～.md',
  // These two differ only at U+FF5E against U+1F600. Code point (and UTF-8
  // byte) order puts U+FF5E first; UTF-16 code unit order puts U+1F600 first.
  'unusual/order-～.md',
  'unusual/order-\u{1F600}.md',
  'unusual/trailing-dot.',
];

/** A failed conformance assertion. */
export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

/** What a check receives besides its storage. */
export interface CheckContext {
  race: RaceParameters;
  /** Receives race results, for example to print a summary. */
  report?(label: string, result: CreateRaceResult | CommitLogRaceResult): void;
}

/** One conformance check. Each check needs its own, empty storage. */
export interface ConformanceCheck {
  /** Group title, for example `putIfMatch`. */
  group: string;
  /** Check title. Vitest uses it as the test name. */
  name: string;
  /** Label passed to the storage factory. */
  label: string;
  /** True for the race checks, which take much longer. */
  race: boolean;
  run(storage: Storage, context: CheckContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Assertions

function fail(message: string): never {
  throw new ConformanceFailure(message);
}

function assert(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    fail(`${message}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

async function assertPreconditionFailed(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(
    isPreconditionFailed(caught),
    `${message}: expected PreconditionFailed, got ${describe(caught)}`,
  );
}

async function assertRejectsWith(
  promise: Promise<unknown>,
  type: new (...args: never[]) => Error,
  message: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof type, `${message}: expected ${type.name}, got ${describe(caught)}`);
}

function describe(value: unknown): string {
  if (value === undefined) return 'no error';
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return show(value);
}

function text(object: { body: Uint8Array } | null): string {
  return fromUtf8(object?.body ?? new Uint8Array());
}

function body(value: string): Uint8Array {
  return utf8(value);
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
  throw new ConformanceFailure('list did not finish');
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

// ---------------------------------------------------------------------------
// The checks

/** The conformance checks, in suite order. Race titles use `race`. */
export function conformanceChecks(race: RaceParameters): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const add = (
    group: string,
    label: string,
    name: string,
    run: ConformanceCheck['run'],
    isRace = false,
  ): void => {
    checks.push({ group, name, label, race: isRace, run });
  };

  // get and putIfAbsent
  add('get and putIfAbsent', 'get-missing', 'returns null for a missing key', async (storage) => {
    assertEqual(await storage.get('missing/key.json'), null, 'get of a missing key');
  });

  add(
    'get and putIfAbsent',
    'create-read',
    'creates a key and reads it back with the same etag',
    async (storage) => {
      const created = await storage.putIfAbsent('a.json', body('{"a":1}'), 'application/json');
      assert(typeof created.etag === 'string', 'etag is a string');
      assert(created.etag.length > 0, 'etag is not empty');
      assert(!created.etag.startsWith('"'), `etag is unquoted, got ${show(created.etag)}`);
      const read = await storage.get('a.json');
      assert(read !== null, 'the created key can be read');
      assertEqual(text(read), '{"a":1}', 'body');
      assertEqual(read?.etag, created.etag, 'etag from get');
    },
  );

  add(
    'get and putIfAbsent',
    'create-exists',
    'fails with PreconditionFailed when the key exists',
    async (storage) => {
      await storage.putIfAbsent('k', body('first'), 'text/plain');
      await assertPreconditionFailed(
        storage.putIfAbsent('k', body('second'), 'text/plain'),
        'second putIfAbsent',
      );
      assertEqual(text(await storage.get('k')), 'first', 'stored body');
    },
  );

  // putIfMatch
  add('putIfMatch', 'match-ok', 'replaces the key when the etag matches', async (storage) => {
    const created = await storage.putIfAbsent('vault.json', body('v1'), 'application/json');
    const updated = await storage.putIfMatch(
      'vault.json',
      body('v2'),
      created.etag,
      'application/json',
    );
    assert(updated.etag !== created.etag, 'the new etag differs from the old etag');
    const read = await storage.get('vault.json');
    assertEqual(text(read), 'v2', 'body');
    assertEqual(read?.etag, updated.etag, 'etag from get');
  });

  add(
    'putIfMatch',
    'match-stale',
    'fails with PreconditionFailed for a stale etag',
    async (storage) => {
      const first = await storage.putIfAbsent('vault.json', body('v1'), 'application/json');
      await storage.putIfMatch('vault.json', body('v2'), first.etag, 'application/json');
      await assertPreconditionFailed(
        storage.putIfMatch('vault.json', body('v3'), first.etag, 'application/json'),
        'putIfMatch with a stale etag',
      );
      assertEqual(text(await storage.get('vault.json')), 'v2', 'stored body');
    },
  );

  add(
    'putIfMatch',
    'match-wrong',
    'fails with PreconditionFailed for a made-up etag',
    async (storage) => {
      await storage.putIfAbsent('vault.json', body('v1'), 'application/json');
      await assertPreconditionFailed(
        storage.putIfMatch(
          'vault.json',
          body('v2'),
          '0123456789abcdef0123456789abcdef',
          'application/json',
        ),
        'putIfMatch with a made-up etag',
      );
    },
  );

  add(
    'putIfMatch',
    'match-missing',
    'fails with PreconditionFailed when the key does not exist',
    async (storage) => {
      const other = await storage.putIfAbsent('other.json', body('x'), 'application/json');
      await assertPreconditionFailed(
        storage.putIfMatch('missing.json', body('x'), other.etag, 'application/json'),
        'putIfMatch on a missing key',
      );
      assertEqual(await storage.get('missing.json'), null, 'get of the missing key');
    },
  );

  add(
    'putIfMatch',
    'match-race',
    'lets exactly one of concurrent matching writers win',
    async (storage, context) => {
      for (let round = 0; round < 5; round += 1) {
        const key = `devices/d${round}.json`;
        const created = await storage.putIfAbsent(key, body('base'), 'application/json');
        const writers = context.race.createWriters;
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
        const others = results.flatMap((result) =>
          result.status === 'rejected' &&
          !isPreconditionFailed(result.reason) &&
          !isStorageError(result.reason, 'transient')
            ? [describe(result.reason)]
            : [],
        );
        assertEqual(others, [], `round ${round}: unexpected errors`);
        if (transient === 0) assertEqual(winners.length, 1, `round ${round}: winners`);
        else assert(winners.length <= 1, `round ${round}: ${winners.length} winners`);
        const stored = text(await storage.get(key));
        if (winners.length === 1) {
          assertEqual(stored, `writer ${winners[0]}`, `round ${round}: stored body`);
        }
      }
    },
  );

  // delete
  add('delete', 'delete', 'deletes a key, and deleting a missing key succeeds', async (storage) => {
    await storage.putIfAbsent('presence/d.json', body('x'), 'application/json');
    await storage.delete('presence/d.json');
    assertEqual(await storage.get('presence/d.json'), null, 'get after delete');
    assertEqual((await storage.list('presence/')).keys, [], 'list after delete');
    await storage.delete('presence/d.json');
    await storage.delete('never/existed.json');
  });

  add('delete', 'delete-recreate', 'allows putIfAbsent again after delete', async (storage) => {
    await storage.putIfAbsent('k', body('one'), 'text/plain');
    await storage.delete('k');
    await storage.putIfAbsent('k', body('two'), 'text/plain');
    assertEqual(text(await storage.get('k')), 'two', 'stored body');
  });

  // list
  add('list', 'list-order', 'lists in code point order, with prefix filtering', async (storage) => {
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
    assertEqual(
      await listAll(storage, 'log/'),
      [
        'log/0000000000000001.json',
        'log/0000000000000002.json',
        'log/0000000000000010.json',
        'log/0000000000000100.json',
      ],
      'list of log/',
    );
    assertEqual(
      await listAll(storage, ''),
      [
        'blobs/sha256/ff',
        'log.json',
        'log/0000000000000001.json',
        'log/0000000000000002.json',
        'log/0000000000000010.json',
        'log/0000000000000100.json',
        'logs/other.json',
      ],
      'list of the root',
    );
    assertEqual((await storage.list('nothing/')).keys, [], 'list of an empty prefix');
  });

  add('list', 'list-start-after', 'excludes startAfter and continues after it', async (storage) => {
    for (const name of ['a', 'b', 'c', 'd']) {
      await storage.putIfAbsent(`p/${name}`, body(name), 'text/plain');
    }
    assertEqual(await listAll(storage, 'p/', undefined, 'p/b'), ['p/c', 'p/d'], 'after p/b');
    assertEqual(await listAll(storage, 'p/', undefined, 'p/bb'), ['p/c', 'p/d'], 'after p/bb');
    assertEqual(await storage.list('p/', 'p/d'), { keys: [], truncated: false }, 'after p/d');
    assertEqual(
      await listAll(storage, 'p/', undefined, 'a'),
      ['p/a', 'p/b', 'p/c', 'p/d'],
      'after a',
    );
  });

  add('list', 'list-limit', 'honours limit and reports truncated', async (storage) => {
    for (const name of ['a', 'b', 'c']) {
      await storage.putIfAbsent(`p/${name}`, body(name), 'text/plain');
    }
    assertEqual(
      await storage.list('p/', undefined, 2),
      { keys: ['p/a', 'p/b'], truncated: true },
      'first page',
    );
    assertEqual(
      await storage.list('p/', 'p/b', 2),
      { keys: ['p/c'], truncated: false },
      'second page',
    );
    assertEqual(
      await storage.list('p/', undefined, 3),
      { keys: ['p/a', 'p/b', 'p/c'], truncated: false },
      'exact page',
    );
  });

  add(
    'list',
    'list-bad-limit',
    'rejects a limit that is not a positive integer',
    async (storage) => {
      await assertRejectsWith(storage.list('p/', undefined, 0), RangeError, 'limit 0');
      await assertRejectsWith(storage.list('p/', undefined, 1.5), RangeError, 'limit 1.5');
    },
  );

  add(
    'list',
    'list-pages',
    'pages through many keys without gaps or duplicates',
    async (storage) => {
      const expected = Array.from(
        { length: 25 },
        (_, index) => `log/${String(index + 1).padStart(16, '0')}.json`,
      );
      await Promise.all(
        [...expected].reverse().map((key) => storage.putIfAbsent(key, body(key), 'text/plain')),
      );
      assertEqual(await listAll(storage, 'log/', 7), expected, 'pages of 7');
      assertEqual(await listAll(storage, 'log/'), expected, 'one page');
    },
  );

  add(
    'list',
    'list-after-write',
    'shows a write and a delete in the next list',
    async (storage) => {
      for (let index = 1; index <= 5; index += 1) {
        const key = `log/${String(index).padStart(16, '0')}.json`;
        await storage.putIfAbsent(key, body(key), 'application/json');
        const keys = await listAll(storage, 'log/');
        assertEqual(keys.at(-1), key, `last key after write ${index}`);
        assertEqual(keys.length, index, `key count after write ${index}`);
      }
      await storage.delete('log/0000000000000005.json');
      assertEqual((await listAll(storage, 'log/')).length, 4, 'key count after delete');
    },
  );

  // keys and bodies
  add(
    'keys and bodies',
    'unusual-keys',
    'round-trips unusual keys through put, get, and list',
    async (storage) => {
      for (const key of UNUSUAL_KEYS) {
        await storage.putIfAbsent(key, body(key), 'text/plain');
      }
      for (const key of UNUSUAL_KEYS) {
        const read = await storage.get(key);
        assert(read !== null, `${key} can be read`);
        assertEqual(text(read), key, `body of ${key}`);
      }
      const listed = await listAll(storage, 'unusual/', 4);
      // The order is computed independently of compareKeys.
      assertEqual(listed, sortByCodePoint(UNUSUAL_KEYS), 'listed keys in code point order');
      // NFC and NFD forms are different keys.
      assert(listed.includes('unusual/café-nfc.md'), 'the NFC key is listed');
      assert(listed.includes('unusual/café-nfd.md'), 'the NFD key is listed');
      // A prefix with special characters filters exactly.
      assertEqual(
        (await storage.list('unusual/plus+')).keys,
        ['unusual/plus+sign.md'],
        'list of unusual/plus+',
      );
      assertEqual(
        (await storage.list('unusual/space ')).keys,
        ['unusual/space in name.md'],
        'list of "unusual/space "',
      );
    },
  );

  add('keys and bodies', 'invalid-keys', 'rejects unsafe keys with InvalidKey', async (storage) => {
    for (const key of ['', '/abs', 'a//b', 'dir/', 'a/../b', 'a/./b', 'ctl\u0001']) {
      let caught: unknown;
      try {
        await storage.putIfAbsent(key, body('x'), 'text/plain');
      } catch (error) {
        caught = error;
      }
      assert(isStorageError(caught, 'invalid-key'), `${show(key)}: expected InvalidKey`);
    }
  });

  add('keys and bodies', 'binary', 'stores binary bodies exactly', async (storage) => {
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
      assertEqual(read?.body.length, bytes.length, `${key} length`);
      assert(read !== null && equalBytes(read.body, bytes), `${key} bytes are equal`);
    }
  });

  add(
    'keys and bodies',
    'copy',
    'does not keep a reference to the caller buffer',
    async (storage) => {
      const bytes = body('original');
      await storage.putIfAbsent('k', bytes, 'text/plain');
      bytes.fill(0);
      assertEqual(text(await storage.get('k')), 'original', 'stored body');
    },
  );

  // races
  add(
    'races',
    'race-create',
    `conditional create: ${race.createWriters} writers x ${race.createRounds} rounds, one winner per round`,
    async (storage, context) => {
      const result = await runCreateRace(storage, {
        writers: context.race.createWriters,
        rounds: context.race.createRounds,
        prefix: '',
        ...(context.race.retry === undefined ? {} : { retry: context.race.retry }),
      });
      context.report?.('conditional-create race', result);
      assertEqual(result.violations, [], 'violations');
      assertEqual(result.roundsPassed, context.race.createRounds, 'rounds with one winner');
    },
    true,
  );

  add(
    'races',
    'race-log',
    `commit log: ${race.logWriters} writers x ${race.commitsPerWriter} commits, no gaps or duplicates`,
    async (storage, context) => {
      const result = await runCommitLogRace(storage, {
        writers: context.race.logWriters,
        commitsPerWriter: context.race.commitsPerWriter,
        prefix: '',
        listLimit: context.race.listLimit,
        ...(context.race.retry === undefined ? {} : { retry: context.race.retry }),
      });
      context.report?.('commit-log race', result);
      assertEqual(result.violations, [], 'violations');
      assertEqual(
        result.logEntries,
        context.race.logWriters * context.race.commitsPerWriter,
        'log entries',
      );
    },
    true,
  );

  return checks;
}

// ---------------------------------------------------------------------------
// A runner without a test framework

export interface CheckResult {
  group: string;
  name: string;
  label: string;
  race: boolean;
  passed: boolean;
  durationMs: number;
  /** `<error name>: <message>` when the check failed. */
  error?: string;
}

export interface RunChecksOptions {
  checks: readonly ConformanceCheck[];
  /** Returns a fresh, empty storage for one check. */
  create(label: string): Storage | Promise<Storage>;
  race: RaceParameters;
  report?: CheckContext['report'];
  /** Time limit for one check. Default 30 s; race checks get ten times this. */
  timeoutMs?: number;
  /** Called after each check, for progress output. */
  onResult?(result: CheckResult): void;
}

/**
 * Runs checks one after another and returns one result per check. A check
 * that exceeds its time limit fails; its requests may still be running.
 */
export async function runConformanceChecks(options: RunChecksOptions): Promise<CheckResult[]> {
  const timeout = options.timeoutMs ?? 30_000;
  const results: CheckResult[] = [];
  const context: CheckContext = {
    race: options.race,
    ...(options.report === undefined ? {} : { report: options.report }),
  };
  for (const check of options.checks) {
    const limit = check.race ? timeout * 10 : timeout;
    const started = now();
    let error: string | undefined;
    try {
      const storage = await options.create(check.label);
      const running = check.run(storage, context).then(() => false);
      // A check that times out keeps running; do not report its late failure.
      running.catch(() => {});
      const timer = cancellableSleep(limit);
      try {
        const timedOut = await Promise.race([running, timer.done.then(() => true)]);
        if (timedOut) error = `Timeout: the check did not finish within ${limit} ms`;
      } finally {
        timer.cancel();
      }
    } catch (caught) {
      error = describe(caught);
    }
    const result: CheckResult = {
      group: check.group,
      name: check.name,
      label: check.label,
      race: check.race,
      passed: error === undefined,
      durationMs: Math.round(now() - started),
      ...(error === undefined ? {} : { error }),
    };
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}
