import { isContentHash, type ContentHash } from './hash';
import { isVaultPath, pathKey } from './paths';
import { decodeUtf8Strict, encodeUtf8, randomBytes } from './web';

/**
 * Records stored in the bucket, and their strict parsers. See
 * docs/subsystems/protocol.md#records.
 *
 * Parsers reject unknown fields, unknown versions, and malformed values. A
 * record that does not parse is corruption: callers stop, they do not skip.
 */

/** The record format version that this package reads and writes. */
export const FORMAT = 1;

/** A record or key breaks the protocol. Not retryable. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// ---------------------------------------------------------------- values

const FILE_ID = /^f_[a-z2-7]{24}$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function isFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID.test(value);
}

/** A new random file ID: `f_` and 24 base32 characters (120 bits). */
export function newFileId(): string {
  let id = 'f_';
  for (const byte of randomBytes(24)) id += BASE32[byte & 31];
  return id;
}

export function isActorId(value: unknown): value is string {
  return typeof value === 'string' && ACTOR_ID.test(value);
}

/** A new operation ID: the actor ID, `:`, and 20 base32 characters. */
export function newOpId(actorId: string): string {
  let suffix = '';
  for (const byte of randomBytes(20)) suffix += BASE32[byte & 31];
  return `${actorId}:${suffix}`;
}

function isOpId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  const colon = value.indexOf(':');
  return (
    colon > 0 && isActorId(value.slice(0, colon)) && /^[a-z2-7]{8,64}$/.test(value.slice(colon + 1))
  );
}

function isRev(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// ---------------------------------------------------------------- types

export interface VaultSettings {
  /** Days that log entries and tombstones are kept. Default 180. */
  readonly retentionDays: number;
  /** Days before an unreferenced blob may be deleted. Default 30. */
  readonly blobSoftDeleteDays: number;
}

/** `vault.json` */
export interface VaultRecord {
  readonly format: 1;
  readonly vaultId: string;
  /** Bumped after an out-of-band repair; devices then reconcile by hash. */
  readonly epoch: number;
  readonly createdAt: string;
  readonly settings: VaultSettings;
}

export type Actor =
  | { readonly kind: 'device'; readonly id: string }
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly run?: string;
      readonly toolCall?: string;
    }
  | { readonly kind: 'system'; readonly id: string };

/**
 * Writes file content. `baseRev` is the file's revision that the change was
 * made against, or `null` when the file is new.
 */
export interface PutOp {
  readonly type: 'put';
  readonly fileId: string;
  readonly path: string;
  readonly baseRev: number | null;
  readonly hash: ContentHash;
  readonly size: number;
  /** Set when the content is a three-way merge: the base and theirs revisions. */
  readonly merge?: { readonly base: number; readonly theirs: number };
  /** Set on a new file that is a conflict copy of another file's revision. */
  readonly conflictOf?: { readonly fileId: string; readonly rev: number };
}

/** Renames a file. Content does not change. */
export interface MoveOp {
  readonly type: 'move';
  readonly fileId: string;
  readonly from: string;
  readonly to: string;
  readonly baseRev: number;
}

/** Deletes a file. Only valid when `baseRev` is the file's current revision. */
export interface DeleteOp {
  readonly type: 'delete';
  readonly fileId: string;
  readonly path: string;
  readonly baseRev: number;
}

export type Op = PutOp | MoveOp | DeleteOp;

/** `log/<seq>.json` */
export interface Commit {
  readonly format: 1;
  readonly seq: number;
  readonly epoch: number;
  /** Unique per logical change; a retried commit keeps its `opId`. */
  readonly opId: string;
  readonly actor: Actor;
  readonly time: string;
  readonly ops: readonly Op[];
}

/** One file in a checkpoint. A deleted file is a tombstone with its last content hash. */
export interface FileEntry {
  readonly path: string;
  readonly rev: number;
  readonly hash: ContentHash;
  readonly size: number;
  readonly deleted: boolean;
}

/** `checkpoints/<seq>.json`: every file as of `seq`. */
export interface Checkpoint {
  readonly format: 1;
  readonly seq: number;
  readonly epoch: number;
  readonly files: Readonly<Record<string, FileEntry>>;
}

// ---------------------------------------------------------------- parsing

type Json = Record<string, unknown>;

function fail(what: string, problem: string): never {
  throw new ProtocolError(`Invalid ${what}: ${problem}`);
}

function object(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(what, 'not an object');
  return value as Json;
}

function onlyKeys(
  value: Json,
  what: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) if (!(key in value)) fail(what, `missing "${key}"`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(what, `unknown field "${key}"`);
  }
}

function check(ok: boolean, what: string, problem: string): void {
  if (!ok) fail(what, problem);
}

function format(value: Json, what: string): void {
  if (value['format'] !== FORMAT)
    fail(what, `unsupported format ${JSON.stringify(value['format'])}`);
}

function time(value: unknown, what: string): string {
  check(
    typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)),
    what,
    'bad time',
  );
  return value as string;
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  let text: string;
  try {
    text = decodeUtf8Strict(bytes);
  } catch {
    fail(what, 'not UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(what, 'not JSON');
  }
}

export function validateVaultRecord(input: unknown): VaultRecord {
  const what = 'vault.json';
  const v = object(input, what);
  onlyKeys(v, what, ['format', 'vaultId', 'epoch', 'createdAt', 'settings']);
  format(v, what);
  check(
    typeof v['vaultId'] === 'string' && /^v_[a-z2-7]{24}$/.test(v['vaultId']),
    what,
    'bad vaultId',
  );
  check(isRev(v['epoch']), what, 'bad epoch');
  time(v['createdAt'], what);
  const s = object(v['settings'], `${what} settings`);
  onlyKeys(s, `${what} settings`, ['retentionDays', 'blobSoftDeleteDays']);
  for (const key of ['retentionDays', 'blobSoftDeleteDays']) {
    check(
      typeof s[key] === 'number' && Number.isSafeInteger(s[key]) && (s[key] as number) >= 1,
      what,
      `bad ${key}`,
    );
  }
  return v as unknown as VaultRecord;
}

/** A new vault ID: `v_` and 24 base32 characters. */
export function newVaultId(): string {
  return `v${newFileId().slice(1)}`;
}

function validateActor(input: unknown, what: string): Actor {
  const a = object(input, `${what} actor`);
  const kind = a['kind'];
  if (kind === 'agent') onlyKeys(a, `${what} actor`, ['kind', 'id'], ['run', 'toolCall']);
  else onlyKeys(a, `${what} actor`, ['kind', 'id']);
  check(kind === 'device' || kind === 'agent' || kind === 'system', what, 'bad actor kind');
  check(isActorId(a['id']), what, 'bad actor id');
  for (const key of ['run', 'toolCall']) {
    if (key in a)
      check(
        typeof a[key] === 'string' && (a[key] as string).length <= 200,
        what,
        `bad actor ${key}`,
      );
  }
  return a as unknown as Actor;
}

function validateOp(input: unknown, what: string): Op {
  const o = object(input, what);
  check(isFileId(o['fileId']), what, 'bad fileId');
  switch (o['type']) {
    case 'put': {
      onlyKeys(
        o,
        what,
        ['type', 'fileId', 'path', 'baseRev', 'hash', 'size'],
        ['merge', 'conflictOf'],
      );
      check(isVaultPath(o['path']), what, 'bad path');
      check(o['baseRev'] === null || isRev(o['baseRev']), what, 'bad baseRev');
      check(isContentHash(o['hash']), what, 'bad hash');
      check(isSize(o['size']), what, 'bad size');
      if ('merge' in o) {
        const m = object(o['merge'], `${what} merge`);
        onlyKeys(m, `${what} merge`, ['base', 'theirs']);
        check(isRev(m['base']) && isRev(m['theirs']), what, 'bad merge revisions');
      }
      if ('conflictOf' in o) {
        const c = object(o['conflictOf'], `${what} conflictOf`);
        onlyKeys(c, `${what} conflictOf`, ['fileId', 'rev']);
        check(isFileId(c['fileId']) && isRev(c['rev']), what, 'bad conflictOf');
        check(o['baseRev'] === null, what, 'a conflict copy must be a new file');
      }
      break;
    }
    case 'move':
      onlyKeys(o, what, ['type', 'fileId', 'from', 'to', 'baseRev']);
      check(isVaultPath(o['from']) && isVaultPath(o['to']), what, 'bad path');
      check(o['from'] !== o['to'], what, 'move to the same path');
      check(isRev(o['baseRev']), what, 'bad baseRev');
      break;
    case 'delete':
      onlyKeys(o, what, ['type', 'fileId', 'path', 'baseRev']);
      check(isVaultPath(o['path']), what, 'bad path');
      check(isRev(o['baseRev']), what, 'bad baseRev');
      break;
    default:
      fail(what, `unknown op type ${JSON.stringify(o['type'])}`);
  }
  return o as unknown as Op;
}

/**
 * Validates a commit. With `expectedSeq`, the commit's `seq` must equal it
 * (the seq in the key).
 */
export function validateCommit(input: unknown, expectedSeq?: number): Commit {
  const what = expectedSeq === undefined ? 'commit' : `commit ${expectedSeq}`;
  const c = object(input, what);
  onlyKeys(c, what, ['format', 'seq', 'epoch', 'opId', 'actor', 'time', 'ops']);
  format(c, what);
  check(isRev(c['seq']), what, 'bad seq');
  if (expectedSeq !== undefined)
    check(c['seq'] === expectedSeq, what, `seq ${String(c['seq'])} in the record`);
  check(isRev(c['epoch']), what, 'bad epoch');
  check(isOpId(c['opId']), what, 'bad opId');
  validateActor(c['actor'], what);
  time(c['time'], what);
  check(Array.isArray(c['ops']) && c['ops'].length > 0, what, 'no ops');
  const ops = (c['ops'] as unknown[]).map((op, i) => validateOp(op, `${what} op ${i}`));
  const fileIds = new Set<string>();
  for (const op of ops) {
    check(!fileIds.has(op.fileId), what, 'two ops for one file');
    fileIds.add(op.fileId);
  }
  check(ops.length <= 10_000, what, 'too many ops');
  return c as unknown as Commit;
}

export function validateCheckpoint(input: unknown, expectedSeq?: number): Checkpoint {
  const what = expectedSeq === undefined ? 'checkpoint' : `checkpoint ${expectedSeq}`;
  const c = object(input, what);
  onlyKeys(c, what, ['format', 'seq', 'epoch', 'files']);
  format(c, what);
  check(isRev(c['seq']), what, 'bad seq');
  if (expectedSeq !== undefined) check(c['seq'] === expectedSeq, what, 'seq differs from its key');
  check(isRev(c['epoch']), what, 'bad epoch');
  const files = object(c['files'], `${what} files`);
  const liveKeys = new Set<string>();
  for (const [fileId, value] of Object.entries(files)) {
    check(isFileId(fileId), what, 'bad fileId');
    const f = object(value, `${what} file`);
    onlyKeys(f, `${what} file`, ['path', 'rev', 'hash', 'size', 'deleted']);
    check(isVaultPath(f['path']), what, 'bad path');
    check(isRev(f['rev']) && (f['rev'] as number) <= (c['seq'] as number), what, 'bad rev');
    check(isContentHash(f['hash']), what, 'bad hash');
    check(isSize(f['size']), what, 'bad size');
    check(typeof f['deleted'] === 'boolean', what, 'bad deleted');
    if (f['deleted'] === false) {
      const key = pathKey(f['path'] as string);
      check(!liveKeys.has(key), what, 'two live files share a path key');
      liveKeys.add(key);
    }
  }
  return c as unknown as Checkpoint;
}

// ---------------------------------------------------------------- agent records

const PROPOSAL_ID = /^p_[a-z2-7]{24}$/;
const OPERATION = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** The longest proposal rationale, in UTF-16 code units. */
export const MAX_RATIONALE_LENGTH = 4000;

export function isProposalId(value: unknown): value is string {
  return typeof value === 'string' && PROPOSAL_ID.test(value);
}

/** Why an agent edit was stored as a proposal instead of committed. */
export type ProposalReason =
  /** The agent asked for a proposal (`proposePatch`). */
  | 'requested'
  /** The heading or block the edit needs is missing. */
  | 'anchor-missing'
  /** The heading or block the edit needs is there more than once, or is damaged. */
  | 'anchor-ambiguous'
  /** A person edited the agent's block, so the block is theirs now. */
  | 'block-edited'
  /** Someone other than the agent changed the file. */
  | 'not-owned'
  /** A device was editing the note. */
  | 'editing';

const PROPOSAL_REASONS: readonly ProposalReason[] = [
  'requested',
  'anchor-missing',
  'anchor-ambiguous',
  'block-edited',
  'not-owned',
  'editing',
];

/**
 * `proposals/<id>.json`: a change that an agent could not commit safely.
 * It holds the whole proposed content as a blob, and the revision it was
 * made against, so that accepting it is a three-way merge with the head.
 */
export interface Proposal {
  readonly format: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly actor: Actor;
  readonly path: string;
  /** The file it changes, or null for a new file. */
  readonly fileId: string | null;
  /** The file's revision that the content was computed from; null for a new file. */
  readonly baseRev: number | null;
  /** The file's content at `baseRev`; null for a new file. */
  readonly baseHash: ContentHash | null;
  /** The proposed content. */
  readonly hash: ContentHash;
  readonly size: number;
  readonly reason: ProposalReason;
  /** The operation that made it, for example `appendToSection`. */
  readonly operation: string;
  readonly rationale: string;
}

/** `resolutions/<id>.json`: the owner's answer to proposal `<id>`. Created once. */
export interface Resolution {
  readonly format: 1;
  readonly id: string;
  readonly resolvedAt: string;
  readonly actor: Actor;
  readonly outcome: 'accepted' | 'rejected';
  /** The commit that applied an accepted proposal. Absent when the head already had its content. */
  readonly seq?: number;
}

/** `presence/<device>.json`: what a device's user edits now. Overwritten by that device only. */
export interface Presence {
  readonly format: 1;
  readonly device: string;
  /** When the user last edited `path`. */
  readonly time: string;
  /** The note being edited, or null when none. */
  readonly path: string | null;
}

export function validateProposal(input: unknown, expectedId?: string): Proposal {
  const what = expectedId === undefined ? 'proposal' : `proposal ${expectedId}`;
  const p = object(input, what);
  onlyKeys(p, what, [
    'format',
    'id',
    'createdAt',
    'actor',
    'path',
    'fileId',
    'baseRev',
    'baseHash',
    'hash',
    'size',
    'reason',
    'operation',
    'rationale',
  ]);
  format(p, what);
  check(isProposalId(p['id']), what, 'bad id');
  if (expectedId !== undefined) check(p['id'] === expectedId, what, 'id differs from its key');
  time(p['createdAt'], what);
  validateActor(p['actor'], what);
  check(isVaultPath(p['path']), what, 'bad path');
  const isNew = p['fileId'] === null;
  check(isNew || isFileId(p['fileId']), what, 'bad fileId');
  check(isNew ? p['baseRev'] === null : isRev(p['baseRev']), what, 'bad baseRev');
  check(isNew ? p['baseHash'] === null : isContentHash(p['baseHash']), what, 'bad baseHash');
  check(isContentHash(p['hash']), what, 'bad hash');
  check(isSize(p['size']), what, 'bad size');
  check(PROPOSAL_REASONS.includes(p['reason'] as ProposalReason), what, 'bad reason');
  check(
    typeof p['operation'] === 'string' && OPERATION.test(p['operation']),
    what,
    'bad operation',
  );
  check(
    typeof p['rationale'] === 'string' && p['rationale'].length <= MAX_RATIONALE_LENGTH,
    what,
    'bad rationale',
  );
  return p as unknown as Proposal;
}

export function validateResolution(input: unknown, expectedId?: string): Resolution {
  const what = expectedId === undefined ? 'resolution' : `resolution ${expectedId}`;
  const r = object(input, what);
  onlyKeys(r, what, ['format', 'id', 'resolvedAt', 'actor', 'outcome'], ['seq']);
  format(r, what);
  check(isProposalId(r['id']), what, 'bad id');
  if (expectedId !== undefined) check(r['id'] === expectedId, what, 'id differs from its key');
  time(r['resolvedAt'], what);
  validateActor(r['actor'], what);
  check(r['outcome'] === 'accepted' || r['outcome'] === 'rejected', what, 'bad outcome');
  if ('seq' in r) check(r['outcome'] === 'accepted' && isRev(r['seq']), what, 'bad seq');
  return r as unknown as Resolution;
}

export function validatePresence(input: unknown, expectedDevice?: string): Presence {
  const what = expectedDevice === undefined ? 'presence' : `presence ${expectedDevice}`;
  const p = object(input, what);
  onlyKeys(p, what, ['format', 'device', 'time', 'path']);
  format(p, what);
  check(isActorId(p['device']), what, 'bad device');
  if (expectedDevice !== undefined)
    check(p['device'] === expectedDevice, what, 'device differs from its key');
  time(p['time'], what);
  check(p['path'] === null || isVaultPath(p['path']), what, 'bad path');
  return p as unknown as Presence;
}

export function decodeProposal(bytes: Uint8Array, expectedId?: string): Proposal {
  return validateProposal(parseJson(bytes, 'proposal'), expectedId);
}

export function decodeResolution(bytes: Uint8Array, expectedId?: string): Resolution {
  return validateResolution(parseJson(bytes, 'resolution'), expectedId);
}

export function decodePresence(bytes: Uint8Array, expectedDevice?: string): Presence {
  return validatePresence(parseJson(bytes, 'presence'), expectedDevice);
}

/** Encodes a record as UTF-8 JSON. */
export function encodeRecord(
  record: VaultRecord | Commit | Checkpoint | Proposal | Resolution | Presence,
): Uint8Array {
  return encodeUtf8(JSON.stringify(record));
}

export function decodeVaultRecord(bytes: Uint8Array): VaultRecord {
  return validateVaultRecord(parseJson(bytes, 'vault.json'));
}

export function decodeCommit(bytes: Uint8Array, expectedSeq?: number): Commit {
  return validateCommit(parseJson(bytes, 'commit'), expectedSeq);
}

export function decodeCheckpoint(bytes: Uint8Array, expectedSeq?: number): Checkpoint {
  return validateCheckpoint(parseJson(bytes, 'checkpoint'), expectedSeq);
}
