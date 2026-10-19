import { isPreconditionFailed, isStorageError } from '@obsy/protocol';
import type { StorageError } from '@obsy/protocol';
import { S3Storage } from '@obsy/storage-s3';
import type { S3StorageOptions } from '@obsy/storage-s3';
import { createFakeS3, describeStorageConformance, utf8 } from '@obsy/storage-testkit';
import type { FakeS3Options } from '@obsy/storage-testkit';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { describe, expect, it } from 'vite-plus/test';

import { fakeRequestUrl } from '../testing/fake-request-url';
import type { FakeRequestUrlOptions } from '../testing/fake-request-url';
import { createRequestUrlFetch, toArrayBuffer } from './request-url-fetch';
import type { RequestUrlFetchOptions, Timers, TransportEvent } from './request-url-fetch';

// Test-only placeholder credentials for the fake endpoint.
const ACCESS_KEY = 'TESTACCESSKEY';
const SECRET_KEY = 'test-secret-key-for-the-fake-endpoint';
const ENDPOINT = 'https://account-id.r2.cloudflarestorage.com';

const timers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

function setup(
  fakeOptions: Partial<FakeS3Options> = {},
  transportOptions: RequestUrlFetchOptions & FakeRequestUrlOptions = {},
  storageOptions: Partial<S3StorageOptions> = {},
) {
  const fake = createFakeS3({
    bucket: 'scratch',
    accessKeyId: ACCESS_KEY,
    region: 'auto',
    ...fakeOptions,
  });
  const fakeUrl = fakeRequestUrl(fake.fetch, transportOptions);
  const events: TransportEvent[] = [];
  const transport = createRequestUrlFetch(fakeUrl.requestUrl, {
    timers,
    observer: (event) => events.push(event),
    ...transportOptions,
  });
  const storage = new S3Storage({
    endpoint: ENDPOINT,
    bucket: 'scratch',
    region: 'auto',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetch: transport,
    ...storageOptions,
  });
  return { fake, params: fakeUrl.params, transport, storage, events };
}

async function caught(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise;
  } catch (error) {
    if (isStorageError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** A `requestUrl` that resolves only when the test says so. */
function deferredRequestUrl() {
  const calls: { param: RequestUrlParam; resolve: (response: RequestUrlResponse) => void }[] = [];
  const requestUrl = (param: RequestUrlParam): Promise<RequestUrlResponse> =>
    new Promise((resolve) => {
      calls.push({ param, resolve });
    });
  return { requestUrl, calls };
}

function okResponse(): RequestUrlResponse {
  return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: null, text: '' };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The full conformance suite through S3Storage, the adapter, and the fake S3.

let counter = 0;
const shared = setup();
describeStorageConformance({
  name: 'S3Storage + requestUrl adapter + fake S3',
  create: (label) => shared.storage.withPrefix(`run/${label}-${counter++}/`),
});

describeStorageConformance({
  name: 'S3Storage + requestUrl adapter (contentType param, lower-case headers) + fake S3',
  create: () => setup({}, { contentType: 'param', lowerCaseHeaders: true }).storage,
  race: { createRounds: 5, commitsPerWriter: 4 },
});

describeStorageConformance({
  name: 'S3Storage + requestUrl adapter that throws for 400+ despite throw: false',
  create: () => setup({}, { ignoreThrowFalse: true }).storage,
  race: { createRounds: 5, commitsPerWriter: 4 },
});

// ---------------------------------------------------------------------------

describe('createRequestUrlFetch', () => {
  it('sends every signed header unchanged and sets throw: false', async () => {
    const { storage, params } = setup();
    await storage.putIfAbsent('a.json', utf8('{}'), 'application/json');
    const created = await storage.get('a.json');
    await storage.putIfMatch('a.json', utf8('{"b":1}'), created?.etag ?? '', 'application/json');

    const [create, , match] = params;
    expect(create?.throw).toBe(false);
    expect(create?.method).toBe('PUT');
    expect(create?.contentType).toBeUndefined();
    expect(create?.headers).toMatchObject({
      'content-type': 'application/json',
      'if-none-match': '*',
    });
    expect(Object.keys(create?.headers ?? {})).toEqual(
      expect.arrayContaining(['authorization', 'x-amz-date', 'x-amz-content-sha256']),
    );
    expect(create?.headers?.['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=TESTACCESSKEY\//,
    );
    expect(match?.headers?.['if-match']).toBe(`"${created?.etag}"`);
    expect(params.every((param) => param.throw === false)).toBe(true);
    // The transport sets Host itself.
    expect(params.every((param) => !('host' in (param.headers ?? {})))).toBe(true);
  });

  it('moves content-type to the contentType parameter in param mode', async () => {
    const { storage, params } = setup({}, { contentType: 'param' });
    await storage.putIfAbsent('a.txt', utf8('x'), 'text/plain');
    expect(params[0]?.contentType).toBe('text/plain');
    expect(params[0]?.headers?.['content-type']).toBeUndefined();
  });

  it('sends and receives binary bodies byte-exact, also from a subarray', async () => {
    const { storage, params } = setup();
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    const view = all.subarray(100, 140);
    await storage.putIfAbsent('bin', view, 'application/octet-stream');
    const body = params[0]?.body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([...view]);
    const read = await storage.get('bin');
    expect([...(read?.body ?? [])]).toEqual([...view]);
  });

  it('sends an empty ArrayBuffer for an empty PUT and no body for GET', async () => {
    const { storage, params } = setup();
    await storage.putIfAbsent('empty', new Uint8Array(), 'application/octet-stream');
    await storage.get('empty');
    expect((params[0]?.body as ArrayBuffer | undefined)?.byteLength).toBe(0);
    expect(params[1]?.body).toBeUndefined();
  });

  it('does not copy a body that fills its whole buffer', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toArrayBuffer(bytes)).toBe(bytes.buffer);
    expect(toArrayBuffer(bytes.subarray(1))).not.toBe(bytes.buffer);
  });

  it('returns 412 and 404 as responses with readable bodies', async () => {
    const { storage, events } = setup();
    await storage.putIfAbsent('k', utf8('1'), 'text/plain');
    const conflict = await caught(storage.putIfAbsent('k', utf8('2'), 'text/plain'));
    expect(isPreconditionFailed(conflict)).toBe(true);
    expect(conflict.code).toBe('PreconditionFailed');
    expect(await storage.get('missing')).toBeNull();
    const missingMatch = await caught(
      storage.putIfMatch('missing', utf8('x'), 'abc', 'text/plain'),
    );
    expect(missingMatch.code).toBe('NoSuchKey');
    expect(events.map((event) => [event.outcome, event.status])).toEqual([
      ['response', 200],
      ['response', 412],
      ['response', 404],
      ['response', 404],
    ]);
    expect(events[1]?.responseBytes).toBeGreaterThan(0);
  });

  it('reads response headers without regard to case', async () => {
    const { storage, events } = setup();
    const created = await storage.putIfAbsent('k', utf8('1'), 'text/plain');
    expect(created.etag.length).toBeGreaterThan(0);
    expect(events[0]?.headerNames).toContain('ETag');
  });

  it.each(['header', 'param'] as const)(
    'stores the content type sent in %s mode, and reports it on GET',
    async (mode) => {
      const { storage, events } = setup({}, { contentType: mode });
      await storage.putIfAbsent('k', utf8('1'), 'application/x-obsy-probe');
      await storage.get('k');
      expect(events[1]?.responseContentType).toBe('application/x-obsy-probe');
    },
  );

  it.each([
    [409, 'ConditionalRequestConflict', false],
    [429, 'TooManyRequests', false],
    [503, 'SlowDown', false],
    [500, 'InternalError', true],
  ])('surfaces %i %s with its body and Retry-After', async (status, code, mayHaveApplied) => {
    const { storage } = setup({
      inject: (request) =>
        request.method === 'PUT' ? { status, code, headers: { 'Retry-After': '2' } } : undefined,
    });
    const error = await caught(storage.putIfAbsent('k', utf8('1'), 'text/plain'));
    expect(error.kind).toBe('transient');
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.retryAfterMs).toBe(2000);
    expect(error.mayHaveApplied).toBe(mayHaveApplied);
  });

  it('makes a response of an error that carries a status', async () => {
    const { storage, transport, events } = setup({}, { ignoreThrowFalse: true });
    await storage.putIfAbsent('k', utf8('1'), 'text/plain');
    const error = await caught(storage.putIfAbsent('k', utf8('2'), 'text/plain'));
    expect(isPreconditionFailed(error)).toBe(true);
    expect(error.code).toBe('PreconditionFailed');
    expect(transport.stats.thrownStatus).toBe(1);
    expect(events[1]?.outcome).toBe('thrown-status');
  });

  it('maps a thrown error without a status to a network error', async () => {
    const { storage, transport } = setup({ inject: () => 'network-error' });
    const error = await caught(storage.get('k'));
    expect(error.code).toBe('NetworkError');
    expect(transport.stats.networkErrors).toBe(1);
  });

  it('times out on the client and counts the abandoned request when it settles', async () => {
    const deferred = deferredRequestUrl();
    const events: TransportEvent[] = [];
    const transport = createRequestUrlFetch(deferred.requestUrl, {
      timers,
      timeoutMs: 20,
      observer: (event) => events.push(event),
    });
    await expect(transport('https://host/b/k', { method: 'GET', headers: {} })).rejects.toThrow(
      /did not settle within 20 ms/,
    );
    expect(transport.stats).toMatchObject({ timeouts: 1, pending: 1, abandonedSettled: 0 });
    expect(events[0]?.outcome).toBe('timeout');
    deferred.calls[0]?.resolve(okResponse());
    await sleep(0);
    expect(transport.stats).toMatchObject({ pending: 0, abandonedSettled: 1, responses: 0 });
  });

  it('gives up on abort, but the underlying request keeps running', async () => {
    const deferred = deferredRequestUrl();
    const transport = createRequestUrlFetch(deferred.requestUrl, { timers, timeoutMs: 0 });
    const controller = new AbortController();
    const pending = transport('https://host/b/k', {
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.stats).toMatchObject({ aborts: 1, pending: 1 });
    deferred.calls[0]?.resolve(okResponse());
    await sleep(0);
    expect(transport.stats.abandonedSettled).toBe(1);
  });

  it('rejects at once when the signal has already aborted', async () => {
    const deferred = deferredRequestUrl();
    const transport = createRequestUrlFetch(deferred.requestUrl, { timers });
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport('https://host/b/k', { method: 'GET', headers: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deferred.calls).toHaveLength(0);
  });

  it('gives S3Storage a timeout through its own timer and signal', async () => {
    const { storage, transport } = setup(
      { inject: () => 'hang' },
      { timeoutMs: 0 },
      { timeoutMs: 20 },
    );
    const error = await caught(storage.putIfAbsent('k', utf8('1'), 'text/plain'));
    expect(error.code).toBe('Timeout');
    expect(error.mayHaveApplied).toBe(true);
    expect(transport.stats.aborts).toBe(1);
  });
});
