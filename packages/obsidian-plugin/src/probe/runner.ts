// The probe runner: runs sections one at a time, keeps the latest result of
// each, checks the restart markers on load, and builds the redacted report.
// It reaches Obsidian only through `ProbeHost`, so Node tests can drive it.
import { S3Storage } from '@obsy/storage-s3';
import type { FetchLike } from '@obsy/storage-s3';
import { deleteAllUnder } from '@obsy/storage-testkit/portable';

import { createRequestUrlFetch } from '../transport/request-url-fetch';
import type { RequestUrlFunction, Timers } from '../transport/request-url-fetch';
import {
  REPORT_SCHEMA,
  REPORT_SCHEMA_VERSION,
  endpointHost,
  guessProvider,
  redactString,
  sensitiveValues,
  serialiseReport,
} from './report';
import type { ProbeReport, SectionId, SectionResult, SensitiveValue } from './report';
import { runTimed } from './section';
import type { SectionOutput } from './section';
import { runHashingSection } from './sections/hashing';
import type { HashingSectionInput } from './sections/hashing';
import {
  deleteProbeDatabase,
  readIndexedDbMarker,
  runIndexedDbSection,
  writeIndexedDbMarker,
} from './sections/indexeddb';
import type { IndexedDbSectionInput, StoredMarker } from './sections/indexeddb';
import { LifecycleLog, runBackgroundTest } from './sections/lifecycle';
import { MARKER_SECRET_ID, TEST_SECRET_ID, runSecretsSection } from './sections/secrets';
import type { SecretStorageLike } from './sections/secrets';
import { checkProbePrefix, runStorageSection } from './sections/storage';
import type { StorageConfig } from './sections/storage';
import { PROBE_FOLDER, runVaultIoSection } from './sections/vault-io';
import type { VaultAdapterLike } from './sections/vault-io';
import type { ProbeSettings } from './settings';
import { MIB, describeError, randomHex } from './util';

/** Everything the runner needs from Obsidian. */
export interface ProbeHost {
  probeVersion: string;
  settings(): ProbeSettings;
  saveSettings(settings: ProbeSettings): Promise<void>;
  secrets: SecretStorageLike | undefined;
  requestUrl: RequestUrlFunction;
  globalFetch: FetchLike | undefined;
  adapter: VaultAdapterLike;
  readPluginData(): Promise<string | null>;
  countInLocalStorage(value: string): number | null;
  /** Vault-scoped localStorage (`App.loadLocalStorage` and `saveLocalStorage`). */
  localStore: { load(key: string): unknown; save(key: string, value: unknown): void };
  environment(): Record<string, unknown>;
  /** Absolute forms of the vault folder, to redact. */
  vaultPaths(): string[];
  timers: Timers;
  visibility(): string;
  /** Overrides for tests: smaller sizes. */
  sizes?: {
    hashing?: Partial<HashingSectionInput>;
    indexedDb?: Partial<IndexedDbSectionInput>;
    binarySizes?: number[];
    vaultIoBytes?: number;
    backgroundBigBytes?: number;
    abandonedWaitMs?: number;
  };
}

export const RUN_ALL_ORDER: readonly SectionId[] = [
  'environment',
  'storage',
  'hashing',
  'indexedDb',
  'secretStorage',
  'vaultIo',
  'markers',
];

export const SECTION_TITLES: Record<SectionId, string> = {
  environment: 'Environment',
  storage: 'Storage over requestUrl',
  hashing: 'SHA-256 throughput',
  indexedDb: 'IndexedDB',
  secretStorage: 'Secret storage',
  vaultIo: 'Vault large files',
  background: 'Background requests',
  markers: 'Restart markers',
};

const LOCAL_LOADS = 'obsy-probe-loads';
const LOCAL_MARKER = 'obsy-probe-marker';
const LOCAL_LIFECYCLE = 'obsy-probe-lifecycle';

const NOTES = [
  'requestUrl has no timeout and no abort. The adapter times out on the client; the underlying request keeps running and its result is ignored.',
  'The obsidian 1.14.4 typings give SecretStorage only setSecret, getSecret, and listSecrets. There is no delete method.',
  'DataAdapter has readBinary but no ranged read; appendBinary allows chunked writes.',
  'Redacted: endpoint, endpoint host, account ID, bucket, credentials, the test secret value, and vault paths. URLs, 32-digit hex strings, AWS key IDs, 12-digit numbers, and absolute paths are replaced by placeholders.',
];

export class ProbeRunner {
  readonly sessionId = randomHex(8);
  readonly lifecycle = new LifecycleLog();
  readonly sections: Partial<Record<SectionId, SectionResult>> = {};
  readonly logLines: string[] = [];
  onLoad: Record<string, unknown> = {};
  busy: SectionId | 'run-all' | 'delete' | null = null;
  /** Random value for the SecretStorage test. It is redacted from the report. */
  readonly testSecretValue = `probe-${randomHex(12)}`;
  readonly #listeners = new Set<() => void>();
  #previousLifecycle: unknown = null;

  constructor(readonly host: ProbeHost) {
    this.#previousLifecycle = host.localStore.load(LOCAL_LIFECYCLE);
    this.lifecycle.subscribe(() => {
      host.localStore.save(LOCAL_LIFECYCLE, {
        sessionId: this.sessionId,
        events: this.lifecycle.events.slice(-30),
      });
      this.#changed();
    });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Adds a progress line. Lines are shown on screen, so they are redacted too. */
  log(message: string): void {
    const line = redactString(message, this.sensitive());
    this.logLines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    this.#changed();
  }

  // -------------------------------------------------------------------------
  // Restart test

  /** Reads the restart markers. Call once when the plugin loads. */
  async checkOnLoad(): Promise<void> {
    const { host } = this;
    const loads = host.localStore.load(LOCAL_LOADS) as {
      count?: number;
      lastLoadAt?: string;
    } | null;
    const count = (typeof loads?.count === 'number' ? loads.count : 0) + 1;
    host.localStore.save(LOCAL_LOADS, { count, lastLoadAt: new Date().toISOString() });
    const expected = host.settings().lastMarker;
    const compare = (found: unknown): { found: boolean; matches: boolean | null } => {
      const token =
        typeof found === 'string'
          ? found
          : (found as Partial<StoredMarker> | null | undefined)?.token;
      return {
        found: typeof token === 'string' && token !== '',
        matches: expected === null || typeof token !== 'string' ? null : token === expected.token,
      };
    };
    let indexedDb: Record<string, unknown>;
    try {
      indexedDb = compare(await readIndexedDbMarker());
    } catch (error) {
      indexedDb = { found: false, error: describeError(error) };
    }
    let secretStorage: Record<string, unknown>;
    try {
      secretStorage =
        host.secrets === undefined
          ? { available: false }
          : compare(host.secrets.getSecret(MARKER_SECRET_ID));
    } catch (error) {
      secretStorage = { found: false, error: describeError(error) };
    }
    this.onLoad = {
      checkedAt: new Date().toISOString(),
      loadCount: count,
      previousLoadAt: typeof loads?.lastLoadAt === 'string' ? loads.lastLoadAt : null,
      expectedMarker:
        expected === null
          ? null
          : {
              writtenAt: expected.writtenAt,
              ageSeconds: Math.round((Date.now() - Date.parse(expected.writtenAt)) / 1000),
            },
      indexedDb,
      localStorage: compare(host.localStore.load(LOCAL_MARKER)),
      secretStorage,
      previousSessionLifecycle: this.#previousLifecycle,
    };
    this.#changed();
  }

  // -------------------------------------------------------------------------
  // Sections

  storageConfig(): StorageConfig {
    const settings = this.host.settings();
    const resolve = (name: string): string =>
      name === '' ? '' : (this.host.secrets?.getSecret(name) ?? '');
    return {
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      addressing: settings.addressing,
      prefix: settings.prefix,
      accessKeyId: resolve(settings.accessKeyIdSecret),
      secretAccessKey: resolve(settings.secretAccessKeySecret),
    };
  }

  /** Runs one section and stores its result. Resolves `false` when another run is busy. */
  async run(id: SectionId): Promise<boolean> {
    if (this.busy !== null) return false;
    this.busy = id;
    this.#changed();
    try {
      await this.#runSection(id);
    } finally {
      this.busy = null;
      this.#changed();
    }
    return true;
  }

  /** Runs every section except the background test, which needs the owner. */
  async runAll(): Promise<boolean> {
    if (this.busy !== null) return false;
    this.busy = 'run-all';
    this.#changed();
    try {
      for (const id of RUN_ALL_ORDER) await this.#runSection(id);
    } finally {
      this.busy = null;
      this.#changed();
    }
    return true;
  }

  async #runSection(id: SectionId): Promise<void> {
    this.log(`Start: ${SECTION_TITLES[id]}`);
    const result = await runTimed(() => this.#sectionOutput(id));
    this.sections[id] = result;
    this.log(`End: ${SECTION_TITLES[id]}: ${result.status} in ${result.durationMs} ms`);
  }

  #sectionOutput(id: SectionId): Promise<SectionOutput> {
    const { host } = this;
    const log = (message: string): void => {
      this.log(message);
    };
    const sizes = host.sizes ?? {};
    const settings = host.settings();
    switch (id) {
      case 'environment':
        return Promise.resolve({ status: 'passed', data: host.environment(), errors: [] });
      case 'storage':
        return runStorageSection({
          config: this.storageConfig(),
          requestUrl: host.requestUrl,
          globalFetch: host.globalFetch,
          runId: `run-${randomHex(4)}`,
          full: settings.fullSuite,
          timers: host.timers,
          log,
          ...(sizes.binarySizes === undefined ? {} : { binarySizes: sizes.binarySizes }),
          ...(sizes.abandonedWaitMs === undefined
            ? {}
            : { abandonedWaitMs: sizes.abandonedWaitMs }),
        });
      case 'hashing':
        return runHashingSection({ log, ...sizes.hashing });
      case 'indexedDb':
        return runIndexedDbSection({ log, ...sizes.indexedDb });
      case 'secretStorage':
        return runSecretsSection({
          secrets: host.secrets,
          readPluginData: () => host.readPluginData(),
          countInLocalStorage: (value) => host.countInLocalStorage(value),
          credentialNames: {
            accessKeyId: settings.accessKeyIdSecret,
            secretAccessKey: settings.secretAccessKeySecret,
          },
          testValue: this.testSecretValue,
          log,
        });
      case 'vaultIo':
        return runVaultIoSection({
          adapter: host.adapter,
          sizeBytes: sizes.vaultIoBytes ?? settings.vaultIoMiB * MIB,
          log,
        });
      case 'background':
        return this.#background(settings, log);
      case 'markers':
        return this.#writeMarkers();
    }
  }

  async #background(
    settings: ProbeSettings,
    log: (message: string) => void,
  ): Promise<SectionOutput> {
    const config = this.storageConfig();
    checkProbePrefix(config.prefix);
    if (
      config.endpoint === '' ||
      config.bucket === '' ||
      config.accessKeyId === '' ||
      config.secretAccessKey === ''
    ) {
      return { status: 'skipped', data: { reason: 'storage is not configured' }, errors: [] };
    }
    const runPrefix = `run-${randomHex(4)}/`;
    const root = this.#storage(config);
    try {
      return await runBackgroundTest({
        storage: root.withPrefix(runPrefix),
        lifecycle: this.lifecycle,
        durationMs: settings.backgroundSeconds * 1000,
        ...(this.host.sizes?.backgroundBigBytes === undefined
          ? {}
          : { bigBytes: this.host.sizes.backgroundBigBytes }),
        visibility: () => this.host.visibility(),
        log,
      });
    } finally {
      await deleteAllUnder(root, runPrefix).catch(() => 0);
    }
  }

  #storage(config: StorageConfig, prefix = config.prefix): S3Storage {
    return new S3Storage({
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      addressing: config.addressing,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      prefix,
      fetch: createRequestUrlFetch(this.host.requestUrl, { timers: this.host.timers }),
    });
  }

  async #writeMarkers(): Promise<SectionOutput> {
    const marker: StoredMarker = { token: randomHex(8), writtenAt: new Date().toISOString() };
    const written: Record<string, unknown> = {};
    const errors: string[] = [];
    const attempt = async (name: string, write: () => Promise<void> | void): Promise<void> => {
      try {
        await write();
        written[name] = true;
      } catch (error) {
        written[name] = false;
        errors.push(`${name}: ${describeError(error)}`);
      }
    };
    await attempt('dataJson', () =>
      this.host.saveSettings({ ...this.host.settings(), lastMarker: marker }),
    );
    await attempt('indexedDb', () => writeIndexedDbMarker(marker));
    await attempt('localStorage', () => {
      this.host.localStore.save(LOCAL_MARKER, marker);
    });
    await attempt('secretStorage', () => {
      if (this.host.secrets === undefined) throw new Error('SecretStorage is not available');
      this.host.secrets.setSecret(MARKER_SECRET_ID, marker.token);
    });
    return {
      status: errors.length === 0 ? 'passed' : 'failed',
      data: {
        writtenAt: marker.writtenAt,
        written,
        next: 'Close Obsidian completely (swipe it away on iPhone), open it again, and open the probe. The "onLoad" part of the report shows which markers survived.',
      },
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup

  /** Deletes everything the probe created. Returns one line per store. */
  async deleteProbeData(): Promise<string[]> {
    if (this.busy !== null) return ['Another probe run is busy; try again when it ends.'];
    this.busy = 'delete';
    this.#changed();
    const lines: string[] = [];
    const attempt = async (name: string, run: () => Promise<string>): Promise<void> => {
      try {
        lines.push(`${name}: ${await run()}`);
      } catch (error) {
        lines.push(`${name}: failed (${describeError(error)})`);
      }
    };
    try {
      await attempt('Bucket', async () => {
        const config = this.storageConfig();
        checkProbePrefix(config.prefix);
        if (config.endpoint === '' || config.bucket === '' || config.accessKeyId === '') {
          return 'not configured';
        }
        const deleted = await deleteAllUnder(this.#storage(config, ''), config.prefix);
        return `${deleted} keys deleted under the probe prefix`;
      });
      await attempt('IndexedDB', () => deleteProbeDatabase());
      await attempt('Local storage', () => {
        for (const key of [LOCAL_LOADS, LOCAL_MARKER, LOCAL_LIFECYCLE])
          this.host.localStore.save(key, null);
        return Promise.resolve('cleared');
      });
      await attempt('Secret storage', () => {
        if (this.host.secrets === undefined) return Promise.resolve('not available');
        this.host.secrets.setSecret(TEST_SECRET_ID, '');
        this.host.secrets.setSecret(MARKER_SECRET_ID, '');
        return Promise.resolve('probe secrets set to empty (there is no delete method)');
      });
      await attempt('Vault folder', async () => {
        if (!(await this.host.adapter.exists(PROBE_FOLDER))) return 'not present';
        await this.host.adapter.rmdir(PROBE_FOLDER, true);
        return 'removed';
      });
      await attempt('Settings marker', async () => {
        await this.host.saveSettings({ ...this.host.settings(), lastMarker: null });
        return 'cleared';
      });
    } finally {
      this.busy = null;
      this.#changed();
    }
    const sensitive = this.sensitive();
    return lines.map((line) => redactString(line, sensitive));
  }

  // -------------------------------------------------------------------------
  // Report

  sensitive(): SensitiveValue[] {
    const settings = this.host.settings();
    const config = this.storageConfig();
    const host = endpointHost(settings.endpoint);
    const accountId = host?.split('.')[0];
    return sensitiveValues([
      { value: settings.endpoint, placeholder: '<endpoint>', match: 'substring' },
      host === undefined
        ? undefined
        : { value: host, placeholder: '<endpoint-host>', match: 'token' },
      accountId === undefined || !/^[0-9a-f]{32}$/i.test(accountId)
        ? undefined
        : { value: accountId, placeholder: '<account-id>', match: 'token' },
      { value: settings.bucket, placeholder: '<bucket>', match: 'token' },
      { value: config.accessKeyId, placeholder: '<access-key-id>', match: 'substring' },
      { value: config.secretAccessKey, placeholder: '<secret-access-key>', match: 'substring' },
      { value: this.testSecretValue, placeholder: '<test-secret>', match: 'substring' },
      ...this.host
        .vaultPaths()
        .map((path) => ({ value: path, placeholder: '<vault-path>', match: 'substring' as const })),
    ]);
  }

  report(): ProbeReport {
    const settings = this.host.settings();
    const config = this.storageConfig();
    return {
      schema: REPORT_SCHEMA,
      schemaVersion: REPORT_SCHEMA_VERSION,
      probeVersion: this.host.probeVersion,
      generatedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      config: {
        provider: guessProvider(settings.endpoint),
        endpoint: settings.endpoint === '' ? 'unset' : '<endpoint>',
        bucket: settings.bucket === '' ? 'unset' : '<bucket>',
        region: /^[a-z0-9-]{2,32}$/.test(settings.region) ? settings.region : '<region>',
        addressing: settings.addressing,
        prefixIsProbeOnly: /^obsy-probe\/[a-z0-9-]{1,64}\/$/.test(settings.prefix),
        credentials: {
          accessKeyIdResolved: config.accessKeyId !== '',
          secretAccessKeyResolved: config.secretAccessKey !== '',
        },
        fullSuite: settings.fullSuite,
        vaultIoMiB: settings.vaultIoMiB,
        backgroundSeconds: settings.backgroundSeconds,
      },
      onLoad: this.onLoad,
      lifecycle: {
        msSinceLoad: Math.round(this.lifecycle.elapsed()),
        events: this.lifecycle.events,
        hiddenPeriods: this.lifecycle.hiddenPeriods(),
      },
      sections: { ...this.sections },
      notes: NOTES,
    };
  }

  /** The redacted report as JSON, or the reason it was withheld. */
  reportJson(): { json: string } | { error: string } {
    try {
      return { json: serialiseReport(this.report(), this.sensitive()) };
    } catch (error) {
      return { error: describeError(error) };
    }
  }
}
