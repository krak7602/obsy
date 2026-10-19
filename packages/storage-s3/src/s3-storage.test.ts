import { isPreconditionFailed, isStorageError } from '@obsy/protocol';
import type { StorageError } from '@obsy/protocol';
import {
  createFakeS3,
  describeStorageConformance,
  randomYieldScheduler,
  utf8,
} from '@obsy/storage-testkit';
import type { FakeS3Options, InjectedFault } from '@obsy/storage-testkit';
import { describe, expect, it } from 'vite-plus/test';

import { S3Storage } from './s3-storage';
import type { S3StorageOptions } from './s3-storage';

// Test-only placeholder credentials for the fake endpoint.
const ACCESS_KEY = 'TESTACCESSKEY';
const SECRET_KEY = 'test-secret-key-for-the-fake-endpoint';
const ENDPOINT = 'https://account-id.r2.cloudflarestorage.com';

function setup(
  fakeOptions: Partial<FakeS3Options> = {},
  storageOptions: Partial<S3StorageOptions> = {},
): { storage: S3Storage; fake: ReturnType<typeof createFakeS3> } {
  const fake = createFakeS3({
    bucket: 'scratch',
    accessKeyId: ACCESS_KEY,
    region: 'auto',
    ...fakeOptions,
  });
  const storage = new S3Storage({
    endpoint: ENDPOINT,
    bucket: 'scratch',
    region: 'auto',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    fetch: fake.fetch,
    ...storageOptions,
  });
  return { storage, fake };
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

const bytes = (text: string): Uint8Array => utf8(text);

// ---------------------------------------------------------------------------
// The full conformance suite, through the S3 adapter and the fake endpoint.

let counter = 0;
const shared = setup();
describeStorageConformance({
  name: 'S3Storage + fake S3 (path-style, R2 endpoint shape)',
  create: (label) => shared.storage.withPrefix(`run/${label}-${counter++}/`),
});

describeStorageConformance({
  name: 'S3Storage + fake S3 (virtual-hosted, 2-key pages, random interleaving)',
  create: () =>
    setup(
      { addressing: 'virtual', maxKeysCap: 2, memory: { scheduler: randomYieldScheduler(9) } },
      { addressing: 'virtual', prefix: 'vaults/main/' },
    ).storage,
  race: { createWriters: 8, createRounds: 10, logWriters: 4, commitsPerWriter: 8, listLimit: 3 },
});

describeStorageConformance({
  name: 'S3Storage + fake S3 that ignores encoding-type=url',
  create: () => setup({ ignoreEncodingType: true }).storage,
  race: { createRounds: 3, commitsPerWriter: 3 },
});

// ---------------------------------------------------------------------------
// Request shape.

describe('S3Storage requests', () => {
  it('uses path-style URLs with encoded keys under the root prefix', async () => {
    const { storage, fake } = setup({}, { prefix: 'vaults/v1/' });
    await storage.putIfAbsent('notes/a b+c.md', bytes('x'), 'text/markdown');
    const request = fake.requests[0];
    expect(request?.url).toBe(
      'https://account-id.r2.cloudflarestorage.com/scratch/vaults/v1/notes/a%20b%2Bc.md',
    );
    expect(request?.key).toBe('vaults/v1/notes/a b+c.md');
  });

  it('uses virtual-hosted URLs when asked', async () => {
    const { storage, fake } = setup({ addressing: 'virtual' }, { addressing: 'virtual' });
    await storage.get('k');
    expect(fake.requests[0]?.url).toBe('https://scratch.account-id.r2.cloudflarestorage.com/k');
  });

  it('signs with SigV4 for region auto and signs the payload hash', async () => {
    const { storage, fake } = setup();
    await storage.putIfAbsent('log/0000000000000001.json', bytes('{}'), 'application/json');
    const headers = fake.requests[0]?.headers ?? {};
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=TESTACCESSKEY\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]*if-none-match[a-z0-9;-]*, Signature=[0-9a-f]{64}$/,
    );
    expect(headers['x-amz-content-sha256']).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers['if-none-match']).toBe('*');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['host']).toBeUndefined();
  });

  it('sends If-Match with a quoted etag', async () => {
    const { storage, fake } = setup();
    const { etag } = await storage.putIfAbsent('vault.json', bytes('1'), 'application/json');
    expect(etag.startsWith('"')).toBe(false);
    await storage.putIfMatch('vault.json', bytes('2'), etag, 'application/json');
    expect(fake.requests[1]?.headers['if-match']).toBe(`"${etag}"`);
    expect(fake.requests[1]?.headers['if-none-match']).toBeUndefined();
  });

  it('lists with ListObjectsV2, encoding-type=url, prefix, start-after, and max-keys', async () => {
    const { storage, fake } = setup({}, { prefix: 'v/' });
    await storage.list('log/', 'log/0000000000000005.json', 10);
    expect(fake.requests[0]?.query).toEqual({
      'list-type': '2',
      'encoding-type': 'url',
      prefix: 'v/log/',
      'start-after': 'v/log/0000000000000005.json',
      'max-keys': '10',
    });
  });

  it('follows continuation tokens when pages are short, up to the limit', async () => {
    const { storage, fake } = setup({ maxKeysCap: 2 });
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await storage.putIfAbsent(`p/${name}`, bytes(name), 'text/plain');
    }
    fake.requests.length = 0;
    expect(await storage.list('p/', undefined, 3)).toEqual({
      keys: ['p/a', 'p/b', 'p/c'],
      truncated: true,
    });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.query['continuation-token']).toBeDefined();
    expect(fake.requests[1]?.query['start-after']).toBeUndefined();
    expect(await storage.list('p/')).toEqual({
      keys: ['p/a', 'p/b', 'p/c', 'p/d', 'p/e'],
      truncated: false,
    });
  });

  it('rejects an invalid root prefix and endpoint', () => {
    expect(() => setup({}, { prefix: 'no-slash' })).toThrow('end with');
    expect(() => setup({}, { prefix: 'a/../' })).toThrow('segment');
    expect(() => setup({}, { endpoint: 'ftp://host' })).toThrow('http(s) URL');
  });
});

// ---------------------------------------------------------------------------
// Status mapping.

function injecting(fault: InjectedFault, method = 'PUT'): ReturnType<typeof setup> {
  return setup({ inject: (request) => (request.method === method ? fault : undefined) });
}

describe('S3Storage status mapping', () => {
  it('maps 412 to PreconditionFailed', async () => {
    const { storage } = setup();
    await storage.putIfAbsent('k', bytes('1'), 'text/plain');
    const error = await caught(storage.putIfAbsent('k', bytes('2'), 'text/plain'));
    expect(isPreconditionFailed(error)).toBe(true);
    expect(error.status).toBe(412);
    expect(error.code).toBe('PreconditionFailed');
  });

  it('maps 404 NoSuchKey on putIfMatch to PreconditionFailed', async () => {
    const { storage } = setup();
    const error = await caught(storage.putIfMatch('missing', bytes('2'), 'abc', 'text/plain'));
    expect(isPreconditionFailed(error)).toBe(true);
    expect(error.status).toBe(404);
  });

  it('maps 409 ConditionalRequestConflict to a transient error that did not apply', async () => {
    const { storage } = injecting({ status: 409, code: 'ConditionalRequestConflict' });
    const error = await caught(storage.putIfAbsent('k', bytes('1'), 'text/plain'));
    expect(error.kind).toBe('transient');
    expect(error.code).toBe('ConditionalRequestConflict');
    expect(error.mayHaveApplied).toBe(false);
  });

  it('maps 429 to a transient error with Retry-After', async () => {
    const { storage } = injecting({
      status: 429,
      code: 'TooManyRequests',
      headers: { 'Retry-After': '2' },
    });
    const error = await caught(storage.putIfAbsent('k', bytes('1'), 'text/plain'));
    expect(error.kind).toBe('transient');
    expect(error.retryAfterMs).toBe(2000);
    expect(error.mayHaveApplied).toBe(false);
  });

  it('maps 503 SlowDown to not applied, and other 5xx on writes to may have applied', async () => {
    const slow = await caught(
      injecting({ status: 503, code: 'SlowDown' }).storage.putIfAbsent('k', bytes(''), 'x/y'),
    );
    expect(slow.kind).toBe('transient');
    expect(slow.mayHaveApplied).toBe(false);

    const internal = await caught(
      injecting({ status: 500, code: 'InternalError', apply: true }).storage.putIfAbsent(
        'k',
        bytes(''),
        'x/y',
      ),
    );
    expect(internal.kind).toBe('transient');
    expect(internal.mayHaveApplied).toBe(true);

    const gateway = await caught(injecting({ status: 502 }, 'GET').storage.get('k'));
    expect(gateway.kind).toBe('transient');
    expect(gateway.mayHaveApplied).toBe(false);
  });

  it('maps 403 and NoSuchBucket to fatal errors', async () => {
    const denied = await caught(
      injecting({ status: 403, code: 'AccessDenied' }, 'GET').storage.get('k'),
    );
    expect(denied.kind).toBe('fatal');
    expect(denied.retryable).toBe(false);

    const { storage } = setup({ bucket: 'other' });
    const missingBucket = await caught(storage.get('k'));
    expect(missingBucket.kind).toBe('fatal');
    expect(missingBucket.code).toBe('NoSuchBucket');
  });

  it('maps network errors and timeouts to transient errors', async () => {
    const network = await caught(
      injecting('network-error').storage.putIfAbsent('k', bytes(''), 'x/y'),
    );
    expect(network.kind).toBe('transient');
    expect(network.code).toBe('NetworkError');
    expect(network.mayHaveApplied).toBe(true);

    const { storage } = setup(
      { inject: (request) => (request.method === 'GET' ? 'hang' : undefined) },
      { timeoutMs: 30 },
    );
    const timeout = await caught(storage.get('k'));
    expect(timeout.kind).toBe('transient');
    expect(timeout.code).toBe('Timeout');
  });

  it('treats a delete of a missing key as success', async () => {
    const { storage } = setup();
    await expect(storage.delete('never')).resolves.toBeUndefined();
  });

  it('never puts credentials or signatures in error messages', async () => {
    const { storage } = injecting({ status: 403, code: 'SignatureDoesNotMatch' }, 'GET');
    const error = await caught(storage.get('k'));
    const text = `${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain('Signature=');
    expect(text).not.toContain('X-Amz-');
    expect(JSON.stringify(storage)).not.toContain(SECRET_KEY);
  });

  it('reports a malformed list response as a fatal error', async () => {
    const fake = setup().fake;
    const storage = new S3Storage({
      endpoint: ENDPOINT,
      bucket: 'scratch',
      region: 'auto',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      fetch: async (url, init) => {
        const response = await fake.fetch(url, init);
        if (init.method !== 'GET') return response;
        return {
          ...response,
          arrayBuffer: () => Promise.resolve(bytes('<ListBucketResult><Contents>').slice().buffer),
        };
      },
    });
    const error = await caught(storage.list(''));
    expect(error.kind).toBe('fatal');
  });
});
