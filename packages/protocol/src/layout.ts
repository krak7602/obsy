import { ProtocolError } from './records';
import { hashHex, type ContentHash } from './hash';

/**
 * The object layout under a vault prefix. See docs/subsystems/protocol.md.
 */

export const VAULT_KEY = 'vault.json';
export const LOG_PREFIX = 'log/';
export const BLOB_PREFIX = 'blobs/sha256/';
export const CHECKPOINT_PREFIX = 'checkpoints/';

/** Sequence numbers are written with this many digits, so that key order is numeric order. */
export const SEQ_DIGITS = 16;

/** The largest sequence number: the largest safe integer, which has 16 digits. */
export const MAX_SEQ: number = Number.MAX_SAFE_INTEGER;

export function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function seqDigits(seq: number): string {
  if (!isSeq(seq)) throw new ProtocolError(`Not a sequence number: ${String(seq)}`);
  return String(seq).padStart(SEQ_DIGITS, '0');
}

/** `log/<16-digit seq>.json` */
export function logKey(seq: number): string {
  return `${LOG_PREFIX}${seqDigits(seq)}.json`;
}

const LOG_KEY = /^log\/(\d{16})\.json$/;

/** The sequence number of a log key, or `null` when `key` is not a log entry key. */
export function parseLogKey(key: string): number | null {
  const match = LOG_KEY.exec(key);
  if (match === null) return null;
  const seq = Number(match[1]);
  return isSeq(seq) ? seq : null;
}

/** `blobs/sha256/<64 hex digits>` */
export function blobKey(hash: ContentHash): string {
  return `${BLOB_PREFIX}${hashHex(hash)}`;
}

/** `checkpoints/<16-digit seq>.json` */
export function checkpointKey(seq: number): string {
  return `${CHECKPOINT_PREFIX}${seqDigits(seq)}.json`;
}

const CHECKPOINT_KEY = /^checkpoints\/(\d{16})\.json$/;

/** The sequence number of a checkpoint key, or `null`. */
export function parseCheckpointKey(key: string): number | null {
  const match = CHECKPOINT_KEY.exec(key);
  if (match === null) return null;
  const seq = Number(match[1]);
  return isSeq(seq) ? seq : null;
}
