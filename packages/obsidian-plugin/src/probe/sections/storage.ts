// Storage over requestUrl: transport checks, the conformance checks, a small
// conditional-create race, per-request latency, a one-off global fetch try,
// and cleanup of every key the run wrote.
import { isPreconditionFailed, isStorageError } from '@obsy/protocol';
import { S3Storage } from '@obsy/storage-s3';
import type { FetchLike, S3StorageOptions } from '@obsy/storage-s3';
import {
  DEFAULT_RACE,
  conformanceChecks,
  deleteAllUnder,
  outcomeLabel,
  runConformanceChecks,
  runCreateRace,
  summariseLatencies,
} from '@obsy/storage-testkit/portable';
import type { LatencySummary } from '@obsy/storage-testkit/portable';

import { createRequestUrlFetch } from '../../transport/request-url-fetch';
import type { RequestUrlFunction, Timers, TransportEvent } from '../../transport/request-url-fetch';
import type { Log, SectionOutput, Step } from '../section';
import { statusOf, step } from '../section';
import { MIB, describeError, equalBytes, mbPerSecond, now, randomBytes, sleep } from '../util';

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  addressing: 'path' | 'virtual';
  /** Probe-only root prefix; see `checkProbePrefix`. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StorageSectionInput {
  config: StorageConfig;
  requestUrl: RequestUrlFunction;
  /** The global `fetch`, for the one CORS try. `undefined` when it does not exist. */
  globalFetch: FetchLike | undefined;
  /** Random run ID. The run writes only under `<prefix><runId>/`. */
  runId: string;
  /** Run every conformance check, including both races at default size. */
  full: boolean;
  timers: Timers;
  log: Log;
  /** Bodies for the binary round trip. Tests pass smaller sizes. */
  binarySizes?: number[];
  /** How long to wait for an abandoned request to settle. Default 15 s. */
  abandonedWaitMs?: number;
}

const PROBE_PREFIX = /^obsy-probe\/[a-z0-9-]{1,64}\/$/;

/** Throws unless `prefix` is a probe-only prefix such as `obsy-probe/3f9a0c1d/`. */
export function checkProbePrefix(prefix: string): void {
  if (!PROBE_PREFIX.test(prefix)) {
    throw new Error(
      'The prefix must be "obsy-probe/<id>/", where <id> is lower-case letters, digits, or dashes',
    );
  }
}

/** Which storage operation a transport event was, from method and header names. */
export function operationOf(event: TransportEvent): string {
  if (event.method === 'GET') return /[?&]list-type=2(?:&|$)/.test(event.url) ? 'list' : 'get';
  if (event.method === 'PUT') {
    if (event.requestHeaderNames.includes('if-none-match')) return 'putIfAbsent';
    if (event.requestHeaderNames.includes('if-match')) return 'putIfMatch';
    return 'put';
  }
  return event.method.toLowerCase();
}

/** Collects latency and outcomes per operation. Keeps no URLs. */
class Recorder {
  readonly latencies = new Map<string, number[]>();
  readonly outcomes = new Map<string, number>();
  readonly headerNames = new Set<string>();
  bytesSent = 0;
  bytesReceived = 0;

  observe = (event: TransportEvent): void => {
    const operation = operationOf(event);
    const label = `${operation} ${event.outcome}${event.status === undefined ? '' : ` ${event.status}`}`;
    this.outcomes.set(label, (this.outcomes.get(label) ?? 0) + 1);
    this.latencies.set(operation, [...(this.latencies.get(operation) ?? []), event.durationMs]);
    this.bytesSent += event.requestBytes;
    this.bytesReceived += event.responseBytes;
    for (const name of event.headerNames) this.headerNames.add(name);
  };

  summary(): {
    latency: Record<string, LatencySummary>;
    outcomes: Record<string, number>;
    bytesSent: number;
    bytesReceived: number;
  } {
    const all = [...this.latencies.values()].flat();
    const latency: Record<string, LatencySummary> = { all: summariseLatencies(all) };
    for (const [operation, samples] of [...this.latencies.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      latency[operation] = summariseLatencies(samples);
    }
    return {
      latency,
      outcomes: Object.fromEntries(
        [...this.outcomes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
    };
  }
}

function errorFields(error: unknown): Record<string, unknown> {
  if (isStorageError(error)) {
    return {
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.code === undefined ? {} : { code: error.code }),
      mayHaveApplied: error.mayHaveApplied,
      error: describeError(error),
    };
  }
  return { error: describeError(error) };
}

export async function runStorageSection(input: StorageSectionInput): Promise<SectionOutput> {
  const { config, log } = input;
  checkProbePrefix(config.prefix);
  if (config.endpoint === '' || config.bucket === '') {
    return { status: 'skipped', data: { reason: 'endpoint or bucket not set' }, errors: [] };
  }
  if (config.accessKeyId === '' || config.secretAccessKey === '') {
    return {
      status: 'skipped',
      data: { reason: 'credentials not found in secret storage' },
      errors: [],
    };
  }

  const recorder = new Recorder();
  const transport = createRequestUrlFetch(input.requestUrl, {
    timers: input.timers,
    observer: recorder.observe,
  });
  const base: S3StorageOptions = {
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    addressing: config.addressing,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    prefix: config.prefix,
    fetch: transport,
  };
  const root = new S3Storage(base);
  const runPrefix = `${input.runId}/`;
  const run = root.withPrefix(runPrefix);
  const errors: string[] = [];

  // 1. Transport checks.
  log('Storage: transport checks');
  const transportSteps = await transportChecks(input, base, run, transport.stats);

  // 2. Conformance checks.
  const race = input.full
    ? DEFAULT_RACE
    : { ...DEFAULT_RACE, createWriters: 4, createRounds: 5, logWriters: 3, commitsPerWriter: 3 };
  const checks = conformanceChecks(race).filter((check) => input.full || !check.race);
  log(`Storage: ${checks.length} conformance checks${input.full ? ' (full suite)' : ''}`);
  let index = 0;
  const conformance = await runConformanceChecks({
    checks,
    race,
    create: (label) => run.withPrefix(`conformance/${String(index++).padStart(2, '0')}-${label}/`),
    onResult: (result) => {
      log(`Storage: ${result.passed ? 'pass' : 'FAIL'} ${result.group}: ${result.name}`);
    },
  });

  // 3. A small conditional-create race (the full suite has its own).
  let createRace: unknown = null;
  if (!input.full) {
    log('Storage: conditional-create race, 4 writers x 5 rounds');
    try {
      const result = await runCreateRace(run.withPrefix('race/'), {
        writers: 4,
        rounds: 5,
        prefix: '',
      });
      createRace = {
        passed: result.violations.length === 0 && result.roundsPassed === 5,
        ...result,
      };
    } catch (error) {
      createRace = { passed: false, error: describeError(error) };
    }
  }

  // 4. One try with the global fetch, to see whether CORS blocks it.
  log('Storage: one request with the global fetch');
  const globalFetch = await tryGlobalFetch(input, base, runPrefix);

  // 5. Clean up every key under the run prefix.
  log('Storage: cleanup');
  let cleanup: Record<string, unknown>;
  try {
    const deletedKeys = await deleteAllUnder(root, runPrefix);
    const remaining = await root.list(runPrefix);
    cleanup = {
      passed: remaining.keys.length === 0,
      deletedKeys,
      remainingKeys: remaining.keys.length,
    };
  } catch (error) {
    cleanup = { passed: false, error: describeError(error) };
    errors.push(`cleanup: ${describeError(error)}`);
  }

  const traffic = recorder.summary();
  const headerNames = [...recorder.headerNames].sort();
  const createRacePassed =
    createRace === null || (createRace as { passed?: boolean }).passed === true;
  const passed =
    statusOf(transportSteps) === 'passed' &&
    conformance.every((result) => result.passed) &&
    createRacePassed &&
    cleanup['passed'] === true;
  return {
    status: passed ? 'passed' : 'failed',
    data: {
      full: input.full,
      transport: {
        steps: transportSteps,
        stats: { ...transport.stats },
        responseHeaderNames: headerNames.slice(0, 60),
        responseHeaderNamesAllLowerCase: headerNames.every((name) => name === name.toLowerCase()),
      },
      conformance: {
        passed: conformance.filter((result) => result.passed).length,
        failed: conformance.filter((result) => !result.passed).length,
        results: conformance.map(({ group, name, passed: ok, durationMs, error }) => ({
          group,
          name,
          passed: ok,
          durationMs,
          ...(error === undefined ? {} : { error }),
        })),
      },
      createRace,
      globalFetch,
      cleanup,
      requests: traffic,
    },
    errors,
  };
}

async function transportChecks(
  input: StorageSectionInput,
  base: S3StorageOptions,
  run: S3Storage,
  stats: { abandonedSettled: number },
): Promise<Step[]> {
  const steps: Step[] = [];
  const storage = run.withPrefix('transport/');
  let etag = '';

  steps.push(
    await step('putIfAbsent creates a key and returns an etag', async () => {
      const created = await storage.putIfAbsent(
        'a.bin',
        randomBytes(1024),
        'application/octet-stream',
      );
      etag = created.etag;
      return { passed: etag.length > 0, etagLength: etag.length };
    }),
  );

  steps.push(
    await step('putIfAbsent on an existing key returns 412 with a readable body', async () => {
      try {
        await storage.putIfAbsent('a.bin', randomBytes(16), 'application/octet-stream');
        return { passed: false, observed: 'the second create succeeded' };
      } catch (error) {
        const fields = errorFields(error);
        return {
          passed: isPreconditionFailed(error) && fields['code'] === 'PreconditionFailed',
          ...fields,
        };
      }
    }),
  );

  steps.push(
    await step('putIfMatch with a wrong etag returns 412', async () => {
      try {
        await storage.putIfMatch(
          'a.bin',
          randomBytes(16),
          '0'.repeat(32),
          'application/octet-stream',
        );
        return { passed: false, observed: 'the write succeeded' };
      } catch (error) {
        return { passed: isPreconditionFailed(error), ...errorFields(error) };
      }
    }),
  );

  steps.push(
    await step('putIfMatch with the current etag succeeds', async () => {
      const updated = await storage.putIfMatch(
        'a.bin',
        randomBytes(16),
        etag,
        'application/octet-stream',
      );
      return { passed: updated.etag.length > 0 && updated.etag !== etag };
    }),
  );

  steps.push(
    await step('get of a missing key returns null (404 NoSuchKey)', async () => {
      const read = await storage.get('missing.bin');
      return { passed: read === null };
    }),
  );

  const sizes = input.binarySizes ?? [0, 256, MIB, 8 * MIB];
  for (const size of sizes) {
    steps.push(
      await step(`binary round trip, ${size} bytes`, async () => {
        const bytes =
          size === 256 ? Uint8Array.from({ length: 256 }, (_, value) => value) : randomBytes(size);
        const key = `binary-${size}.bin`;
        const putStarted = now();
        await storage.putIfAbsent(key, bytes, 'application/octet-stream');
        const putMs = now() - putStarted;
        const getStarted = now();
        const read = await storage.get(key);
        const getMs = now() - getStarted;
        return {
          passed: read !== null && equalBytes(read.body, bytes),
          bytes: size,
          readBytes: read?.body.length ?? null,
          putMs: Math.round(putMs),
          getMs: Math.round(getMs),
          putMBps: mbPerSecond(size, putMs),
          getMBps: mbPerSecond(size, getMs),
        };
      }),
    );
  }

  steps.push(
    await step('content-type in RequestUrlParam.contentType instead of a header', async () => {
      const paramTransport = createRequestUrlFetch(input.requestUrl, {
        timers: input.timers,
        contentType: 'param',
      });
      const paramStorage = new S3Storage({ ...base, fetch: paramTransport }).withPrefix(
        `${input.runId}/transport/`,
      );
      try {
        await paramStorage.putIfAbsent('content-type-param.txt', new Uint8Array([1]), 'text/plain');
        return { passed: true, observed: 'accepted' };
      } catch (error) {
        // Informational: a signature error here means requestUrl changed the header.
        return { passed: true, observed: 'rejected', ...errorFields(error) };
      }
    }),
  );

  steps.push(
    await step('client-side timeout; the abandoned request is not cancelled', async () => {
      const timeoutStorage = new S3Storage({ ...base, timeoutMs: 1 }).withPrefix(
        `${input.runId}/transport/`,
      );
      const before = stats.abandonedSettled;
      let code: unknown = null;
      try {
        await timeoutStorage.get('timeout-probe.bin');
      } catch (error) {
        code = isStorageError(error) ? (error.code ?? error.kind) : describeError(error);
      }
      const waitStarted = now();
      const limit = input.abandonedWaitMs ?? 15_000;
      while (stats.abandonedSettled === before && now() - waitStarted < limit) await sleep(100);
      const settled = stats.abandonedSettled > before;
      return {
        passed: code === 'Timeout',
        errorCode: code,
        underlyingRequestSettled: settled,
        settledAfterMs: settled ? Math.round(now() - waitStarted) : null,
        cancellable: false,
      };
    }),
  );
  return steps;
}

async function tryGlobalFetch(
  input: StorageSectionInput,
  base: S3StorageOptions,
  runPrefix: string,
): Promise<Record<string, unknown>> {
  if (input.globalFetch === undefined) return { available: false };
  const started = now();
  try {
    const storage = new S3Storage({ ...base, fetch: input.globalFetch, timeoutMs: 15_000 });
    const read = await storage.get(`${runPrefix}fetch-probe/missing.json`);
    return {
      available: true,
      works: read === null,
      observed: read === null ? '404 read as null, as expected' : 'unexpected object',
      ms: Math.round(now() - started),
    };
  } catch (error) {
    return {
      available: true,
      works: false,
      outcome: outcomeLabel(error),
      ...errorFields(error),
      ms: Math.round(now() - started),
    };
  }
}
