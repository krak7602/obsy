import diffSequences from '@jest/diff-sequences';

/**
 * One change between two line lists: `oLength` lines of the old list at
 * `oStart` are replaced by `sLength` lines of the new list at `sStart`.
 */
export interface Hunk {
  readonly oStart: number;
  readonly oLength: number;
  readonly sStart: number;
  readonly sLength: number;
}

/**
 * Default work limit for one merge, counted in line comparisons across all
 * of its diffs. A small edit to a 20,000-line note needs far less than 1%
 * of it. Heavy reordering of a long note with repeated lines can exceed it
 * (about 0.4 s on an Apple M4 Pro); the merge then returns a conflict.
 */
export const DEFAULT_DIFF_WORK_LIMIT = 50_000_000;

/** Line comparisons left. Diffs that share a budget share one limit. */
export class WorkBudget {
  remaining: number;

  constructor(readonly limit: number = DEFAULT_DIFF_WORK_LIMIT) {
    this.remaining = limit;
  }
}

/** The diffs needed more line comparisons than their budget allows. */
export class DiffWorkLimitExceeded extends Error {
  constructor(readonly limit: number) {
    super(`diff work limit of ${limit} line comparisons exceeded`);
    this.name = 'DiffWorkLimitExceeded';
  }
}

/**
 * Returns the changes from `o` to `s` as a minimal line diff, in order.
 *
 * This is the only place that chooses a diff algorithm. It uses the Myers
 * O(ND) algorithm from `@jest/diff-sequences`, so the cost grows with the
 * size of the change, not with how often lines repeat. Before the diff,
 * lines that do not occur in the other list are set aside: they can never
 * match, and removing them keeps a large rewrite cheap. The longest common
 * subsequence is the same with or without them. After the diff, changes are
 * slid over runs of equal lines (see `slideChanges`).
 *
 * Each line comparison takes one unit from `budget`. Throws
 * `DiffWorkLimitExceeded` when the budget runs out.
 */
export function diffLines(
  o: readonly string[],
  s: readonly string[],
  budget: WorkBudget = new WorkBudget(),
): Hunk[] {
  // Number each distinct line, so the diff compares integers.
  const ids = new Map<string, number>();
  const idOf = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const oIds = o.map(idOf);
  const sIds = s.map(idOf);
  const inO = new Set(oIds);
  const inS = new Set(sIds);
  const oKept: number[] = [];
  const sKept: number[] = [];
  oIds.forEach((id, i) => {
    if (inS.has(id)) oKept.push(i);
  });
  sIds.forEach((id, i) => {
    if (inO.has(id)) sKept.push(i);
  });

  // 1 marks a line that is not part of the common subsequence.
  const oChanged = new Uint8Array(o.length).fill(1);
  const sChanged = new Uint8Array(s.length).fill(1);
  diffSequences(
    oKept.length,
    sKept.length,
    (i, j) => {
      budget.remaining--;
      if (budget.remaining < 0) throw new DiffWorkLimitExceeded(budget.limit);
      return oIds[oKept[i] ?? -1] === sIds[sKept[j] ?? -1];
    },
    (count, i, j) => {
      for (let k = 0; k < count; k++) {
        oChanged[oKept[i + k] ?? 0] = 0;
        sChanged[sKept[j + k] ?? 0] = 0;
      }
    },
  );

  slideChanges(oIds, oChanged, sChanged);
  slideChanges(sIds, sChanged, oChanged);
  return hunksOf(oChanged, sChanged);
}

/** Turns change marks into hunks. Unchanged lines pair up in order. */
function hunksOf(oChanged: Uint8Array, sChanged: Uint8Array): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < oChanged.length || j < sChanged.length) {
    if (oChanged[i] === 0 && sChanged[j] === 0) {
      i++;
      j++;
      continue;
    }
    const oStart = i;
    const sStart = j;
    while (oChanged[i] === 1) i++;
    while (sChanged[j] === 1) j++;
    hunks.push({ oStart, oLength: i - oStart, sStart, sLength: j - sStart });
  }
  return hunks;
}

/**
 * Moves each run of changed lines in one list to a better place among
 * equal lines, without changing the size of the diff.
 *
 * When a run of changed lines is next to a run of equal lines, any of
 * several positions gives a minimal diff. Deleting one of three blank
 * lines is an example. The diff algorithm picks one position by chance.
 * Merges need a stable, predictable choice, and the choice decides whether
 * two nearby changes touch. This follows git's documented behaviour:
 *
 * 1. Slide the run up as far as equal lines allow, then down as far as
 *    they allow. A run that reaches another changed run joins it, and the
 *    slide repeats until the run stops growing.
 * 2. Prefer the lowest position where the run lines up with a run of
 *    changed lines in the other list (a replacement, not a pure insert or
 *    delete). Else keep the lowest position.
 *
 * Sliding a run by one line swaps a changed line and an unchanged line
 * with the same content, so the unchanged lines still pair with equal
 * lines in the other list.
 */
function slideChanges(ids: readonly number[], changed: Uint8Array, other: Uint8Array): void {
  // Indices of unchanged lines in the other list. A run in this list that
  // has `u` unchanged lines before it lines up with the other list's run
  // between its unchanged lines `u - 1` and `u`.
  const otherUnchanged: number[] = [];
  other.forEach((mark, i) => {
    if (mark === 0) otherUnchanged.push(i);
  });
  const linesUpWithChange = (u: number): boolean =>
    (otherUnchanged[u] ?? other.length) - (otherUnchanged[u - 1] ?? -1) > 1;

  const n = ids.length;
  let unchangedBefore = 0;
  let i = 0;
  while (i < n) {
    if (changed[i] === 0) {
      unchangedBefore++;
      i++;
      continue;
    }
    let start = i;
    let end = i;
    while (end < n && changed[end] === 1) end++;
    let u = unchangedBefore;

    const slideUp = (): void => {
      changed[start - 1] = 1;
      changed[end - 1] = 0;
      start--;
      end--;
      u--;
    };

    let size: number;
    let earliestEnd: number;
    let alignedEnd: number;
    do {
      size = end - start;
      while (start > 0 && ids[start - 1] === ids[end - 1]) {
        slideUp();
        while (start > 0 && changed[start - 1] === 1) start--;
      }
      earliestEnd = end;
      alignedEnd = linesUpWithChange(u) ? end : -1;
      while (end < n && ids[start] === ids[end]) {
        changed[end] = 1;
        changed[start] = 0;
        start++;
        end++;
        u++;
        while (end < n && changed[end] === 1) end++;
        if (linesUpWithChange(u)) alignedEnd = end;
      }
    } while (end - start !== size);

    if (end !== earliestEnd && alignedEnd !== -1) {
      while (end > alignedEnd) slideUp();
    }
    unchangedBefore = u;
    i = end;
  }
}
