// Lifecycle: a timestamped log of visibility and page events, and a
// background test that keeps requests in flight while the owner switches
// apps, to see which requests complete, fail, or stall.
import type { Storage } from '@obsy/protocol';
import { deleteAllUnder, outcomeLabel } from '@obsy/storage-testkit/portable';

import type { Log, SectionOutput } from '../section';
import { MIB, describeError, now, randomBytes, round1 } from '../util';

export interface LifecycleEvent {
  /** Milliseconds since the plugin loaded (monotonic clock). */
  atMs: number;
  /** Wall-clock time. */
  at: string;
  type: string;
  visibility: string;
}

const MAX_EVENTS = 300;

export class LifecycleLog {
  readonly loadedAt = now();
  readonly events: LifecycleEvent[] = [];
  #listeners = new Set<(event: LifecycleEvent) => void>();

  record(type: string, visibility: string): void {
    const event = {
      atMs: Math.round(now() - this.loadedAt),
      at: new Date().toISOString(),
      type,
      visibility,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const listener of this.#listeners) listener(event);
  }

  /** Milliseconds since load, on the same clock as `atMs`. */
  elapsed(): number {
    return now() - this.loadedAt;
  }

  subscribe(listener: (event: LifecycleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Hidden periods from `visibilitychange` events, with `durationMs: null` while still hidden. */
  hiddenPeriods(fromMs = 0): { startMs: number; durationMs: number | null }[] {
    const periods: { startMs: number; durationMs: number | null }[] = [];
    let hiddenAt: number | undefined;
    for (const event of this.events) {
      if (event.type !== 'visibilitychange') continue;
      if (event.visibility === 'hidden' && hiddenAt === undefined) hiddenAt = event.atMs;
      if (event.visibility === 'visible' && hiddenAt !== undefined) {
        if (event.atMs >= fromMs)
          periods.push({ startMs: hiddenAt, durationMs: event.atMs - hiddenAt });
        hiddenAt = undefined;
      }
    }
    if (hiddenAt !== undefined) periods.push({ startMs: hiddenAt, durationMs: null });
    return periods;
  }
}

export interface BackgroundTestInput {
  /** Storage rooted at a fresh run prefix. The test writes under `bg/` and deletes it. */
  storage: Storage;
  lifecycle: LifecycleLog;
  durationMs: number;
  /** Size of the object that the test downloads again and again. Default 4 MiB. */
  bigBytes?: number;
  /** Visibility now, for example `document.visibilityState`. */
  visibility(): string;
  log: Log;
}

interface RequestRecord {
  op: string;
  startMs: number;
  endMs: number;
  outcome: string;
  startedHidden: boolean;
}

export async function runBackgroundTest(input: BackgroundTestInput): Promise<SectionOutput> {
  const { storage, lifecycle } = input;
  const bigBytes = input.bigBytes ?? 4 * MIB;
  const startMs = lifecycle.elapsed();
  const wallStart = Date.now();
  const errors: string[] = [];

  input.log('Background test: uploading the test object');
  await storage.putIfAbsent('bg/big.bin', randomBytes(bigBytes), 'application/octet-stream');

  const beats: number[] = [];
  const heartbeat = window.setInterval(() => {
    beats.push(lifecycle.elapsed());
  }, 250);
  const requests: RequestRecord[] = [];
  const ops: [string, () => Promise<unknown>][] = [
    ['get 4 MiB', () => storage.get('bg/big.bin')],
    ['list', () => storage.list('bg/')],
    [
      'putIfAbsent small',
      () =>
        storage.putIfAbsent(`bg/s-${requests.length}.json`, new Uint8Array(64), 'application/json'),
    ],
  ];

  input.log('Background test: running. Switch to another app now, wait, then come back.');
  try {
    for (let index = 0; Date.now() - wallStart < input.durationMs; index += 1) {
      const [op, call] = ops[index % ops.length] ?? ['none', () => Promise.resolve()];
      const started = lifecycle.elapsed();
      const startedHidden = input.visibility() === 'hidden';
      let outcome = 'success';
      try {
        await call();
      } catch (error) {
        outcome = outcomeLabel(error);
      }
      requests.push({
        op,
        startMs: Math.round(started),
        endMs: Math.round(lifecycle.elapsed()),
        outcome,
        startedHidden,
      });
    }
  } finally {
    window.clearInterval(heartbeat);
  }

  try {
    await deleteAllUnder(storage, 'bg/');
  } catch (error) {
    errors.push(`cleanup: ${describeError(error)}`);
  }

  const endMs = lifecycle.elapsed();
  const hidden = lifecycle.hiddenPeriods(startMs).filter((period) => period.startMs >= startMs);
  const overlapsHidden = (record: RequestRecord): boolean =>
    record.startedHidden ||
    hidden.some(
      (period) =>
        period.startMs < record.endMs &&
        (period.durationMs === null ? Infinity : period.startMs + period.durationMs) >
          record.startMs,
    );
  const spanning = requests.filter(overlapsHidden);
  const byOutcome = (records: RequestRecord[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const record of records) counts[record.outcome] = (counts[record.outcome] ?? 0) + 1;
    return counts;
  };
  const gaps: { atMs: number; gapMs: number }[] = [];
  for (let index = 1; index < beats.length; index += 1) {
    const gap = (beats[index] ?? 0) - (beats[index - 1] ?? 0);
    if (gap > 1000) gaps.push({ atMs: Math.round(beats[index - 1] ?? 0), gapMs: Math.round(gap) });
  }
  const wallElapsed = Date.now() - wallStart;
  return {
    status: 'passed',
    data: {
      durationMs: input.durationMs,
      ownerActionObserved: hidden.length > 0,
      hiddenPeriods: hidden,
      requests: requests.length,
      outcomes: byOutcome(requests),
      requestsOverlappingHidden: spanning.length,
      outcomesOverlappingHidden: byOutcome(spanning),
      requestsStartedWhileHidden: requests.filter((record) => record.startedHidden).length,
      longestRequestMs: Math.max(0, ...requests.map((record) => record.endMs - record.startMs)),
      overlappingDetail: spanning.slice(0, 30),
      heartbeat: {
        intervalMs: 250,
        beats: beats.length,
        maxGapMs: Math.round(Math.max(0, ...gaps.map((gap) => gap.gapMs))),
        gapsOver1s: gaps.slice(0, 20),
      },
      clocks: {
        wallElapsedMs: wallElapsed,
        monotonicElapsedMs: round1(endMs - startMs),
      },
    },
    errors,
  };
}
