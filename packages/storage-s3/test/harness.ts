// Shared setup for the local Docker and live R2/S3 conformance runs.
// Test-only code: it uses Node APIs.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

import {
  DEFAULT_RACE,
  deleteAllUnder,
  describeStorageConformance,
  formatRaceResult,
} from '@obsy/storage-testkit';
import type { RaceParameters } from '@obsy/storage-testkit';
import { afterAll, describe, it } from 'vite-plus/test';

import { S3Storage } from '../src/index';
import type { S3StorageOptions } from '../src/index';

/** Loads `KEY=value` lines from `path` into `process.env`, if the file exists. */
export function loadEnvFile(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Race parameters from `OBSY_RACE_*` variables, with `defaults` for unset ones. */
export function raceFromEnv(defaults: RaceParameters = DEFAULT_RACE): RaceParameters {
  return {
    createWriters: positiveInt('OBSY_RACE_CREATE_WRITERS', defaults.createWriters),
    createRounds: positiveInt('OBSY_RACE_CREATE_ROUNDS', defaults.createRounds),
    logWriters: positiveInt('OBSY_RACE_LOG_WRITERS', defaults.logWriters),
    commitsPerWriter: positiveInt('OBSY_RACE_COMMITS_PER_WRITER', defaults.commitsPerWriter),
    listLimit: positiveInt('OBSY_RACE_LIST_LIMIT', defaults.listLimit),
  };
}

export interface RunOptions {
  /** Provider label for titles and the summary. Never the endpoint or bucket. */
  label: string;
  storage: S3StorageOptions;
  race: RaceParameters;
  /** Extra summary lines, such as the server image. */
  notes: string[];
}

/**
 * Registers the conformance suite against S3 storage. Each run writes only
 * under `<prefix>obsy-conformance/<run id>/` and deletes only that sub-prefix
 * afterwards. It prints a Markdown summary without endpoint, bucket, prefix,
 * or credentials. Without options, it registers one skipped test that says
 * what to configure.
 */
export function describeS3Run(options: RunOptions | undefined, skipReason: string): void {
  if (options === undefined) {
    describe.skip(skipReason, () => {
      it('needs configuration', () => {});
    });
    return;
  }
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const runPrefix = `obsy-conformance/${runId}/`;
  const root = new S3Storage(options.storage);
  const run = root.withPrefix(runPrefix);
  const reports: string[] = [];
  let tests = 0;
  let deleted = 0;
  const started = new Date();

  describeStorageConformance({
    name: options.label,
    create: (label) => run.withPrefix(`${String(tests++).padStart(2, '0')}-${label}/`),
    race: options.race,
    report: (label, result) => {
      reports.push(formatRaceResult(label, result));
    },
    cleanup: async () => {
      deleted = await deleteAllUnder(root, runPrefix);
    },
  });

  afterAll(() => {
    const summary = [
      `## Storage conformance run: ${options.label}`,
      '',
      `- Started: ${started.toISOString()}`,
      `- Run id: ${runId}`,
      `- Node: ${process.version}`,
      `- Region: ${options.storage.region}; addressing: ${options.storage.addressing ?? 'path'}`,
      ...options.notes.map((note) => `- ${note}`),
      `- Race parameters: ${JSON.stringify(options.race)}`,
      `- Cleanup: deleted ${deleted} keys under the run prefix`,
      '',
      ...reports,
    ].join('\n');
    console.log(`\n${summary}`);
    const file = process.env['OBSY_S3_REPORT_FILE'];
    if (file !== undefined && file !== '') writeFileSync(file, `${summary}\n`);
  });
}

/** A provider label from the endpoint host, without account IDs. */
export function providerLabel(endpoint: string): string {
  const host = /^https?:\/\/([^/:]+)/.exec(endpoint)?.[1] ?? '';
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'Cloudflare R2 (S3 API)';
  if (host.endsWith('.amazonaws.com')) return 'AWS S3';
  return 'S3-compatible endpoint';
}

function setting(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Options for the local Docker run, from `.env.s3-local`, or `undefined`. */
export function localRunOptions(envFile: string): RunOptions | undefined {
  loadEnvFile(envFile);
  const endpoint = setting('OBSY_S3_LOCAL_ENDPOINT');
  const bucket = setting('OBSY_S3_LOCAL_BUCKET');
  const accessKeyId = setting('OBSY_S3_LOCAL_ACCESS_KEY_ID');
  const secretAccessKey = setting('OBSY_S3_LOCAL_SECRET_ACCESS_KEY');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const server = setting('OBSY_S3_LOCAL_SERVER') ?? 'S3 server';
  return {
    label: `local ${server} in Docker (harness target, not a supported provider)`,
    storage: { endpoint, bucket, region: 'us-east-1', accessKeyId, secretAccessKey },
    race: raceFromEnv({
      createWriters: 16,
      createRounds: 50,
      logWriters: 8,
      commitsPerWriter: 25,
      listLimit: 10,
    }),
    notes: [`Server image: ${setting('OBSY_S3_LOCAL_IMAGE') ?? 'unknown'}`],
  };
}

/** Options for the live R2/S3 run, from the environment or `.env.local`, or `undefined`. */
export function liveRunOptions(envFile: string): RunOptions | undefined {
  loadEnvFile(envFile);
  const endpoint = setting('OBSY_S3_ENDPOINT');
  const bucket = setting('OBSY_S3_BUCKET');
  const accessKeyId = setting('OBSY_S3_ACCESS_KEY_ID');
  const secretAccessKey = setting('OBSY_S3_SECRET_ACCESS_KEY');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const rawPrefix = setting('OBSY_S3_PREFIX') ?? '';
  const prefix = rawPrefix === '' || rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
  const sessionToken = setting('OBSY_S3_SESSION_TOKEN');
  return {
    label: providerLabel(endpoint),
    storage: {
      endpoint,
      bucket,
      region: setting('OBSY_S3_REGION') ?? 'auto',
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      prefix,
      addressing: setting('OBSY_S3_ADDRESSING') === 'virtual' ? 'virtual' : 'path',
      timeoutMs: Number(setting('OBSY_S3_TIMEOUT_MS') ?? '30000'),
    },
    race: raceFromEnv(),
    notes: [],
  };
}
