import {
  joinFrontmatter,
  mergeFrontmatter,
  splitFrontmatter,
  type FrontmatterConflict,
} from './frontmatter';
import { mergeLines, strictlyExtends, type LineRange } from './lines';
import { decode, encode, lineEndingOf, type DecodedText, type LineEnding } from './text';

/** The three texts of a merge. */
export interface MergeInput {
  /**
   * The common ancestor: the file at the operation's `baseRev`. Use null
   * when there is no common ancestor, for example when two devices created
   * the same path independently.
   */
  readonly base: string | null;
  /** The local version: the change that is being committed. */
  readonly ours: string;
  /** The current committed head. It was committed first. */
  readonly theirs: string;
}

/** A rule that the merge used in addition to a plain line-level diff3. */
export type MergeRule =
  /** Both sides inserted different lines at one base position. Both kept, theirs first. */
  | 'union-insert'
  /** Both sides inserted at one base position, and one insert contained the other. Kept once. */
  | 'contained-insert'
  /** Both sides changed the frontmatter. It was merged key by key. */
  | 'frontmatter-keys'
  /**
   * The three texts did not share one line-ending style or byte order mark.
   * Lines were compared without line breaks, and the style was resolved
   * three-way.
   */
  | 'text-format'
  /** There was no base, and one side strictly extended the other. */
  | 'no-base-extends';

const RULE_ORDER: readonly MergeRule[] = [
  'union-insert',
  'contained-insert',
  'frontmatter-keys',
  'text-format',
  'no-base-extends',
];

/** One reason why a merge is not clean. */
export type MergeConflict =
  /** There was no base, and neither side strictly extends the other. */
  | { readonly kind: 'no-base' }
  /**
   * Both sides changed overlapping or adjacent lines. Each range is a
   * 0-based line index and a line count in that text, counted after the
   * byte order mark.
   */
  | {
      readonly kind: 'lines';
      readonly base: LineRange;
      readonly ours: LineRange;
      readonly theirs: LineRange;
    }
  /** The sides changed the line-ending style in different ways. */
  | { readonly kind: 'line-endings' }
  /**
   * Aligning the body needed more work than the merge allows, for example
   * after heavy reordering of a long note. The merge gives up safely.
   */
  | { readonly kind: 'work-limit' }
  | FrontmatterConflict;

export interface CleanMerge {
  readonly status: 'clean';
  /** The merged text, to commit as the new revision. */
  readonly text: string;
  /** Rules used beyond a plain line-level diff3, in a fixed order. */
  readonly rules: readonly MergeRule[];
}

/**
 * The merge is not clean. The caller keeps `keep` (theirs, the current
 * head) at the path and writes `copy` (ours) as a conflict copy. The merge
 * never produces conflict markers.
 */
export interface ConflictMerge {
  readonly status: 'conflict';
  /** The text that stays at the path: theirs. */
  readonly keep: string;
  /** The text to write as the conflict copy: ours. */
  readonly copy: string;
  /** At least one reason, in text order where that applies. */
  readonly conflicts: readonly MergeConflict[];
}

export type MergeResult = CleanMerge | ConflictMerge;

function clean(text: string, rules: ReadonlySet<MergeRule> = new Set()): CleanMerge {
  return { status: 'clean', text, rules: RULE_ORDER.filter((rule) => rules.has(rule)) };
}

function conflict(input: MergeInput, conflicts: readonly MergeConflict[]): ConflictMerge {
  return { status: 'conflict', keep: input.theirs, copy: input.ours, conflicts };
}

const known = (eol: LineEnding): boolean => eol === 'lf' || eol === 'crlf';

/**
 * Resolves the output line-ending style three-way. A text without a line
 * break (`none`) has no style. Returns null when both sides have different
 * styles and the base does not show which side changed.
 */
function mergeLineEnding(
  base: LineEnding,
  ours: LineEnding,
  theirs: LineEnding,
): LineEnding | null {
  if (!known(ours)) return known(theirs) ? theirs : known(base) ? base : 'lf';
  if (!known(theirs) || ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  return null;
}

function mergeNoBase(input: MergeInput): MergeResult {
  const { ours, theirs } = input;
  const raw = lineEndingOf(ours) === 'mixed' || lineEndingOf(theirs) === 'mixed';
  const a = decode(ours, raw);
  const b = decode(theirs, raw);
  const sameFormat = a.bom === b.bom && (!known(a.eol) || !known(b.eol) || a.eol === b.eol);
  if (sameFormat) {
    if (strictlyExtends(a.lines, a.finalNewline, b.lines, b.finalNewline)) {
      return clean(ours, new Set(['no-base-extends']));
    }
    if (strictlyExtends(b.lines, b.finalNewline, a.lines, a.finalNewline)) {
      return clean(theirs, new Set(['no-base-extends']));
    }
  }
  return conflict(input, [{ kind: 'no-base' }]);
}

function shift(range: LineRange, offset: number): LineRange {
  return { start: range.start + offset, length: range.length };
}

/**
 * Merges two versions of a Markdown text against their common base.
 *
 * The function is pure and deterministic. It never returns conflict
 * markers. It treats every input as text; the caller must not send binary
 * files. See docs/subsystems/merge.md for the rules.
 */
export function merge3(input: MergeInput): MergeResult {
  const { base, ours, theirs } = input;
  if (ours === theirs) return clean(ours);
  if (base === null) return mergeNoBase(input);
  if (base === ours) return clean(theirs);
  if (base === theirs) return clean(ours);

  const raw = [base, ours, theirs].some((text) => lineEndingOf(text) === 'mixed');
  const [o, a, b] = [base, ours, theirs].map((text) => decode(text, raw)) as [
    DecodedText,
    DecodedText,
    DecodedText,
  ];

  const rules = new Set<MergeRule>();
  const conflicts: MergeConflict[] = [];

  const bom = a.bom === o.bom ? b.bom : a.bom;
  let eol: LineEnding = 'lf';
  if (!raw) {
    const merged = mergeLineEnding(o.eol, a.eol, b.eol);
    if (merged === null) conflicts.push({ kind: 'line-endings' });
    else eol = merged;
  }
  const styles = new Set([o.eol, a.eol, b.eol].filter(known));
  if (styles.size > 1 || a.bom !== o.bom || b.bom !== o.bom) rules.add('text-format');
  const finalNewline = a.finalNewline === o.finalNewline ? b.finalNewline : a.finalNewline;

  const so = splitFrontmatter(o.lines);
  const sa = splitFrontmatter(a.lines);
  const sb = splitFrontmatter(b.lines);

  const frontmatter = mergeFrontmatter(so.frontmatter, sa.frontmatter, sb.frontmatter);
  if (frontmatter.clean) {
    if (frontmatter.keyMerged) rules.add('frontmatter-keys');
    if (frontmatter.unionInserts > 0) rules.add('union-insert');
    if (frontmatter.containedInserts > 0) rules.add('contained-insert');
  } else {
    conflicts.push(...frontmatter.conflicts);
  }

  const body = mergeLines(so.body, sa.body, sb.body);
  if (body.clean) {
    if (body.unionInserts > 0) rules.add('union-insert');
    if (body.containedInserts > 0) rules.add('contained-insert');
  } else {
    if (body.workLimitExceeded) conflicts.push({ kind: 'work-limit' });
    for (const region of body.conflicts) {
      conflicts.push({
        kind: 'lines',
        base: shift(region.base, so.bodyStart),
        ours: shift(region.ours, sa.bodyStart),
        theirs: shift(region.theirs, sb.bodyStart),
      });
    }
  }

  if (conflicts.length > 0 || !frontmatter.clean || !body.clean) return conflict(input, conflicts);
  const lines = joinFrontmatter(frontmatter.frontmatter, body.lines);
  return clean(encode(lines, finalNewline, eol, bom), rules);
}
