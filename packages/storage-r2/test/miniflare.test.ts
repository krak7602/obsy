import { describeStorageConformance } from '@obsy/storage-testkit';
import { Miniflare } from 'miniflare';
import { afterAll } from 'vite-plus/test';

import { R2Storage, type R2BucketLike } from '../src/index';

/**
 * The conformance suite against Miniflare's local R2 simulation. This checks
 * the adapter's use of the binding API. It does not show how real R2
 * behaves; that needs a deployed Worker (docs/runbooks/storage-conformance.md).
 */
const mf = new Miniflare({ modules: true, script: 'export default {}', r2Buckets: ['BUCKET'] });
const bucket: R2BucketLike = await mf.getR2Bucket('BUCKET');
const root = new R2Storage(bucket);
let tests = 0;

afterAll(async () => {
  await mf.dispose();
});

describeStorageConformance({
  name: 'Miniflare R2 binding',
  create: (label) => root.withPrefix(`${String(tests++).padStart(2, '0')}-${label}/`),
  race: { createWriters: 8, createRounds: 10, logWriters: 4, commitsPerWriter: 5 },
});
