// Typed access to the few web platform globals that this package needs.
//
// The package compiles with ES libraries only, so that it cannot use DOM or
// Node APIs. Node 24, Cloudflare Workers, and Obsidian on desktop and iOS
// all provide these globals.

interface WebGlobals {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new (
    label: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  ) => { decode(bytes: Uint8Array): string };
  crypto: {
    subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
    getRandomValues<T extends Uint8Array>(array: T): T;
  };
}

export const web = globalThis as unknown as WebGlobals;

const encoder = new web.TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF in the text, so that decoding and
// encoding again gives the same bytes.
const strictDecoder = new web.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes UTF-8 and throws on malformed input. A byte order mark stays in the text as U+FEFF. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  return strictDecoder.decode(bytes);
}

export function randomBytes(length: number): Uint8Array {
  return web.crypto.getRandomValues(new Uint8Array(length));
}
