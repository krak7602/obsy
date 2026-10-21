import fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import {
  appendToSection,
  blockHash,
  findBlock,
  findSection,
  headings,
  insertBlock,
  isOwned,
  joinLines,
  replaceBlockContent,
  splitLines,
} from './markdown';

const NOTE = `---
title: Day
---
# 2026-10-21

## Plan
- write

## Log
- 09:00 start

\`\`\`
## not a heading
\`\`\`

## Notes
text
`;

describe('lines', () => {
  it('splits and joins any text without change', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', '\n', '\r', '#', ' ', '﻿') }), (s) => {
        expect(joinLines(splitLines(s))).toBe(s);
      }),
    );
  });
});

describe('sections', () => {
  it('finds ATX headings outside frontmatter and code', () => {
    expect(headings(splitLines(NOTE)).map((h) => `${h.level} ${h.title}`)).toEqual([
      '1 2026-10-21',
      '2 Plan',
      '2 Log',
      '2 Notes',
    ]);
  });

  it('appends at the end of a section, before the blank line', () => {
    const result = appendToSection(NOTE, ['## Log'], ['- 10:00 agent']);
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.text).toContain(
      '## Log\n- 09:00 start\n\n```\n## not a heading\n```\n- 10:00 agent\n\n## Notes',
    );
  });

  it('finds nested paths and levels', () => {
    const text = '# A\n## Log\nx\n# B\n## Log\ny\n';
    expect(findSection(splitLines(text), ['Log']).status).toBe('ambiguous');
    expect(findSection(splitLines('## A\n### A\nx\n'), ['A']).status).toBe('found');
    expect(appendToSection('## A\n### A\nx\n', ['A', 'A'], ['y'])).toEqual({
      status: 'ok',
      text: '## A\n### A\nx\ny\n',
    });
    const result = appendToSection(text, ['B', 'Log'], ['z']);
    expect(result).toEqual({ status: 'ok', text: '# A\n## Log\nx\n# B\n## Log\ny\nz\n' });
    expect(appendToSection(text, ['### Log'], ['z'], false).status).toBe('missing');
  });

  it('creates missing headings at the end of the deepest found section', () => {
    expect(appendToSection('# Day\ntext\n\n# Other\n', ['Day', 'Agent'], ['- a'])).toEqual({
      status: 'ok',
      text: '# Day\ntext\n\n## Agent\n- a\n\n# Other\n',
    });
    expect(appendToSection('', ['Log'], ['- a'])).toEqual({ status: 'ok', text: '## Log\n- a\n' });
    expect(appendToSection('```\ncode\n', [], ['- a'])).toEqual({ status: 'ambiguous' });
    expect(appendToSection('no newline', [], ['- a'])).toEqual({
      status: 'ok',
      text: 'no newline\n- a\n',
    });
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    const result = appendToSection('﻿## Log\r\n- a\r\n', ['Log'], ['- b']);
    expect(result).toEqual({ status: 'ok', text: '﻿## Log\r\n- a\r\n- b\r\n' });
  });

  it('keeps every original line in order, and adds the lines together, inside the section', () => {
    const line = fc.constantFrom('', 'x', '# A', '## B', '### C', '```', '- item', '## A');
    const step = fc.constantFrom('A', 'B', 'C', '## A', '# A');
    expect(() =>
      fc.assert(
        fc.property(
          fc.array(line, { maxLength: 12 }),
          fc.array(step, { maxLength: 3 }),
          (lines, path) => {
            const text = lines.map((l) => `${l}\n`).join('');
            const added = ['- new 1', '- new 2'];
            const result = appendToSection(text, path, added);
            // Not ok only when a heading repeats, the end of the section is in
            // an unclosed fence, or a created heading could not nest.
            if (result.status !== 'ok') return result.status === 'ambiguous';
            const out = splitLines(result.text).lines;
            let i = 0;
            for (const l of out) if (i < lines.length && l === lines[i]) i++;
            const at = out.indexOf('- new 1');
            const lookup = findSection(splitLines(result.text), path);
            return (
              i === lines.length &&
              out[at + 1] === '- new 2' &&
              lookup.status === 'found' &&
              at >= lookup.scope.start &&
              at + 1 < lookup.scope.end
            );
          },
        ),
      ),
    ).not.toThrow();
  });
});

describe('blocks', () => {
  it('inserts an owned block and replaces it', async () => {
    const inserted = await insertBlock(NOTE, ['Plan'], 'weather', 'Sunny\n');
    expect(inserted.status).toBe('ok');
    if (inserted.status !== 'ok') return;
    const hash = await blockHash('Sunny');
    expect(inserted.text).toContain(
      `## Plan\n- write\n<!-- obsy:agent id=weather hash=${hash} -->\nSunny\n<!-- /obsy:agent id=weather -->\n\n## Log`,
    );
    const lookup = findBlock(splitLines(inserted.text), 'weather');
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(await isOwned(lookup.block)).toBe(true);
    const replaced = await replaceBlockContent(
      inserted.text,
      lookup.block,
      'weather',
      'Rain\nWind',
    );
    expect(replaced).toContain('Rain\nWind\n<!-- /obsy:agent id=weather -->');
    expect(replaced.replace(/<!-- obsy:agent[^\n]*\n[\s\S]*?<!-- \/obsy:agent[^\n]*\n/, '')).toBe(
      inserted.text.replace(/<!-- obsy:agent[^\n]*\n[\s\S]*?<!-- \/obsy:agent[^\n]*\n/, ''),
    );
  });

  it('sees a person edit inside the block', async () => {
    const inserted = await insertBlock('', [], 'w', 'a\nb');
    if (inserted.status !== 'ok') throw new Error('insert failed');
    const edited = inserted.text.replace('\nb\n', '\nb!\n');
    const lookup = findBlock(splitLines(edited), 'w');
    expect(lookup.status === 'found' && (await isOwned(lookup.block))).toBe(false);
  });

  it('treats duplicates, a missing end, and markers in code as not found or ambiguous', () => {
    const block = '<!-- obsy:agent id=w -->\nx\n<!-- /obsy:agent id=w -->\n';
    expect(findBlock(splitLines(block + block), 'w').status).toBe('ambiguous');
    expect(findBlock(splitLines('<!-- obsy:agent id=w -->\nx\n'), 'w').status).toBe('ambiguous');
    expect(findBlock(splitLines(`\`\`\`\n${block}\`\`\`\n`), 'w').status).toBe('missing');
    expect(findBlock(splitLines(block), 'other').status).toBe('missing');
    const nested =
      '<!-- obsy:agent id=w -->\n<!-- obsy:agent id=v -->\n<!-- /obsy:agent id=w -->\n';
    expect(findBlock(splitLines(nested), 'w').status).toBe('ambiguous');
  });

  it('keeps ownership through a round of replaces, in CRLF too', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('x', '', '- a', '## H'), { maxLength: 6 }),
        fc.array(fc.array(fc.constantFrom('one', 'two', '', '```'), { maxLength: 4 }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.boolean(),
        async (lines, contents, crlf) => {
          const eol = crlf ? '\r\n' : '\n';
          let text = lines.map((l) => `${l}${eol}`).join('');
          const first = await insertBlock(text, [], 'b', (contents[0] as string[]).join('\n'));
          if (first.status !== 'ok') throw new Error('insert failed');
          text = first.text;
          for (const content of contents) {
            const lookup = findBlock(splitLines(text), 'b');
            if (lookup.status !== 'found') throw new Error(`lookup ${lookup.status}`);
            expect(await isOwned(lookup.block)).toBe(true);
            text = await replaceBlockContent(text, lookup.block, 'b', content.join('\n'));
          }
          // Every original line is still there, in order.
          const out = splitLines(text).lines;
          let i = 0;
          for (const l of out)
            if (i < lines.length && l === `${lines[i] as string}${crlf ? '\r' : ''}`) i++;
          expect(i).toBe(lines.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
