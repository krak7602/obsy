/**
 * Errors that a `Storage` adapter throws.
 *
 * Callers decide what to do from `kind`, `retryable`, and `mayHaveApplied`,
 * not from provider status codes. Adapters do not retry by themselves.
 */

export type StorageErrorKind =
  /** A conditional write did not apply because its condition was false. */
  | 'precondition-failed'
  /** The request failed for a temporary reason. Retry after a delay. */
  | 'transient'
  /** The key or prefix breaks the key rules. Do not retry. */
  | 'invalid-key'
  /** Configuration, permission, or protocol error. Do not retry. */
  | 'fatal';

export interface StorageErrorDetails {
  /** HTTP status, when the error came from an HTTP response. */
  status?: number;
  /** Provider error code, for example `PreconditionFailed` or `SlowDown`. */
  code?: string;
  /**
   * True when the provider may have applied a write even though the call
   * failed (a timeout, a lost connection, or a 5xx). After such a failure, a
   * retried conditional write can fail with `PreconditionFailed` because of
   * the caller's own first attempt. Re-read to learn the outcome.
   */
  mayHaveApplied?: boolean;
  /** Delay that the provider asked for, from `Retry-After`. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly mayHaveApplied: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(kind: StorageErrorKind, message: string, details: StorageErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'StorageError';
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
    this.mayHaveApplied = details.mayHaveApplied ?? false;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** True when the same request may succeed if it is sent again later. */
  get retryable(): boolean {
    return this.kind === 'transient';
  }
}

/**
 * A conditional write did not apply: the key exists (`putIfAbsent`), or it
 * is missing or has another etag (`putIfMatch`). Nothing was written by this
 * request. Re-read before you try again.
 */
export class PreconditionFailed extends StorageError {
  constructor(message: string, details: Omit<StorageErrorDetails, 'mayHaveApplied'> = {}) {
    super('precondition-failed', message, { ...details, mayHaveApplied: false });
    this.name = 'PreconditionFailed';
  }
}

/**
 * A temporary failure: a rate limit, a provider conflict between concurrent
 * requests, a 5xx, a timeout, or a network error. Retry after a delay. Check
 * `mayHaveApplied` before you treat a later `PreconditionFailed` as another
 * writer's success.
 */
export class TransientStorageError extends StorageError {
  constructor(message: string, details: StorageErrorDetails = {}) {
    super('transient', message, details);
    this.name = 'TransientStorageError';
  }
}

/** The key or prefix breaks the key rules in `checkStorageKey`. */
export class InvalidKey extends StorageError {
  constructor(message: string) {
    super('invalid-key', message);
    this.name = 'InvalidKey';
  }
}

/**
 * True when `error` is a `StorageError`, optionally of one kind. This works
 * across duplicate copies of this package, where `instanceof` does not.
 */
export function isStorageError(error: unknown, kind?: StorageErrorKind): error is StorageError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { kind?: unknown; mayHaveApplied?: unknown };
  if (typeof candidate.kind !== 'string' || typeof candidate.mayHaveApplied !== 'boolean') {
    return false;
  }
  return kind === undefined || candidate.kind === kind;
}

export function isPreconditionFailed(error: unknown): error is PreconditionFailed {
  return isStorageError(error, 'precondition-failed');
}
