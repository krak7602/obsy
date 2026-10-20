export interface SchedulerTimers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/**
 * Runs one sync at a time. A request during a run starts one more run after
 * it. `request` keeps the earliest due time; `touch` restarts the delay, so
 * that a burst of edits gives one sync after the last edit. While paused,
 * nothing new starts; requests made meanwhile run on `resume`.
 */
export class SyncScheduler {
  readonly #run: () => Promise<void>;
  readonly #timers: SchedulerTimers;
  readonly #now: () => number;
  #timer: number | null = null;
  #due: number | null = null;
  #running = false;
  #again = false;
  #paused = false;
  #wanted = false;

  constructor(run: () => Promise<void>, timers: SchedulerTimers, now: () => number = Date.now) {
    this.#run = run;
    this.#timers = timers;
    this.#now = now;
  }

  get running(): boolean {
    return this.#running;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Runs after `delayMs`, or earlier if a run is already due earlier. */
  request(delayMs = 0): void {
    const due = this.#now() + delayMs;
    if (this.#due !== null && this.#due <= due) return;
    this.#arm(due);
  }

  /** Runs `delayMs` after the last call. */
  touch(delayMs: number): void {
    this.#arm(this.#now() + delayMs);
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    if (this.#wanted) {
      this.#wanted = false;
      this.request(0);
    }
  }

  stop(): void {
    this.#paused = true;
    this.#wanted = false;
    this.#clear();
  }

  #clear(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#due = null;
  }

  #arm(due: number): void {
    this.#clear();
    this.#due = due;
    this.#timer = this.#timers.setTimeout(
      () => {
        this.#timer = null;
        this.#due = null;
        this.#fire();
      },
      Math.max(0, due - this.#now()),
    );
  }

  #fire(): void {
    if (this.#paused) {
      this.#wanted = true;
      return;
    }
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    void this.#run()
      .catch(() => undefined)
      .finally(() => {
        this.#running = false;
        if (this.#again) {
          this.#again = false;
          this.request(0);
        }
      });
  }
}
