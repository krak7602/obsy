/**
 * The obsy bucket protocol.
 *
 * Phase 0 contains only the storage contract: the `Storage` interface, its
 * errors, and the key rules. See docs/subsystems/storage.md. The layout,
 * records, and validation arrive in phase 1 (docs/subsystems/protocol.md).
 */
export type { ListResult, PutResult, Storage, StoredObject } from './storage';
export { MAX_LIST_LIMIT } from './storage';
export type { StorageErrorDetails, StorageErrorKind } from './errors';
export {
  InvalidKey,
  PreconditionFailed,
  StorageError,
  TransientStorageError,
  isPreconditionFailed,
  isStorageError,
} from './errors';
export {
  MAX_KEY_BYTES,
  checkStorageKey,
  checkStoragePrefix,
  compareKeys,
  utf8ByteLength,
} from './keys';
