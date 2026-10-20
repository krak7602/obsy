// `Storage` over the live-run Worker: one HTTPS request per call. The
// adapter under test, `R2Storage`, runs in the Worker; this client only
// carries calls and rebuilds the adapter's errors. Failures between this
// client and the Worker are transient with a `worker-` code, so that the
// summary keeps them apart from R2's own errors.
import { StorageError, TransientStorageError } from '@obsy/protocol';
import type { ListResult, PutResult, Storage, StoredObject } from '@obsy/protocol';

import { errorFromWire, fromBase64, toBase64 } from '../live/wire';
import type { WireCall, WireReply } from '../live/wire';

type WithoutRoot<T> = T extends unknown ? Omit<T, 'root'> : never;
/** A call without `root`; the client adds its own. */
type Call = WithoutRoot<WireCall>;

export class WorkerStorage implements Storage {
  readonly #url: string;
  readonly #token: string;
  readonly #root: string;
  readonly #timeoutMs: number;

  constructor(url: string, token: string, root = '', timeoutMs = 30_000) {
    this.#url = url;
    this.#token = token;
    this.#root = root;
    this.#timeoutMs = timeoutMs;
  }

  withPrefix(subPrefix: string): WorkerStorage {
    return new WorkerStorage(this.#url, this.#token, this.#root + subPrefix, this.#timeoutMs);
  }

  /** Sends one call. Throws the adapter's error, or a transient `worker-` error. */
  async #call(call: Call, write: boolean): Promise<unknown> {
    const label = call.op;
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...call, root: this.#root }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new TransientStorageError(`${label}: request to the Worker failed`, {
        code: 'worker-network',
        mayHaveApplied: write,
        cause: error,
      });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      const details = { status: response.status, code: `worker-http-${response.status}` };
      if (response.status === 429 || response.status >= 500) {
        throw new TransientStorageError(`${label}: Worker answered ${response.status}`, {
          ...details,
          mayHaveApplied: write,
        });
      }
      throw new StorageError('fatal', `${label}: Worker answered ${response.status}`, details);
    }
    const reply = (await response.json()) as WireReply;
    if (!reply.ok) throw errorFromWire(reply.error);
    return reply.value;
  }

  async get(key: string): Promise<StoredObject | null> {
    const value = (await this.#call({ op: 'get', key }, false)) as {
      etag: string;
      body: string;
    } | null;
    return value === null ? null : { etag: value.etag, body: fromBase64(value.body) };
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    return (await this.#call(
      { op: 'putIfAbsent', key, body: toBase64(body), contentType },
      true,
    )) as PutResult;
  }

  async putIfMatch(
    key: string,
    body: Uint8Array,
    etag: string,
    contentType: string,
  ): Promise<PutResult> {
    return (await this.#call(
      { op: 'putIfMatch', key, body: toBase64(body), etag, contentType },
      true,
    )) as PutResult;
  }

  async list(prefix: string, startAfter?: string, limit?: number): Promise<ListResult> {
    return (await this.#call(
      {
        op: 'list',
        prefix,
        ...(startAfter === undefined ? {} : { startAfter }),
        ...(limit === undefined ? {} : { limit }),
      },
      false,
    )) as ListResult;
  }

  async delete(key: string): Promise<void> {
    await this.#call({ op: 'delete', key }, true);
  }
}
