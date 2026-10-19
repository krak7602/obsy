import {
  InvalidKey,
  MAX_LIST_LIMIT,
  PreconditionFailed,
  StorageError,
  TransientStorageError,
  checkStorageKey,
  checkStoragePrefix,
} from '@obsy/protocol';
import type { ListResult, PutResult, Storage, StoredObject } from '@obsy/protocol';
import { AwsV4Signer } from 'aws4fetch';

import {
  decodeListValue,
  encodeKeyPath,
  encodeQuery,
  encodeRfc3986,
  quoteEtag,
  unquoteEtag,
} from './encoding';
import { decodeUtf8, globalFetch, sha256Hex, web } from './web';
import type { FetchLike, FetchResponseLike } from './web';
import { XmlParseError, childText, parseXml } from './xml';

export interface S3StorageOptions {
  /**
   * Service endpoint without the bucket, for example
   * `https://<account-id>.r2.cloudflarestorage.com` for R2 or
   * `https://s3.<region>.amazonaws.com` for AWS S3.
   */
  endpoint: string;
  bucket: string;
  /** Signing region. Use `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary credentials. */
  sessionToken?: string;
  /**
   * Root prefix for every key, for example the vault prefix `vaults/main/`.
   * Empty, or ending in `/`.
   */
  prefix?: string;
  /** `path` (default): `<endpoint>/<bucket>/<key>`. `virtual`: `<bucket>.<host>/<key>`. */
  addressing?: 'path' | 'virtual';
  /** Transport. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Time limit for one request, including its body. Default 30,000 ms. */
  timeoutMs?: number;
}

type Operation = 'get' | 'putIfAbsent' | 'putIfMatch' | 'list' | 'delete';

const WRITE_OPERATIONS = new Set<Operation>(['putIfAbsent', 'putIfMatch', 'delete']);

interface Reply {
  status: number;
  headers: FetchResponseLike['headers'];
  body: Uint8Array;
}

/**
 * `Storage` over the S3 API, signed with SigV4 by `aws4fetch`.
 *
 * - `putIfAbsent` sends `If-None-Match: *`; `putIfMatch` sends `If-Match`.
 * - 412 becomes `PreconditionFailed`. A 404 on `putIfMatch` (AWS: the key was
 *   deleted or never existed) also becomes `PreconditionFailed`.
 * - 409, 429, 503, other 5xx, timeouts, and network errors become
 *   `TransientStorageError`. The adapter does not retry; the caller decides.
 * - Payloads are signed (`x-amz-content-sha256` is the body's SHA-256).
 * - Lists use ListObjectsV2 with `encoding-type=url` and follow continuation
 *   tokens until `limit` keys are collected.
 *
 * Credentials stay in private fields. Errors carry the operation, the key,
 * the status, and the provider error code, never headers or signed URLs.
 */
export class S3Storage implements Storage {
  readonly #endpoint: { scheme: string; host: string; basePath: string };
  readonly #bucket: string;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken: string | undefined;
  readonly #prefix: string;
  readonly #addressing: 'path' | 'virtual';
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #signingCache = new Map<string, ArrayBuffer>();

  constructor(options: S3StorageOptions) {
    const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/.exec(options.endpoint.trim());
    if (match === null) {
      throw new TypeError(
        'S3 endpoint must be an http(s) URL without a query, for example https://host',
      );
    }
    this.#endpoint = {
      scheme: match[1] ?? 'https',
      host: match[2] ?? '',
      basePath: (match[3] ?? '').replace(/\/+$/, ''),
    };
    if (options.bucket.length === 0 || options.bucket.includes('/')) {
      throw new TypeError('S3 bucket must be a bucket name without "/"');
    }
    const prefix = options.prefix ?? '';
    if (prefix !== '') {
      checkStoragePrefix(prefix);
      if (!prefix.endsWith('/')) throw new InvalidKey('Root prefix must end with "/"');
      checkStorageKey(prefix.slice(0, -1));
    }
    const fetch = options.fetch ?? globalFetch();
    if (fetch === undefined) throw new TypeError('No fetch available; pass options.fetch');
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#accessKeyId = options.accessKeyId;
    this.#secretAccessKey = options.secretAccessKey;
    this.#sessionToken = options.sessionToken;
    this.#prefix = prefix;
    this.#addressing = options.addressing ?? 'path';
    this.#fetch = fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** The root prefix that this adapter adds to every key. */
  get prefix(): string {
    return this.#prefix;
  }

  /** A new adapter with the same settings, rooted at `<prefix><subPrefix>`. */
  withPrefix(subPrefix: string): S3Storage {
    return new S3Storage({
      endpoint: `${this.#endpoint.scheme}://${this.#endpoint.host}${this.#endpoint.basePath}`,
      bucket: this.#bucket,
      region: this.#region,
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
      ...(this.#sessionToken === undefined ? {} : { sessionToken: this.#sessionToken }),
      prefix: this.#prefix + subPrefix,
      addressing: this.#addressing,
      fetch: this.#fetch,
      timeoutMs: this.#timeoutMs,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const fullKey = this.#fullKey(key);
    const reply = await this.#send('get', key, 'GET', this.#objectUrl(fullKey), {});
    if (reply.status === 404) {
      const code = errorCode(reply.body);
      if (code === undefined || code === 'NoSuchKey') return null;
      throw this.#error('get', key, reply, code);
    }
    if (reply.status !== 200) throw this.#error('get', key, reply);
    return { body: reply.body, etag: this.#etagOf('get', key, reply) };
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    const fullKey = this.#fullKey(key);
    const reply = await this.#send(
      'putIfAbsent',
      key,
      'PUT',
      this.#objectUrl(fullKey),
      { 'content-type': contentType, 'if-none-match': '*' },
      body,
    );
    if (reply.status === 200) return { etag: this.#etagOf('putIfAbsent', key, reply) };
    throw this.#error('putIfAbsent', key, reply);
  }

  async putIfMatch(
    key: string,
    body: Uint8Array,
    etag: string,
    contentType: string,
  ): Promise<PutResult> {
    const fullKey = this.#fullKey(key);
    const reply = await this.#send(
      'putIfMatch',
      key,
      'PUT',
      this.#objectUrl(fullKey),
      { 'content-type': contentType, 'if-match': quoteEtag(etag) },
      body,
    );
    if (reply.status === 200) return { etag: this.#etagOf('putIfMatch', key, reply) };
    if (reply.status === 404) {
      const code = errorCode(reply.body);
      if (code === undefined || code === 'NoSuchKey') {
        throw new PreconditionFailed(`putIfMatch ${key}: the key does not exist`, {
          status: 404,
          code: code ?? 'NoSuchKey',
        });
      }
    }
    throw this.#error('putIfMatch', key, reply);
  }

  async list(prefix: string, startAfter?: string, limit?: number): Promise<ListResult> {
    checkStoragePrefix(prefix);
    const wanted = normaliseLimit(limit);
    const keys: string[] = [];
    let token: string | undefined;
    for (;;) {
      const query = encodeQuery({
        'list-type': '2',
        prefix: this.#prefix + prefix,
        'max-keys': String(Math.min(wanted - keys.length, MAX_LIST_LIMIT)),
        'encoding-type': 'url',
        'start-after':
          token === undefined && startAfter !== undefined && startAfter !== ''
            ? this.#prefix + startAfter
            : undefined,
        'continuation-token': token,
      });
      const reply = await this.#send('list', prefix, 'GET', `${this.#bucketUrl()}?${query}`, {});
      if (reply.status !== 200) throw this.#error('list', prefix, reply);
      const page = this.#parseListPage(prefix, reply.body);
      for (const fullKey of page.keys) {
        if (!fullKey.startsWith(this.#prefix)) {
          throw new StorageError('fatal', `list ${prefix}: key outside the root prefix`);
        }
        keys.push(fullKey.slice(this.#prefix.length));
      }
      if (keys.length > wanted) return { keys: keys.slice(0, wanted), truncated: true };
      if (!page.truncated) return { keys, truncated: false };
      if (keys.length === wanted) return { keys, truncated: true };
      if (page.nextToken === undefined) {
        throw new StorageError(
          'fatal',
          `list ${prefix}: truncated page without a continuation token`,
        );
      }
      token = page.nextToken;
    }
  }

  async delete(key: string): Promise<void> {
    const fullKey = this.#fullKey(key);
    const reply = await this.#send('delete', key, 'DELETE', this.#objectUrl(fullKey), {});
    // S3 returns 204 whether or not the key existed. Accept 404 from
    // providers that report a missing key.
    if (reply.status === 204 || reply.status === 200) return;
    if (reply.status === 404 && (errorCode(reply.body) ?? 'NoSuchKey') === 'NoSuchKey') return;
    throw this.#error('delete', key, reply);
  }

  #fullKey(key: string): string {
    checkStorageKey(key);
    const fullKey = this.#prefix + key;
    checkStorageKey(fullKey);
    return fullKey;
  }

  #bucketUrl(): string {
    const { scheme, host, basePath } = this.#endpoint;
    return this.#addressing === 'path'
      ? `${scheme}://${host}${basePath}/${encodeRfc3986(this.#bucket)}`
      : `${scheme}://${this.#bucket}.${host}${basePath}`;
  }

  #objectUrl(fullKey: string): string {
    return `${this.#bucketUrl()}/${encodeKeyPath(fullKey)}`;
  }

  #etagOf(operation: Operation, key: string, reply: Reply): string {
    const header = reply.headers.get('etag');
    if (header === null || unquoteEtag(header) === '') {
      throw new StorageError('fatal', `${operation} ${key}: response has no ETag`, {
        status: reply.status,
      });
    }
    return unquoteEtag(header);
  }

  #parseListPage(
    prefix: string,
    body: Uint8Array,
  ): { keys: string[]; truncated: boolean; nextToken: string | undefined } {
    try {
      const root = parseXml(decodeUtf8(body));
      if (root.name !== 'ListBucketResult') {
        throw new XmlParseError(`Unexpected root element <${root.name}>`);
      }
      const encoded = childText(root, 'EncodingType') === 'url';
      const keys = root.children
        .filter((child) => child.name === 'Contents')
        .map((contents) => {
          const raw = childText(contents, 'Key');
          if (raw === undefined) throw new XmlParseError('<Contents> without <Key>');
          return encoded ? decodeListValue(raw) : raw;
        });
      const truncated = (childText(root, 'IsTruncated') ?? 'false').trim() === 'true';
      const nextToken = childText(root, 'NextContinuationToken');
      return { keys, truncated, nextToken: nextToken === '' ? undefined : nextToken };
    } catch (error) {
      throw new StorageError('fatal', `list ${prefix}: cannot parse the ListObjectsV2 response`, {
        cause: error,
      });
    }
  }

  async #send(
    operation: Operation,
    key: string,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Reply> {
    const payload = body ?? new Uint8Array();
    const signer = new AwsV4Signer({
      method,
      url,
      headers: { ...headers, 'x-amz-content-sha256': await sha256Hex(payload) },
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
      ...(this.#sessionToken === undefined ? {} : { sessionToken: this.#sessionToken }),
      service: 's3',
      region: this.#region,
      cache: this.#signingCache,
    });
    const signed = (await signer.sign()) as unknown as {
      headers: { forEach(callback: (value: string, name: string) => void): void };
    };
    const signedHeaders: Record<string, string> = {};
    signed.headers.forEach((value, name) => {
      signedHeaders[name] = value;
    });

    const controller = web.AbortController === undefined ? undefined : new web.AbortController();
    let timedOut = false;
    let timer: unknown;
    const deadline = new Promise<never>((_, reject) => {
      timer = web.setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(new Error('timeout'));
      }, this.#timeoutMs);
    });
    const mayHaveApplied = WRITE_OPERATIONS.has(operation);
    try {
      const response = await Promise.race([
        this.#fetch(url, {
          method,
          headers: signedHeaders,
          ...(body === undefined ? {} : { body }),
          ...(controller === undefined ? {} : { signal: controller.signal }),
        }),
        deadline,
      ]);
      const bytes = await Promise.race([response.arrayBuffer(), deadline]);
      return { status: response.status, headers: response.headers, body: new Uint8Array(bytes) };
    } catch (error) {
      if (timedOut) {
        throw new TransientStorageError(
          `${operation} ${key}: timed out after ${this.#timeoutMs} ms`,
          {
            code: 'Timeout',
            mayHaveApplied,
          },
        );
      }
      throw new TransientStorageError(`${operation} ${key}: network error`, {
        code: 'NetworkError',
        mayHaveApplied,
        cause: error,
      });
    } finally {
      web.clearTimeout(timer);
    }
  }

  #error(operation: Operation, key: string, reply: Reply, knownCode?: string): StorageError {
    const status = reply.status;
    const code = knownCode ?? errorCode(reply.body);
    const label = `${operation} ${key}: HTTP ${status}${code === undefined ? '' : ` ${code}`}`;
    const details = { status, ...(code === undefined ? {} : { code }) };
    const write = WRITE_OPERATIONS.has(operation);

    if (status === 412) return new PreconditionFailed(label, details);
    if (status === 409 || status === 429 || (status === 503 && code === 'SlowDown')) {
      // Rejected before it applied: a conflicting concurrent request (AWS
      // ConditionalRequestConflict or OperationAborted) or a rate limit.
      const retryAfterMs = retryAfter(reply.headers.get('retry-after'));
      return new TransientStorageError(label, {
        ...details,
        mayHaveApplied: false,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    if (status === 400 && code === 'RequestTimeout') {
      return new TransientStorageError(label, { ...details, mayHaveApplied: false });
    }
    if (status >= 500) {
      const retryAfterMs = retryAfter(reply.headers.get('retry-after'));
      return new TransientStorageError(label, {
        ...details,
        mayHaveApplied: write,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    return new StorageError('fatal', label, details);
  }
}

function normaliseLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`List limit must be a positive integer, got ${limit}`);
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

/** The `<Code>` of an S3 XML error body, or `undefined`. */
function errorCode(body: Uint8Array): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const root = parseXml(decodeUtf8(body));
    return root.name === 'Error' ? childText(root, 'Code')?.trim() : undefined;
  } catch {
    return undefined;
  }
}

function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
