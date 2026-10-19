// Small runtime helpers. The testkit is ES-only, so it reaches timers and
// clocks through `globalThis` instead of DOM or Node types.

interface TimerGlobals {
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  performance?: { now(): number };
}

const runtime = globalThis as unknown as TimerGlobals;

/** Waits `ms` milliseconds. Needs `setTimeout`, which Node, Workers, and Obsidian have. */
export function sleep(ms: number): Promise<void> {
  const setTimer = runtime.setTimeout;
  if (setTimer === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    setTimer(resolve, ms);
  });
}

/**
 * A timer that resolves after `ms` milliseconds unless it is cancelled. A
 * cancelled timer never resolves and holds no pending callback.
 */
export function cancellableSleep(ms: number): { done: Promise<void>; cancel(): void } {
  const setTimer = runtime.setTimeout;
  const clearTimer = runtime.clearTimeout;
  if (setTimer === undefined) return { done: Promise.resolve(), cancel: () => {} };
  let handle: unknown;
  const done = new Promise<void>((resolve) => {
    handle = setTimer(resolve, ms);
  });
  return { done, cancel: () => clearTimer?.(handle) };
}

/** A monotonic clock in milliseconds when available, else wall time. */
export function now(): number {
  return runtime.performance?.now() ?? Date.now();
}

/** A small seeded PRNG (mulberry32). Returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A `MemoryStorage` scheduler that yields a random number of microtasks
 * (0 to `maxYields`) before each operation. The same seed gives the same
 * interleaving for the same sequence of calls.
 */
export function randomYieldScheduler(seed: number, maxYields = 4): () => Promise<void> {
  const random = seededRandom(seed);
  return async () => {
    const yields = Math.floor(random() * (maxYields + 1));
    for (let index = 0; index < yields; index += 1) await Promise.resolve();
  };
}

interface TextCodecGlobals {
  TextEncoder: new () => { encode(value: string): Uint8Array };
  TextDecoder: new (
    label: string,
    options: { fatal: boolean },
  ) => { decode(bytes: Uint8Array): string };
}

const codecs = globalThis as unknown as TextCodecGlobals;
const encoder = new codecs.TextEncoder();
const decoder = new codecs.TextDecoder('utf-8', { fatal: true });

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
