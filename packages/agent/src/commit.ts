import {
  hashContent,
  pathKey,
  type Actor,
  type Commit,
  type ContentHash,
  type Manifest,
  type Op,
} from '@obsy/protocol';
import type { Environment } from '@obsy/core';

import type { VaultReader } from './reader';

/** Devices write a checkpoint after a commit whose `seq` is a multiple of this. */
const CHECKPOINT_EVERY = 500;

/** Content to upload before a commit. */
export interface NewBlob {
  readonly bytes: Uint8Array;
  readonly hash: ContentHash;
}

export async function newBlob(bytes: Uint8Array): Promise<NewBlob> {
  return { bytes, hash: await hashContent(bytes) };
}

/**
 * Uploads the blobs and claims the next log entry with `ops`, computed
 * against `manifest`, which must be the object that `reader.head()`
 * returned: it is updated in place when the commit wins. Returns the commit when it won,
 * or null when another writer took the number first: the caller then
 * reads the new head and computes its ops again.
 *
 * The commit is applied to a copy of the head first, so that a rule it
 * would break throws here instead of reaching the log.
 */
export async function claimCommit(
  reader: VaultReader,
  env: Environment,
  manifest: Manifest,
  actor: Actor,
  ops: readonly Op[],
  blobs: readonly NewBlob[],
): Promise<Commit | null> {
  const commit: Commit = {
    format: 1,
    seq: manifest.seq + 1,
    epoch: manifest.epoch,
    opId: env.newOpId(actor.id),
    actor,
    time: env.now().toISOString(),
    ops,
  };
  manifest.clone().apply(commit);
  for (const blob of blobs) await reader.remote.putBlob(blob.bytes, blob.hash);
  const result = await reader.remote.claim(commit.seq, JSON.stringify(commit), commit.opId);
  if (!result.won) return null;
  reader.applied(commit);
  // Checkpoints at the same numbers as devices write them, so that agents
  // do not leave gaps.
  if (commit.seq % CHECKPOINT_EVERY === 0) await reader.remote.writeCheckpoint(manifest);
  return commit;
}

/** Files whose content obsy merges line by line, as in the sync engine. */
export function isMergeable(path: string): boolean {
  return /\.(md|txt)$/i.test(path);
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}
