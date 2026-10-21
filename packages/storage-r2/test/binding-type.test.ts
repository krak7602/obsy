/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it } from 'vite-plus/test';

import { R2Storage, type R2BucketLike } from '../src/index';

// A Workers `R2Bucket` binding must fit `R2BucketLike` without a cast. This
// file fails the type check if it does not.
function accepts(bucket: R2Bucket): R2Storage {
  const like: R2BucketLike = bucket;
  return new R2Storage(like, { prefix: 'vault/' });
}

describe('R2BucketLike', () => {
  it('is satisfied by the Workers R2Bucket type', () => {
    expect(typeof accepts).toBe('function');
  });
});
