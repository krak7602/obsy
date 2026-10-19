import { diff3MergeRegions } from 'node-diff3';

/** A range of lines: `start` is a 0-based line index, `length` a line count. */
export interface LineRange {
  readonly start: number;
  readonly length: number;
}

/** A region where both sides changed overlapping or adjacent lines of the base. */
export interface LineConflict {
  readonly base: LineRange;
  readonly ours: LineRange;
  readonly theirs: LineRange;
}

export type LineMergeResult =
  | {
      readonly clean: true;
      readonly lines: string[];
      /** Regions where both sides inserted different lines, kept theirs first. */
      readonly unionInserts: number;
      /** Regions where one side's insert contained the other's, kept once. */
      readonly containedInserts: number;
    }
  | { readonly clean: false; readonly conflicts: LineConflict[] };

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === '';
}

type InsertResolution = { readonly lines: string[]; readonly kind: 'union' | 'contained' };

/**
 * Resolves two different inserts at the same anchor. Neither side deleted a
 * base line. `first` is the side that committed first (theirs).
 *
 * Lines that both inserts share at the start or the end are kept once. When
 * one insert then contains the other, the result is the larger insert. Else
 * the result is the shared start, the rest of `first`, the rest of `second`,
 * and the shared end. Blank lines at the edge of a shared start or end stay
 * with each insert, so that two paragraphs or blocks stay separate.
 */
function resolveInserts(first: readonly string[], second: readonly string[]): InsertResolution {
  const shortest = Math.min(first.length, second.length);
  let prefix = 0;
  while (prefix < shortest && first[prefix] === second[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    first[first.length - 1 - suffix] === second[second.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (prefix + suffix === first.length) return { lines: [...second], kind: 'contained' };
  if (prefix + suffix === second.length) return { lines: [...first], kind: 'contained' };

  while (prefix > 0 && isBlank(first[prefix - 1])) prefix--;
  while (suffix > 0 && isBlank(first[first.length - suffix])) suffix--;
  return {
    lines: [
      ...first.slice(0, first.length - suffix),
      ...second.slice(prefix, second.length - suffix),
      ...first.slice(first.length - suffix),
    ],
    kind: 'union',
  };
}

interface Anchor {
  readonly o: number;
  readonly a: number;
  readonly b: number;
}

/** Maps each line to its index, or to -1 when the line occurs more than once. */
function positions(lines: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  lines.forEach((line, i) => result.set(line, result.has(line) ? -1 : i));
  return result;
}

/** Longest subsequence of `items` (in order) whose `key` strictly increases. */
function longestIncreasing<T>(items: readonly T[], key: (item: T) => number): T[] {
  const tails: number[] = [];
  const previous: number[] = Array.from({ length: items.length }, () => -1);
  items.forEach((item, i) => {
    const value = key(item);
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (key(items[tails[mid] ?? 0] as T) < value) low = mid + 1;
      else high = mid;
    }
    previous[i] = low > 0 ? (tails[low - 1] ?? -1) : -1;
    tails[low] = i;
  });
  const result: T[] = [];
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i] ?? -1) {
    result.push(items[i] as T);
  }
  return result.reverse();
}

/**
 * Finds anchor lines: lines that occur exactly once in each list, in the
 * same order in all three. Anchors are unchanged on both sides, so changes
 * on different sides of an anchor never touch, and the lists can be merged
 * one segment at a time. This is the idea behind patience diff.
 */
function findAnchors(o: readonly string[], a: readonly string[], b: readonly string[]): Anchor[] {
  const inA = positions(a);
  const inB = positions(b);
  const candidates: Anchor[] = [];
  for (const [line, io] of positions(o)) {
    const ia = inA.get(line) ?? -1;
    const ib = inB.get(line) ?? -1;
    if (io >= 0 && ia >= 0 && ib >= 0) candidates.push({ o: io, a: ia, b: ib });
  }
  // Filter by ours' order then theirs', and the other way round. Choose by a
  // rule that does not depend on which side is ours, so that swapping the
  // sides gives the same anchors.
  const byA = (anchor: Anchor): number => anchor.a;
  const byB = (anchor: Anchor): number => anchor.b;
  const first = longestIncreasing(longestIncreasing(candidates, byA), byB);
  const second = longestIncreasing(longestIncreasing(candidates, byB), byA);
  if (first.length !== second.length) return first.length > second.length ? first : second;
  for (let i = 0; i < first.length; i++) {
    const x = first[i]?.o ?? 0;
    const y = second[i]?.o ?? 0;
    if (x !== y) return x < y ? first : second;
  }
  return first;
}

class MergeState {
  readonly lines: string[] = [];
  readonly conflicts: LineConflict[] = [];
  unionInserts = 0;
  containedInserts = 0;

  /** Merges one segment. Offsets map segment indices to indices in the full lists. */
  segment(
    o: string[],
    a: string[],
    b: string[],
    offset: { readonly o: number; readonly a: number; readonly b: number },
  ): void {
    if (sameLines(a, b) || sameLines(o, b)) {
      this.lines.push(...a);
      return;
    }
    if (sameLines(o, a)) {
      this.lines.push(...b);
      return;
    }
    for (const region of diff3MergeRegions(a, o, b)) {
      if (region.stable) {
        this.lines.push(...region.bufferContent);
      } else if (sameLines(region.aContent, region.bContent)) {
        this.lines.push(...region.aContent);
      } else if (region.oLength === 0) {
        const resolution = resolveInserts(region.bContent, region.aContent);
        this.lines.push(...resolution.lines);
        if (resolution.kind === 'union') this.unionInserts++;
        else this.containedInserts++;
      } else {
        this.conflicts.push({
          base: { start: offset.o + region.oStart, length: region.oLength },
          ours: { start: offset.a + region.aStart, length: region.aLength },
          theirs: { start: offset.b + region.bStart, length: region.bLength },
        });
      }
    }
  }
}

export interface MergeLinesOptions {
  /**
   * Split the lists at anchor lines before the diff. Default true. Without
   * anchors, node-diff3 aligns the whole lists, which is slow for long
   * notes. Tests turn this off to compare the two alignments.
   */
  readonly anchors?: boolean;
}

/**
 * Three-way merges line lists.
 *
 * - A change on one side only is applied.
 * - The same change on both sides is applied once.
 * - Different inserts at the same base position, with no deleted base line,
 *   are both kept: theirs first, then ours (see `resolveInserts`).
 * - Any other pair of changes that overlap or touch is a conflict.
 *
 * Lines that all three lists share at the start are set aside first. The
 * rest is split at anchor lines (see `findAnchors`), and node-diff3 merges
 * each segment.
 *
 * Lines shared at the end are not set aside. Doing so moves an ambiguous
 * insert or delete among repeated lines (often blank lines) to its earliest
 * position. That can join two inserts that git keeps apart, and move an
 * insert away from its context. git moves such changes to their latest
 * position, and trimming only the start keeps that bias.
 */
export function mergeLines(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  options: MergeLinesOptions = {},
): LineMergeResult {
  const shortest = Math.min(base.length, ours.length, theirs.length);
  let prefix = 0;
  while (prefix < shortest && base[prefix] === ours[prefix] && base[prefix] === theirs[prefix]) {
    prefix++;
  }
  const o = base.slice(prefix);
  const a = ours.slice(prefix);
  const b = theirs.slice(prefix);

  const state = new MergeState();
  state.lines.push(...base.slice(0, prefix));
  const anchors = (options.anchors ?? true) ? findAnchors(o, a, b) : [];
  let from: Anchor = { o: 0, a: 0, b: 0 };
  for (const anchor of [...anchors, { o: o.length, a: a.length, b: b.length }]) {
    state.segment(o.slice(from.o, anchor.o), a.slice(from.a, anchor.a), b.slice(from.b, anchor.b), {
      o: prefix + from.o,
      a: prefix + from.a,
      b: prefix + from.b,
    });
    if (anchor.o < o.length) state.lines.push(o[anchor.o] ?? '');
    from = { o: anchor.o + 1, a: anchor.a + 1, b: anchor.b + 1 };
  }

  if (state.conflicts.length > 0) return { clean: false, conflicts: state.conflicts };
  return {
    clean: true,
    lines: state.lines,
    unionInserts: state.unionInserts,
    containedInserts: state.containedInserts,
  };
}

/**
 * Returns true when `longer` strictly extends `shorter`: the texts differ,
 * and `shorter` is `longer` with whole lines removed.
 *
 * Each line of `shorter` must match a line of `longer`, in order. A line
 * break of `shorter` must be kept in `longer`. Only the last line of
 * `shorter` may lack a line break that its match in `longer` has, so
 * adding a final line break counts as an extension.
 */
export function strictlyExtends(
  longer: readonly string[],
  longerFinalNewline: boolean,
  shorter: readonly string[],
  shorterFinalNewline: boolean,
): boolean {
  if (shorter.length > longer.length) return false;
  if (shorter.length === longer.length) {
    // Same line count: only a final line break may be added.
    return sameLines(longer, shorter) && longerFinalNewline && !shorterFinalNewline;
  }
  if (shorter.length === 0) return true;

  // Leftmost match keeps the most room for the line-break rule below.
  let matched = -1;
  let next = 0;
  for (const line of shorter) {
    while (next < longer.length && longer[next] !== line) next++;
    if (next === longer.length) return false;
    matched = next;
    next++;
  }
  const lastMatchHasBreak = matched < longer.length - 1 || longerFinalNewline;
  return !shorterFinalNewline || lastMatchHasBreak;
}
