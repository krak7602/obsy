import type { CommitLogRaceResult, CreateRaceResult } from './race';
import type { LatencySummary } from './stats';

function latency(summary: LatencySummary): string {
  return (
    `n=${summary.count} p50=${summary.p50Ms} ms p90=${summary.p90Ms} ms ` +
    `p99=${summary.p99Ms} ms max=${summary.maxMs} ms`
  );
}

function outcomes(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, count]) => `${label}=${count}`)
    .join(', ');
}

/** Formats a race result as Markdown lines that can go into a learning page. */
export function formatRaceResult(
  label: string,
  result: CreateRaceResult | CommitLogRaceResult,
): string {
  const lines = [`### ${label}`, ''];
  if ('rounds' in result) {
    lines.push(
      `- Writers per round: ${result.writers}; rounds: ${result.rounds}`,
      `- Rounds with exactly one winner: ${result.roundsPassed}/${result.rounds}`,
      `- Request outcomes: ${outcomes(result.outcomes)}`,
      `- putIfAbsent latency: ${latency(result.latency)}`,
    );
  } else {
    lines.push(
      `- Writers: ${result.writers}; commits per writer: ${result.commitsPerWriter}`,
      `- Log entries: ${result.logEntries}; claim attempts: ${result.claimAttempts}; ` +
        `conflicts: ${result.claimConflicts}; most claims for one commit: ${result.maxClaimsForOneCommit}`,
      `- Request outcomes: ${outcomes(result.outcomes)}`,
      `- Claim latency: ${latency(result.claimLatency)}`,
      `- List latency: ${latency(result.listLatency)}`,
    );
  }
  lines.push(
    `- Duration: ${result.durationMs} ms`,
    `- Violations: ${result.violations.length === 0 ? 'none' : result.violations.join('; ')}`,
    '',
  );
  return lines.join('\n');
}
