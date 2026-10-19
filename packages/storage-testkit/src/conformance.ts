import type { Storage } from '@obsy/protocol';
import { afterAll, describe, it } from 'vite-plus/test';

import { DEFAULT_RACE, conformanceChecks } from './checks';
import type { ConformanceCheck, RaceParameters } from './checks';
import type { CommitLogRaceResult, CreateRaceResult } from './race';

export { DEFAULT_RACE, UNUSUAL_KEYS } from './checks';
export type { RaceParameters } from './checks';

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

/**
 * Registers the storage conformance suite for `target` with Vitest. The
 * checks themselves are in `checks.ts`, so that the platform probe can run
 * them without Vitest.
 */
export function describeStorageConformance(target: ConformanceTarget): void {
  const race: RaceParameters = { ...DEFAULT_RACE, ...target.race };
  const timeout = target.timeoutMs ?? 30_000;
  const raceTimeout = timeout * 10;
  const report = target.report?.bind(target);
  const groups = new Map<string, ConformanceCheck[]>();
  for (const check of conformanceChecks(race)) {
    groups.set(check.group, [...(groups.get(check.group) ?? []), check]);
  }

  describe(`Storage conformance: ${target.name}`, () => {
    if (target.cleanup !== undefined) {
      const cleanup = target.cleanup.bind(target);
      afterAll(async () => {
        await cleanup();
      }, raceTimeout);
    }

    for (const [group, checks] of groups) {
      describe(group, () => {
        for (const check of checks) {
          it(check.name, { timeout: check.race ? raceTimeout : timeout }, async () => {
            const storage = await target.create(check.label);
            await check.run(storage, { race, ...(report === undefined ? {} : { report }) });
          });
        }
      });
    }
  });
}
