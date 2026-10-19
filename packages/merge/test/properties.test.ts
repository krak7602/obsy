import fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { merge3, type MergeConflict, type MergeResult } from '../src/index.ts';
import { decode, encode } from '../src/text.ts';
import {
  docArb,
  editArb,
  applyEdits,
  render,
  toCrlf,
  tripleArb,
  type Triple,
} from './arbitraries.ts';

/**
 * Property tests over generated Markdown edits. Set OBSY_PROPERTY_RUNS to
 * run more cases per property; set OBSY_PROPERTY_SEED to replay a seed.
 */
const RUNS = Number(process.env['OBSY_PROPERTY_RUNS'] ?? 300);
const seed = process.env['OBSY_PROPERTY_SEED'];
const params: fc.Parameters<unknown> =
  seed === undefined ? { numRuns: RUNS } : { numRuns: RUNS, seed: Number(seed) };

const merge = (t: Triple): MergeResult => merge3(t);
const swapped = (t: Triple): MergeResult =>
  merge3({ base: t.base, ours: t.theirs, theirs: t.ours });

/** Lines without line breaks or a byte order mark. */
function linesOf(text: string): string[] {
  const rest = text.replace(/^\uFEFF/, '');
  return rest === '' ? [] : rest.replace(/\r?\n$/, '').split(/\r?\n/);
}
const sorted = (items: string[]): string[] => items.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
const MARKER = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/;

function swapConflict(conflict: MergeConflict): MergeConflict {
  return conflict.kind === 'lines'
    ? { ...conflict, ours: conflict.theirs, theirs: conflict.ours }
    : conflict;
}

/** Top-level keys of the frontmatter of `text`, or null when there is none. */
function frontmatterKeys(text: string): string[] | null {
  const lines = linesOf(text);
  if (lines[0] !== '---') return null;
  const close = lines.indexOf('---', 1);
  if (close === -1) return null;
  return lines
    .slice(1, close)
    .flatMap((line) => /^([^\s#'"-][^:]*):(?:\s|$)/.exec(line)?.[1] ?? []);
}

const allTriples = tripleArb(['lf', 'crlf', 'per-side']);

describe('merge properties', () => {
  it('merges an identical change on both sides to that change', () => {
    fc.assert(
      fc.property(tripleArb(['lf', 'crlf']), (t) => {
        expect(merge3({ base: t.base, ours: t.ours, theirs: t.ours })).toEqual({
          status: 'clean',
          text: t.ours,
          rules: [],
        });
      }),
      params,
    );
  });

  it('returns the changed side when only one side changed', () => {
    fc.assert(
      fc.property(allTriples, (t) => {
        expect(merge3({ base: t.base, ours: t.base, theirs: t.theirs })).toMatchObject({
          text: t.theirs,
        });
        expect(merge3({ base: t.base, ours: t.ours, theirs: t.base })).toMatchObject({
          text: t.ours,
        });
      }),
      params,
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(allTriples, (t) => {
        expect(merge(t)).toEqual(merge(t));
      }),
      params,
    );
  });

  it('makes the same decision when ours and theirs swap', () => {
    fc.assert(
      fc.property(allTriples, (t) => {
        const a = merge(t);
        // Union inserts and merged frontmatter may order kept lines differently.
        const unordered =
          a.status === 'clean' &&
          (a.rules.includes('union-insert') || a.rules.includes('frontmatter-keys'));
        const view = (result: MergeResult, swap: boolean): unknown =>
          result.status === 'conflict'
            ? { conflicts: swap ? result.conflicts.map(swapConflict) : result.conflicts }
            : {
                rules: result.rules,
                text: unordered ? sorted(result.text.split(/\r?\n/)) : result.text,
              };
        expect(view(swapped(t), true)).toEqual(view(a, false));
      }),
      params,
    );
  });

  it('keeps every non-blank line that either side added, when clean', () => {
    fc.assert(
      fc.property(allTriples, (t) => {
        const result = merge(t);
        const base = new Set(linesOf(t.base));
        const output = new Set(result.status === 'clean' ? linesOf(result.text) : []);
        // Blank lines are not checked: a blank last line and a removed final
        // line break can cancel out (see docs/learning/merge-spike.md).
        const added = [...linesOf(t.ours), ...linesOf(t.theirs)].filter(
          (line) => line.trim() !== '' && !base.has(line),
        );
        const missing = result.status === 'clean' ? added.filter((line) => !output.has(line)) : [];
        expect(missing).toEqual([]);
      }),
      params,
    );
  });

  it('never writes conflict markers, and keeps frontmatter keys unique', () => {
    fc.assert(
      fc.property(allTriples, (t) => {
        const result = merge(t);
        const text = result.status === 'clean' ? result.text : '';
        expect(linesOf(text).filter((line) => MARKER.test(line))).toEqual([]);
        const keys = frontmatterKeys(text) ?? [];
        expect(new Set(keys).size).toBe(keys.length);
      }),
      params,
    );
  });

  it('gives theirs to keep and ours to copy on conflict', () => {
    fc.assert(
      fc.property(allTriples, (t) => {
        const result = merge(t);
        const contract =
          result.status === 'conflict'
            ? [result.keep, result.copy, result.conflicts.length > 0]
            : [t.theirs, t.ours, true];
        expect(contract).toEqual([t.theirs, t.ours, true]);
      }),
      params,
    );
  });

  it('merges CRLF texts exactly like the same LF texts', () => {
    fc.assert(
      fc.property(tripleArb(['lf']), (t) => {
        // Without any line break, a CRLF text is the same as the LF text.
        fc.pre([t.base, t.ours, t.theirs].some((text) => text.includes('\n')));
        const lf = merge(t);
        const crlf = merge3({
          base: toCrlf(t.base),
          ours: toCrlf(t.ours),
          theirs: toCrlf(t.theirs),
        });
        const expected =
          lf.status === 'clean'
            ? { ...lf, text: toCrlf(lf.text) }
            : { ...lf, keep: toCrlf(lf.keep), copy: toCrlf(lf.copy) };
        expect(crlf).toEqual(expected);
      }),
      params,
    );
  });

  it('never changes line endings when all three texts agree on them', () => {
    fc.assert(
      fc.property(tripleArb(['lf', 'crlf']), (t) => {
        const result = merge(t);
        const text = result.status === 'clean' ? result.text : '';
        const crlf = [t.base, t.ours, t.theirs].some((side) => side.includes('\r\n'));
        const changed = crlf ? text.replaceAll('\r\n', '').includes('\n') : text.includes('\r');
        expect(changed).toBe(false);
      }),
      params,
    );
  });
});

describe('no-base properties', () => {
  it('takes the longer text when one side appended to the other', () => {
    fc.assert(
      fc.property(
        docArb,
        fc.array(editArb, { maxLength: 3 }),
        fc.array(fc.string(), { minLength: 1 }),
        (doc, edits, extra) => {
          const short = render(applyEdits(doc, edits));
          const long = `${short}${short === '' || short.endsWith('\n') ? '' : '\n'}${extra.map((l) => l.replaceAll(/[\r\n]/g, '')).join('\n')}\n`;
          expect(merge3({ base: null, ours: short, theirs: long })).toMatchObject({
            status: 'clean',
            text: long,
          });
          expect(merge3({ base: null, ours: long, theirs: short })).toMatchObject({
            status: 'clean',
            text: long,
          });
        },
      ),
      params,
    );
  });

  it('returns one side unchanged when clean', () => {
    fc.assert(
      fc.property(allTriples, (t) => {
        const result = merge3({ base: null, ours: t.ours, theirs: t.theirs });
        const ok =
          result.status === 'clean'
            ? [t.ours, t.theirs].includes(result.text)
            : JSON.stringify(result.conflicts) === '[{"kind":"no-base"}]';
        expect(ok).toBe(true);
      }),
      params,
    );
  });
});

describe('text model', () => {
  const textArb = fc.string({
    unit: fc.constantFrom('a', 'b', ' ', '\n', '\r', '\r\n', '\uFEFF', 'é', '-'),
  });

  it('decodes and encodes every text back to itself', () => {
    fc.assert(
      fc.property(textArb, fc.boolean(), (text, raw) => {
        const decoded = decode(text, raw);
        const eol = raw ? 'lf' : decoded.eol;
        expect(encode(decoded.lines, decoded.finalNewline, eol, decoded.bom)).toBe(text);
      }),
      { ...params, numRuns: RUNS * 3 },
    );
  });

  it('merges arbitrary text without throwing, and keeps the contract', () => {
    fc.assert(
      fc.property(textArb, textArb, textArb, fc.boolean(), (base, ours, theirs, noBase) => {
        const result = merge3({ base: noBase ? null : base, ours, theirs });
        const sides = result.status === 'conflict' ? [result.keep, result.copy] : [theirs, ours];
        expect(sides).toEqual([theirs, ours]);
      }),
      { ...params, numRuns: RUNS * 3 },
    );
  });
});
