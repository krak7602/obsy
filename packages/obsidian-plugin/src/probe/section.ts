import type { SectionResult, SectionStatus } from './report';
import { describeError, now } from './util';

/** Progress output for the probe view. Never pass credentials or URLs. */
export type Log = (message: string) => void;

export interface SectionOutput {
  status: SectionStatus;
  data: unknown;
  errors: string[];
}

/** Runs one section, times it, and turns an unexpected throw into an `error` result. */
export async function runTimed(run: () => Promise<SectionOutput>): Promise<SectionResult> {
  const startedAt = new Date().toISOString();
  const started = now();
  try {
    const output = await run();
    return { ...output, startedAt, durationMs: Math.round(now() - started) };
  } catch (error) {
    return {
      status: 'error',
      data: null,
      errors: [describeError(error)],
      startedAt,
      durationMs: Math.round(now() - started),
    };
  }
}

/** `passed` when every step passed, else `failed`. */
export function statusOf(steps: readonly { passed: boolean }[]): SectionStatus {
  return steps.every((step) => step.passed) ? 'passed' : 'failed';
}

/** One named step with its own result, so that one failure does not hide the others. */
export interface Step {
  name: string;
  passed: boolean;
  [detail: string]: unknown;
}

/** Runs a step. A throw becomes a failed step with the error description. */
export async function step(
  name: string,
  run: () => Promise<Record<string, unknown> & { passed: boolean }>,
): Promise<Step> {
  const started = now();
  try {
    const result = await run();
    return { name, ...result, ms: Math.round(now() - started) };
  } catch (error) {
    return { name, passed: false, error: describeError(error), ms: Math.round(now() - started) };
  }
}
