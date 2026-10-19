// A `FetchLike` for `@obsy/storage-s3` that sends requests through Obsidian's
// `requestUrl`, which has no CORS restrictions on desktop or mobile.
//
// `requestUrl` has no timeout and no abort. This adapter adds a client-side
// timeout and honours an abort signal, but it cannot cancel the underlying
// request: the request keeps running, and its result is ignored. `stats`
// counts these abandoned requests and when they settle.
//
// The module imports only types from `obsidian`, so Node tests can load it.
import type { FetchLike, FetchRequestInit, FetchResponseLike } from '@obsy/storage-s3';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

/** The `requestUrl` function, or a fake with the same shape. */
export type RequestUrlFunction = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

/** Timer functions. In Obsidian this is `window`. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** How a request ended, as seen by the adapter. */
export type TransportOutcome =
  /** `requestUrl` resolved with a response. */
  | 'response'
  /** `requestUrl` threw an error that carried a status; the adapter made a response of it. */
  | 'thrown-status'
  /** `requestUrl` threw an error without a status. */
  | 'network-error'
  /** The client-side timeout fired. The request was abandoned, not cancelled. */
  | 'timeout'
  /** The caller's signal aborted. The request was abandoned, not cancelled. */
  | 'aborted';

/** One finished request. Do not store `url`: it holds the endpoint and bucket. */
export interface TransportEvent {
  method: string;
  url: string;
  outcome: TransportOutcome;
  /** Present for `response` and `thrown-status`. */
  status?: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  /** Request header names as sent, without values. */
  requestHeaderNames: string[];
  /** Response header names exactly as `requestUrl` returned them. */
  headerNames: string[];
  /** The response `content-type` value, or `null`. */
  responseContentType: string | null;
}

export interface TransportStats {
  started: number;
  responses: number;
  /** Errors thrown by `requestUrl` that carried a status, although `throw: false` was set. */
  thrownStatus: number;
  networkErrors: number;
  timeouts: number;
  aborts: number;
  /** Timed out or aborted requests whose `requestUrl` call later settled. */
  abandonedSettled: number;
  /** Requests whose `requestUrl` call has not settled yet. */
  pending: number;
}

export interface RequestUrlFetchOptions {
  /** Client-side time limit for one request. Default 30,000 ms. 0 turns it off. */
  timeoutMs?: number;
  /**
   * How to pass the `content-type` header. `header` (default) sends every
   * header unchanged. `param` moves it to `RequestUrlParam.contentType`.
   */
  contentType?: 'header' | 'param';
  /** Called once per request when the adapter returns or throws. */
  observer?: (event: TransportEvent) => void;
  /** Defaults to `window`. */
  timers?: Timers;
  /** Clock for durations. Defaults to `performance.now`. */
  now?: () => number;
}

/** A `FetchLike` with counters. */
export interface RequestUrlFetch extends FetchLike {
  readonly stats: TransportStats;
}

/** The error for a request that exceeded the client-side timeout. */
export class RequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`requestUrl did not settle within ${ms} ms; the request was abandoned`);
    this.name = 'TimeoutError';
  }
}

/** The error for a request whose signal aborted. */
export class RequestAbortedError extends Error {
  constructor() {
    super('The request was aborted; the underlying requestUrl call was abandoned');
    this.name = 'AbortError';
  }
}

interface SignalLike {
  aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

function isSignal(value: unknown): value is SignalLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof (value as { addEventListener?: unknown }).addEventListener === 'function'
  );
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'unknown error');
}

/** The body as an `ArrayBuffer` with exactly the view's bytes. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return buffer;
  }
  return bytes.slice().buffer;
}

function responseOf(
  status: number,
  headers: Record<string, string> | undefined,
  body: ArrayBuffer | undefined,
): FetchResponseLike {
  const lower = new Map<string, string>();
  for (const [name, value] of Object.entries(headers ?? {})) lower.set(name.toLowerCase(), value);
  const bytes = body ?? new ArrayBuffer(0);
  return {
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    arrayBuffer: () => Promise.resolve(bytes),
  };
}

/** Reads `arrayBuffer` from a response. Some responses have no body. */
function bodyOf(response: { arrayBuffer?: unknown }): ArrayBuffer | undefined {
  try {
    const body = response.arrayBuffer;
    return body instanceof ArrayBuffer ? body : undefined;
  } catch {
    return undefined;
  }
}

/** A thrown error with a numeric status, as `requestUrl` throws for 400+ by default. */
function statusError(
  error: unknown,
): { status: number; headers?: Record<string, string>; arrayBuffer?: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 100 && status <= 599
    ? (error as { status: number; headers?: Record<string, string>; arrayBuffer?: unknown })
    : undefined;
}

/**
 * Builds a `FetchLike` on `requestUrl`. Every request sets `throw: false`, so
 * 4xx and 5xx responses come back as responses with readable headers and
 * bodies. Response header names are matched without regard to case.
 */
export function createRequestUrlFetch(
  requestUrl: RequestUrlFunction,
  options: RequestUrlFetchOptions = {},
): RequestUrlFetch {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timers: Timers = options.timers ?? window;
  const now = options.now ?? (() => performance.now());
  const stats: TransportStats = {
    started: 0,
    responses: 0,
    thrownStatus: 0,
    networkErrors: 0,
    timeouts: 0,
    aborts: 0,
    abandonedSettled: 0,
    pending: 0,
  };

  const send = (url: string, init: FetchRequestInit): Promise<FetchResponseLike> => {
    const started = now();
    const headers: Record<string, string> = { ...init.headers };
    let contentType: string | undefined;
    if (options.contentType === 'param') {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'content-type') {
          contentType = headers[name];
          delete headers[name];
        }
      }
    }
    const body = init.body === undefined ? undefined : toArrayBuffer(init.body);
    const param: RequestUrlParam = {
      url,
      method: init.method,
      headers,
      throw: false,
      ...(body === undefined ? {} : { body }),
      ...(contentType === undefined ? {} : { contentType }),
    };
    const signal = isSignal(init.signal) ? init.signal : undefined;

    let settled = false;
    let abandoned = false;
    const report = (
      outcome: TransportOutcome,
      status?: number,
      response?: { headers?: Record<string, string> },
      responseBytes = 0,
    ): void => {
      options.observer?.({
        method: init.method,
        url,
        outcome,
        ...(status === undefined ? {} : { status }),
        durationMs: now() - started,
        requestBytes: body?.byteLength ?? 0,
        responseBytes,
        requestHeaderNames: Object.keys(headers),
        headerNames: Object.keys(response?.headers ?? {}),
        responseContentType:
          Object.entries(response?.headers ?? {}).find(
            ([name]) => name.toLowerCase() === 'content-type',
          )?.[1] ?? null,
      });
    };

    return new Promise<FetchResponseLike>((resolve, reject) => {
      let timer: number | undefined;
      const finish = (): void => {
        settled = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const abandon = (outcome: 'timeout' | 'aborted', error: Error): void => {
        if (settled) return;
        abandoned = true;
        finish();
        if (outcome === 'timeout') stats.timeouts += 1;
        else stats.aborts += 1;
        report(outcome);
        reject(error);
      };
      const onAbort = (): void => {
        abandon('aborted', new RequestAbortedError());
      };

      if (signal?.aborted === true) {
        reject(new RequestAbortedError());
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = timers.setTimeout(() => {
          abandon('timeout', new RequestTimeoutError(timeoutMs));
        }, timeoutMs);
      }

      stats.started += 1;
      stats.pending += 1;
      let call: Promise<RequestUrlResponse>;
      try {
        call = requestUrl(param);
      } catch (error) {
        call = Promise.reject(error instanceof Error ? error : new Error(describe(error)));
      }
      call.then(
        (response) => {
          stats.pending -= 1;
          if (abandoned) {
            stats.abandonedSettled += 1;
            return;
          }
          if (settled) return;
          finish();
          stats.responses += 1;
          const bytes = bodyOf(response);
          report('response', response.status, response, bytes?.byteLength ?? 0);
          resolve(responseOf(response.status, response.headers, bytes));
        },
        (error: unknown) => {
          stats.pending -= 1;
          if (abandoned) {
            stats.abandonedSettled += 1;
            return;
          }
          if (settled) return;
          finish();
          const withStatus = statusError(error);
          if (withStatus !== undefined) {
            // `requestUrl` threw for a status although `throw: false` was set.
            stats.thrownStatus += 1;
            const bytes = bodyOf(withStatus);
            report('thrown-status', withStatus.status, withStatus, bytes?.byteLength ?? 0);
            resolve(responseOf(withStatus.status, withStatus.headers, bytes));
            return;
          }
          stats.networkErrors += 1;
          report('network-error');
          reject(error instanceof Error ? error : new Error(describe(error)));
        },
      );
    });
  };

  return Object.assign(send, { stats });
}
