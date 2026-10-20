/**
 * `git merge-file` as a test oracle for `merge3`, and the categories that
 * explain each disagreement.
 *
 * This file uses Node APIs. It must stay runnable by Node's type stripping
 * (the corpus runner imports it), so it uses erasable syntax only and
 * imports the merge function's types, not its code.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Diff3Region, MergeInput, MergeResult, MergeRule } from '../src/index.ts';

/** `diff3Regions` from `@obsy/merge`, passed in so that this file imports no code. */
export type Diff3Regions = (a: string[], o: string[], b: string[]) => Diff3Region[];

export interface GitResult {
  readonly clean: boolean;
  /** Merged text when clean; text with conflict markers otherwise. */
  readonly text: string;
}

/**
 * Runs `git merge-file -p` in a private temporary directory. User and
 * system git configuration are ignored, so local settings cannot change
 * the result. Call `dispose` when done.
 */
export class GitMergeFile {
  readonly #dir: string = mkdtempSync(join(tmpdir(), 'obsy-merge-oracle-'));

  run(base: string, ours: string, theirs: string): GitResult {
    const paths = ['ours', 'base', 'theirs'].map((name) => join(this.#dir, name));
    [ours, base, theirs].forEach((text, i) => writeFileSync(paths[i] ?? '', text));
    const result = spawnSync(
      'git',
      ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', ...paths],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
      },
    );
    if (result.status === null || result.status >= 128 || result.error !== undefined) {
      throw new Error(`git merge-file failed: ${result.error?.message ?? result.stderr}`);
    }
    return { clean: result.status === 0, text: result.stdout };
  }

  dispose(): void {
    rmSync(this.#dir, { recursive: true, force: true });
  }
}

/** Splits text the way git does: each line keeps its line break. */
export function gitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Plain diff3 on git's line model, with no Markdown layer and no anchors:
 * obsy's `diff3Regions`, where a region changed on both sides is a
 * conflict unless both sides made the same change. It separates diff
 * alignment differences from differences that obsy's own rules cause.
 */
export function plainDiff3(
  regionsOf: Diff3Regions,
  base: string,
  ours: string,
  theirs: string,
): GitResult {
  const text: string[] = [];
  for (const region of regionsOf(gitLines(ours), gitLines(base), gitLines(theirs))) {
    if (region.stable) text.push(...region.lines);
    else if (region.a.lines.join('') === region.b.lines.join('')) text.push(...region.a.lines);
    else return { clean: false, text: '' };
  }
  return { clean: true, text: text.join('') };
}

/**
 * How obsy and git compare on one case.
 *
 * - `agree-clean`, `agree-conflict`: same decision (and same text when clean).
 * - `obsy-only:<reason>`: obsy is clean, git conflicts. Expected for
 *   obsy's extra rules.
 * - `git-only:<reason>`: git is clean, obsy conflicts or returns another
 *   text. Every reason must be documented.
 */
export type Comparison =
  | 'agree-clean'
  | 'agree-conflict'
  | `obsy-only:${string}`
  | `git-only:${string}`;

const RULE_PRIORITY: readonly MergeRule[] = [
  'no-base-extends',
  'text-format',
  'frontmatter-keys',
  'union-insert',
  'contained-insert',
];

const nonBlank = (text: string): string[] => gitLines(text).filter((line) => line.trim() !== '');

function isSubsequence(short: readonly string[], long: readonly string[]): boolean {
  let at = 0;
  for (const line of long) if (line === short[at]) at++;
  return at === short.length;
}

/**
 * Explains two clean results with different text: the same non-blank
 * lines with other blank lines, or git keeping an identical insert twice.
 */
function textDifference(obsy: string, git: string): string {
  const a = nonBlank(obsy);
  const b = nonBlank(git);
  if (a.length === b.length && a.every((line, i) => line === b[i])) return 'blank-lines';
  if (a.length < b.length && isSubsequence(a, b) && b.every((line) => a.includes(line)))
    return 'git-duplicates';
  return 'different-text';
}

const FRONTMATTER = /^\uFEFF?---\r?\n(?:[^\n]*\n)*?---\r?(?:\n|$)/;

/** True when any text has frontmatter, which obsy merges apart from the body. */
function hasFrontmatter(input: MergeInput): boolean {
  return [input.base ?? '', input.ours, input.theirs].some((text) => FRONTMATTER.test(text));
}

function lacksFinalNewline(input: MergeInput): boolean {
  return [input.base ?? '', input.ours, input.theirs].some(
    (text) => text !== '' && !text.endsWith('\n'),
  );
}

/** Compares one obsy result with git's result on the same input. */
export function compare(
  input: MergeInput,
  obsy: MergeResult,
  git: GitResult,
  regionsOf: Diff3Regions,
): Comparison {
  const { ours, theirs } = input;
  const base = input.base ?? '';
  if (obsy.status === 'clean' && git.clean && obsy.text === git.text) return 'agree-clean';
  if (obsy.status === 'conflict' && !git.clean) return 'agree-conflict';
  const plain = plainDiff3(regionsOf, base, ours, theirs);
  const plainAgrees = plain.clean === git.clean && (!plain.clean || plain.text === git.text);

  if (obsy.status === 'clean' && !git.clean) {
    const rule = RULE_PRIORITY.find((r) => obsy.rules.includes(r));
    if (rule !== undefined) return `obsy-only:${rule}`;
    if (!plainAgrees) return 'obsy-only:diff3-alignment';
    if (hasFrontmatter(input)) return 'obsy-only:frontmatter-split';
    if (lacksFinalNewline(input)) return 'obsy-only:final-newline';
    // By elimination: plain diff3 agrees with git, so obsy's prefix
    // trim and anchors chose another alignment. Inspect these cases.
    return 'obsy-only:segment-alignment';
  }

  if (obsy.status === 'clean') {
    // Both clean, different text.
    const difference = textDifference(obsy.text, git.text);
    if (difference !== 'different-text') return `git-only:${difference}`;
    if (!plainAgrees) return 'git-only:diff3-alignment';
    // git can move a body line above frontmatter that one side added.
    if (hasFrontmatter(input)) return 'git-only:frontmatter-split';
    return 'git-only:different-text';
  }

  const kinds = new Set(obsy.conflicts.map((c) => c.kind));
  if (kinds.has('frontmatter') || kinds.has('frontmatter-key')) return 'git-only:frontmatter';
  if (kinds.has('line-endings')) return 'git-only:line-endings';
  if (kinds.has('no-base')) return 'git-only:no-base';
  if (kinds.has('work-limit')) return 'git-only:work-limit';
  if (!plainAgrees) return 'git-only:diff3-alignment';
  if (lacksFinalNewline(input)) return 'git-only:final-newline';
  // A side added frontmatter and changed the body's first lines. git sees
  // one change at the top; obsy merges the body apart, so the body change
  // can touch the other side's change.
  if (hasFrontmatter(input)) return 'git-only:frontmatter-split';
  return 'git-only:unexplained';
}
