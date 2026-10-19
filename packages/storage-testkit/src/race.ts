import { isPreconditionFailed, isStorageError } from '@obsy/protocol';
import type { Storage } from '@obsy/protocol';

import { fromUtf8, now, sleep, utf8 } from './runtime';
import { Counter, summariseLatencies } from './stats';
import type { LatencySummary } from './stats';

/** How a harness retries transient errors. */
export interface RetryPolicy {
  /** Attempts per call, including the first. */
  maxAttempts: number;
  /** First backoff delay. Each retry doubles it, with full jitter. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 8, baseDelayMs: 20, maxDelayMs: 1000 };

/** A short label for the outcome of one request, for result tables. */
export function outcomeLabel(error: unknown): string {
  if (!isStorageError(error)) return 'error:unknown';
  const detail = error.code ?? (error.status === undefined ? undefined : String(error.status));
  return detail === undefined ? error.kind : `${error.kind}:${detail}`;
}

function backoffMs(policy: RetryPolicy, attempt: number, error: unknown): number {
  const requested = isStorageError(error) ? error.retryAfterMs : undefined;
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.max(requested ?? 0, Math.random() * ceiling);
}

/** Retries a read-only call on transient errors. */
async function withReadRetry<T>(
  policy: RetryPolicy,
  outcomes: Counter,
  label: string,
  call: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      outcomes.add(`${label} ${outcomeLabel(error)}`);
      if (!isStorageError(error, 'transient') || attempt + 1 >= policy.maxAttempts) throw error;
      await sleep(backoffMs(policy, attempt, error));
    }
  }
}

// ---------------------------------------------------------------------------
// Conditional-create race

export interface CreateRaceOptions {
  /** Concurrent writers per round. */
  writers: number;
  rounds: number;
  /** Prefix for the race keys, for example `race-1/`. */
  prefix: string;
  retry?: RetryPolicy;
}

export interface CreateRaceResult {
  writers: number;
  rounds: number;
  /** Rounds with exactly one winner whose body is the stored body. */
  roundsPassed: number;
  /** Request outcomes, for example `success` or `transient:SlowDown`. */
  outcomes: Record<string, number>;
  /** Latency of every `putIfAbsent` request. */
  latency: LatencySummary;
  durationMs: number;
  /** Human-readable property violations. Empty when the race passed. */
  violations: string[];
}

/**
 * Runs `rounds` rounds. In each round, `writers` writers call `putIfAbsent`
 * on one fresh key at the same time. Exactly one writer must succeed, and the
 * stored body must be the winner's body.
 *
 * A writer retries transient errors. If a transient error says that the write
 * may have applied, a later `PreconditionFailed` is resolved by reading the
 * stored body.
 */
export async function runCreateRace(
  storage: Storage,
  options: CreateRaceOptions,
): Promise<CreateRaceResult> {
  const policy = options.retry ?? DEFAULT_RETRY;
  const outcomes = new Counter();
  const latencies: number[] = [];
  const violations: string[] = [];
  let roundsPassed = 0;
  const started = now();

  for (let round = 0; round < options.rounds; round += 1) {
    const key = `${options.prefix}create/${String(round).padStart(6, '0')}`;
    const bodyOf = (writer: number): string => `round ${round} writer ${writer}`;

    const claims = await Promise.all(
      Array.from({ length: options.writers }, async (_, writer) => {
        let ambiguous = false;
        for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
          const sent = now();
          try {
            await storage.putIfAbsent(key, utf8(bodyOf(writer)), 'text/plain');
            latencies.push(now() - sent);
            outcomes.add('success');
            return 'won' as const;
          } catch (error) {
            latencies.push(now() - sent);
            outcomes.add(outcomeLabel(error));
            if (isPreconditionFailed(error))
              return ambiguous ? ('unknown' as const) : ('lost' as const);
            if (!isStorageError(error, 'transient')) return 'error' as const;
            if (error.mayHaveApplied) ambiguous = true;
            await sleep(backoffMs(policy, attempt, error));
          }
        }
        return ambiguous ? ('unknown' as const) : ('error' as const);
      }),
    );

    const stored = await withReadRetry(policy, outcomes, 'get', () => storage.get(key));
    const storedBody = stored === null ? null : fromUtf8(stored.body);
    const winners = claims.flatMap((claim, writer) =>
      claim === 'won' || (claim === 'unknown' && storedBody === bodyOf(writer)) ? [writer] : [],
    );
    const errors = claims.filter((claim) => claim === 'error').length;

    if (winners.length !== 1) {
      violations.push(`round ${round}: ${winners.length} winners (${errors} writers errored)`);
    } else if (storedBody !== bodyOf(winners[0] ?? -1)) {
      violations.push(`round ${round}: stored body is not the winner's body`);
    } else {
      roundsPassed += 1;
    }
  }

  return {
    writers: options.writers,
    rounds: options.rounds,
    roundsPassed,
    outcomes: outcomes.counts,
    latency: summariseLatencies(latencies),
    durationMs: Math.round(now() - started),
    violations,
  };
}

// ---------------------------------------------------------------------------
// Commit-log race

export interface CommitLogRaceOptions {
  /** Concurrent writers. */
  writers: number;
  /** Commits that each writer must make. */
  commitsPerWriter: number;
  /** Prefix for the race keys. The log is `<prefix>log/<seq>.json`. */
  prefix: string;
  /** `limit` for catch-up lists. A small value exercises pagination. */
  listLimit?: number;
  /** Give up on one commit after this many claim attempts. */
  maxClaimsPerCommit?: number;
  retry?: RetryPolicy;
}

export interface CommitLogRaceResult {
  writers: number;
  commitsPerWriter: number;
  /** Entries in the log after the race. */
  logEntries: number;
  /** `putIfAbsent` calls on log keys. */
  claimAttempts: number;
  /** Claims that failed because another writer took the number first. */
  claimConflicts: number;
  /** Most claim attempts that one commit needed. */
  maxClaimsForOneCommit: number;
  /** Request outcomes, for example `success` or `transient:503`. */
  outcomes: Record<string, number>;
  claimLatency: LatencySummary;
  listLatency: LatencySummary;
  durationMs: number;
  /** Human-readable property violations. Empty when the race passed. */
  violations: string[];
}

interface CommitRecord {
  format: 1;
  seq: number;
  opId: string;
  writer: number;
  time: string;
}

const SEQ_DIGITS = 16;

/** `log/<seq>.json` with a zero-padded 16-digit sequence number. */
export function logKey(prefix: string, seq: number): string {
  return `${prefix}log/${String(seq).padStart(SEQ_DIGITS, '0')}.json`;
}

function parseSeq(prefix: string, key: string): number | null {
  const match = /^log\/(\d{16})\.json$/.exec(key.slice(prefix.length));
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Runs the commit algorithm from docs/subsystems/protocol.md with `writers`
 * concurrent writers. Each writer repeatedly catches up by listing `log/` and
 * reading every new entry, then claims the next sequence number with
 * `putIfAbsent`. On `PreconditionFailed` it catches up and tries again.
 *
 * Afterwards the log must have no gaps and no duplicates, and every writer's
 * every commit must appear exactly once (checked by `opId`).
 */
export async function runCommitLogRace(
  storage: Storage,
  options: CommitLogRaceOptions,
): Promise<CommitLogRaceResult> {
  const policy = options.retry ?? DEFAULT_RETRY;
  const maxClaims = options.maxClaimsPerCommit ?? 1000;
  const logPrefix = `${options.prefix}log/`;
  const outcomes = new Counter();
  const claimLatencies: number[] = [];
  const listLatencies: number[] = [];
  const violations: string[] = [];
  let claimAttempts = 0;
  let claimConflicts = 0;
  let maxClaimsForOneCommit = 0;
  const started = now();

  const readLog = async (
    cursor: number,
    onEntry: (seq: number, record: CommitRecord) => void,
  ): Promise<number> => {
    let startAfter = cursor === 0 ? undefined : logKey(options.prefix, cursor);
    let current = cursor;
    for (;;) {
      const sent = now();
      const page = await withReadRetry(policy, outcomes, 'list', () =>
        storage.list(logPrefix, startAfter, options.listLimit),
      );
      listLatencies.push(now() - sent);
      for (const key of page.keys) {
        const seq = parseSeq(options.prefix, key);
        if (seq !== current + 1) {
          throw new RaceViolation(`log after seq ${current} continues with ${key}`);
        }
        const object = await withReadRetry(policy, outcomes, 'get', () => storage.get(key));
        if (object === null) throw new RaceViolation(`listed key ${key} cannot be read`);
        const record = JSON.parse(fromUtf8(object.body)) as CommitRecord;
        if (record.seq !== seq) throw new RaceViolation(`${key} holds seq ${record.seq}`);
        onEntry(seq, record);
        current = seq;
        startAfter = key;
      }
      if (!page.truncated) return current;
      if (page.keys.length === 0) throw new RaceViolation('list is truncated but returned no keys');
    }
  };

  const writer = async (id: number): Promise<void> => {
    let cursor = 0;
    const ownInLog = new Set<string>();
    for (let commit = 0; commit < options.commitsPerWriter; commit += 1) {
      const opId = `w${id}:c${commit}`;
      let done = false;
      let mayHaveApplied = false;
      for (let claims = 0; !done;) {
        // Catch up. A commit whose write may have applied is found here by opId.
        cursor = await readLog(cursor, (_, record) => {
          if (record.writer === id) ownInLog.add(record.opId);
        });
        if (mayHaveApplied && ownInLog.has(opId)) break;
        if (claims >= maxClaims) throw new RaceViolation(`${opId} gave up after ${claims} claims`);

        claims += 1;
        claimAttempts += 1;
        maxClaimsForOneCommit = Math.max(maxClaimsForOneCommit, claims);
        const seq = cursor + 1;
        const record: CommitRecord = {
          format: 1,
          seq,
          opId,
          writer: id,
          time: new Date().toISOString(),
        };
        const sent = now();
        try {
          await storage.putIfAbsent(
            logKey(options.prefix, seq),
            utf8(JSON.stringify(record)),
            'application/json',
          );
          claimLatencies.push(now() - sent);
          outcomes.add('success');
          cursor = seq;
          done = true;
        } catch (error) {
          claimLatencies.push(now() - sent);
          outcomes.add(outcomeLabel(error));
          if (isPreconditionFailed(error)) {
            claimConflicts += 1;
          } else if (isStorageError(error, 'transient')) {
            if (error.mayHaveApplied) mayHaveApplied = true;
            await sleep(backoffMs(policy, Math.min(claims, 6), error));
          } else {
            throw error;
          }
        }
      }
    }
  };

  const results = await Promise.allSettled(
    Array.from({ length: options.writers }, (_, id) => writer(id)),
  );
  for (const [id, result] of results.entries()) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      violations.push(
        `writer ${id} stopped: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  // Verify the whole log from the start.
  const seen = new Map<string, number>();
  let logEntries = 0;
  try {
    logEntries = await readLog(0, (seq, record) => {
      const previous = seen.get(record.opId);
      if (previous !== undefined) {
        violations.push(`opId ${record.opId} appears at seq ${previous} and ${seq}`);
      }
      seen.set(record.opId, seq);
    });
  } catch (error) {
    violations.push(`final read: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (let id = 0; id < options.writers; id += 1) {
    for (let commit = 0; commit < options.commitsPerWriter; commit += 1) {
      if (!seen.has(`w${id}:c${commit}`)) violations.push(`commit w${id}:c${commit} is missing`);
    }
  }
  const expected = options.writers * options.commitsPerWriter;
  if (logEntries !== expected)
    violations.push(`log has ${logEntries} entries, expected ${expected}`);

  return {
    writers: options.writers,
    commitsPerWriter: options.commitsPerWriter,
    logEntries,
    claimAttempts,
    claimConflicts,
    maxClaimsForOneCommit,
    outcomes: outcomes.counts,
    claimLatency: summariseLatencies(claimLatencies),
    listLatency: summariseLatencies(listLatencies),
    durationMs: Math.round(now() - started),
    violations,
  };
}

class RaceViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaceViolation';
  }
}
