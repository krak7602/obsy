import { describe, expect, it } from 'vite-plus/test';

import {
  InvalidKey,
  PreconditionFailed,
  StorageError,
  TransientStorageError,
  isPreconditionFailed,
  isStorageError,
} from './errors';

describe('storage errors', () => {
  it('sets kind, retryable, and mayHaveApplied', () => {
    const precondition = new PreconditionFailed('exists', {
      status: 412,
      code: 'PreconditionFailed',
    });
    expect(precondition).toBeInstanceOf(StorageError);
    expect(precondition.kind).toBe('precondition-failed');
    expect(precondition.retryable).toBe(false);
    expect(precondition.mayHaveApplied).toBe(false);
    expect(precondition.status).toBe(412);

    const transient = new TransientStorageError('timeout', { mayHaveApplied: true });
    expect(transient.retryable).toBe(true);
    expect(transient.mayHaveApplied).toBe(true);

    expect(new InvalidKey('bad').kind).toBe('invalid-key');
    expect(new StorageError('fatal', 'denied', { status: 403 }).retryable).toBe(false);
  });

  it('recognises errors structurally', () => {
    expect(isPreconditionFailed(new PreconditionFailed('x'))).toBe(true);
    expect(isPreconditionFailed(new TransientStorageError('x'))).toBe(false);
    expect(isStorageError({ kind: 'transient', mayHaveApplied: false }, 'transient')).toBe(true);
    expect(isStorageError(new Error('x'))).toBe(false);
    expect(isStorageError(null)).toBe(false);
  });

  it('keeps the cause', () => {
    const cause = new Error('socket hang up');
    expect(new TransientStorageError('network', { cause }).cause).toBe(cause);
  });
});
