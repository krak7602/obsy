import { isPreconditionFailed } from '@obsy/protocol';

import { MemoryStorage } from './memory-storage';
import type { MemoryStorageOptions } from './memory-storage';

/** The request shape that `@obsy/storage-s3` passes to its injected `fetch`. */
export interface FakeS3Init {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  signal?: unknown;
}

/** The response shape that `@obsy/storage-s3` reads. */
export interface FakeS3Response {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** One request as the fake saw it. Header names are lower case. */
export interface FakeS3Request {
  method: string;
  url: string;
  host: string;
  /** Decoded object key, or `null` for bucket requests. */
  key: string | null;
  bucket: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A canned reply from `FakeS3Options.inject`. */
export interface InjectedReply {
  status: number;
  code?: string;
  headers?: Record<string, string>;
  /** Apply the request before replying, to simulate a lost success response. */
  apply?: boolean;
}

export type InjectedFault = InjectedReply | 'network-error' | 'hang';

export interface FakeS3Options {
  bucket: string;
  accessKeyId: string;
  region: string;
  /** `path`: `https://host/<bucket>/<key>`. `virtual`: `https://<bucket>.host/<key>`. */
  addressing?: 'path' | 'virtual';
  /** Largest page that one ListObjectsV2 response holds. Default 1000. */
  maxKeysCap?: number;
  /** Ignore `encoding-type=url`, like a provider that does not support it. */
  ignoreEncodingType?: boolean;
  /** Called for each request; return a fault to replace the normal reply. */
  inject?: (request: FakeS3Request) => InjectedFault | undefined;
  memory?: MemoryStorageOptions;
}

export interface FakeS3 {
  fetch: (url: string, init: FakeS3Init) => Promise<FakeS3Response>;
  requests: FakeS3Request[];
  storage: MemoryStorage;
}

interface CryptoGlobals {
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  TextEncoder: new () => { encode(value: string): Uint8Array };
}

const web = globalThis as unknown as CryptoGlobals;
const encoder = new web.TextEncoder();

/**
 * A fake S3 endpoint behind an injectable `fetch`, backed by `MemoryStorage`.
 *
 * It implements the subset of S3 that `@obsy/storage-s3` uses: GetObject,
 * conditional PutObject, DeleteObject, and ListObjectsV2 with prefix,
 * start-after, max-keys, continuation tokens, and `encoding-type=url`. It
 * checks the shape of SigV4 headers and the payload hash, but it does not
 * verify signatures. The local Docker suite verifies real signatures.
 */
export function createFakeS3(options: FakeS3Options): FakeS3 {
  const storage = new MemoryStorage(options.memory);
  const requests: FakeS3Request[] = [];
  const addressing = options.addressing ?? 'path';
  const cap = options.maxKeysCap ?? 1000;

  const fetch = async (url: string, init: FakeS3Init): Promise<FakeS3Response> => {
    const request = parseRequest(url, init, addressing);
    requests.push(request);

    const fault = options.inject?.(request);
    if (fault === 'network-error') throw new TypeError('fetch failed (injected)');
    if (fault === 'hang') return new Promise<never>(() => {});
    if (fault !== undefined && fault.apply !== true) return errorReply(fault);

    const authProblem = await checkAuth(request, options);
    if (authProblem !== undefined) return xmlError(403, 'SignatureDoesNotMatch', authProblem);
    if (request.bucket !== options.bucket) {
      return xmlError(404, 'NoSuchBucket', 'The specified bucket does not exist');
    }
    const reply = await handle(request);
    return fault === undefined ? reply : errorReply(fault);
  };

  const handle = async (request: FakeS3Request): Promise<FakeS3Response> => {
    const { key, method } = request;
    if (key === null) {
      if (method === 'GET' && request.query['list-type'] === '2') return list(request);
      return xmlError(501, 'NotImplemented', 'Only ListObjectsV2 is implemented');
    }
    if (method === 'GET') {
      const object = await storage.get(key);
      if (object === null) return xmlError(404, 'NoSuchKey', 'The specified key does not exist.');
      return reply(
        200,
        {
          etag: `"${object.etag}"`,
          'content-length': String(object.body.length),
          'content-type': storage.contentTypeOf(key) ?? 'binary/octet-stream',
        },
        object.body,
      );
    }
    if (method === 'DELETE') {
      await storage.delete(key);
      return reply(204, {}, new Uint8Array());
    }
    if (method === 'PUT') {
      const contentType = request.headers['content-type'] ?? 'binary/octet-stream';
      const ifNoneMatch = request.headers['if-none-match'];
      const ifMatch = request.headers['if-match'];
      try {
        if (ifNoneMatch === '*') {
          const { etag } = await storage.putIfAbsent(key, request.body, contentType);
          return reply(200, { etag: `"${etag}"` }, new Uint8Array());
        }
        if (ifMatch !== undefined) {
          const current = await storage.get(key);
          if (current === null) {
            return xmlError(404, 'NoSuchKey', 'The specified key does not exist.');
          }
          const wanted = ifMatch.replace(/^"(.*)"$/, '$1');
          const { etag } = await storage.putIfMatch(key, request.body, wanted, contentType);
          return reply(200, { etag: `"${etag}"` }, new Uint8Array());
        }
      } catch (error) {
        if (isPreconditionFailed(error)) {
          return xmlError(
            412,
            'PreconditionFailed',
            'At least one of the pre-conditions you specified did not hold',
          );
        }
        throw error;
      }
      return xmlError(501, 'NotImplemented', 'The fake accepts only conditional PUT');
    }
    return xmlError(405, 'MethodNotAllowed', `Method ${method} is not allowed`);
  };

  const list = async (request: FakeS3Request): Promise<FakeS3Response> => {
    const query = request.query;
    const prefix = query['prefix'] ?? '';
    const maxKeys = Math.min(Number(query['max-keys'] ?? '1000'), cap);
    const token = query['continuation-token'];
    const startAfter = token === undefined ? query['start-after'] : decodeToken(token);
    const page = await storage.list(prefix, startAfter, Math.max(1, maxKeys));
    const encode = query['encoding-type'] === 'url' && options.ignoreEncodingType !== true;
    const text = (value: string): string => escapeXml(encode ? urlEncodeKey(value) : value);
    const lastKey = page.keys.at(-1);
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Name>${escapeXml(options.bucket)}</Name>`,
      `<Prefix>${text(prefix)}</Prefix>`,
      startAfter === undefined || token !== undefined
        ? ''
        : `<StartAfter>${text(startAfter)}</StartAfter>`,
      `<KeyCount>${page.keys.length}</KeyCount>`,
      `<MaxKeys>${maxKeys}</MaxKeys>`,
      encode ? '<EncodingType>url</EncodingType>' : '',
      `<IsTruncated>${page.truncated}</IsTruncated>`,
      token === undefined ? '' : `<ContinuationToken>${escapeXml(token)}</ContinuationToken>`,
      page.truncated && lastKey !== undefined
        ? `<NextContinuationToken>${escapeXml(encodeToken(lastKey))}</NextContinuationToken>`
        : '',
      ...page.keys.map(
        (key) =>
          `<Contents><Key>${text(key)}</Key><LastModified>2026-10-20T00:00:00.000Z</LastModified>` +
          `<ETag>&quot;0&quot;</ETag><Size>0</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      ),
      '</ListBucketResult>',
    ];
    return reply(200, { 'content-type': 'application/xml' }, encoder.encode(parts.join('')));
  };

  return { fetch, requests, storage };
}

function parseRequest(
  url: string,
  init: FakeS3Init,
  addressing: 'path' | 'virtual',
): FakeS3Request {
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/.exec(url);
  if (match === null) throw new TypeError(`Invalid URL: ${url}`);
  const host = match[2] ?? '';
  const rawPath = match[3] === undefined || match[3] === '' ? '/' : match[3];
  const query: Record<string, string> = {};
  for (const pair of (match[4] ?? '').split('&')) {
    if (pair === '') continue;
    const [name = '', value = ''] = pair.split('=');
    query[decodeURIComponent(name)] = decodeURIComponent(value);
  }
  let bucket: string;
  let rawKey: string;
  if (addressing === 'path') {
    const slash = rawPath.indexOf('/', 1);
    bucket = decodeURIComponent(slash === -1 ? rawPath.slice(1) : rawPath.slice(1, slash));
    rawKey = slash === -1 ? '' : rawPath.slice(slash + 1);
  } else {
    bucket = host.split('.')[0] ?? '';
    rawKey = rawPath.slice(1);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers)) headers[name.toLowerCase()] = value;
  return {
    method: init.method.toUpperCase(),
    url,
    host,
    key: rawKey === '' ? null : decodeURIComponent(rawKey),
    bucket,
    query,
    headers,
    body: init.body ?? new Uint8Array(),
  };
}

async function checkAuth(
  request: FakeS3Request,
  options: FakeS3Options,
): Promise<string | undefined> {
  const auth = request.headers['authorization'];
  if (auth === undefined) return 'Missing Authorization header';
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (match === null) return 'Malformed Authorization header';
  if (match[1] !== options.accessKeyId) return 'Unknown access key';
  if (match[3] !== options.region) return `Wrong region ${match[3]}`;
  const amzDate = request.headers['x-amz-date'];
  if (amzDate === undefined || !/^\d{8}T\d{6}Z$/.test(amzDate)) return 'Missing x-amz-date';
  if (amzDate.slice(0, 8) !== match[2]) return 'Credential date differs from x-amz-date';
  const signed = new Set((match[4] ?? '').split(';'));
  for (const name of ['host', 'x-amz-date', 'x-amz-content-sha256', 'if-none-match', 'if-match']) {
    if ((name === 'host' || request.headers[name] !== undefined) && !signed.has(name)) {
      return `Header ${name} is not signed`;
    }
  }
  const payloadHash = request.headers['x-amz-content-sha256'];
  if (payloadHash === undefined) return 'Missing x-amz-content-sha256';
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== (await sha256Hex(request.body))) {
    return 'x-amz-content-sha256 does not match the body';
  }
  return undefined;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await web.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reply(status: number, headers: Record<string, string>, body: Uint8Array): FakeS3Response {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    arrayBuffer: () => Promise.resolve(body.slice().buffer),
  };
}

function xmlError(status: number, code: string, message: string): FakeS3Response {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message>` +
    '<RequestId>FAKE</RequestId></Error>';
  return reply(status, { 'content-type': 'application/xml' }, encoder.encode(xml));
}

function errorReply(fault: InjectedReply): FakeS3Response {
  if (fault.code === undefined) return reply(fault.status, fault.headers ?? {}, new Uint8Array());
  const response = xmlError(fault.status, fault.code, 'Injected fault');
  const extra = new Map(
    Object.entries(fault.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ...response,
    headers: { get: (name) => extra.get(name.toLowerCase()) ?? response.headers.get(name) },
  };
}

/** Escapes text for XML, with a mix of named and numeric entities. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** AWS-style `encoding-type=url`: percent-encoding with `+` for space. */
function urlEncodeKey(value: string): string {
  return encodeURIComponent(value).replaceAll('%20', '+').replaceAll('%2F', '/');
}

function encodeToken(key: string): string {
  return `t:${encodeURIComponent(key)}`;
}

function decodeToken(token: string): string {
  if (!token.startsWith('t:')) throw new Error(`Bad continuation token ${token}`);
  return decodeURIComponent(token.slice(2));
}
