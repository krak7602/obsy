/**
 * Test tools for obsy storage: an in-memory `Storage`, the conformance suite,
 * the race harness, and a fake S3 endpoint. See
 * docs/runbooks/storage-conformance.md.
 *
 * `describeStorageConformance` registers Vitest tests, so import this entry
 * only from test files. `@obsy/storage-testkit/portable` has everything else
 * without Vitest.
 */
export * from './portable';
export { describeStorageConformance } from './conformance';
export type { ConformanceTarget } from './conformance';
