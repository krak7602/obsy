import { isStorageError } from '@obsy/protocol';
import { describe, expect, it } from 'vite-plus/test';

import { R2Storage, type R2BucketLike } from '../src/index';

function failingBucket(error: unknown): R2BucketLike {
  const fail = () => Promise.reject(error);
  return { get: fail, put: fail, delete: fail, list: fail };
}

describe('R2Storage binding errors', () => {
  it('keeps the R2 error code and marks writes as possibly applied', async () => {
    const storage = new R2Storage(
      failingBucket(new Error('put: We encountered an internal error. Please try again. (10001)')),
    );
    const error: unknown = await storage
      .putIfAbsent('a.json', new Uint8Array([1]), 'application/json')
      .catch((caught: unknown) => caught);
    expect(isStorageError(error, 'transient')).toBe(true);
    expect(error).toMatchObject({ code: '10001', mayHaveApplied: true });
  });

  it('has no code when the message has none, and reads are not applied', async () => {
    const storage = new R2Storage(failingBucket(new Error('Network connection lost.')));
    const error: unknown = await storage.get('a.json').catch((caught: unknown) => caught);
    expect(isStorageError(error, 'transient')).toBe(true);
    expect(error).toMatchObject({ code: undefined, mayHaveApplied: false });
  });
});
