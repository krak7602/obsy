import { ProtocolError, isActorId, isProposalId } from './records';
import { hashHex, type ContentHash } from './hash';

/**
 * The object layout under a vault prefix. See docs/subsystems/protocol.md.
 */

export const VAULT_KEY = 'vault.json';
export const LOG_PREFIX = 'log/';
export const BLOB_PREFIX = 'blobs/sha256/';
export const CHECKPOINT_PREFIX = 'checkpoints/';
export const PROPOSAL_PREFIX = 'proposals/';
export const RESOLUTION_PREFIX = 'resolutions/';
export const PRESENCE_PREFIX = 'presence/';

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

/** `proposals/<id>.json` */
export function proposalKey(id: string): string {
  if (!isProposalId(id)) throw new ProtocolError(`Not a proposal ID: ${JSON.stringify(id)}`);
  return `${PROPOSAL_PREFIX}${id}.json`;
}

/** `resolutions/<id>.json`: the answer to proposal `<id>`. */
export function resolutionKey(id: string): string {
  if (!isProposalId(id)) throw new ProtocolError(`Not a proposal ID: ${JSON.stringify(id)}`);
  return `${RESOLUTION_PREFIX}${id}.json`;
}

const PROPOSAL_KEY = /^(?:proposals|resolutions)\/(p_[a-z2-7]{24})\.json$/;

/** The proposal ID of a proposal or resolution key, or `null`. */
export function parseProposalKey(key: string): string | null {
  return PROPOSAL_KEY.exec(key)?.[1] ?? null;
}

/** `presence/<device>.json` */
export function presenceKey(device: string): string {
  if (!isActorId(device)) throw new ProtocolError(`Not a device ID: ${JSON.stringify(device)}`);
  return `${PRESENCE_PREFIX}${device}.json`;
}

const PRESENCE_KEY = /^presence\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/;

/** The device ID of a presence key, or `null`. */
export function parsePresenceKey(key: string): string | null {
  return PRESENCE_KEY.exec(key)?.[1] ?? null;
}
