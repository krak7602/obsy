/**
 * Test tools for obsy storage: an in-memory `Storage`, the conformance suite,
 * the race harness, and a fake S3 endpoint. See
 * docs/runbooks/storage-conformance.md.
 *
 * The suite registers Vitest tests, so import it only from test files.
 */
export { MemoryStorage, hashEtag } from './memory-storage';
export type { MemoryOperation, MemoryScheduler, MemoryStorageOptions } from './memory-storage';
export { DEFAULT_RACE, UNUSUAL_KEYS, describeStorageConformance } from './conformance';
export type { ConformanceTarget, RaceParameters } from './conformance';
export { DEFAULT_RETRY, logKey, outcomeLabel, runCommitLogRace, runCreateRace } from './race';
export type {
  CommitLogRaceOptions,
  CommitLogRaceResult,
  CreateRaceOptions,
  CreateRaceResult,
  RetryPolicy,
} from './race';
export { formatRaceResult } from './report';
export { deleteAllUnder } from './cleanup';
export { createFakeS3 } from './fake-s3';
export type {
  FakeS3,
  FakeS3Init,
  FakeS3Options,
  FakeS3Request,
  FakeS3Response,
  InjectedFault,
  InjectedReply,
} from './fake-s3';
export { randomYieldScheduler, seededRandom } from './runtime';
export { summariseLatencies } from './stats';
export type { LatencySummary } from './stats';
