import { describe, expect, it } from 'vite-plus/test';

import { SyncScheduler } from './scheduler';

/** Timers on a manual clock. */
class Clock {
  t = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.#next++;
    this.#timers.set(handle, { at: this.t + ms, callback });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.#timers.delete(handle);
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    for (;;) {
      const due = [...this.#timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.t = due[1].at;
      due[1].callback();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    this.t = end;
  }
}

function setup(): { clock: Clock; scheduler: SyncScheduler; runs: number[]; finish: () => void } {
  const clock = new Clock();
  const runs: number[] = [];
  let release: (() => void) | null = null;
  const scheduler = new SyncScheduler(
    () => {
      runs.push(clock.t);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    clock,
    () => clock.t,
  );
  const finish = (): void => {
    release?.();
    release = null;
  };
  return { clock, scheduler, runs, finish };
}

describe('SyncScheduler', () => {
  it('debounces edits and keeps the earliest request', async () => {
    const { clock, scheduler, runs, finish } = setup();
    scheduler.touch(2000);
    await clock.advance(1500);
    scheduler.touch(2000);
    await clock.advance(1900);
    expect(runs).toEqual([]);
    await clock.advance(100);
    expect(runs).toEqual([3500]);
    finish();
    await clock.advance(0);
    scheduler.request(5000);
    scheduler.request(1000);
    scheduler.request(3000);
    await clock.advance(5000);
    expect(runs).toEqual([3500, 4500]);
  });

  it('runs one sync at a time and once more after a request during a run', async () => {
    const { clock, scheduler, runs, finish } = setup();
    scheduler.request(0);
    await clock.advance(0);
    scheduler.request(0);
    scheduler.request(0);
    await clock.advance(100);
    expect(runs).toEqual([0]);
    finish();
    await clock.advance(0);
    expect(runs).toEqual([0, 100]);
    finish();
    await clock.advance(1000);
    expect(runs).toEqual([0, 100]);
  });

  it('starts nothing while paused, and runs on resume when asked meanwhile', async () => {
    const { clock, scheduler, runs } = setup();
    scheduler.pause();
    scheduler.request(0);
    await clock.advance(1000);
    expect(runs).toEqual([]);
    scheduler.resume();
    await clock.advance(0);
    expect(runs).toEqual([1000]);
  });
});
