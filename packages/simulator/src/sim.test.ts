import { describe, expect, it } from 'vite-plus/test';

import { NO_FAULTS } from './faulty-storage';
import { simulate } from './sim';

/**
 * Short simulation runs for `pnpm test`. OBSY_SIM_SEEDS sets the number of
 * seeds per test (default 200); OBSY_SIM_SEED replays one seed. The long
 * run is in docs/runbooks/simulator.md.
 */
const SEEDS = Number(process.env['OBSY_SIM_SEEDS'] ?? 200);
const ONLY = process.env['OBSY_SIM_SEED'];
const seeds = ONLY === undefined ? Array.from({ length: SEEDS }, (_, i) => i + 1) : [Number(ONLY)];

async function run(faults?: typeof NO_FAULTS): Promise<string[]> {
  const failures: string[] = [];
  for (const seed of seeds) {
    const result = await simulate(faults === undefined ? { seed } : { seed, faults });
    if (!result.ok) {
      failures.push(`seed ${seed}: ${result.failure ?? ''}`);
      if (ONLY !== undefined) console.log(result.trace.join('\n'));
    }
  }
  return failures;
}

/** Seeds that found engine bugs in the million-seed run; they must keep passing. */
const REGRESSIONS = [13_431, 14_816, 95_652, 318_587];

describe('simulator', () => {
  it('keeps passing the seeds that found bugs', { timeout: 600_000 }, async () => {
    const failures: string[] = [];
    for (const seed of REGRESSIONS) {
      const result = await simulate({ seed });
      if (!result.ok) failures.push(`seed ${seed}: ${result.failure ?? ''}`);
    }
    expect(failures).toEqual([]);
  });

  it('keeps every invariant without faults', { timeout: 600_000 }, async () => {
    expect(await run(NO_FAULTS)).toEqual([]);
  });

  it('keeps every invariant with network faults and crashes', { timeout: 600_000 }, async () => {
    expect(await run()).toEqual([]);
  });
});
