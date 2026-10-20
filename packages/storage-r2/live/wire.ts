// The messages between the live R2 test (Node) and its Worker. See
// docs/runbooks/storage-conformance.md#live-r2-binding-run.
import {
  InvalidKey,
  PreconditionFailed,
  StorageError,
  TransientStorageError,
  isStorageError,
} from '@obsy/protocol';

/** One `Storage` call. `root` is the sub-prefix under the Worker's fixed root. */
export type WireCall =
  | { readonly op: 'ping' }
  | { readonly op: 'get'; readonly root: string; readonly key: string }
  | {
      readonly op: 'putIfAbsent';
      readonly root: string;
      readonly key: string;
      /** Base64. */
      readonly body: string;
      readonly contentType: string;
    }
  | {
      readonly op: 'putIfMatch';
      readonly root: string;
      readonly key: string;
      readonly body: string;
      readonly etag: string;
      readonly contentType: string;
    }
  | {
      readonly op: 'list';
      readonly root: string;
      readonly prefix: string;
      readonly startAfter?: string;
      readonly limit?: number;
    }
  | { readonly op: 'delete'; readonly root: string; readonly key: string };

export interface WireError {
  readonly name: string;
  /** A `StorageErrorKind`, or `unexpected` for other errors. */
  readonly kind: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly mayHaveApplied: boolean;
  readonly retryAfterMs?: number;
}

export type WireReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: WireError };

interface Base64Globals {
  btoa(data: string): string;
  atob(data: string): string;
}

const base64 = globalThis as unknown as Base64Globals;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return base64.btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = base64.atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}

export function errorToWire(error: unknown): WireError {
  if (isStorageError(error)) {
    return {
      name: error.name,
      kind: error.kind,
      message: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.status === undefined ? {} : { status: error.status }),
      mayHaveApplied: error.mayHaveApplied,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return { name, kind: 'unexpected', message, mayHaveApplied: false };
}

/** Rebuilds the error that the adapter threw in the Worker. */
export function errorFromWire(error: WireError): Error {
  const details = {
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.status === undefined ? {} : { status: error.status }),
  };
  switch (error.kind) {
    case 'precondition-failed':
      return new PreconditionFailed(error.message, details);
    case 'transient':
      return new TransientStorageError(error.message, {
        ...details,
        mayHaveApplied: error.mayHaveApplied,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      });
    case 'invalid-key':
      return new InvalidKey(error.message);
    case 'fatal':
      return new StorageError('fatal', error.message, details);
    default: {
      const rebuilt =
        error.name === 'RangeError' ? new RangeError(error.message) : new Error(error.message);
      rebuilt.name = error.name;
      return rebuilt;
    }
  }
}
