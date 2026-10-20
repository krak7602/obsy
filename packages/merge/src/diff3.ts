import { diffLines, WorkBudget, type Hunk } from './diff';

/** A run of lines in one list: `start` is a 0-based index. */
export interface Span {
  readonly start: number;
  readonly length: number;
  readonly lines: string[];
}

/**
 * One region of a three-way comparison.
 *
 * - `stable`: the lines to keep. Either both sides left the base unchanged
 *   here, or only one side changed it.
 * - not `stable`: both sides changed overlapping or adjacent base lines.
 *   The spans hold each list's lines for the region.
 */
export type Diff3Region =
  | { readonly stable: true; readonly lines: string[] }
  | { readonly stable: false; readonly o: Span; readonly a: Span; readonly b: Span };

interface SideHunk extends Hunk {
  readonly side: 'a' | 'b';
}

function span(lines: readonly string[], start: number, end: number): Span {
  return { start, length: end - start, lines: lines.slice(start, end) };
}

/**
 * Compares two changed line lists, `a` and `b`, with their common base `o`.
 *
 * This is the classic diff3 procedure: diff `o` against each side, sort the
 * changes by base position, and join changes that overlap or touch in the
 * base into one region. A region with a change from one side only takes
 * that side's lines. A region with changes from both sides is returned with
 * all three spans, for the caller to resolve.
 *
 * Both diffs take line comparisons from `budget`. Throws
 * `DiffWorkLimitExceeded` from `diffLines`.
 */
export function diff3Regions(
  a: readonly string[],
  o: readonly string[],
  b: readonly string[],
  budget: WorkBudget = new WorkBudget(),
): Diff3Region[] {
  const hunks: SideHunk[] = [
    ...diffLines(o, a, budget).map((hunk): SideHunk => ({ ...hunk, side: 'a' })),
    ...diffLines(o, b, budget).map((hunk): SideHunk => ({ ...hunk, side: 'b' })),
  ];
  // Stable sort: at the same base position, `a` hunks come first.
  hunks.sort((x, y) => x.oStart - y.oStart);

  const regions: Diff3Region[] = [];
  let done = 0;
  const keepBase = (end: number): void => {
    if (end > done) regions.push({ stable: true, lines: o.slice(done, end) });
  };

  let next = 0;
  while (next < hunks.length) {
    const first = hunks[next] as SideHunk;
    const group: SideHunk[] = [first];
    const start = first.oStart;
    let end = first.oStart + first.oLength;
    next++;
    // Two hunks of one side are always separated by a common line, so a
    // group of two or more hunks always holds both sides.
    while (next < hunks.length && (hunks[next] as SideHunk).oStart <= end) {
      const hunk = hunks[next] as SideHunk;
      end = Math.max(end, hunk.oStart + hunk.oLength);
      group.push(hunk);
      next++;
    }

    keepBase(start);
    if (group.length === 1) {
      const lines = first.side === 'a' ? a : b;
      if (first.sLength > 0) {
        regions.push({
          stable: true,
          lines: lines.slice(first.sStart, first.sStart + first.sLength),
        });
      }
    } else {
      regions.push({
        stable: false,
        o: span(o, start, end),
        a: sideSpan(a, group, 'a', start, end),
        b: sideSpan(b, group, 'b', start, end),
      });
    }
    done = end;
  }
  keepBase(o.length);
  return regions;
}

/**
 * The span of one side that covers base lines `start` to `end`. Outside its
 * own hunks, a side matches the base line for line, so the span extends the
 * side's changed lines by the same number of lines as the region extends
 * past that side's hunks in the base.
 */
function sideSpan(
  lines: readonly string[],
  group: readonly SideHunk[],
  side: 'a' | 'b',
  start: number,
  end: number,
): Span {
  const own = group.filter((hunk) => hunk.side === side);
  if (own.length === 0) return span(lines, start, end);
  const firstHunk = own[0] as SideHunk;
  const lastHunk = own.at(-1) as SideHunk;
  const from = firstHunk.sStart - (firstHunk.oStart - start);
  const to = lastHunk.sStart + lastHunk.sLength + (end - lastHunk.oStart - lastHunk.oLength);
  return span(lines, from, to);
}
