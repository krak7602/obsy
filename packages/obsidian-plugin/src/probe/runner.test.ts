// Runs the probe sections in Node, against the testkit's fake S3 behind a
// fake requestUrl, with in-memory stand-ins for SecretStorage, the vault
// adapter, and localStorage. Node has no IndexedDB, so that section reports
// `unavailable`. Then checks that the report holds no sensitive value.
import { createFakeS3 } from '@obsy/storage-testkit/portable';
import { afterAll, describe, expect, it, vi } from 'vite-plus/test';

import { fakeRequestUrl } from '../testing/fake-request-url';
import type { Timers } from '../transport/request-url-fetch';
import { REPORT_SCHEMA } from './report';
import type { ProbeReport } from './report';
import { ProbeRunner } from './runner';
import type { ProbeHost } from './runner';
import type { SecretStorageLike } from './sections/secrets';
import type { VaultAdapterLike } from './sections/vault-io';
import { normaliseSettings } from './settings';
import type { ProbeSettings } from './settings';
import { KIB } from './util';

// Made-up values in the shape of real ones. None of them is real.
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const BUCKET = 'obsy-probe';
const KEY_ID = 'FAKEKEYID0123456789';
const SECRET = 'fake-secret-access-key-for-tests';
const VAULT = '/Users/someone/Vaults/Scratch probe';

// The probe code uses `window` for timers and crypto, as Obsidian's review rules ask.
vi.stubGlobal('window', globalThis);
afterAll(() => {
  vi.unstubAllGlobals();
});

class MemorySecrets implements SecretStorageLike {
  readonly values = new Map<string, string>();
  setSecret(id: string, secret: string): void {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid ID');
    this.values.set(id, secret);
  }
  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  listSecrets(): string[] {
    return [...this.values.keys()];
  }
}

class MemoryAdapter implements VaultAdapterLike {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.folders.has(path));
  }
  mkdir(path: string): Promise<void> {
    this.folders.add(path);
    return Promise.resolve();
  }
  writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(data.slice(0)));
    return Promise.resolve();
  }
  appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    const old = this.files.get(path) ?? new Uint8Array();
    const next = new Uint8Array(old.length + data.byteLength);
    next.set(old);
    next.set(new Uint8Array(data), old.length);
    this.files.set(path, next);
    return Promise.resolve();
  }
  readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (file === undefined) return Promise.reject(new Error(`ENOENT: ${VAULT}/${path}`));
    return Promise.resolve(file.slice().buffer);
  }
  stat(path: string): Promise<{ size: number } | null> {
    const file = this.files.get(path);
    return Promise.resolve(file === undefined ? null : { size: file.length });
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  rmdir(path: string): Promise<void> {
    for (const name of this.files.keys()) if (name.startsWith(`${path}/`)) this.files.delete(name);
    this.folders.delete(path);
    return Promise.resolve();
  }
}

const timers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

function world() {
  const fake = createFakeS3({ bucket: BUCKET, accessKeyId: KEY_ID, region: 'auto' });
  const secrets = new MemorySecrets();
  secrets.setSecret('r2-key-id', KEY_ID);
  secrets.setSecret('r2-secret', SECRET);
  const adapter = new MemoryAdapter();
  const local = new Map<string, unknown>();
  let settings: ProbeSettings = normaliseSettings({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    accessKeyIdSecret: 'r2-key-id',
    secretAccessKeySecret: 'r2-secret',
  });
  const host = (): ProbeHost => ({
    probeVersion: '0.0.0-test',
    settings: () => settings,
    saveSettings: (next) => {
      settings = next;
      return Promise.resolve();
    },
    secrets,
    requestUrl: fakeRequestUrl(fake.fetch, {
      // Slow enough that the 1 ms client-side timeout fires first.
      delayMs: (param) => (param.url.includes('timeout-probe') ? 50 : 0),
    }).requestUrl,
    // The global fetch fails like a CORS rejection, with the URL in the message.
    globalFetch: (url) => Promise.reject(new TypeError(`Load failed: ${url}`)),
    adapter,
    readPluginData: () => Promise.resolve(JSON.stringify(settings)),
    countInLocalStorage: (value) =>
      [...local.values()].filter((item) => JSON.stringify(item).includes(value)).length +
      [...secrets.values.values()].filter((item) => item.includes(value)).length,
    localStore: {
      load: (key) => local.get(key) ?? null,
      save: (key, value) => {
        if (value === null) local.delete(key);
        else local.set(key, value);
      },
    },
    environment: () => ({
      apiVersion: '1.14.4',
      resourceUrl: `app://0123abcd/${VAULT}/`,
      note: `vault at ${VAULT}`,
    }),
    vaultPaths: () => [VAULT],
    timers,
    visibility: () => 'visible',
    sizes: {
      hashing: { sizes: [KIB, 64 * KIB], minTotalMs: 1 },
      binarySizes: [0, 256, 64 * KIB],
      vaultIoBytes: 3 * 64 * KIB + 5,
      backgroundBigBytes: 4 * KIB,
      abandonedWaitMs: 2000,
    },
  });
  return { fake, secrets, adapter, local, host, settings: () => settings };
}

function sectionData<T>(report: ProbeReport, id: keyof ProbeReport['sections']): T {
  return report.sections[id]?.data as T;
}

describe('ProbeRunner', () => {
  const w = world();
  const runner = new ProbeRunner(w.host());
  let json = '';

  it('runs every section', { timeout: 60_000 }, async () => {
    await runner.checkOnLoad();
    expect(await runner.runAll()).toBe(true);
    const report = runner.report();
    const statuses = Object.fromEntries(
      Object.entries(report.sections).map(([id, result]) => [id, result.status]),
    );
    expect(statuses).toEqual({
      environment: 'passed',
      storage: 'passed',
      hashing: 'passed',
      indexedDb: 'unavailable',
      secretStorage: 'passed',
      vaultIo: 'passed',
      // Node has no IndexedDB, so one of the four markers fails.
      markers: 'failed',
    });
  });

  it('measured storage over the requestUrl adapter and cleaned up', () => {
    const storage = sectionData<{
      transport: { steps: { name: string; passed: boolean }[]; responseHeaderNames: string[] };
      conformance: { failed: number; passed: number };
      createRace: { passed: boolean };
      globalFetch: { works: boolean; code: string };
      cleanup: { remainingKeys: number; deletedKeys: number };
      requests: { latency: Record<string, { count: number }> };
    }>(runner.report(), 'storage');
    expect(storage.transport.steps.filter((step) => !step.passed)).toEqual([]);
    expect(storage.transport.responseHeaderNames).toContain('ETag');
    expect(storage.conformance).toEqual(expect.objectContaining({ failed: 0, passed: 20 }));
    expect(storage.createRace.passed).toBe(true);
    expect(storage.globalFetch).toMatchObject({ works: false, code: 'NetworkError' });
    expect(storage.cleanup.remainingKeys).toBe(0);
    expect(storage.cleanup.deletedKeys).toBeGreaterThan(50);
    expect(Object.keys(storage.requests.latency)).toEqual(
      expect.arrayContaining(['all', 'get', 'list', 'putIfAbsent', 'putIfMatch', 'delete']),
    );
    // Every key was under the run prefix, and cleanup deleted them all.
    expect(w.fake.storage.size).toBe(0);
  });

  it('left no probe file in the vault', () => {
    expect(w.adapter.files.size).toBe(0);
    expect(w.adapter.folders.size).toBe(0);
  });

  it('produces a report without any sensitive value', () => {
    const result = runner.reportJson();
    expect('json' in result).toBe(true);
    json = 'json' in result ? result.json : '';
    const parsed = JSON.parse(json) as ProbeReport;
    expect(parsed.schema).toBe(REPORT_SCHEMA);
    expect(parsed.config).toMatchObject({
      provider: 'r2',
      endpoint: '<endpoint>',
      bucket: '<bucket>',
    });
    for (const value of [
      ACCOUNT,
      'r2.cloudflarestorage.com',
      KEY_ID,
      SECRET,
      VAULT,
      'Scratch probe',
      '/Users/',
      runner.testSecretValue,
      w.settings().prefix,
      w.settings().prefix.slice(0, -1),
    ]) {
      expect({ value, found: json.includes(value) }).toEqual({ value, found: false });
    }
    expect(json).not.toMatch(/(?<![A-Za-z0-9._-])obsy-probe(?![A-Za-z0-9._-])/);
    expect(json).toContain('Load failed: <endpoint>/<bucket>/');
    expect(json).toContain('<vault-path>');
  });

  it('finds the markers after a restart', async () => {
    runner.lifecycle.record('visibilitychange', 'hidden');
    // A new runner with the same stores is what the next plugin load sees.
    const next = new ProbeRunner(w.host());
    await next.checkOnLoad();
    expect(next.onLoad).toMatchObject({
      loadCount: 2,
      localStorage: { found: true, matches: true },
      secretStorage: { found: true, matches: true },
      indexedDb: { found: false },
    });
    expect(next.onLoad['previousSessionLifecycle']).toMatchObject({
      sessionId: runner.sessionId,
      events: [{ type: 'visibilitychange', visibility: 'hidden' }],
    });
  });

  it('runs the background test and records requests', { timeout: 30_000 }, async () => {
    const settings = w.settings();
    await w.host().saveSettings({ ...settings, backgroundSeconds: 10 });
    const background = new ProbeRunner({ ...w.host(), sizes: { ...w.host().sizes } });
    const started = Date.now();
    // Shorten the test: stop the loop after 300 ms by moving the wall clock.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => {
      const value = realNow();
      return value - started > 300 ? value + 60_000 : value;
    });
    try {
      expect(await background.run('background')).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    const data = sectionData<{ requests: number; ownerActionObserved: boolean }>(
      background.report(),
      'background',
    );
    expect(background.report().sections.background?.status).toBe('passed');
    expect(data.requests).toBeGreaterThan(0);
    expect(data.ownerActionObserved).toBe(false);
    expect(w.fake.storage.size).toBe(0);
  });

  it('deletes all probe data', async () => {
    await w.fake.storage.putIfAbsent(
      `${w.settings().prefix}left/over.json`,
      new Uint8Array(),
      'x/y',
    );
    const lines = await runner.deleteProbeData();
    expect(lines.join('\n')).toMatch(/Bucket: 1 keys deleted/);
    expect(w.fake.storage.size).toBe(0);
    expect(w.local.size).toBe(0);
    expect(w.settings().lastMarker).toBeNull();
    expect(w.secrets.getSecret('obsy-probe-marker')).toBe('');
  });
});
