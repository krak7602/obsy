import { describe, expect, it } from 'vite-plus/test';

import { hashContent } from './hash';
import { blobKey, checkpointKey, logKey, parseCheckpointKey, parseLogKey } from './layout';
import { Manifest } from './manifest';
import { conflictCopyPath, freeConflictCopyPath, pathKey, vaultPathProblem } from './paths';
import {
  ProtocolError,
  decodeCheckpoint,
  decodeCommit,
  decodeVaultRecord,
  encodeRecord,
  newFileId,
  newOpId,
  newVaultId,
  type Commit,
  type Op,
} from './records';
import { encodeUtf8 } from './web';

const H1 = `sha256:${'1'.repeat(64)}` as const;
const H2 = `sha256:${'2'.repeat(64)}` as const;
const FA = 'f_aaaaaaaaaaaaaaaaaaaaaaaa';
const FB = 'f_bbbbbbbbbbbbbbbbbbbbbbbb';

function commit(seq: number, ops: Op[], epoch = 1): Commit {
  return {
    format: 1,
    seq,
    epoch,
    opId: `mac:${'a'.repeat(20)}`,
    actor: { kind: 'device', id: 'mac' },
    time: '2026-10-20T10:00:00Z',
    ops,
  };
}

describe('layout', () => {
  it('writes and parses 16-digit sequence keys', () => {
    expect(logKey(1043)).toBe('log/0000000000001043.json');
    expect(parseLogKey('log/0000000000001043.json')).toBe(1043);
    expect(parseLogKey('log/0000000000000000.json')).toBeNull();
    expect(parseLogKey('log/1043.json')).toBeNull();
    expect(checkpointKey(7)).toBe('checkpoints/0000000000000007.json');
    expect(parseCheckpointKey(checkpointKey(7))).toBe(7);
    expect(() => logKey(0)).toThrow(ProtocolError);
    expect(() => logKey(1.5)).toThrow(ProtocolError);
  });

  it('sorts log keys numerically when listed in key order', () => {
    const keys = [9, 10, 100, 2].map(logKey).sort();
    expect(keys.map(parseLogKey)).toEqual([2, 9, 10, 100]);
  });

  it('addresses blobs by hash', async () => {
    const hash = await hashContent(encodeUtf8('abc'));
    expect(hash).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(blobKey(hash)).toBe(`blobs/sha256/${hash.slice(7)}`);
  });
});

describe('paths', () => {
  it('accepts normal vault paths and rejects unsafe ones', () => {
    expect(vaultPathProblem('journals/2026-10-19.md')).toBeNull();
    expect(vaultPathProblem('Notes/Café ☕/a b+c.md')).toBeNull();
    for (const bad of [
      '',
      '/a.md',
      'a//b.md',
      'a/',
      './a.md',
      'a/../b.md',
      'a\\b.md',
      'a\u0000.md',
      'a\ud800.md',
    ]) {
      expect(vaultPathProblem(bad)).not.toBeNull();
    }
  });

  it('gives case and normalisation twins the same key', () => {
    expect(pathKey('Notes/Café.md')).toBe(pathKey('notes/café.MD'));
    expect(pathKey('a.md')).not.toBe(pathKey('b.md'));
  });

  it('names conflict copies in the same folder', () => {
    const time = new Date(Date.UTC(2026, 9, 20, 7, 5));
    expect(conflictCopyPath('journals/2026-10-20.md', 'iPhone', time)).toBe(
      'journals/2026-10-20 (conflict iPhone 202610200705).md',
    );
    expect(conflictCopyPath('README', 'my/mac', time)).toBe(
      'README (conflict my-mac 202610200705)',
    );
    const taken = new Set([pathKey('a (conflict mac 202610200705).md')]);
    expect(freeConflictCopyPath('a.md', 'mac', time, (k) => taken.has(k))).toBe(
      'a (conflict mac 202610200705) 2.md',
    );
  });
});

describe('records', () => {
  it('round-trips a commit and rejects unknown fields and formats', () => {
    const c = commit(3, [
      { type: 'put', fileId: FA, path: 'a.md', baseRev: null, hash: H1, size: 5 },
      { type: 'move', fileId: FB, from: 'b.md', to: 'c.md', baseRev: 2 },
    ]);
    expect(decodeCommit(encodeRecord(c), 3)).toEqual(c);
    expect(() => decodeCommit(encodeRecord(c), 4)).toThrow(ProtocolError);
    expect(() => decodeCommit(encodeUtf8(JSON.stringify({ ...c, extra: 1 })))).toThrow(
      /unknown field/,
    );
    expect(() => decodeCommit(encodeUtf8(JSON.stringify({ ...c, format: 2 })))).toThrow(/format/);
    expect(() => decodeCommit(encodeUtf8('{'))).toThrow(/not JSON/);
    expect(() => decodeCommit(new Uint8Array([0xff]))).toThrow(/UTF-8/);
  });

  it('rejects two ops for one file, and bad values', () => {
    const put: Op = { type: 'put', fileId: FA, path: 'a.md', baseRev: null, hash: H1, size: 1 };
    expect(() => decodeCommit(encodeRecord(commit(1, [put, put])))).toThrow(/two ops/);
    expect(() => decodeCommit(encodeRecord(commit(1, [])))).toThrow(/no ops/);
    expect(() => decodeCommit(encodeRecord(commit(1, [{ ...put, path: '../x.md' }])))).toThrow(
      /bad path/,
    );
    expect(() => decodeCommit(encodeRecord(commit(1, [{ ...put, fileId: 'f_x' }])))).toThrow(
      /fileId/,
    );
    expect(() =>
      decodeCommit(
        encodeRecord(commit(1, [{ ...put, baseRev: 1, conflictOf: { fileId: FB, rev: 1 } }])),
      ),
    ).toThrow(/new file/);
  });

  it('round-trips vault.json', () => {
    const vault = {
      format: 1 as const,
      vaultId: newVaultId(),
      epoch: 1,
      createdAt: '2026-10-20T10:00:00.000Z',
      settings: { retentionDays: 180, blobSoftDeleteDays: 30 },
    };
    expect(decodeVaultRecord(encodeRecord(vault))).toEqual(vault);
    expect(() => decodeVaultRecord(encodeRecord({ ...vault, epoch: 0 }))).toThrow(/epoch/);
  });

  it('makes IDs in the expected shapes', () => {
    expect(newFileId()).toMatch(/^f_[a-z2-7]{24}$/);
    expect(newOpId('mac')).toMatch(/^mac:[a-z2-7]{20}$/);
    expect(new Set(Array.from({ length: 100 }, newFileId)).size).toBe(100);
  });
});

describe('Manifest', () => {
  it('applies puts, moves, and deletes, and round-trips through a checkpoint', () => {
    const m = new Manifest(1);
    m.apply(
      commit(1, [{ type: 'put', fileId: FA, path: 'a.md', baseRev: null, hash: H1, size: 1 }]),
    );
    m.apply(commit(2, [{ type: 'put', fileId: FA, path: 'a.md', baseRev: 1, hash: H2, size: 2 }]));
    m.apply(commit(3, [{ type: 'move', fileId: FA, from: 'a.md', to: 'b.md', baseRev: 2 }]));
    expect(m.file(FA)).toEqual({ path: 'b.md', rev: 3, hash: H2, size: 2, deleted: false });
    expect(m.liveAt('B.MD')).toBe(FA);
    m.apply(commit(4, [{ type: 'delete', fileId: FA, path: 'b.md', baseRev: 3 }]));
    expect(m.liveAt('b.md')).toBeUndefined();
    const checkpoint = decodeCheckpoint(encodeRecord(m.toCheckpoint()), 4);
    const restored = Manifest.fromCheckpoint(checkpoint);
    expect(restored.file(FA)).toEqual(m.file(FA));
    // A put against the tombstone restores the file at its last path.
    restored.apply(
      commit(5, [{ type: 'put', fileId: FA, path: 'b.md', baseRev: 4, hash: H1, size: 1 }]),
    );
    expect(restored.liveAt('b.md')).toBe(FA);
  });

  it('rejects stale, out-of-order, and colliding commits, and stays unchanged', () => {
    const m = new Manifest(1);
    m.apply(
      commit(1, [{ type: 'put', fileId: FA, path: 'a.md', baseRev: null, hash: H1, size: 1 }]),
    );
    const snapshot = JSON.stringify(m.toCheckpoint());
    const reject = (c: Commit, pattern: RegExp): void => {
      expect(() => m.apply(c)).toThrow(pattern);
      expect(JSON.stringify(m.toCheckpoint())).toBe(snapshot);
    };
    reject(commit(3, [{ type: 'delete', fileId: FA, path: 'a.md', baseRev: 1 }]), /expected seq 2/);
    reject(commit(2, [{ type: 'delete', fileId: FA, path: 'a.md', baseRev: 1 }], 2), /epoch/);
    reject(
      commit(2, [{ type: 'put', fileId: FA, path: 'a.md', baseRev: 7, hash: H2, size: 1 }]),
      /rev 1/,
    );
    reject(
      commit(2, [{ type: 'put', fileId: FB, path: 'A.md', baseRev: null, hash: H2, size: 1 }]),
      /in use/,
    );
    reject(
      commit(2, [{ type: 'put', fileId: FA, path: 'a.md', baseRev: null, hash: H2, size: 1 }]),
      /exists/,
    );
    reject(
      commit(2, [{ type: 'move', fileId: FA, from: 'x.md', to: 'y.md', baseRev: 1 }]),
      /move from/,
    );
    reject(
      commit(2, [
        { type: 'put', fileId: FB, path: 'b.md', baseRev: null, hash: H2, size: 1 },
        { type: 'move', fileId: FA, from: 'a.md', to: 'B.md', baseRev: 1 },
      ]),
      /in use/,
    );
  });

  it('lets renames swap paths within one commit', () => {
    const m = new Manifest(1);
    m.apply(
      commit(1, [
        { type: 'put', fileId: FA, path: 'a.md', baseRev: null, hash: H1, size: 1 },
        { type: 'put', fileId: FB, path: 'b.md', baseRev: null, hash: H2, size: 1 },
      ]),
    );
    m.apply(
      commit(2, [
        { type: 'move', fileId: FA, from: 'a.md', to: 'b.md', baseRev: 1 },
        { type: 'move', fileId: FB, from: 'b.md', to: 'a.md', baseRev: 1 },
      ]),
    );
    expect(m.liveAt('a.md')).toBe(FB);
    expect(m.liveAt('b.md')).toBe(FA);
  });

  it('frees a path in the same commit that takes it', () => {
    const m = new Manifest(1);
    m.apply(
      commit(1, [{ type: 'put', fileId: FA, path: 'a.md', baseRev: null, hash: H1, size: 1 }]),
    );
    m.apply(
      commit(2, [
        { type: 'move', fileId: FA, from: 'a.md', to: 'old/a.md', baseRev: 1 },
        { type: 'put', fileId: FB, path: 'a.md', baseRev: null, hash: H2, size: 1 },
      ]),
    );
    expect(m.liveAt('a.md')).toBe(FB);
    expect(m.liveAt('old/a.md')).toBe(FA);
  });
});
