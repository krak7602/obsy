import { diff3Merge } from 'node-diff3';
import { describe, expect, it } from 'vite-plus/test';

// Characterises the node-diff3 behaviour that the merge design builds on.
// Inputs match the local experiment in
// docs/learning/research-notes/merge-algorithms.md.
const base = ['# Todo', '', '- buy milk', '- call bob', ''];
const appended = (line: string): string[] => [...base.slice(0, -1), line, ''];

describe('node-diff3 line-level merge', () => {
  it('merges an identical append on both sides once', () => {
    const result = diff3Merge(appended('- pay rent'), base, appended('- pay rent'));

    expect(result).toEqual([{ ok: appended('- pay rent') }]);
  });

  it('reports different appends at the same anchor as a conflict', () => {
    const result = diff3Merge(appended('- pay rent'), base, appended('- book flight'));

    expect(result.some((region) => 'conflict' in region)).toBe(true);
  });
});
