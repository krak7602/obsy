import { Manifest, ProtocolError, pathKey, type Storage } from '@obsy/protocol';

import type { Environment, LocalFiles } from './host';
import { RemoteVault } from './remote';

/** One difference between the device and the head. */
export interface VerifyProblem {
  /** The head path, or the local path for `extra`. */
  readonly path: string;
  /**
   * `missing`: the head has the file and the device does not. `extra`: the
   * device has a file that the head does not. `content`: the content
   * differs. `path`: the paths differ in case or Unicode form only.
   */
  readonly problem: 'missing' | 'extra' | 'content' | 'path';
}

export interface VerifyReport {
  /** The head that the device was compared with. */
  readonly seq: number;
  /** Live files in the head. */
  readonly headFiles: number;
  /** Files on the device. */
  readonly localFiles: number;
  /** Sorted by path. Empty when the device holds exactly the head files. */
  readonly problems: readonly VerifyProblem[];
  /** With `maxFileSize`: head files over the limit that are not here. Not problems. */
  readonly skipped: number;
}

/**
 * Compares every local file with the head manifest, which it reads from the
 * bucket (newest checkpoint, then the log). Changes nothing. With
 * `maxFileSize`, head files over the limit that are not here are counted as
 * skipped, as the engine leaves them out.
 */
export async function verifyLocal(
  storage: Storage,
  env: Environment,
  local: LocalFiles,
  options: { readonly maxFileSize?: number } = {},
): Promise<VerifyReport> {
  const max = options.maxFileSize ?? Number.POSITIVE_INFINITY;
  const remote = new RemoteVault(storage, env);
  const vault = await remote.getVault();
  if (vault === null) throw new ProtocolError('The bucket has no vault.json.');
  const checkpoint = await remote.latestCheckpoint();
  const head =
    checkpoint !== null && checkpoint.epoch === vault.epoch
      ? Manifest.fromCheckpoint(checkpoint)
      : new Manifest(vault.epoch);
  await remote.catchUp(head);

  const files = await local.list();
  const byKey = new Map(files.map((file) => [pathKey(file.path), file]));
  const problems: VerifyProblem[] = [];
  let headFiles = 0;
  let skipped = 0;
  for (const [, entry] of head.liveFiles()) {
    headFiles++;
    const key = pathKey(entry.path);
    const file = byKey.get(key);
    byKey.delete(key);
    if (file === undefined && entry.size > max) skipped++;
    else if (file === undefined) problems.push({ path: entry.path, problem: 'missing' });
    else if (file.hash !== entry.hash) problems.push({ path: entry.path, problem: 'content' });
    else if (file.path !== entry.path) problems.push({ path: entry.path, problem: 'path' });
  }
  for (const file of byKey.values()) problems.push({ path: file.path, problem: 'extra' });
  problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { seq: head.seq, headFiles, localFiles: files.length, problems, skipped };
}
