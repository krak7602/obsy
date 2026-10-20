/**
 * Runs many simulation seeds in parallel worker threads.
 *
 *   pnpm --filter @obsy/simulator run build
 *   node packages/simulator/dist/cli.mjs --seeds 1000000 [--start 1] [--workers 12] [--steps 600]
 *   node packages/simulator/dist/cli.mjs --seed 1234 --trace
 *
 * Prints progress, aggregate counts, and the first failing seeds. Exit code
 * 1 when any seed fails. See docs/runbooks/simulator.md.
 */
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { simulate } from './sim';

interface Job {
  readonly start: number;
  readonly count: number;
  readonly worker: number;
  readonly workers: number;
  readonly steps: number;
}

interface Progress {
  readonly done: number;
  readonly failures: { seed: number; failure: string }[];
  readonly totals: Record<string, number>;
  readonly finished: boolean;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function runWorker(job: Job): Promise<void> {
  const port = parentPort;
  if (port === null) throw new Error('not a worker');
  let done = 0;
  let failures: Progress['failures'] = [];
  let totals: Record<string, number> = {};
  const flush = (finished: boolean): void => {
    port.postMessage({ done, failures, totals, finished } satisfies Progress);
    done = 0;
    failures = [];
    totals = {};
  };
  for (let seed = job.start + job.worker; seed < job.start + job.count; seed += job.workers) {
    const result = await simulate({ seed, steps: job.steps });
    done++;
    for (const [key, value] of Object.entries(result.stats))
      totals[key] = (totals[key] ?? 0) + value;
    if (!result.ok) failures.push({ seed, failure: result.failure ?? 'unknown' });
    if (done >= 500) flush(false);
  }
  flush(true);
}

async function runMain(): Promise<void> {
  const single = arg('seed');
  const steps = Number(arg('steps') ?? 600);
  if (single !== undefined) {
    const result = await simulate({ seed: Number(single), steps });
    if (process.argv.includes('--trace')) console.log(result.trace.join('\n'));
    console.log(
      JSON.stringify(
        { seed: result.seed, ok: result.ok, failure: result.failure, stats: result.stats },
        null,
        2,
      ),
    );
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const start = Number(arg('start') ?? 1);
  const count = Number(arg('seeds') ?? 10_000);
  const workers = Math.max(1, Number(arg('workers') ?? availableParallelism()));
  const began = Date.now();
  let done = 0;
  const failures: Progress['failures'] = [];
  const totals: Record<string, number> = {};
  let lastReport = 0;

  await Promise.all(
    Array.from({ length: workers }, (_, worker) => {
      const job: Job = { start, count, worker, workers, steps };
      return new Promise<void>((resolve, reject) => {
        const thread = new Worker(new URL(import.meta.url), { workerData: job });
        thread.on('message', (progress: Progress) => {
          done += progress.done;
          failures.push(...progress.failures);
          for (const [key, value] of Object.entries(progress.totals))
            totals[key] = (totals[key] ?? 0) + value;
          if (Date.now() - lastReport > 10_000) {
            lastReport = Date.now();
            const rate = done / ((Date.now() - began) / 1000);
            console.log(
              `${done}/${count} seeds, ${failures.length} failed, ${rate.toFixed(0)} seeds/s`,
            );
          }
          if (progress.finished) resolve();
        });
        thread.on('error', reject);
      });
    }),
  );

  const seconds = (Date.now() - began) / 1000;
  console.log(
    JSON.stringify(
      {
        seeds: done,
        start,
        steps,
        workers,
        failed: failures.length,
        seconds: Math.round(seconds),
        totals,
      },
      null,
      2,
    ),
  );
  failures.sort((a, b) => a.seed - b.seed);
  for (const f of failures.slice(0, 20)) console.log(`seed ${f.seed}: ${f.failure}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await (isMainThread ? runMain() : runWorker(workerData as Job));
