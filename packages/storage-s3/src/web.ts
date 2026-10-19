// Typed access to the few web platform globals that this package needs.
//
// The package compiles with ES libraries only, so that it cannot use DOM-only
// APIs such as `DOMParser`. Node 24, Cloudflare Workers, and Obsidian on
// desktop and iOS all provide these globals.

/** The request that `S3Storage` passes to its `fetch`. */
export interface FetchRequestInit {
  method: string;
  /** Header names are as signed. The transport sets Host and Content-Length. */
  headers: Record<string, string>;
  body?: Uint8Array;
  /** An `AbortSignal` when the runtime has `AbortController`. */
  signal?: unknown;
}

/** The subset of a fetch `Response` that `S3Storage` reads. */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * A `fetch` replacement. The global `fetch` fits. The Obsidian plugin can
 * pass a function built on `requestUrl`, which does not need CORS.
 */
export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

interface WebGlobals {
  fetch?: FetchLike;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  AbortController?: new () => { signal: unknown; abort(): void };
  TextDecoder: new (label: string) => { decode(bytes: Uint8Array): string };
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
}

export const web = globalThis as unknown as WebGlobals;

const decoder = new web.TextDecoder('utf-8');

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await web.crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The global `fetch`, bound to `globalThis`, or `undefined`. */
export function globalFetch(): FetchLike | undefined {
  const fetch = web.fetch;
  return fetch === undefined ? undefined : (url, init) => fetch.call(globalThis, url, init);
}
