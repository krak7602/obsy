import { hashContent, hashHex, encodeUtf8 } from '@obsy/protocol';

/**
 * Pure Markdown edits for agent operations: sections found by heading, and
 * agent-owned blocks. See docs/subsystems/agent-sdk.md#anchors.
 *
 * A text is split into lines without changing any line that the edit does
 * not touch: line endings, a byte order mark, and a missing final newline
 * stay as they were.
 */

/** A text as lines. Each line keeps a trailing `\r` if it had one. */
export interface Lines {
  readonly bom: string;
  readonly lines: string[];
  readonly finalNewline: boolean;
  /** `\r` when the text uses CRLF line endings, else empty. */
  readonly cr: string;
}

export function splitLines(text: string): Lines {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = text.slice(bom.length);
  const firstBreak = body.indexOf('\n');
  const cr = firstBreak > 0 && body[firstBreak - 1] === '\r' ? '\r' : '';
  if (body === '') return { bom, lines: [], finalNewline: false, cr };
  const lines = body.split('\n');
  const finalNewline = lines.at(-1) === '';
  if (finalNewline) lines.pop();
  return { bom, lines, finalNewline, cr };
}

/**
 * Joins lines again. `inserted` lines are new; they get the text's line
 * ending. Inserting after a last line that had no newline gives it one.
 */
export function joinLines(text: Lines): string {
  if (text.lines.length === 0) return text.bom;
  return `${text.bom}${text.lines.join('\n')}${text.finalNewline ? '\n' : ''}`;
}

/** Inserts `added` (without line endings) before line `at`. */
function insertLines(text: Lines, at: number, added: readonly string[]): Lines {
  if (added.length === 0) return text;
  const lines = [...text.lines];
  const atEnd = at === lines.length;
  // A last line without a newline gets one before lines follow it.
  if (atEnd && lines.length > 0 && !text.finalNewline) {
    lines[lines.length - 1] = `${lines.at(-1) as string}${text.cr}`;
  }
  lines.splice(at, 0, ...added.map((line) => `${line}${text.cr}`));
  return { ...text, lines, finalNewline: atEnd ? true : text.finalNewline };
}

function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// ---------------------------------------------------------------- structure

export interface Heading {
  readonly line: number;
  readonly level: number;
  readonly title: string;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * For each line, whether it is frontmatter or fenced code (fence lines
 * included). The last entry, at index `lines.length`, tells whether text
 * added at the end would be inside an unclosed fence.
 */
function codeMap(text: Lines): boolean[] {
  const code = Array.from({ length: text.lines.length + 1 }, () => false);
  let start = 0;
  if (text.lines.length > 0 && bare(text.lines[0] as string) === '---') {
    const end = text.lines.findIndex(
      (line, i) => i > 0 && (bare(line) === '---' || bare(line) === '...'),
    );
    if (end > 0) {
      for (let i = 0; i <= end; i++) code[i] = true;
      start = end + 1;
    }
  }
  let fence: string | null = null;
  for (let i = start; i < text.lines.length; i++) {
    const line = bare(text.lines[i] as string);
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      code[i] = true;
      if (
        fenceMatch !== null &&
        fenceMatch[1]?.[0] === fence[0] &&
        (fenceMatch[1]?.length ?? 0) >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = null;
      }
    } else if (fenceMatch !== null) {
      code[i] = true;
      fence = fenceMatch[1] as string;
    }
  }
  code[text.lines.length] = fence !== null;
  return code;
}

/** True when a line inserted before line `at` would be fenced code or frontmatter. */
function insideCode(text: Lines, at: number): boolean {
  const lines = [...text.lines];
  lines.splice(at, 0, 'probe');
  return codeMap({ ...text, lines })[at] as boolean;
}

/**
 * ATX headings outside YAML frontmatter and fenced code. Setext headings
 * (underlined) are not recognised.
 */
export function headings(text: Lines): Heading[] {
  const found: Heading[] = [];
  const code = codeMap(text);
  for (let i = 0; i < text.lines.length; i++) {
    if (code[i] as boolean) continue;
    const line = bare(text.lines[i] as string);
    const match = ATX.exec(line);
    if (match !== null) {
      found.push({ line: i, level: (match[1] as string).length, title: (match[2] ?? '').trim() });
    }
  }
  return found;
}

/** One step of a heading path: a title, optionally with its level as `#` marks (`## Log`). */
interface HeadingSpec {
  readonly level: number | null;
  readonly title: string;
}

function parseSpec(spec: string): HeadingSpec {
  const match = /^(#{1,6})\s+(.*)$/.exec(spec.trim());
  if (match === null) return { level: null, title: spec.trim() };
  return { level: (match[1] as string).length, title: (match[2] as string).trim() };
}

/** Checks a heading path. Returns the problem, or null. */
export function headingPathProblem(path: readonly string[]): string | null {
  for (const spec of path) {
    const parsed = parseSpec(spec);
    if (parsed.title === '') return 'a heading in the path is empty';
    if (/[\r\n]/.test(spec)) return 'a heading in the path has a line break';
  }
  return null;
}

/** Lines `[start, end)` of the text that a section covers, below its heading. */
interface Scope {
  readonly start: number;
  readonly end: number;
  /** The level of the heading that owns the scope; 0 for the whole text. */
  readonly level: number;
}

export type SectionLookup =
  | { readonly status: 'found'; readonly scope: Scope }
  | {
      readonly status: 'missing';
      /** The deepest section that was found. */
      readonly parent: Scope;
      /** The steps of the path that are missing. */
      readonly missing: readonly string[];
    }
  | { readonly status: 'ambiguous'; readonly title: string };

/**
 * Finds the section of a heading path. Each step is searched below the
 * previous one, at a deeper level. An empty path is the whole text.
 */
export function findSection(text: Lines, path: readonly string[]): SectionLookup {
  const all = headings(text);
  let scope: Scope = { start: 0, end: text.lines.length, level: 0 };
  for (let depth = 0; depth < path.length; depth++) {
    const spec = parseSpec(path[depth] as string);
    const matches = all.filter(
      (h) =>
        h.line >= scope.start &&
        h.line < scope.end &&
        h.level > scope.level &&
        (spec.level === null || h.level === spec.level) &&
        h.title === spec.title,
    );
    // A heading nested in the section of another match is not a second match.
    const sectionEnd = (h: Heading): number =>
      all.find((n) => n.line > h.line && n.level <= h.level)?.line ?? text.lines.length;
    const outermost = matches.filter(
      (h) => !matches.some((o) => o.line < h.line && h.line < sectionEnd(o)),
    );
    if (outermost.length > 1) return { status: 'ambiguous', title: spec.title };
    const match = outermost[0];
    if (match === undefined)
      return { status: 'missing', parent: scope, missing: path.slice(depth) };
    const next = all.find((h) => h.line > match.line && h.level <= match.level);
    scope = {
      start: match.line + 1,
      end: Math.min(scope.end, next?.line ?? text.lines.length),
      level: match.level,
    };
  }
  return { status: 'found', scope };
}

/** The line after the last non-blank line of the scope, or its start. */
function endOfContent(text: Lines, scope: Scope): number {
  for (let i = scope.end - 1; i >= scope.start; i--) {
    if (bare(text.lines[i] as string).trim() !== '') return i + 1;
  }
  return scope.start;
}

/**
 * Inserts lines at the end of a section's content. Missing headings of the
 * path are created at the end of the deepest section found; a heading
 * without a level gets one level below its parent, and at least `##`.
 */
function insertInSection(
  text: Lines,
  path: readonly string[],
  added: readonly string[],
  createMissing: boolean,
): { status: 'ok'; text: Lines } | { status: 'missing' | 'ambiguous' } {
  const lookup = findSection(text, path);
  if (lookup.status === 'ambiguous') return { status: 'ambiguous' };
  if (lookup.status === 'found') {
    const at = endOfContent(text, lookup.scope);
    // Lines added inside an unclosed code fence would be code, not text.
    if (insideCode(text, at)) return { status: 'ambiguous' };
    return { status: 'ok', text: insertLines(text, at, added) };
  }
  if (!createMissing) return { status: 'missing' };
  const at = endOfContent(text, lookup.parent);
  if (insideCode(text, at)) return { status: 'ambiguous' };
  const block: string[] = [];
  let level: number;
  let parentLevel = lookup.parent.level;
  for (const step of lookup.missing) {
    const spec = parseSpec(step);
    level = spec.level ?? Math.min(Math.max(parentLevel, 1) + 1, 6);
    // A heading must be deeper than its parent to be inside its section.
    if (level <= parentLevel) return { status: 'ambiguous' };
    block.push(`${'#'.repeat(level)} ${spec.title}`);
    parentLevel = level;
  }
  const before = at > 0 && bare(text.lines[at - 1] as string).trim() !== '' ? [''] : [];
  const after = at < text.lines.length && bare(text.lines[at] as string).trim() !== '' ? [''] : [];
  return { status: 'ok', text: insertLines(text, at, [...before, ...block, ...added, ...after]) };
}

// ---------------------------------------------------------------- appends

/** Why a line cannot be added by an agent, or null. */
export function lineProblem(line: string): string | null {
  if (/[\r\n]/.test(line)) return 'a line has a line break';
  if (MARKER.test(line)) return 'a line is an obsy block marker';
  return null;
}

export type EditResult =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'missing' | 'ambiguous' };

/** Appends lines at the end of the section. An empty path appends at the end of the text. */
export function appendToSection(
  text: string,
  path: readonly string[],
  added: readonly string[],
  createMissing = true,
): EditResult {
  const result = insertInSection(splitLines(text), path, added, createMissing);
  return result.status === 'ok' ? { status: 'ok', text: joinLines(result.text) } : result;
}

/**
 * Appends lines at the very end of the text, with no anchor checks. For
 * proposals, which the owner reads before anything is written.
 */
export function appendAtEnd(text: string, added: readonly string[]): string {
  const lines = splitLines(text);
  return joinLines(insertLines(lines, lines.lines.length, added));
}

// ---------------------------------------------------------------- blocks

const BLOCK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MARKER = /^\s*<!--\s*\/?obsy:agent\b/;
const START = /^\s*<!--\s*obsy:agent\s+id=(\S+?)(?:\s+hash=([0-9a-f]{16}))?\s*-->\s*$/;
const END = /^\s*<!--\s*\/obsy:agent(?:\s+id=(\S+?))?\s*-->\s*$/;

export function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && BLOCK_ID.test(value);
}

/** One block with the asked ID. */
export interface Block {
  /** The line of the start marker. */
  readonly start: number;
  /** The line of the end marker. */
  readonly end: number;
  /** The hash in the start marker, or null. */
  readonly declared: string | null;
  /** The lines between the markers, joined with `\n`. */
  readonly inner: string;
}

export type BlockLookup =
  | { readonly status: 'found'; readonly block: Block }
  | { readonly status: 'missing' }
  | { readonly status: 'ambiguous' };

/**
 * Finds the block with `id`. More than one block with the ID, a start
 * marker without its end, or another block's marker inside it is
 * `ambiguous`. Markers inside fenced code are text, not markers.
 */
export function findBlock(text: Lines, id: string): BlockLookup {
  const found: Block[] = [];
  let fence: string | null = null;
  let open: { start: number; declared: string | null } | null = null;
  for (let i = 0; i < text.lines.length; i++) {
    const line = bare(text.lines[i] as string);
    if (open === null) {
      const fenceMatch = FENCE.exec(line);
      if (fence !== null) {
        if (fenceMatch !== null && fenceMatch[1]?.[0] === fence[0] && line.trim() === fenceMatch[1])
          fence = null;
        continue;
      }
      if (fenceMatch !== null) {
        fence = fenceMatch[1] as string;
        continue;
      }
      const start = START.exec(line);
      if (start?.[1] === id) open = { start: i, declared: start[2] ?? null };
      else if (END.exec(line)?.[1] === id) return { status: 'ambiguous' };
      continue;
    }
    if (START.test(line)) return { status: 'ambiguous' };
    const end = END.exec(line);
    if (end === null) continue;
    if (end[1] !== undefined && end[1] !== id) return { status: 'ambiguous' };
    found.push({
      start: open.start,
      end: i,
      declared: open.declared,
      inner: text.lines.slice(open.start + 1, i).join('\n'),
    });
    open = null;
  }
  if (open !== null || found.length > 1) return { status: 'ambiguous' };
  const block = found[0];
  return block === undefined ? { status: 'missing' } : { status: 'found', block };
}

/** The hash that a start marker carries: the first 16 hex digits of the SHA-256 of `inner`. */
export async function blockHash(inner: string): Promise<string> {
  return hashHex(await hashContent(encodeUtf8(inner))).slice(0, 16);
}

/** True when the block's content is what an agent last wrote: nobody edited it since. */
export async function isOwned(block: Block): Promise<boolean> {
  return block.declared !== null && block.declared === (await blockHash(block.inner));
}

/** Splits block content into lines: one final newline is not a line. */
export function contentLines(content: string): string[] {
  if (content === '') return [];
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  return body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

async function blockLines(text: Lines, id: string, content: string): Promise<string[]> {
  const inner = contentLines(content);
  const hash = await blockHash(inner.map((line) => `${line}${text.cr}`).join('\n'));
  return [`<!-- obsy:agent id=${id} hash=${hash} -->`, ...inner, `<!-- /obsy:agent id=${id} -->`];
}

/**
 * Replaces the inner lines of a found block, with a new hash. The caller
 * has checked that the agent owns it.
 */
export async function replaceBlockContent(
  text: string,
  block: Block,
  id: string,
  content: string,
): Promise<string> {
  const lines = splitLines(text);
  const replacement = (await blockLines(lines, id, content)).map((line) => `${line}${lines.cr}`);
  const next = [...lines.lines];
  // Keep the end marker's own line ending if it is the last line without a newline.
  next.splice(block.start, block.end - block.start + 1, ...replacement);
  const lastWasEnd = block.end === lines.lines.length - 1;
  if (lastWasEnd && !lines.finalNewline) {
    next[next.length - 1] = bare(next.at(-1) as string);
  }
  return joinLines({ ...lines, lines: next });
}

/** Inserts a new block at the end of a section, creating missing headings. */
export async function insertBlock(
  text: string,
  path: readonly string[],
  id: string,
  content: string,
): Promise<EditResult> {
  const lines = splitLines(text);
  const result = insertInSection(lines, path, await blockLines(lines, id, content), true);
  return result.status === 'ok' ? { status: 'ok', text: joinLines(result.text) } : result;
}

/** Appends a new block at the very end of the text, with no anchor checks. For proposals. */
export async function appendBlockAtEnd(text: string, id: string, content: string): Promise<string> {
  const lines = splitLines(text);
  return joinLines(insertLines(lines, lines.lines.length, await blockLines(lines, id, content)));
}
