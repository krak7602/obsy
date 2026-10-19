/**
 * fast-check generators for realistic Markdown merge inputs.
 *
 * A base note is built from headings, list items, tasks, paragraphs, blank
 * lines, and optional frontmatter. Each side applies a few edits that
 * people and agents make: insert, delete, or change a line, append at the
 * end or under a heading, change a frontmatter key, or toggle the final
 * line break. Both sides can share some edits, to exercise identical
 * changes.
 */
import fc from 'fast-check';

export interface FrontmatterEntry {
  readonly key: string;
  readonly lines: readonly string[];
}

export interface Doc {
  readonly frontmatter: readonly FrontmatterEntry[] | null;
  readonly body: readonly string[];
  readonly finalNewline: boolean;
}

export type Edit =
  | { readonly kind: 'insert'; readonly at: number; readonly line: string }
  | { readonly kind: 'delete'; readonly at: number }
  | { readonly kind: 'modify'; readonly at: number; readonly line: string }
  | { readonly kind: 'append'; readonly line: string }
  | { readonly kind: 'append-under-heading'; readonly heading: number; readonly line: string }
  | { readonly kind: 'append-block'; readonly lines: readonly string[] }
  | { readonly kind: 'set-key'; readonly entry: FrontmatterEntry }
  | { readonly kind: 'delete-key'; readonly key: string }
  | { readonly kind: 'add-list-item'; readonly key: string; readonly item: string }
  | { readonly kind: 'toggle-final-newline' };

const WORDS = [
  'milk',
  'bob',
  'rent',
  'flight',
  'inbox',
  'review',
  'notes',
  'idea',
  'plan',
  'draft',
];
const KEYS = ['title', 'tags', 'status', 'created', 'aliases', 'rating'];

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
const word = fc.constantFrom(...WORDS);

export const lineArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constant('') },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.constantFrom('#', '##', '###'), word)
      .map(([level, text]) => `${level} ${capital(text)}`),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        fc.constantFrom('- ', '- [ ] ', '- [x] ', '* ', '1. '),
        word,
        fc.option(fc.nat(20), { nil: undefined }),
      )
      .map(([bullet, text, n]) => `${bullet}${text}${n === undefined ? '' : ` ${n}`}`),
  },
  {
    weight: 3,
    arbitrary: fc.tuple(word, word, fc.nat(50)).map(([a, b, n]) => `${capital(a)} and ${b} ${n}.`),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '> quote',
      '```',
      '---',
      'code();',
      '| a | b |',
      '[[Link]]',
      '  - nested',
    ),
  },
);

const valueArb = (key: string): fc.Arbitrary<FrontmatterEntry> =>
  fc.oneof(
    word.map((value) => ({ key, lines: [`${key}: ${value}`] })),
    fc
      .array(word, { maxLength: 3 })
      .map((items) => ({ key, lines: [`${key}: [${items.join(', ')}]`] })),
    fc
      .tuple(fc.array(word, { minLength: 1, maxLength: 3 }), fc.constantFrom('  - ', '- '))
      .map(([items, bullet]) => ({
        key,
        lines: [`${key}:`, ...items.map((item) => bullet + item)],
      })),
  );

const entryArb: fc.Arbitrary<FrontmatterEntry> = fc.constantFrom(...KEYS).chain(valueArb);

const frontmatterArb: fc.Arbitrary<FrontmatterEntry[]> = fc
  .array(entryArb, { maxLength: 5 })
  .map((entries) =>
    entries.filter((entry, i) => entries.findIndex((e) => e.key === entry.key) === i),
  );

export const docArb: fc.Arbitrary<Doc> = fc.record({
  frontmatter: fc.option(frontmatterArb, { nil: null, freq: 2 }),
  body: fc.array(lineArb, { maxLength: 20 }),
  finalNewline: fc.oneof(
    { weight: 5, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
});

const index = fc.nat(1000);

export const editArb: fc.Arbitrary<Edit> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('insert' as const), at: index, line: lineArb }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), at: index }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('modify' as const), at: index, line: lineArb }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('append' as const), line: lineArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('append-under-heading' as const),
      heading: index,
      line: lineArb,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('append-block' as const),
      lines: fc.tuple(word, lineArb).map(([heading, line]) => ['', `## ${capital(heading)}`, line]),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('set-key' as const), entry: entryArb }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('delete-key' as const),
      key: fc.constantFrom(...KEYS),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('add-list-item' as const),
      key: fc.constantFrom(...KEYS),
      item: word,
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'toggle-final-newline' as const }) },
);

function headingSectionEnd(body: readonly string[], heading: number): number | null {
  const headings = body.flatMap((line, i) => (/^#{1,6} /.test(line) ? [i] : []));
  if (headings.length === 0) return null;
  const start = headings[heading % headings.length] ?? 0;
  let end = body.findIndex((line, i) => i > start && /^#{1,6} /.test(line));
  if (end === -1) end = body.length;
  while (end > start + 1 && body[end - 1] === '') end--;
  return end;
}

/** Applies one edit. Out-of-range positions wrap; impossible edits do nothing. */
export function applyEdit(doc: Doc, edit: Edit): Doc {
  const body = [...doc.body];
  const frontmatter = doc.frontmatter === null ? null : [...doc.frontmatter];
  switch (edit.kind) {
    case 'insert':
      body.splice(edit.at % (body.length + 1), 0, edit.line);
      break;
    case 'delete':
      if (body.length > 0) body.splice(edit.at % body.length, 1);
      break;
    case 'modify':
      if (body.length > 0) body[edit.at % body.length] = edit.line;
      break;
    case 'append':
      body.push(edit.line);
      break;
    case 'append-under-heading': {
      const end = headingSectionEnd(body, edit.heading);
      if (end === null) body.push(edit.line);
      else body.splice(end, 0, edit.line);
      break;
    }
    case 'append-block':
      body.push(...edit.lines);
      break;
    case 'set-key': {
      const entries = frontmatter ?? [];
      const at = entries.findIndex((entry) => entry.key === edit.entry.key);
      if (at === -1) entries.push(edit.entry);
      else entries[at] = edit.entry;
      return { ...doc, frontmatter: entries };
    }
    case 'delete-key':
      if (frontmatter === null) return doc;
      return { ...doc, frontmatter: frontmatter.filter((entry) => entry.key !== edit.key) };
    case 'add-list-item': {
      if (frontmatter === null) return doc;
      const at = frontmatter.findIndex((entry) => entry.key === edit.key);
      const entry = frontmatter[at];
      if (entry === undefined || entry.lines.length < 2) return doc;
      const bullet = entry.lines[1]?.startsWith('  ') ? '  - ' : '- ';
      frontmatter[at] = { key: entry.key, lines: [...entry.lines, bullet + edit.item] };
      return { ...doc, frontmatter };
    }
    case 'toggle-final-newline':
      return { ...doc, finalNewline: !doc.finalNewline };
  }
  return { ...doc, body };
}

export function applyEdits(doc: Doc, edits: readonly Edit[]): Doc {
  return edits.reduce(applyEdit, doc);
}

/** Renders a document as LF text. */
export function render(doc: Doc): string {
  const lines =
    doc.frontmatter === null
      ? [...doc.body]
      : ['---', ...doc.frontmatter.flatMap((entry) => entry.lines), '---', ...doc.body];
  if (lines.length === 0) return '';
  return lines.join('\n') + (doc.finalNewline ? '\n' : '');
}

export interface Triple {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

export const toCrlf = (text: string): string => text.replaceAll('\n', '\r\n');

/** Line-ending variants: all LF, all CRLF, or each side chosen alone. */
export type FormatMode = 'lf' | 'crlf' | 'per-side';

export function tripleArb(formats: readonly FormatMode[] = ['lf']): fc.Arbitrary<Triple> {
  return fc
    .record({
      base: docArb,
      shared: fc.array(editArb, { maxLength: 2 }),
      ours: fc.array(editArb, { maxLength: 4 }),
      theirs: fc.array(editArb, { maxLength: 4 }),
      format: fc.constantFrom(...formats),
      sides: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
    })
    .map(({ base, shared, ours, theirs, format, sides }) => {
      const texts = [
        render(base),
        render(applyEdits(base, [...shared, ...ours])),
        render(applyEdits(base, [...shared, ...theirs])),
      ];
      const crlf = (i: number): boolean =>
        format === 'crlf' || (format === 'per-side' && sides[i] === true);
      const [b = '', o = '', t = ''] = texts.map((text, i) => (crlf(i) ? toCrlf(text) : text));
      return { base: b, ours: o, theirs: t };
    });
}
