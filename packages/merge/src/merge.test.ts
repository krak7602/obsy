import { describe, expect, it } from 'vite-plus/test';

import { merge3, type MergeResult } from './index';

const lines = (...items: string[]): string => items.map((line) => `${line}\n`).join('');

function m(base: string | null, ours: string, theirs: string): MergeResult {
  return merge3({ base, ours, theirs });
}

function expectClean(result: MergeResult): string {
  if (result.status !== 'clean')
    throw new Error(`expected clean, got ${JSON.stringify(result.conflicts)}`);
  return result.text;
}

function expectConflict(result: MergeResult): MergeResult & { status: 'conflict' } {
  if (result.status !== 'conflict')
    throw new Error(`expected conflict, got ${JSON.stringify(result.text)}`);
  return result;
}

const MARKERS = /^(<{7}|={7}|>{7}|\|{7})/m;

describe('fast paths', () => {
  it('returns ours when both sides are identical', () => {
    expect(m('a\n', 'b\n', 'b\n')).toEqual({ status: 'clean', text: 'b\n', rules: [] });
  });

  it('returns theirs when ours did not change', () => {
    expect(expectClean(m('a\n', 'a\n', 'b\r\n'))).toBe('b\r\n');
  });

  it('returns ours when theirs did not change', () => {
    expect(expectClean(m('a\n', '\uFEFFb', 'a\n'))).toBe('\uFEFFb');
  });
});

describe('line-level merge', () => {
  const base = lines('# Note', '', 'one', 'two', 'three', 'four', 'five');

  it('applies changes to separate lines from both sides', () => {
    const ours = lines('# Note', '', 'ONE', 'two', 'three', 'four', 'five');
    const theirs = lines('# Note', '', 'one', 'two', 'three', 'four', 'FIVE');
    expect(m(base, ours, theirs)).toEqual({
      status: 'clean',
      text: lines('# Note', '', 'ONE', 'two', 'three', 'four', 'FIVE'),
      rules: [],
    });
  });

  it('merges an identical change on both sides once', () => {
    const both = lines('# Note', '', 'one', 'TWO', 'three', 'four', 'five', 'six');
    const ours = lines('# Note!', '', 'one', 'TWO', 'three', 'four', 'five', 'six');
    expect(expectClean(m(base, ours, both))).toBe(
      lines('# Note!', '', 'one', 'TWO', 'three', 'four', 'five', 'six'),
    );
  });

  it('merges identical deletes once', () => {
    const ours = lines('# Note', '', 'one', 'four', 'five', 'six');
    const theirs = lines('# Note', '', 'one', 'four', 'five');
    expect(expectClean(m(base, ours, theirs))).toBe(
      lines('# Note', '', 'one', 'four', 'five', 'six'),
    );
  });

  it('reports overlapping changes as a conflict with line ranges', () => {
    const ours = lines('# Note', '', 'one', 'TWO', 'three', 'four', 'five');
    const theirs = lines('# Note', '', 'one', 'Two!', 'three', 'four', 'five');
    expect(expectConflict(m(base, ours, theirs)).conflicts).toEqual([
      {
        kind: 'lines',
        base: { start: 3, length: 1 },
        ours: { start: 3, length: 1 },
        theirs: { start: 3, length: 1 },
      },
    ]);
  });

  it('reports changes to adjacent lines as a conflict, like git', () => {
    const ours = lines('# Note', '', 'one', 'TWO', 'three', 'four', 'five');
    const theirs = lines('# Note', '', 'one', 'two', 'THREE', 'four', 'five');
    expect(m(base, ours, theirs).status).toBe('conflict');
  });

  it('reports an insert next to a changed line as a conflict', () => {
    const ours = lines('# Note', '', 'one', 'two', 'three', 'four', 'FIVE');
    const theirs = lines('# Note', '', 'one', 'two', 'three', 'four', 'five', 'six');
    expect(m(base, ours, theirs).status).toBe('conflict');
  });

  it('reports a delete against a change as a conflict', () => {
    const ours = lines('# Note', '', 'one', 'three', 'four', 'five');
    const theirs = lines('# Note', '', 'one', 'two!', 'three', 'four', 'five');
    expect(m(base, ours, theirs).status).toBe('conflict');
  });

  it('does not anchor on a blank line, so a delete is not lost', () => {
    // Ours moved a line across a blank line; theirs deleted that line.
    const b = lines('## Notes', '- a', '', '', '1. item');
    const ours = lines('## Notes', '- a', '', '1. item', '');
    const theirs = lines('## Notes', '- a', '', '');
    expect(m(b, ours, theirs).status).toBe('conflict');
  });

  it('gives the caller theirs to keep and ours to copy, never markers', () => {
    const ours = lines('# Ours');
    const theirs = lines('# Theirs');
    const result = expectConflict(m(lines('# Base'), ours, theirs));
    expect(result.keep).toBe(theirs);
    expect(result.copy).toBe(ours);
    expect(JSON.stringify(result)).not.toMatch(/<{7}|>{7}/);
  });

  it('reports every conflicting region in text order', () => {
    const ours = lines('# Note', '', 'ONE', 'two', 'three', 'four', 'FIVE');
    const theirs = lines('# Note', '', 'One', 'two', 'three', 'four', 'Five');
    const result = expectConflict(m(base, ours, theirs));
    expect(result.conflicts.map((c) => (c.kind === 'lines' ? c.base.start : -1))).toEqual([2, 6]);
  });
});

describe('concurrent inserts at the same anchor', () => {
  const base = lines('# Todo', '', '- buy milk', '- call bob');

  it('keeps both appends, theirs first then ours', () => {
    const ours = lines('# Todo', '', '- buy milk', '- call bob', '- pay rent');
    const theirs = lines('# Todo', '', '- buy milk', '- call bob', '- book flight');
    expect(m(base, ours, theirs)).toEqual({
      status: 'clean',
      text: lines('# Todo', '', '- buy milk', '- call bob', '- book flight', '- pay rent'),
      rules: ['union-insert'],
    });
  });

  it('keeps both inserts in the middle of a note', () => {
    const ours = lines('# Todo', '', '- buy milk', '- ours', '- call bob');
    const theirs = lines('# Todo', '', '- buy milk', '- theirs', '- call bob');
    expect(expectClean(m(base, ours, theirs))).toBe(
      lines('# Todo', '', '- buy milk', '- theirs', '- ours', '- call bob'),
    );
  });

  it('keeps an insert once when the other side inserted a larger block that contains it', () => {
    const ours = lines('# Todo', '', '- buy milk', '- call bob', '- pay rent', '- book flight');
    const theirs = lines('# Todo', '', '- buy milk', '- call bob', '- pay rent');
    expect(m(base, ours, theirs)).toEqual({
      status: 'clean',
      text: ours,
      rules: ['contained-insert'],
    });
  });

  it('keeps a shared heading once and both entries under it', () => {
    const ours = base + lines('', '## Log', '- ours');
    const theirs = base + lines('', '## Log', '- theirs');
    expect(expectClean(m(base, ours, theirs))).toBe(
      base + lines('', '## Log', '- theirs', '- ours'),
    );
  });

  it('keeps a blank line between two new paragraphs', () => {
    const ours = base + lines('', 'Ours paragraph.');
    const theirs = base + lines('', 'Theirs paragraph.');
    expect(expectClean(m(base, ours, theirs))).toBe(
      base + lines('', 'Theirs paragraph.', '', 'Ours paragraph.'),
    );
  });

  it('keeps a blank line between two new paragraphs before shared content', () => {
    const b = lines('# A', '', '# B');
    const ours = lines('# A', '', 'Ours.', '', '# B');
    const theirs = lines('# A', '', 'Theirs.', '', '# B');
    expect(expectClean(m(b, ours, theirs))).toBe(
      lines('# A', '', 'Theirs.', '', 'Ours.', '', '# B'),
    );
  });

  it('does not union when one side also deleted a line at that place', () => {
    const ours = lines('# Todo', '', '- buy milk', '- pay rent');
    const theirs = lines('# Todo', '', '- buy milk', '- call bob', '- book flight');
    expect(m(base, ours, theirs).status).toBe('conflict');
  });

  it('keeps both appends to a note without a final line break', () => {
    expect(expectClean(m('a\nb', 'a\nb\nc', 'a\nb\nd'))).toBe('a\nb\nd\nc');
  });

  it('keeps both inserts into an empty base', () => {
    expect(expectClean(m('', 'ours\n', 'theirs\n'))).toBe('theirs\nours\n');
  });
});

describe('no base', () => {
  const template = lines('# 2026-10-20', '', '## Log');

  it('is clean when both versions are identical', () => {
    expect(expectClean(m(null, template, template))).toBe(template);
  });

  it('takes ours when ours strictly extends theirs', () => {
    const ours = template + lines('- woke up');
    expect(m(null, ours, template)).toEqual({
      status: 'clean',
      text: ours,
      rules: ['no-base-extends'],
    });
  });

  it('takes theirs when theirs strictly extends ours', () => {
    const theirs = lines('# 2026-10-20', 'inserted', '', '## Log', '- woke up');
    expect(expectClean(m(null, template, theirs))).toBe(theirs);
  });

  it('counts a typed last line without a line break as an extension', () => {
    const ours = `${template}- typed`;
    expect(expectClean(m(null, ours, template))).toBe(ours);
  });

  it('counts an added final line break as an extension', () => {
    expect(expectClean(m(null, 'a\nb', 'a\nb\n'))).toBe('a\nb\n');
  });

  it('counts a line typed after a final line break as an extension', () => {
    expect(expectClean(m(null, 'a\nb\n', 'a\nb\nc'))).toBe('a\nb\nc');
  });

  it('does not count joined lines as an extension', () => {
    expect(expectConflict(m(null, 'a\nb\n', 'ab\n')).conflicts).toEqual([{ kind: 'no-base' }]);
  });

  it('treats an empty text as extended by any text', () => {
    expect(expectClean(m(null, '', 'x'))).toBe('x');
  });

  it('conflicts when both versions add different lines', () => {
    const result = expectConflict(
      m(null, template + lines('- ours'), template + lines('- theirs')),
    );
    expect(result.conflicts).toEqual([{ kind: 'no-base' }]);
    expect(result.keep).toBe(template + lines('- theirs'));
  });

  it('conflicts when a line was changed', () => {
    expect(m(null, lines('# A', 'x'), lines('# A', 'y', 'z')).status).toBe('conflict');
  });

  it('conflicts when line endings or the byte order mark differ', () => {
    expect(m(null, 'a\r\nb\r\n', 'a\n').status).toBe('conflict');
    expect(m(null, '\uFEFFa\nb\n', 'a\n').status).toBe('conflict');
  });
});

describe('frontmatter', () => {
  const fm = (...items: string[]): string => lines('---', ...items, '---');
  const body = lines('# Title', '', 'Body text.');

  it('merges changes to different keys from both sides', () => {
    const base = fm('title: Note', 'status: draft', 'rating: 3') + body;
    const ours = fm('title: Note', 'status: done', 'rating: 3') + body;
    const theirs = fm('title: Note', 'status: draft', 'rating: 4') + body;
    expect(m(base, ours, theirs)).toEqual({
      status: 'clean',
      text: fm('title: Note', 'status: done', 'rating: 4') + body,
      rules: ['frontmatter-keys'],
    });
  });

  it('merges changes to adjacent keys, which a line merge would reject', () => {
    const base = fm('a: 1', 'b: 2') + body;
    const ours = fm('a: 10', 'b: 2') + body;
    const theirs = fm('a: 1', 'b: 20') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(fm('a: 10', 'b: 20') + body);
  });

  it('reports a key changed differently on both sides', () => {
    const base = fm('status: draft') + body;
    const result = expectConflict(m(base, fm('status: done') + body, fm('status: review') + body));
    expect(result.conflicts).toEqual([{ kind: 'frontmatter-key', key: 'status' }]);
  });

  it('merges a key changed the same way on both sides once', () => {
    const base = fm('status: draft', 'a: 1') + body;
    const ours = fm('status: done', 'a: 2') + body;
    const theirs = fm('status: done', 'a: 1') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(fm('status: done', 'a: 2') + body);
  });

  it('keeps keys that each side added, after the key they follow', () => {
    const base = fm('title: Note', 'tags: []') + body;
    const ours = fm('title: Note', 'mine: 1', 'tags: []') + body;
    const theirs = fm('title: Note', 'tags: []', 'yours: 2') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(
      fm('title: Note', 'mine: 1', 'tags: []', 'yours: 2') + body,
    );
  });

  it('keeps a key that both sides added with the same value once', () => {
    const base = fm('title: Note', 'a: 1') + body;
    const ours = fm('title: Note', 'a: 2', 'new: x') + body;
    const theirs = fm('title: Note', 'a: 1', 'new: x', 'b: 3') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(
      fm('title: Note', 'a: 2', 'new: x', 'b: 3') + body,
    );
  });

  it('reports a key that both sides added with different values', () => {
    const base = fm('title: Note', 'a: 1') + body;
    const ours = fm('title: Note', 'a: 2', 'new: x') + body;
    const theirs = fm('title: Note', 'a: 1', 'new: y') + body;
    expect(expectConflict(m(base, ours, theirs)).conflicts).toEqual([
      { kind: 'frontmatter-key', key: 'new' },
    ]);
  });

  it('removes a key that one side removed and the other did not change', () => {
    const base = fm('a: 1', 'b: 2', 'c: 3') + body;
    const ours = fm('a: 1', 'c: 3') + body;
    const theirs = fm('a: 1', 'b: 2', 'c: 30') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(fm('a: 1', 'c: 30') + body);
  });

  it('reports a key removed on one side and changed on the other', () => {
    const base = fm('a: 1', 'b: 2', 'c: 3') + body;
    const ours = fm('a: 1', 'c: 30') + body;
    const theirs = fm('a: 1', 'b: 20', 'c: 3') + body;
    expect(expectConflict(m(base, ours, theirs)).conflicts).toEqual([
      { kind: 'frontmatter-key', key: 'b' },
    ]);
  });

  it('merges list items that both sides appended to one key', () => {
    const base = fm('title: Note', 'tags:', '  - inbox', 'status: draft') + body;
    const ours = fm('title: Note', 'tags:', '  - inbox', '  - ours', 'status: done') + body;
    const theirs = fm('title: Note', 'tags:', '  - inbox', '  - theirs', 'status: draft') + body;
    expect(m(base, ours, theirs)).toEqual({
      status: 'clean',
      text:
        fm('title: Note', 'tags:', '  - inbox', '  - theirs', '  - ours', 'status: done') + body,
      rules: ['union-insert', 'frontmatter-keys'],
    });
  });

  it('merges list items without indentation', () => {
    const base = fm('tags:', '- a', 'x: 1') + body;
    const ours = fm('tags:', '- a', '- b', 'x: 1') + body;
    const theirs = fm('tags:', '- a', 'x: 2') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(fm('tags:', '- a', '- b', 'x: 2') + body);
  });

  it('reports different flow-list changes to one key', () => {
    const base = fm('tags: [a]', 'x: 1') + body;
    const ours = fm('tags: [a, b]', 'x: 1') + body;
    const theirs = fm('tags: [a, c]', 'x: 2') + body;
    expect(expectConflict(m(base, ours, theirs)).conflicts).toEqual([
      { kind: 'frontmatter-key', key: 'tags' },
    ]);
  });

  it('keeps the exact formatting of untouched keys', () => {
    const untouched = [
      '# a comment',
      'title: "Quoted: value"',
      "'single key': x",
      'aliases:   [one,   two]',
      'desc: |',
      '  line one',
      '',
      '  line two',
      'url: https://example.com/a:b',
    ];
    const base = fm(...untouched, 'status: draft', 'n: 1') + body;
    const ours = fm(...untouched, 'status: done', 'n: 1') + body;
    const theirs = fm(...untouched, 'status: draft', 'n: 2') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(
      fm(...untouched, 'status: done', 'n: 2') + body,
    );
  });

  it('merges frontmatter and body changes together', () => {
    const base = fm('a: 1', 'b: 2') + body;
    const ours = fm('a: 10', 'b: 2') + lines('# Title', '', 'Body text.', 'ours');
    const theirs = fm('a: 1', 'b: 20') + lines('# Title!', '', 'Body text.');
    expect(expectClean(m(base, ours, theirs))).toBe(
      fm('a: 10', 'b: 20') + lines('# Title!', '', 'Body text.', 'ours'),
    );
  });

  it('reports body line numbers in each text, after the frontmatter', () => {
    const base = fm('a: 1') + body;
    const ours = fm('a: 1', 'b: 2') + lines('# Ours', '', 'Body text.');
    const theirs = fm('a: 1') + lines('# Theirs', '', 'Body text.');
    expect(expectConflict(m(base, ours, theirs)).conflicts).toEqual([
      {
        kind: 'lines',
        base: { start: 3, length: 1 },
        ours: { start: 4, length: 1 },
        theirs: { start: 3, length: 1 },
      },
    ]);
  });

  it('keeps added frontmatter at the top when the other side inserts at the top', () => {
    // The base starts with a thematic break, not frontmatter. Found by the oracle.
    const base = lines('---', '1. inbox');
    const ours = lines('1. plan 9', '---', '1. inbox');
    const theirs = `${fm('aliases:', '- inbox')}- notes 2\n---\n1. inbox`;
    expect(expectClean(m(base, ours, theirs))).toBe(
      `${fm('aliases:', '- inbox')}- notes 2\n1. plan 9\n---\n1. inbox`,
    );
  });

  it('keeps frontmatter that one side added while the other changed the body', () => {
    const ours = fm('tags: [new]') + body;
    const theirs = lines('# Title', '', 'Body text!');
    expect(expectClean(m(body, ours, theirs))).toBe(
      fm('tags: [new]') + lines('# Title', '', 'Body text!'),
    );
  });

  it('merges frontmatter that both sides added with different keys', () => {
    const ours = fm('a: 1', 'c: 3') + body;
    const theirs = fm('b: 2') + body;
    // `a` follows no key in ours, so it goes first; `c` follows `a`.
    expect(expectClean(m(body, ours, theirs))).toBe(fm('a: 1', 'c: 3', 'b: 2') + body);
  });

  it('reports frontmatter removed on one side and changed on the other', () => {
    const base = fm('a: 1') + body;
    const result = expectConflict(m(base, body, fm('a: 2') + body));
    expect(result.conflicts).toEqual([{ kind: 'frontmatter', reason: 'presence' }]);
  });

  it('treats frontmatter that is not a plain mapping as one unit', () => {
    const base = fm('- a', '- b') + body;
    const result = expectConflict(
      m(base, fm('- a', '- b', '- c') + body, fm('- z', '- a', '- b') + body),
    );
    expect(result.conflicts).toEqual([{ kind: 'frontmatter', reason: 'unparsed' }]);
  });

  it('treats frontmatter with a duplicate key as one unit', () => {
    const base = fm('a: 1', 'a: 2', 'b: 1') + body;
    const result = expectConflict(
      m(base, fm('a: 1', 'a: 2', 'b: 2') + body, fm('a: 0', 'a: 2', 'b: 1') + body),
    );
    expect(result.conflicts).toEqual([{ kind: 'frontmatter', reason: 'unparsed' }]);
  });

  it('keeps the key order of ours when only ours moved keys', () => {
    const base = fm('a: 1', 'b: 2', 'c: 3') + body;
    const ours = fm('c: 3', 'a: 1', 'b: 2') + body;
    const theirs = fm('a: 1', 'b: 20', 'c: 3') + body;
    expect(expectClean(m(base, ours, theirs))).toBe(fm('c: 3', 'a: 1', 'b: 20') + body);
  });

  it('reports keys that both sides moved into different orders', () => {
    const base = fm('a: 1', 'b: 2', 'c: 3') + body;
    const ours = fm('c: 3', 'a: 1', 'b: 2') + body;
    const theirs = fm('b: 2', 'a: 1', 'c: 30') + body;
    expect(expectConflict(m(base, ours, theirs)).conflicts).toEqual([
      { kind: 'frontmatter', reason: 'order' },
    ]);
  });

  it('never puts conflict markers inside YAML', () => {
    const base = fm('status: draft') + body;
    const result = expectConflict(m(base, fm('status: done') + body, fm('status: review') + body));
    expect(result.keep).not.toMatch(MARKERS);
    expect(result.copy).not.toMatch(MARKERS);
  });

  it('treats an unclosed fence as body text', () => {
    const base = lines('---', 'a: 1', 'text');
    const ours = lines('---', 'a: 2', 'text');
    const theirs = lines('---', 'a: 1', 'TEXT');
    expect(m(base, ours, theirs).status).toBe('conflict');
  });

  it('keeps frontmatter that ends the file without a line break', () => {
    const base = '---\na: 1\nb: 2\n---';
    expect(expectClean(m(base, '---\na: 10\nb: 2\n---', '---\na: 1\nb: 20\n---'))).toBe(
      '---\na: 10\nb: 20\n---',
    );
  });

  it('finds frontmatter after a byte order mark', () => {
    const base = `\uFEFF${fm('a: 1', 'b: 2')}${body}`;
    const ours = `\uFEFF${fm('a: 10', 'b: 2')}${body}`;
    const theirs = `\uFEFF${fm('a: 1', 'b: 20')}${body}`;
    expect(expectClean(m(base, ours, theirs))).toBe(`\uFEFF${fm('a: 10', 'b: 20')}${body}`);
  });
});

describe('line endings and encoding', () => {
  const crlf = (text: string): string => text.replaceAll('\n', '\r\n');
  const base = lines('one', 'two', 'three', 'four');
  const ours = lines('ONE', 'two', 'three', 'four');
  const theirs = lines('one', 'two', 'three', 'FOUR');
  const merged = lines('ONE', 'two', 'three', 'FOUR');

  it('keeps CRLF when all sides use CRLF', () => {
    expect(m(crlf(base), crlf(ours), crlf(theirs))).toEqual({
      status: 'clean',
      text: crlf(merged),
      rules: [],
    });
  });

  it('applies a line-ending change by one side, and merges the content', () => {
    expect(m(base, crlf(ours), theirs)).toEqual({
      status: 'clean',
      text: crlf(merged),
      rules: ['text-format'],
    });
    expect(expectClean(m(crlf(base), ours, crlf(theirs)))).toBe(merged);
  });

  it('reports line-ending changes by both sides in different ways', () => {
    const result = expectConflict(m('one', crlf(lines('one', 'a')), lines('one', 'b')));
    expect(result.conflicts).toContainEqual({ kind: 'line-endings' });
  });

  it('does not change any line ending when a side mixes CRLF and LF', () => {
    const mixed = 'one\r\ntwo\nthree\r\nfour\n';
    expect(
      expectClean(m(mixed, 'ONE\r\ntwo\nthree\r\nfour\n', 'one\r\ntwo\nthree\r\nFOUR\n')),
    ).toBe('ONE\r\ntwo\nthree\r\nFOUR\n');
  });

  it('treats a changed line ending in a mixed text as a changed line', () => {
    const mixed = 'one\r\ntwo\nthree\n';
    expect(expectClean(m(mixed, 'one\ntwo\nthree\n', 'one\r\ntwo\nTHREE\n'))).toBe(
      'one\ntwo\nTHREE\n',
    );
    expect(m(mixed, 'one\ntwo\nthree\n', 'one\r\nTWO\nthree\n').status).toBe('conflict');
  });

  it('keeps a final line break that one side removed out of the result', () => {
    expect(
      expectClean(m(base, 'one\ntwo\nthree\nfour', lines('ONE', 'two', 'three', 'four'))),
    ).toBe('ONE\ntwo\nthree\nfour');
  });

  it('keeps a byte order mark that one side added', () => {
    expect(expectClean(m(base, `\uFEFF${ours}`, theirs))).toBe(`\uFEFF${merged}`);
    expect(expectClean(m(`\uFEFF${base}`, ours, `\uFEFF${theirs}`))).toBe(merged);
  });

  it('keeps lone carriage returns inside lines', () => {
    expect(expectClean(m('a\rb\nc\nd\n', 'A\rb\nc\nd\n', 'a\rb\nc\nD\n'))).toBe('A\rb\nc\nD\n');
  });
});

describe('empty files', () => {
  it('applies emptying a file when the other side did not change it', () => {
    expect(expectClean(m('a\n', '', 'a\n'))).toBe('');
  });

  it('reports emptying a file against a change', () => {
    expect(m('a\nb\n', '', 'a\nB\n').status).toBe('conflict');
  });

  it('merges a whitespace-only base', () => {
    expect(expectClean(m('\n', 'x\n\n', '\ny\n'))).toBe('x\n\ny\n');
  });
});

describe('large inputs', () => {
  it('merges very long lines', () => {
    const long = 'x'.repeat(1_000_000);
    const base = lines('head', long, 'tail');
    const ours = lines('HEAD', long, 'tail');
    const theirs = lines('head', long, 'TAIL');
    expect(expectClean(m(base, ours, theirs))).toBe(lines('HEAD', long, 'TAIL'));
  });

  it('merges a large note with blank lines and repeated items quickly', () => {
    // A long log: unique headings and entries, blank lines, repeated tasks.
    const baseLines = Array.from({ length: 10_000 }, (_, i) => {
      if (i % 50 === 0) return `## Day ${i / 50}`;
      if (i % 5 === 4) return '';
      if (i % 7 === 0) return '- [ ] review inbox';
      return `- entry ${i}`;
    });
    const ourLines = ['---', 'updated: today', '---', ...baseLines, '- ours'];
    const theirLines = [...baseLines];
    theirLines.splice(5001, 1, '- theirs');
    theirLines.unshift('# Log');
    const started = Date.now();
    const result = m(lines(...baseLines), lines(...ourLines), lines(...theirLines));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.status).toBe('clean');
  });
});
