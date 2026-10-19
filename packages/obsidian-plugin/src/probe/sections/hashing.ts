// SubtleCrypto SHA-256 throughput, from 1 KiB to 50 MiB (the mobile
// attachment cap). Records time per size, MB/s, and memory errors.
import type { Log, SectionOutput } from '../section';
import { statusOf, step } from '../section';
import {
  KIB,
  MIB,
  describeError,
  mbPerSecond,
  median,
  now,
  randomBytes,
  round1,
  sha256Hex,
  sizeLabel,
} from '../util';

export const DEFAULT_HASH_SIZES = [KIB, 64 * KIB, MIB, 4 * MIB, 16 * MIB, 50 * MIB];

export interface HashingSectionInput {
  sizes?: number[];
  /** Keep hashing one size until this much time has passed. Default 300 ms. */
  minTotalMs?: number;
  /** At most this many digests per size. Default 50. */
  maxRepetitions?: number;
  log: Log;
}

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

export async function runHashingSection(input: HashingSectionInput): Promise<SectionOutput> {
  if (window.crypto?.subtle?.digest === undefined) {
    return { status: 'unavailable', data: { subtle: false }, errors: [] };
  }
  const minTotalMs = input.minTotalMs ?? 300;
  const maxRepetitions = input.maxRepetitions ?? 50;

  const checks = [
    await step('SHA-256 of "abc" matches the FIPS 180-2 test vector', async () => ({
      passed: (await sha256Hex(new TextEncoder().encode('abc'))) === ABC_SHA256,
    })),
    await step('digest of a Uint8Array view hashes only the view', async () => {
      const whole = randomBytes(4096);
      const view = whole.subarray(1000, 3000);
      return { passed: (await sha256Hex(view)) === (await sha256Hex(view.slice())) };
    }),
  ];

  const sizes = [];
  for (const size of input.sizes ?? DEFAULT_HASH_SIZES) {
    input.log(`Hashing: ${sizeLabel(size)}`);
    const allocStarted = now();
    try {
      // The buffer goes out of scope after each size, so at most one is alive.
      const bytes = randomBytes(size);
      const allocMs = now() - allocStarted;
      const times: number[] = [];
      const started = now();
      while (
        times.length < maxRepetitions &&
        (times.length === 0 || now() - started < minTotalMs)
      ) {
        const digestStarted = now();
        await window.crypto.subtle.digest('SHA-256', bytes as BufferSource);
        times.push(now() - digestStarted);
      }
      const medianMs = median(times);
      sizes.push({
        size: sizeLabel(size),
        bytes: size,
        repetitions: times.length,
        allocAndFillMs: round1(allocMs),
        medianMs: round1(medianMs),
        minMs: round1(Math.min(...times)),
        maxMs: round1(Math.max(...times)),
        medianMBps: mbPerSecond(size, medianMs),
      });
    } catch (error) {
      // A RangeError or an out-of-memory error here is a finding, not a probe bug.
      sizes.push({ size: sizeLabel(size), bytes: size, error: describeError(error) });
    }
  }

  const failedSizes = sizes.filter((entry) => 'error' in entry).length;
  return {
    status: statusOf(checks) === 'passed' && failedSizes === 0 ? 'passed' : 'failed',
    data: { checks, sizes },
    errors: [],
  };
}
