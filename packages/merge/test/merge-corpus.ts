/**
 * Runs merge3 and `git merge-file` over a corpus of merge cases and prints
 * aggregate statistics only.
 *
 * Usage (from the repository root, after `pnpm --filter @obsy/merge run build`):
 *
 *   node packages/merge/test/merge-corpus.ts <corpus-dir> [--json] [--list] [--show <case>]
 *
 * The corpus directory must be outside the repository. Each case is a
 * folder with `ours.md`, `theirs.md`, and an optional `base.md`. A case
 * without `base.md` is a no-base case; git then gets an empty base.
 *
 * A case name's part before `--`, if any, is its group. The output then
 * also counts clean and conflict results per group; generated corpora use
 * the edit kind as the group (see corpus-generate.ts).
 *
 * Output never contains note content or case names, unless `--list`
 * (case names per category) or `--show <case>` (one case in full) is
 * given. The runner writes only to a temporary directory outside the
 * repository, and removes it at the end.
 *
 * See docs/runbooks/merge-corpus.md.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MergeInput, MergeResult } from '../src/index.ts';
import { compare, GitMergeFile, type Comparison, type Diff3Regions } from './oracle.ts';

interface Options {
  readonly corpus: string;
  readonly json: boolean;
  readonly list: boolean;
  readonly show: string | null;
}

class UsageError extends Error {}

function usage(message: string): never {
  throw new UsageError(message);
}

function parseArgs(args: readonly string[]): Options {
  let corpus: string | null = null;
  let json = false;
  let list = false;
  let show: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--json') json = true;
    else if (arg === '--list') list = true;
    else if (arg === '--show') show = args[++i] ?? usage('--show needs a case name');
    else if (arg.startsWith('--')) usage(`Unknown option ${arg}`);
    else if (corpus === null) corpus = arg;
    else usage('Give exactly one corpus directory');
  }
  if (corpus === null) usage('Give a corpus directory');
  return { corpus, json, list, show };
}

const here = dirname(fileURLToPath(import.meta.url));

function repositoryRoot(): string {
  for (let dir = here; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return realpathSync(dir);
  }
  throw new Error('Cannot find the repository root');
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

type Merge = (input: MergeInput) => MergeResult;

interface MergeModule {
  readonly merge3: Merge;
  readonly diff3Regions: Diff3Regions;
}

async function loadMerge(): Promise<MergeModule> {
  const built = join(here, '..', 'dist', 'index.js');
  if (!existsSync(built))
    usage('The merge package is not built. Run: pnpm --filter @obsy/merge run build');
  return (await import(pathToFileURL(built).href)) as MergeModule;
}

interface Case {
  readonly name: string;
  readonly input: MergeInput;
  readonly bytes: number;
}

type Loaded =
  | { readonly ok: true; readonly value: Case }
  | { readonly ok: false; readonly reason: string };

function loadCase(dir: string, name: string): Loaded {
  const path = (file: string): string => join(dir, name, file);
  if (!existsSync(path('ours.md')) || !existsSync(path('theirs.md')))
    return { ok: false, reason: 'missing ours.md or theirs.md' };
  const read = (file: string): Buffer => readFileSync(path(file));
  const buffers = [
    read('ours.md'),
    read('theirs.md'),
    ...(existsSync(path('base.md')) ? [read('base.md')] : []),
  ];
  if (buffers.some((buffer) => buffer.includes(0)))
    return { ok: false, reason: 'binary (contains NUL)' };
  const [ours = '', theirs = '', base = null] = buffers.map((buffer) => buffer.toString('utf8'));
  const bytes = buffers.reduce((total, buffer) => total + buffer.length, 0);
  return { ok: true, value: { name, input: { base, ours, theirs }, bytes } };
}

class Counter<K extends string> {
  readonly counts = new Map<K, number>();
  add(key: K): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  entries(): [K, number][] {
    return [...this.counts].sort(([x], [y]) => (x < y ? -1 : 1));
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const corpus = realpathSync(resolve(options.corpus));
  if (isInside(corpus, repositoryRoot()))
    usage('The corpus directory must be outside the repository');
  if (!statSync(corpus).isDirectory()) usage('The corpus path is not a directory');

  const { merge3, diff3Regions } = await loadMerge();
  const git = new GitMergeFile();
  const names = readdirSync(corpus, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((x, y) => (x < y ? -1 : 1));

  try {
    if (options.show !== null) {
      const loaded = loadCase(corpus, options.show);
      if (!loaded.ok) usage(`Case not usable: ${loaded.reason}`);
      const { input } = loaded.value;
      const result = merge3(input);
      const oracle = git.run(input.base ?? '', input.ours, input.theirs);
      console.log(
        JSON.stringify(
          { comparison: compare(input, result, oracle, diff3Regions), obsy: result, git: oracle },
          null,
          2,
        ),
      );
      return;
    }

    const outcome = new Counter<string>();
    const rules = new Counter<string>();
    const conflicts = new Counter<string>();
    const comparisons = new Counter<Comparison>();
    const skipped = new Counter<string>();
    const byCategory = new Map<Comparison, string[]>();
    const groups = new Counter<string>();
    const timings: number[] = [];
    let gitMs = 0;
    let largest = 0;
    let errors = 0;

    for (const name of names) {
      const loaded = loadCase(corpus, name);
      if (!loaded.ok) {
        skipped.add(loaded.reason);
        continue;
      }
      const { input, bytes } = loaded.value;
      largest = Math.max(largest, bytes);
      let result: MergeResult;
      const started = performance.now();
      try {
        result = merge3(input);
      } catch {
        errors++;
        continue;
      }
      timings.push(performance.now() - started);
      const gitStarted = performance.now();
      const oracle = git.run(input.base ?? '', input.ours, input.theirs);
      gitMs += performance.now() - gitStarted;

      const kind = input.base === null ? 'no-base' : 'with-base';
      outcome.add(`${kind}:${result.status}`);
      const separator = name.indexOf('--');
      if (separator > 0) groups.add(`${name.slice(0, separator)}:${result.status}`);
      if (result.status === 'clean') {
        for (const rule of result.rules) rules.add(rule);
        if (result.rules.length === 0) rules.add('(plain diff3 or fast path)');
      } else {
        for (const kinds of new Set(
          result.conflicts.map((c) =>
            c.kind === 'frontmatter' ? `frontmatter:${c.reason}` : c.kind,
          ),
        )) {
          conflicts.add(kinds);
        }
      }
      const comparison = compare(input, result, oracle, diff3Regions);
      comparisons.add(comparison);
      byCategory.set(comparison, [...(byCategory.get(comparison) ?? []), name]);
    }

    timings.sort((x, y) => x - y);
    const total = timings.reduce((sum, ms) => sum + ms, 0);
    const summary = {
      cases: timings.length,
      errors,
      skipped: Object.fromEntries(skipped.entries()),
      outcome: Object.fromEntries(outcome.entries()),
      cleanRules: Object.fromEntries(rules.entries()),
      conflictKinds: Object.fromEntries(conflicts.entries()),
      comparisonWithGit: Object.fromEntries(comparisons.entries()),
      groups: Object.fromEntries(groups.entries()),
      obsyMs: {
        total: Number(total.toFixed(1)),
        mean: Number((total / Math.max(1, timings.length)).toFixed(3)),
        p50: Number(percentile(timings, 0.5).toFixed(3)),
        p95: Number(percentile(timings, 0.95).toFixed(3)),
        max: Number((timings.at(-1) ?? 0).toFixed(3)),
      },
      gitMsTotal: Number(gitMs.toFixed(1)),
      largestCaseBytes: largest,
    };

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const section = (title: string, entries: Record<string, number>): void => {
        console.log(`${title}:`);
        for (const [key, n] of Object.entries(entries)) console.log(`  ${key}: ${n}`);
      };
      console.log(`cases: ${summary.cases}  errors: ${summary.errors}`);
      section('skipped', summary.skipped);
      section('outcome', summary.outcome);
      section('clean results by rule', summary.cleanRules);
      section('conflicts by kind', summary.conflictKinds);
      section('comparison with git merge-file', summary.comparisonWithGit);
      if (groups.counts.size > 0) section('outcome by group', summary.groups);
      const ms = summary.obsyMs;
      console.log(
        `obsy ms: total ${ms.total}  mean ${ms.mean}  p50 ${ms.p50}  p95 ${ms.p95}  max ${ms.max}`,
      );
      console.log(
        `git ms total: ${summary.gitMsTotal}  largest case bytes: ${summary.largestCaseBytes}`,
      );
    }

    if (options.list) {
      console.log('case names by category (private: do not share):');
      for (const [category, list] of [...byCategory].sort(([x], [y]) => (x < y ? -1 : 1))) {
        if (!category.startsWith('agree')) console.log(`  ${category}: ${list.join(', ')}`);
      }
    }
  } finally {
    git.dispose();
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(
    `${error.message}\nUsage: node packages/merge/test/merge-corpus.ts <corpus-dir> [--json] [--list] [--show <case>]`,
  );
  process.exitCode = 2;
}
