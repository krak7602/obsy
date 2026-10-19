/**
 * The parts of the storage testkit that do not need Vitest: the in-memory
 * `Storage`, the conformance checks and their runner, the race harness, the
 * fake S3 endpoint, and helpers. They run in Node, Workers, and Obsidian, so
 * the platform probe can bundle them. Import `@obsy/storage-testkit` for the
 * Vitest suite.
 */
export { MemoryStorage, hashEtag } from './memory-storage';
export type { MemoryOperation, MemoryScheduler, MemoryStorageOptions } from './memory-storage';
export {
  ConformanceFailure,
  DEFAULT_RACE,
  UNUSUAL_KEYS,
  conformanceChecks,
  runConformanceChecks,
} from './checks';
export type {
  CheckContext,
  CheckResult,
  ConformanceCheck,
  RaceParameters,
  RunChecksOptions,
} from './checks';
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
export { cancellableSleep, fromUtf8, randomYieldScheduler, seededRandom, utf8 } from './runtime';
export { summariseLatencies } from './stats';
export type { LatencySummary } from './stats';
