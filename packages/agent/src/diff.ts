import { diffLines } from '@obsy/merge';

/** One line of a displayed diff. */
export interface DiffLine {
  /** `=` unchanged, `-` only in the old text, `+` only in the new text, `…` skipped unchanged lines. */
  readonly kind: '=' | '-' | '+' | '…';
  readonly text: string;
}

function lines(text: string): string[] {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

/**
 * The changes from `before` to `after`, line by line, with `context`
 * unchanged lines around each change. Longer runs of unchanged lines are
 * one `…` line that gives their count. For showing a proposal.
 */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const o = lines(before);
  const s = lines(after);
  const all: DiffLine[] = [];
  let oi = 0;
  for (const hunk of diffLines(o, s)) {
    while (oi < hunk.oStart) all.push({ kind: '=', text: o[oi++] as string });
    for (let i = 0; i < hunk.oLength; i++) all.push({ kind: '-', text: o[oi++] as string });
    for (let i = 0; i < hunk.sLength; i++)
      all.push({ kind: '+', text: s[hunk.sStart + i] as string });
  }
  while (oi < o.length) all.push({ kind: '=', text: o[oi++] as string });
  const near = all.map(() => false);
  all.forEach((line, i) => {
    if (line.kind === '=') return;
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++)
      near[j] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, i) => {
    if (near[i] === true) {
      if (skipped > 0) out.push({ kind: '…', text: `${skipped} unchanged lines` });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped > 0) out.push({ kind: '…', text: `${skipped} unchanged lines` });
  return out;
}
