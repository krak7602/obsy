import type { Storage } from '@obsy/protocol';

/**
 * Deletes every key under `prefix` and returns the number of deleted keys.
 *
 * Use it only on a run-specific prefix in a scratch bucket. It refuses an
 * empty prefix, so that it never empties a whole bucket root by mistake.
 */
export async function deleteAllUnder(storage: Storage, prefix: string): Promise<number> {
  if (prefix.length === 0) throw new Error('deleteAllUnder refuses an empty prefix');
  let deleted = 0;
  let previousFirst: string | undefined;
  // Each pass lists from the start, because deletes change what follows.
  for (;;) {
    const page = await storage.list(prefix);
    if (page.keys.length === 0) return deleted;
    if (page.keys[0] === previousFirst) {
      throw new Error(`Delete did not remove ${previousFirst}; stopping cleanup`);
    }
    previousFirst = page.keys[0];
    for (const key of page.keys) {
      await storage.delete(key);
      deleted += 1;
    }
  }
}
