// Test support: a fake `requestUrl` in front of the testkit's fake S3 fetch.
// Not part of any bundle.
import type { FakeS3 } from '@obsy/storage-testkit/portable';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

import type { RequestUrlFunction } from '../transport/request-url-fetch';

/** Response header names in the casing that the fake returns. */
const HEADER_NAMES = ['ETag', 'Content-Type', 'Content-Length', 'Retry-After', 'X-Amz-Request-Id'];

export interface FakeRequestUrlOptions {
  /** Throw for 400+ even when `throw: false` is set, as an old or odd platform might. */
  ignoreThrowFalse?: boolean;
  /** Return response header names in lower case. */
  lowerCaseHeaders?: boolean;
  /** Milliseconds to wait before the fake answers a request. */
  delayMs?: (param: RequestUrlParam) => number;
}

export interface FakeRequestUrl {
  requestUrl: RequestUrlFunction;
  /** Every request as `requestUrl` received it. */
  params: RequestUrlParam[];
}

/** An error shaped like the one `requestUrl` throws for a status of 400 or more. */
class FakeRequestUrlError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly arrayBuffer: ArrayBuffer,
  ) {
    super(`Request failed, status ${status}`);
  }
}

export function fakeRequestUrl(
  fetch: FakeS3['fetch'],
  options: FakeRequestUrlOptions = {},
): FakeRequestUrl {
  const params: RequestUrlParam[] = [];
  const requestUrl: RequestUrlFunction = async (param) => {
    params.push(param);
    const delay = options.delayMs?.(param) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const headers = { ...param.headers };
    if (param.contentType !== undefined) headers['content-type'] = param.contentType;
    const body = param.body;
    if (typeof body === 'string') throw new TypeError('The fake accepts only ArrayBuffer bodies');
    const reply = await fetch(param.url, {
      method: param.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    });
    const responseHeaders: Record<string, string> = {};
    for (const name of HEADER_NAMES) {
      const value = reply.headers.get(name);
      if (value !== null) {
        responseHeaders[options.lowerCaseHeaders === true ? name.toLowerCase() : name] = value;
      }
    }
    const arrayBuffer = await reply.arrayBuffer();
    if (reply.status >= 400 && (param.throw !== false || options.ignoreThrowFalse === true)) {
      throw new FakeRequestUrlError(reply.status, responseHeaders, arrayBuffer);
    }
    const response: RequestUrlResponse = {
      status: reply.status,
      headers: responseHeaders,
      arrayBuffer,
      get text() {
        return new TextDecoder().decode(arrayBuffer);
      },
      get json(): unknown {
        return JSON.parse(new TextDecoder().decode(arrayBuffer));
      },
    };
    return response;
  };
  return { requestUrl, params };
}
