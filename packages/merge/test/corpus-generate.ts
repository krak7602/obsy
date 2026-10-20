/**
 * Builds a merge corpus from real notes and generated two-sided edits.
 *
 * Usage (from the repository root):
 *
 *   node packages/merge/test/corpus-generate.ts <notes-dir> <corpus-dir> [--seed <n>]
 *
 * `<notes-dir>` is a copy of a vault (only `.md` files are read). For each
 * note and each edit kind below that applies to it, the generator writes
 * one case folder `<kind>--<id>` with `base.md` (the note as it is),
 * `ours.md`, and `theirs.md`. `<id>` is a hash of the note path, so case
 * names do not reveal note names. The kind before `--` is the case's group
 * in the corpus runner's output.
 *
 * Both directories must be outside the repository. `<corpus-dir>` must not
 * exist yet. The generator never writes to `<notes-dir>`.
 *
 * See docs/runbooks/merge-corpus.md.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

class UsageError extends Error {}

function usage(message: string): never {
  throw new UsageError(message);
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

/** Small deterministic random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Note {
  readonly lines: string[];
  readonly newline: string;
  readonly finalNewline: boolean;
  /** Index of the first body line, after any frontmatter. */
  readonly bodyStart: number;
  readonly hasFrontmatter: boolean;
}

function parse(text: string): Note {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();
  let bodyStart = 0;
  let hasFrontmatter = false;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      bodyStart = close + 1;
      hasFrontmatter = true;
    }
  }
  return { lines, newline, finalNewline, bodyStart, hasFrontmatter };
}

function render(note: Note, lines: readonly string[]): string {
  return lines.join(note.newline) + (note.finalNewline ? note.newline : '');
}

type Pick = <T>(items: readonly T[]) => T | undefined;

/** One generated case: the two sides' line lists. Null when the kind does not apply. */
type EditKind = (note: Note, pick: Pick) => { ours: string[]; theirs: string[] } | null;

const isText = (line: string): boolean => line.trim() !== '' && line.trim() !== '---';
const edited = (line: string, side: string): string => `${line} (edited by ${side})`;

function bodyTextLines(note: Note): number[] {
  const out: number[] = [];
  for (let i = note.bodyStart; i < note.lines.length; i++) {
    if (isText(note.lines[i] ?? '')) out.push(i);
  }
  return out;
}

function headings(note: Note): number[] {
  return bodyTextLines(note).filter((i) => /^#{1,6} /.test(note.lines[i] ?? ''));
}

/** End of the section that starts at heading `h`: the next heading of the same or a higher level. */
function sectionEnd(note: Note, h: number): number {
  const level = /^(#+)/.exec(note.lines[h] ?? '')?.[1]?.length ?? 1;
  for (let i = h + 1; i < note.lines.length; i++) {
    const match = /^(#{1,6}) /.exec(note.lines[i] ?? '');
    if (match !== null && (match[1]?.length ?? 7) <= level) return i;
  }
  return note.lines.length;
}

/** Index after the last non-blank line of lines `from` to `to`. */
function lastTextEnd(note: Note, from: number, to: number): number {
  let end = to;
  while (end > from && (note.lines[end - 1] ?? '').trim() === '') end--;
  return end;
}

const KINDS: Record<string, EditKind> = {
  // Both sides append a different line at the end, like two devices adding to a log.
  'append-both': (note) => {
    const end = lastTextEnd(note, note.bodyStart, note.lines.length);
    const at = (side: string): string[] => {
      const lines = [...note.lines];
      lines.splice(end, 0, `- added by ${side}`);
      return lines;
    };
    return { ours: at('ours'), theirs: at('theirs') };
  },
  // Both sides append the same line.
  'append-same': (note) => {
    const end = lastTextEnd(note, note.bodyStart, note.lines.length);
    const lines = [...note.lines];
    lines.splice(end, 0, '- added on both sides');
    return { ours: lines, theirs: [...lines] };
  },
  // Ours ticks a task; theirs appends at the end.
  'task-and-append': (note, pick) => {
    const tasks = bodyTextLines(note).filter((i) => /^\s*[-*] \[ \] /.test(note.lines[i] ?? ''));
    const task = pick(tasks);
    if (task === undefined) return null;
    const ours = [...note.lines];
    ours[task] = (ours[task] ?? '').replace('[ ]', '[x]');
    const theirs = [...note.lines];
    theirs.splice(lastTextEnd(note, note.bodyStart, note.lines.length), 0, '- added by theirs');
    return { ours, theirs };
  },
  // Each side edits a different line, far apart.
  'far-edits': (note, pick) => {
    const text = bodyTextLines(note);
    if (text.length < 6) return null;
    const third = Math.floor(text.length / 3);
    const a = pick(text.slice(0, third));
    const b = pick(text.slice(text.length - third));
    if (a === undefined || b === undefined || b - a < 3) return null;
    const ours = [...note.lines];
    ours[a] = edited(ours[a] ?? '', 'ours');
    const theirs = [...note.lines];
    theirs[b] = edited(theirs[b] ?? '', 'theirs');
    return { ours, theirs };
  },
  // Both sides edit the same line differently: a conflict.
  'same-line': (note, pick) => {
    const line = pick(bodyTextLines(note));
    if (line === undefined) return null;
    const ours = [...note.lines];
    ours[line] = edited(ours[line] ?? '', 'ours');
    const theirs = [...note.lines];
    theirs[line] = edited(theirs[line] ?? '', 'theirs');
    return { ours, theirs };
  },
  // The sides edit two neighbouring lines: a conflict by the adjacency rule.
  'adjacent-lines': (note, pick) => {
    const text = bodyTextLines(note);
    const line = pick(text.filter((i) => text.includes(i + 1)));
    if (line === undefined) return null;
    const ours = [...note.lines];
    ours[line] = edited(ours[line] ?? '', 'ours');
    const theirs = [...note.lines];
    theirs[line + 1] = edited(theirs[line + 1] ?? '', 'theirs');
    return { ours, theirs };
  },
  // Ours adds a frontmatter key (or frontmatter); theirs edits the body.
  'frontmatter-and-body': (note, pick) => {
    const line = pick(bodyTextLines(note));
    if (line === undefined) return null;
    const ours = [...note.lines];
    if (note.hasFrontmatter) ours.splice(note.bodyStart - 1, 0, 'obsy-test: added by ours');
    else ours.unshift('---', 'obsy-test: added by ours', '---');
    const theirs = [...note.lines];
    theirs[line] = edited(theirs[line] ?? '', 'theirs');
    return { ours, theirs };
  },
  // Both sides insert a different line right under the same heading.
  'under-heading-both': (note, pick) => {
    const h = pick(headings(note));
    if (h === undefined) return null;
    const at = (side: string): string[] => {
      const lines = [...note.lines];
      lines.splice(h + 1, 0, `- added under the heading by ${side}`);
      return lines;
    };
    return { ours: at('ours'), theirs: at('theirs') };
  },
  // Each side appends to the end of a different section, like two agents.
  'two-sections': (note, pick) => {
    const hs = headings(note);
    if (hs.length < 2) return null;
    const first = pick(hs.slice(0, -1)) ?? 0;
    const second = pick(hs.filter((h) => h >= sectionEnd(note, first)));
    if (second === undefined) return null;
    const insert = (h: number, side: string): string[] => {
      const lines = [...note.lines];
      lines.splice(lastTextEnd(note, h, sectionEnd(note, h)), 0, `- added by ${side}`);
      return lines;
    };
    return { ours: insert(first, 'ours'), theirs: insert(second, 'theirs') };
  },
  // Ours deletes a section; theirs edits a line inside it: a conflict.
  'delete-vs-edit': (note, pick) => {
    const h = pick(headings(note));
    if (h === undefined) return null;
    const end = sectionEnd(note, h);
    const inside = bodyTextLines(note).filter((i) => i > h && i < end);
    const line = pick(inside);
    if (line === undefined) return null;
    const ours = [...note.lines];
    ours.splice(h, end - h);
    const theirs = [...note.lines];
    theirs[line] = edited(theirs[line] ?? '', 'theirs');
    return { ours, theirs };
  },
};

function markdownFiles(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path, root));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(relative(root, path));
  }
  return out.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function main(): void {
  const args = process.argv.slice(2);
  let seed = 1;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--seed') seed = Number(args[++i] ?? usage('--seed needs a number'));
    else if (arg.startsWith('--')) usage(`Unknown option ${arg}`);
    else paths.push(arg);
  }
  if (paths.length !== 2) usage('Give a notes directory and a corpus directory');
  const root = repositoryRoot();
  const notesDir = realpathSync(resolve(paths[0] ?? ''));
  const corpusDir = resolve(paths[1] ?? '');
  if (isInside(notesDir, root)) usage('The notes directory must be outside the repository');
  if (existsSync(corpusDir)) usage('The corpus directory must not exist yet');
  if (!existsSync(dirname(corpusDir))) usage('The parent of the corpus directory must exist');
  if (isInside(realpathSync(dirname(corpusDir)), root) || isInside(corpusDir, notesDir))
    usage('The corpus directory must be outside the repository and the notes directory');

  mkdirSync(corpusDir);
  const counts = new Map<string, number>();
  let notes = 0;
  for (const file of markdownFiles(notesDir)) {
    const text = readFileSync(join(notesDir, file), 'utf8');
    if (text.includes('\0')) continue;
    notes++;
    const note = parse(text);
    const id = createHash('sha256').update(file).digest('hex').slice(0, 10);
    for (const [kind, make] of Object.entries(KINDS)) {
      const caseSeed = createHash('sha256').update(`${seed}:${file}:${kind}`).digest('hex');
      const next = random(Number.parseInt(caseSeed.slice(0, 8), 16));
      const pick: Pick = (items) =>
        items.length === 0 ? undefined : items[Math.floor(next() * items.length)];
      const sides = make(note, pick);
      if (sides === null) continue;
      const dir = join(corpusDir, `${kind}--${id}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'base.md'), text);
      writeFileSync(join(dir, 'ours.md'), render(note, sides.ours));
      writeFileSync(join(dir, 'theirs.md'), render(note, sides.theirs));
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  console.log(`notes: ${notes}`);
  for (const [kind, n] of [...counts].sort(([x], [y]) => (x < y ? -1 : 1)))
    console.log(`  ${kind}: ${n} cases`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(
    `${error.message}\nUsage: node packages/merge/test/corpus-generate.ts <notes-dir> <corpus-dir> [--seed <n>]`,
  );
  process.exitCode = 2;
}
