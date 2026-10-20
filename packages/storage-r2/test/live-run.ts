// Setup for the live R2 binding run. Test-only code: it uses Node APIs.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import {
  deleteAllUnder,
  describeStorageConformance,
  formatRaceResult,
  raceFromSettings,
} from '@obsy/storage-testkit';
import { afterAll, describe, it } from 'vite-plus/test';

import { WorkerStorage } from './worker-storage';

/**
 * Registers the conformance suite against the live-run Worker at `url`.
 * Without a URL and token, it registers one skipped test that says how to
 * run it. Prints a Markdown summary without the URL or the token.
 */
export function describeR2Run(url: string | undefined, token: string | undefined): void {
  if (url === undefined || url === '' || token === undefined || token === '') {
    describe.skip('live R2 binding (not configured; run pnpm run test:r2-live)', () => {
      it('needs configuration', () => {});
    });
    return;
  }
  const label = 'Cloudflare R2 (Workers binding)';
  const race = raceFromSettings(process.env);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const runPrefix = `${runId}/`;
  const root = new WorkerStorage(url, token);
  const run = root.withPrefix(runPrefix);
  const reports: string[] = [];
  const started = new Date();
  let tests = 0;
  let deleted = 0;

  describeStorageConformance({
    name: label,
    create: (check) => run.withPrefix(`${String(tests++).padStart(2, '0')}-${check}/`),
    race,
    report: (check, result) => {
      reports.push(formatRaceResult(check, result));
    },
    cleanup: async () => {
      deleted = await deleteAllUnder(root, runPrefix);
    },
  });

  afterAll(() => {
    const summary = [
      `## Storage conformance run: ${label}`,
      '',
      `- Started: ${started.toISOString()}`,
      `- Run id: ${runId}`,
      `- Node: ${process.version}`,
      '- Path: Node → test Worker (one request per call) → R2 binding',
      `- Race parameters: ${JSON.stringify(race)}`,
      `- Cleanup: deleted ${deleted} keys under the run prefix`,
      '',
      ...reports,
    ].join('\n');
    console.log(`\n${summary}`);
    const file = process.env['OBSY_R2_REPORT_FILE'];
    if (file !== undefined && file !== '') writeFileSync(file, `${summary}\n`);
  });
}
