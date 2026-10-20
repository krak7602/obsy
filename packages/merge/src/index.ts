/**
 * Markdown-aware three-way merge for obsy.
 *
 * `merge3` is the only entry point. It is pure, deterministic, and free of
 * Node and DOM APIs. See docs/subsystems/merge.md for the rules.
 */
export { merge3 } from './merge';
export type {
  CleanMerge,
  ConflictMerge,
  MergeConflict,
  MergeInput,
  MergeResult,
  MergeRule,
} from './merge';
export type { FrontmatterConflictReason } from './frontmatter';
export type { LineRange } from './lines';
/** Low-level three-way line comparison, without obsy's Markdown rules. Tests use it as a baseline. */
export { diff3Regions } from './diff3';
export type { Diff3Region, Span } from './diff3';
