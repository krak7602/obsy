// The parts of Obsidian that `VaultLocalFiles` uses. `ObsidianVaultPort`
// implements them on the app; tests use `FakeVault`. Paths are vault paths.

/** One file in the vault index. */
export interface VaultFileInfo {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}

/** The editor of a note that is open for editing. */
export interface EditorPort {
  getText(): string;
  /** Replaces the text from `from` to `to` (UTF-16 offsets) with `text`, as one transaction. */
  replace(from: number, to: number, text: string): void;
  /** Writes the editor text to the file now. */
  save(): Promise<void>;
}

export interface VaultPort {
  /** Every file in the vault index. The config folder and dot paths are not in it. */
  files(): VaultFileInfo[];
  /** The indexed file at exactly this path, or null. */
  file(path: string): VaultFileInfo | null;
  /** Whether anything exists at this path on disk, matching case and Unicode form as the file system does. */
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<Uint8Array>;
  /** Reads the text, passes it to `fn`, and writes the result, as one step for Obsidian. */
  processText(path: string, fn: (text: string) => string): Promise<void>;
  modifyBinary(path: string, bytes: Uint8Array): Promise<void>;
  /** Creates a file, and its parent folders when needed. Fails when the path exists. */
  createBinary(path: string, bytes: Uint8Array): Promise<void>;
  /** Appends to an existing file. */
  appendBinary(path: string, bytes: Uint8Array): Promise<void>;
  /** Renames a file without updating links, creating parent folders when needed. Fails when the target exists. */
  rename(from: string, to: string): Promise<void>;
  /** Deletes a file as the user's deletion preference says (trash, or permanently). */
  trash(path: string): Promise<void>;
  /** The editor of the note when it is open in source or live preview mode, else null. */
  editor(path: string): EditorPort | null;
  /**
   * Vault paths of symbolic links in the vault folder, outside dot folders,
   * without following them. Empty where links cannot be read (mobile).
   */
  symlinks(): Promise<string[]>;
}
