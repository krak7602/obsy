/** Latency percentiles in milliseconds. */
export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

/** Summarises samples with the nearest-rank percentile method. */
export function summariseLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (fraction: number): number =>
    round(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: rank(0.5),
    p90Ms: rank(0.9),
    p99Ms: rank(0.99),
    maxMs: round(sorted.at(-1) ?? 0),
    meanMs: round(total / sorted.length),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Counts labelled events. */
export class Counter {
  readonly counts: Record<string, number> = {};

  add(label: string, amount = 1): void {
    this.counts[label] = (this.counts[label] ?? 0) + amount;
  }

  get(label: string): number {
    return this.counts[label] ?? 0;
  }
}
