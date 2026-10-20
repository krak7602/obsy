import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import { diff3Regions, merge3 } from '../src/index.ts';
import { tripleArb, type FormatMode, type Triple } from './arbitraries.ts';
import { compare, GitMergeFile, type Comparison } from './oracle.ts';

/**
 * Compares merge3 with `git merge-file` on generated triples. Where git is
 * clean, obsy must be clean with the same text, except in the categories
 * that docs/learning/merge-spike.md and docs/learning/merge-diff.md explain.
 *
 * OBSY_ORACLE_RUNS sets the cases per survey (default 300).
 * OBSY_ORACLE_SEED sets the seed. OBSY_ORACLE_EXAMPLES=1 prints two
 * example triples for each disagreement category.
 */
const RUNS = Number(process.env['OBSY_ORACLE_RUNS'] ?? 300);
const SEED = Number(process.env['OBSY_ORACLE_SEED'] ?? 20_261_020);
const TIMEOUT = Math.max(20_000, RUNS * 30);

/** git-only categories that the learning page explains. Any other is a bug. */
const DOCUMENTED_GIT_ONLY: ReadonlySet<Comparison> = new Set<Comparison>([
  'git-only:frontmatter',
  'git-only:diff3-alignment',
  'git-only:blank-lines',
  'git-only:git-duplicates',
  'git-only:frontmatter-split',
]);

const git = new GitMergeFile();
afterAll(() => git.dispose());

function survey(formats: readonly FormatMode[], withBase: boolean): Map<Comparison, Triple[]> {
  const found = new Map<Comparison, Triple[]>();
  for (const triple of fc.sample(tripleArb(formats), { numRuns: RUNS, seed: SEED })) {
    const input = { base: withBase ? triple.base : null, ours: triple.ours, theirs: triple.theirs };
    const oracle = git.run(withBase ? triple.base : '', triple.ours, triple.theirs);
    const comparison = compare(input, merge3(input), oracle, diff3Regions);
    found.set(comparison, [...(found.get(comparison) ?? []), triple]);
  }
  const counts = [...found]
    .map(([key, cases]) => `  ${key}: ${cases.length}`)
    .sort((x, y) => (x < y ? -1 : 1));
  const name = `${formats.join('+')} ${withBase ? 'with' : 'without'} base`;
  console.log(`${name}, ${RUNS} cases, seed ${SEED}:\n${counts.join('\n')}`);
  if (process.env['OBSY_ORACLE_EXAMPLES'] !== undefined) {
    for (const [key, cases] of found) {
      if (!key.startsWith('agree')) console.log(key, JSON.stringify(cases.slice(0, 2), null, 1));
    }
  }
  return found;
}

function undocumented(
  found: Map<Comparison, Triple[]>,
  allowed: ReadonlySet<Comparison>,
): Comparison[] {
  return [...found.keys()].filter((key) => key.startsWith('git-only') && !allowed.has(key));
}

describe('oracle: git merge-file', () => {
  it(
    'matches git where git is clean, except in documented categories',
    { timeout: TIMEOUT },
    () => {
      expect(undocumented(survey(['lf'], true), DOCUMENTED_GIT_ONLY)).toEqual([]);
    },
  );

  it(
    'stays in the documented categories when sides differ in line endings',
    { timeout: TIMEOUT },
    () => {
      expect(undocumented(survey(['per-side'], true), DOCUMENTED_GIT_ONLY)).toEqual([]);
    },
  );

  it('is never less clean than git without a base', { timeout: TIMEOUT }, () => {
    expect(undocumented(survey(['lf'], false), new Set())).toEqual([]);
  });
});
