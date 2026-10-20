import fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { DiffWorkLimitExceeded, WorkBudget, diffLines, type Hunk } from './diff';
import { diff3Regions } from './diff3';
import { merge3 } from './merge';

/** Applies hunks from `diffLines(o, s)` to `o`, taking new lines from `s`. */
function apply(o: readonly string[], s: readonly string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    out.push(...o.slice(at, hunk.oStart), ...s.slice(hunk.sStart, hunk.sStart + hunk.sLength));
    at = hunk.oStart + hunk.oLength;
  }
  return [...out, ...o.slice(at)];
}

/** Length of the longest common subsequence, by dynamic programming. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = Array.from({ length: b.length + 1 }, () => 0);
  for (const x of a) {
    const row = [0];
    b.forEach((y, j) =>
      row.push(x === y ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, row[j] ?? 0)),
    );
    previous = row;
  }
  return previous[b.length] ?? 0;
}

// Few distinct lines, so that most lines repeat.
const linesArb = fc.array(fc.constantFrom('', '- [ ] a', '- [x] a', 'text', '---', '# h'), {
  maxLength: 30,
});

describe('diffLines', () => {
  it('returns hunks that turn the old list into the new one', () => {
    fc.assert(
      fc.property(linesArb, linesArb, (o, s) => {
        expect(apply(o, s, diffLines(o, s))).toEqual(s);
      }),
      { numRuns: 500 },
    );
  });

  it('keeps a longest common subsequence', () => {
    fc.assert(
      fc.property(linesArb, linesArb, (o, s) => {
        const hunks = diffLines(o, s);
        const removed = hunks.reduce((sum, hunk) => sum + hunk.oLength, 0);
        expect(o.length - removed).toBe(lcsLength(o, s));
      }),
      { numRuns: 500 },
    );
  });

  it('returns sorted, separated hunks with no empty hunk', () => {
    fc.assert(
      fc.property(linesArb, linesArb, (o, s) => {
        let oEnd = -1;
        let sEnd = -1;
        for (const hunk of diffLines(o, s)) {
          expect(hunk.oLength + hunk.sLength).toBeGreaterThan(0);
          expect(hunk.oStart).toBeGreaterThan(oEnd);
          expect(hunk.sStart).toBeGreaterThan(sEnd);
          oEnd = hunk.oStart + hunk.oLength;
          sEnd = hunk.sStart + hunk.sLength;
        }
      }),
      { numRuns: 500 },
    );
  });

  it('returns no hunks for equal lists, and one hunk for disjoint lists', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(diffLines(['a', 'b'], ['c'])).toEqual([
      { oStart: 0, oLength: 2, sStart: 0, sLength: 1 },
    ]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('throws DiffWorkLimitExceeded past the work limit', () => {
    const o = Array.from({ length: 200 }, (_, i) => `line ${i % 7}`);
    const s = o.toReversed();
    expect(() => diffLines(o, s, new WorkBudget(100))).toThrow(DiffWorkLimitExceeded);
    expect(apply(o, s, diffLines(o, s))).toEqual(s);
  });
});

describe('diff3Regions', () => {
  const text = (regions: ReturnType<typeof diff3Regions>): string[] | null => {
    const out: string[] = [];
    for (const region of regions) {
      if (!region.stable) return null;
      out.push(...region.lines);
    }
    return out;
  };

  it('takes the changed side when only one side changed', () => {
    fc.assert(
      fc.property(linesArb, linesArb, (o, s) => {
        expect(text(diff3Regions(s, o, o))).toEqual(s);
        expect(text(diff3Regions(o, o, s))).toEqual(s);
      }),
      { numRuns: 300 },
    );
  });

  it('returns spans that hold exactly the lines at their positions', () => {
    fc.assert(
      fc.property(linesArb, linesArb, linesArb, (a, o, b) => {
        for (const region of diff3Regions(a, o, b)) {
          if (region.stable) continue;
          expect(region.o.lines).toEqual(o.slice(region.o.start, region.o.start + region.o.length));
          expect(region.a.lines).toEqual(a.slice(region.a.start, region.a.start + region.a.length));
          expect(region.b.lines).toEqual(b.slice(region.b.start, region.b.start + region.b.length));
        }
      }),
      { numRuns: 500 },
    );
  });

  it('reports overlapping changes from both sides as one region', () => {
    const regions = diff3Regions(['x', 'A', 'y'], ['x', 'o', 'y'], ['x', 'B', 'y']);
    expect(regions).toEqual([
      { stable: true, lines: ['x'] },
      {
        stable: false,
        o: { start: 1, length: 1, lines: ['o'] },
        a: { start: 1, length: 1, lines: ['A'] },
        b: { start: 1, length: 1, lines: ['B'] },
      },
      { stable: true, lines: ['y'] },
    ]);
  });
});

describe('merge speed and the work limit', () => {
  /** A note made only of a repeated 5-line block, with edits at the top, middle, and end. */
  function repeated(lines: number, tag: string | null): string {
    const block = ['- [ ] task', '', 'some text', '', '---'];
    const out: string[] = [];
    while (out.length < lines) out.push(...block);
    out.length = lines;
    if (tag !== null) {
      out[Math.floor(lines / 2)] = `${tag} middle`;
      out.splice(1, 0, `${tag} top`);
      out.push(`${tag} end`);
    }
    return `${out.join('\n')}\n`;
  }

  it('merges a 20,000-line note of repeated lines quickly', () => {
    const base = repeated(20_000, null);
    const started = Date.now();
    const result = merge3({
      base,
      ours: repeated(20_000, 'ours'),
      theirs: repeated(20_000, 'theirs'),
    });
    const ms = Date.now() - started;
    expect(result.status).toBe('conflict');
    expect(ms).toBeLessThan(2_000);
  });

  it('returns a work-limit conflict instead of running without bound', () => {
    const started = Date.now();
    // Every line occurs twice, so there are no anchors to split the note.
    const o = Array.from({ length: 10_000 }, (_, i) => `line ${i % 5_000}`);
    const base = `${o.join('\n')}\n`;
    const ours = `${o.toReversed().join('\n')}\n`;
    const theirs = `${['new first line', ...o].join('\n')}\n`;
    const result = merge3({ base, ours, theirs });
    expect(result).toMatchObject({
      status: 'conflict',
      conflicts: expect.arrayContaining([{ kind: 'work-limit' }]),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
