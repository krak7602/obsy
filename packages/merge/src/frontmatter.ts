import { mergeLines } from './lines';

/**
 * A Markdown text split at its frontmatter. Line numbers of the body start
 * at `bodyStart` in the full text.
 */
export interface SplitText {
  /** Lines between the two `---` fences, or null when there is no frontmatter. */
  readonly frontmatter: string[] | null;
  readonly body: string[];
  readonly bodyStart: number;
}

const FENCE = '---';

/**
 * Splits off a leading frontmatter block. The first line must be exactly
 * `---`, and a later line must be exactly `---`. Else the whole text is
 * body. A `...` line does not close frontmatter.
 */
export function splitFrontmatter(lines: string[]): SplitText {
  if (lines[0] === FENCE) {
    const close = lines.indexOf(FENCE, 1);
    if (close !== -1) {
      return {
        frontmatter: lines.slice(1, close),
        body: lines.slice(close + 1),
        bodyStart: close + 1,
      };
    }
  }
  return { frontmatter: null, body: lines, bodyStart: 0 };
}

/** Joins a split text back into lines. */
export function joinFrontmatter(
  frontmatter: readonly string[] | null,
  body: readonly string[],
): string[] {
  return frontmatter === null ? [...body] : [FENCE, ...frontmatter, FENCE, ...body];
}

interface Entry {
  readonly key: string;
  readonly lines: string[];
}

/**
 * Frontmatter split into top-level keys. `preamble` holds blank and
 * comment lines before the first key. Each entry holds a key line and the
 * lines after it up to the next key line: indented lines, `- ` items,
 * blank lines, and comments.
 */
interface Entries {
  readonly preamble: string[];
  readonly entries: Entry[];
}

const QUOTED_KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:(?:\s|$)/;
const PLAIN_KEY = /^([^\s#'"?:,[\]{}&*!|>%@`-][^\r\n]*?)[ \t]*:(?:\s|$)/;
const SEQUENCE_ITEM = /^-(?:\s|$)/;

function keyOf(line: string): string | null {
  const match = QUOTED_KEY.exec(line) ?? PLAIN_KEY.exec(line);
  return match?.[1] ?? null;
}

/**
 * Splits frontmatter into top-level keys. Returns null when the block is
 * not a plain top-level mapping that this splitter understands, or when a
 * key appears twice. The caller then treats the block as one unit.
 */
function parseEntries(lines: readonly string[]): Entries | null {
  const preamble: string[] = [];
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let current: Entry | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const first = line.charAt(0);
    if (trimmed === '' || trimmed.startsWith('#')) {
      // Blank or comment line: belongs to the entry above, or the preamble.
      (current?.lines ?? preamble).push(line);
    } else if (first === ' ' || first === '\t' || SEQUENCE_ITEM.test(line)) {
      if (current === null) return null;
      current.lines.push(line);
    } else {
      const key = keyOf(line);
      if (key === null || seen.has(key)) return null;
      seen.add(key);
      current = { key, lines: [line] };
      entries.push(current);
    }
  }
  return { preamble, entries };
}

function renderEntries(value: Entries): string[] {
  return [...value.preamble, ...value.entries.flatMap((entry) => entry.lines)];
}

function sameLines(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

export type FrontmatterConflictReason =
  /** Both sides changed frontmatter that is not a plain top-level mapping. */
  | 'unparsed'
  /** One side removed the frontmatter and the other side changed it. */
  | 'presence'
  /** Both sides moved keys, into different orders. */
  | 'order'
  /** Both sides changed the blank or comment lines before the first key. */
  | 'preamble'
  /** The merged block did not split back into the same keys. */
  | 'invalid-result';

export type FrontmatterConflict =
  | { readonly kind: 'frontmatter'; readonly reason: FrontmatterConflictReason }
  | { readonly kind: 'frontmatter-key'; readonly key: string };

export type FrontmatterMergeResult =
  | {
      readonly clean: true;
      readonly frontmatter: string[] | null;
      /** Both sides changed the frontmatter, and it was merged key by key. */
      readonly keyMerged: boolean;
      readonly unionInserts: number;
      readonly containedInserts: number;
    }
  | { readonly clean: false; readonly conflicts: FrontmatterConflict[] };

type ValueMerge =
  | {
      readonly clean: true;
      readonly lines: string[] | undefined;
      readonly union: number;
      readonly contained: number;
    }
  | { readonly clean: false };

/**
 * Three-way merges one value. `undefined` means absent. When both sides
 * changed a present value, the lines are merged with `mergeLines`.
 */
function mergeValue(
  base: string[] | undefined,
  ours: string[] | undefined,
  theirs: string[] | undefined,
): ValueMerge {
  if (sameLines(ours, theirs)) return { clean: true, lines: ours, union: 0, contained: 0 };
  if (sameLines(base, ours)) return { clean: true, lines: theirs, union: 0, contained: 0 };
  if (sameLines(base, theirs)) return { clean: true, lines: ours, union: 0, contained: 0 };
  if (base === undefined || ours === undefined || theirs === undefined) return { clean: false };
  const merged = mergeLines(base, ours, theirs);
  if (!merged.clean) return { clean: false };
  return {
    clean: true,
    lines: merged.lines,
    union: merged.unionInserts,
    contained: merged.containedInserts,
  };
}

/** True when `side` lists the keys it shares with `base` in a different order. */
function reordered(side: readonly string[], base: readonly string[]): boolean {
  const inBase = new Set(base);
  const inSide = new Set(side);
  const sideShared = side.filter((key) => inBase.has(key));
  const baseShared = base.filter((key) => inSide.has(key));
  return !sameLines(sideShared, baseShared);
}

/**
 * Three-way merges frontmatter blocks. `null` means no frontmatter.
 *
 * When only one side changed the block, that side's block is used as is.
 * When both changed it, keys are merged one by one: a key changed on one
 * side takes that change; a key changed on both sides is merged line by
 * line, and conflicts if that fails. A key added on both sides with
 * different values, or removed on one side and changed on the other,
 * conflicts. Key order follows theirs, or ours when only ours moved keys.
 * Keys added by the other side are placed after the key they follow there.
 */
export function mergeFrontmatter(
  base: string[] | null,
  ours: string[] | null,
  theirs: string[] | null,
): FrontmatterMergeResult {
  const unchanged = (frontmatter: string[] | null): FrontmatterMergeResult => ({
    clean: true,
    frontmatter,
    keyMerged: false,
    unionInserts: 0,
    containedInserts: 0,
  });
  const conflict = (reason: FrontmatterConflictReason): FrontmatterMergeResult => ({
    clean: false,
    conflicts: [{ kind: 'frontmatter', reason }],
  });

  const absent = (value: string[] | null): string[] | undefined => value ?? undefined;
  if (sameLines(absent(ours), absent(theirs))) return unchanged(ours);
  if (sameLines(absent(base), absent(ours))) return unchanged(theirs);
  if (sameLines(absent(base), absent(theirs))) return unchanged(ours);
  if (ours === null || theirs === null) return conflict('presence');

  // Both sides added frontmatter: merge against an empty mapping.
  const baseEntries = parseEntries(base ?? []);
  const ourEntries = parseEntries(ours);
  const theirEntries = parseEntries(theirs);
  if (baseEntries === null || ourEntries === null || theirEntries === null)
    return conflict('unparsed');

  const preamble = mergeValue(baseEntries.preamble, ourEntries.preamble, theirEntries.preamble);
  if (!preamble.clean) return conflict('preamble');

  const toMap = (value: Entries): Map<string, string[]> =>
    new Map(value.entries.map((entry) => [entry.key, entry.lines]));
  const baseMap = toMap(baseEntries);
  const ourMap = toMap(ourEntries);
  const theirMap = toMap(theirEntries);
  const baseKeys = baseEntries.entries.map((entry) => entry.key);
  const ourKeys = ourEntries.entries.map((entry) => entry.key);
  const theirKeys = theirEntries.entries.map((entry) => entry.key);

  const merged = new Map<string, string[]>();
  const conflicts: FrontmatterConflict[] = [];
  let unionInserts = preamble.union;
  let containedInserts = preamble.contained;
  // Base order, then added keys sorted, so that the conflict list does not
  // depend on which side is ours.
  const added = [...new Set([...ourKeys, ...theirKeys])]
    .filter((key) => !baseMap.has(key))
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const allKeys = [...baseKeys, ...added];
  for (const key of allKeys) {
    const value = mergeValue(baseMap.get(key), ourMap.get(key), theirMap.get(key));
    if (!value.clean) {
      conflicts.push({ kind: 'frontmatter-key', key });
    } else if (value.lines !== undefined) {
      merged.set(key, value.lines);
      unionInserts += value.union;
      containedInserts += value.contained;
    }
  }
  if (conflicts.length > 0) return { clean: false, conflicts };

  const oursMoved = reordered(ourKeys, baseKeys);
  const theirsMoved = reordered(theirKeys, baseKeys);
  if (oursMoved && theirsMoved) {
    const inAll = (key: string): boolean =>
      baseMap.has(key) && ourMap.has(key) && theirMap.has(key);
    if (!sameLines(ourKeys.filter(inAll), theirKeys.filter(inAll))) return conflict('order');
  }
  const [skeleton, other] = oursMoved && !theirsMoved ? [ourKeys, theirKeys] : [theirKeys, ourKeys];

  const order = skeleton.filter((key) => merged.has(key));
  const placed = new Set(order);
  let after: string | null = null;
  for (const key of other) {
    if (merged.has(key) && !placed.has(key)) {
      const at = after === null ? 0 : order.indexOf(after) + 1;
      order.splice(at, 0, key);
      placed.add(key);
    }
    if (placed.has(key)) after = key;
  }

  const result: Entries = {
    preamble: preamble.lines ?? [],
    entries: order.map((key) => ({ key, lines: merged.get(key) ?? [] })),
  };
  const rendered = renderEntries(result);
  const check = parseEntries(rendered);
  if (
    check === null ||
    !sameLines(
      check.entries.map((entry) => entry.key),
      order,
    )
  ) {
    return conflict('invalid-result');
  }
  return { clean: true, frontmatter: rendered, keyMerged: true, unionInserts, containedInserts };
}
