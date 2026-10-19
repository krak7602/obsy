/**
 * Text model for the merge: a text is a list of lines plus a few
 * attributes (byte order mark, line-ending style, final line break).
 *
 * `decode` and `encode` are exact inverses for one text: for every string
 * `s`, `encode(decode(s, raw), ...)` with the decoded attributes returns `s`.
 */

/** The line-ending style of a text. */
export type LineEnding =
  /** Every line break is `\n`. */
  | 'lf'
  /** Every line break is `\r\n`. */
  | 'crlf'
  /** The text uses both `\n` and `\r\n` line breaks. */
  | 'mixed'
  /** The text has no line break. */
  | 'none';

export interface DecodedText {
  /** The text started with U+FEFF. The mark is not part of `lines`. */
  readonly bom: boolean;
  readonly eol: LineEnding;
  /**
   * Lines without their line breaks. In raw mode, the text is split on
   * `\n` only, so a line can end with `\r`.
   */
  readonly lines: string[];
  /** The last line ends with a line break. Always false when `lines` is empty. */
  readonly finalNewline: boolean;
}

const BOM = '﻿';
const CR = 13;

/** Returns the line-ending style of `text`. */
export function detectLineEnding(text: string): LineEnding {
  let lf = 0;
  let crlf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === CR) {
      crlf++;
    } else {
      lf++;
    }
  }
  if (lf === 0 && crlf === 0) return 'none';
  if (crlf === 0) return 'lf';
  if (lf === 0) return 'crlf';
  return 'mixed';
}

function stripBom(text: string): { readonly bom: boolean; readonly rest: string } {
  return text.startsWith(BOM) ? { bom: true, rest: text.slice(1) } : { bom: false, rest: text };
}

/** Returns the line-ending style of `text`, ignoring a leading byte order mark. */
export function lineEndingOf(text: string): LineEnding {
  return detectLineEnding(stripBom(text).rest);
}

/**
 * Splits `text` into lines.
 *
 * In normal mode, a `crlf` text is split on `\r\n` and any other text on
 * `\n`. In raw mode, every text is split on `\n`, and `\r` stays part of
 * the line. Use raw mode when any input has mixed line endings, so that
 * no line ending is changed.
 */
export function decode(text: string, raw: boolean): DecodedText {
  const { bom, rest } = stripBom(text);
  const eol = detectLineEnding(rest);
  if (rest === '') return { bom, eol, lines: [], finalNewline: false };
  const separator = !raw && eol === 'crlf' ? '\r\n' : '\n';
  if (rest.endsWith(separator)) {
    return {
      bom,
      eol,
      lines: rest.slice(0, -separator.length).split(separator),
      finalNewline: true,
    };
  }
  return { bom, eol, lines: rest.split(separator), finalNewline: false };
}

/**
 * Joins lines into text. `eol` selects the line break: `crlf` uses `\r\n`;
 * every other value uses `\n`.
 */
export function encode(
  lines: readonly string[],
  finalNewline: boolean,
  eol: LineEnding,
  bom: boolean,
): string {
  const separator = eol === 'crlf' ? '\r\n' : '\n';
  const prefix = bom ? BOM : '';
  if (lines.length === 0) return prefix;
  return prefix + lines.join(separator) + (finalNewline ? separator : '');
}
