import { setImmediate } from 'node:timers';

/** A small seeded random number generator (mulberry32). */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[this.int(items.length)];
  }
}

interface Step {
  readonly owner: string;
  readonly label: string;
  readonly resolve: () => void;
  /** Called instead of `resolve` when the owner crashes while waiting. */
  readonly onCrash?: () => void;
}

interface Task {
  readonly owner: string;
  done: boolean;
  error: unknown;
}

/**
 * Runs tasks (device syncs, agent writes) one step at a time. A task blocks
 * at every `wait`; the simulation chooses which waiting step runs next, so
 * every interleaving comes from the seed. Crypto and other off-thread work
 * finishes between steps: `settle` waits until every live task is blocked
 * or done.
 */
export class Scheduler {
  readonly #steps: Step[] = [];
  readonly #tasks = new Map<string, Task>();
  readonly trace: string[] = [];

  constructor(readonly random: Random) {}

  /** Blocks the calling task until the simulation runs this step. */
  wait(owner: string, label: string, onCrash?: () => void): Promise<void> {
    const task = this.#tasks.get(owner);
    if (task === undefined || task.done) {
      // Called outside a task (setup or a user action): run at once.
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#steps.push(
        onCrash === undefined ? { owner, label, resolve } : { owner, label, resolve, onCrash },
      );
    });
  }

  running(owner: string): boolean {
    const task = this.#tasks.get(owner);
    return task !== undefined && !task.done;
  }

  get pendingSteps(): number {
    return this.#steps.length;
  }

  /** Starts a task. At most one task per owner. */
  spawn(owner: string, action: () => Promise<unknown>): void {
    if (this.running(owner)) throw new Error(`${owner} already has a task`);
    const task: Task = { owner, done: false, error: undefined };
    this.#tasks.set(owner, task);
    this.trace.push(`spawn ${owner}`);
    action().then(
      () => {
        if (this.#tasks.get(owner) === task) task.done = true;
      },
      (error: unknown) => {
        if (this.#tasks.get(owner) === task) {
          task.done = true;
          task.error = error;
        }
      },
    );
  }

  /** The error of the owner's last task, cleared on read. */
  takeError(owner: string): unknown {
    const task = this.#tasks.get(owner);
    if (task === undefined || !task.done) return undefined;
    const error = task.error;
    task.error = undefined;
    return error;
  }

  /** Runs one waiting step, chosen at random. Returns false when none waits. */
  async step(): Promise<boolean> {
    if (this.#steps.length === 0) return false;
    const index = this.random.int(this.#steps.length);
    const [step] = this.#steps.splice(index, 1) as [Step];
    this.trace.push(`${step.owner} ${step.label}`);
    step.resolve();
    await this.settle();
    return true;
  }

  /**
   * Stops the owner's task where it waits. Its steps never run. A step with
   * `onCrash` (an in-flight request) may still reach the bucket.
   */
  crash(owner: string): void {
    const task = this.#tasks.get(owner);
    if (task === undefined || task.done) return;
    this.trace.push(`crash ${owner}`);
    for (let i = this.#steps.length - 1; i >= 0; i--) {
      const step = this.#steps[i] as Step;
      if (step.owner !== owner) continue;
      this.#steps.splice(i, 1);
      step.onCrash?.();
    }
    // Detach the task; a later spawn replaces it.
    task.done = true;
    this.#tasks.delete(owner);
  }

  /** Waits until every live task is blocked in `wait` or done. */
  async settle(): Promise<void> {
    for (let spins = 0; ; spins++) {
      const live = [...this.#tasks.values()].filter((t) => !t.done).length;
      const blocked = new Set(this.#steps.map((s) => s.owner)).size;
      if (live === blocked) return;
      if (spins > 100_000) throw new Error('a task neither finished nor reached a step');
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  /** Runs steps until no task is running. */
  async drain(maxSteps = 100_000): Promise<void> {
    await this.settle();
    for (let i = 0; i < maxSteps; i++) {
      if (!(await this.step())) return;
    }
    throw new Error('tasks did not finish');
  }
}
