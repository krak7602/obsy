import { web } from './web';

/** A content hash as stored in records: `sha256:` and 64 lowercase hex digits. */
export type ContentHash = `sha256:${string}`;

const HASH = /^sha256:[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && HASH.test(value);
}

/** Hashes `bytes` with SHA-256. */
export async function hashContent(bytes: Uint8Array): Promise<ContentHash> {
  const digest = new Uint8Array(await web.crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

/** The 64 hex digits of a content hash. */
export function hashHex(hash: ContentHash): string {
  return hash.slice('sha256:'.length);
}
