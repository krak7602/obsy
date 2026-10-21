// Test support: a vault in memory with Obsidian's write behaviour and a
// case-insensitive file system, as on macOS and iOS. Not part of any bundle.
import { decodeUtf8Strict, encodeUtf8, pathKey } from '@obsy/protocol';

import type { EditorPort, VaultFileInfo, VaultPort } from '../sync/vault-port';

interface Stored {
  path: string;
  bytes: Uint8Array;
  mtime: number;
}

/** An open note. `text` is the editor buffer; it differs from the file while edits are unsaved. */
export class FakeEditor implements EditorPort {
  /** When false, `save` does nothing, like a view that did not notice the change. */
  saves = true;
  transactions = 0;

  constructor(
    readonly vault: FakeVault,
    readonly path: string,
    public text: string,
  ) {}

  getText(): string {
    return this.text;
  }

  replace(from: number, to: number, text: string): void {
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    this.transactions++;
  }

  save(): Promise<void> {
    if (this.saves) this.vault.userWrite(this.path, this.text);
    return Promise.resolve();
  }
}

export class FakeVault implements VaultPort {
  readonly #files = new Map<string, Stored>();
  readonly editors = new Map<string, FakeEditor>();
  readonly trashed: string[] = [];
  /** Vault paths with an event, in order: obsy's own writes and user changes. */
  readonly events: string[] = [];
  #clock = 1_000;
  /**
   * Called at the points where a user action can land in Obsidian: before a
   * read, after a read (while obsy hashes), and before `processText` reads.
   * Other writes are treated as atomic.
   */
  before: (call: string, path: string) => void = () => undefined;
  /** Paths that `symlinks` reports. */
  links: string[] = [];

  symlinks(): Promise<string[]> {
    return Promise.resolve([...this.links]);
  }

  #tick(): number {
    this.#clock += 1;
    return this.#clock;
  }

  // ------------------------------------------------------------ user and test access

  userWrite(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === 'string' ? encodeUtf8(content) : content.slice();
    const existing = this.#files.get(pathKey(path));
    this.#files.set(pathKey(path), {
      path: existing?.path ?? path,
      bytes,
      mtime: this.#tick(),
    });
    const editor = this.editors.get(pathKey(path));
    if (editor !== undefined && typeof content === 'string') editor.text = content;
    this.events.push(path);
  }

  userRemove(path: string): void {
    this.#files.delete(pathKey(path));
    this.events.push(path);
  }

  userRename(from: string, to: string): void {
    const file = this.#files.get(pathKey(from));
    if (file === undefined) throw new Error(`no file ${from}`);
    this.#files.delete(pathKey(from));
    this.#files.set(pathKey(to), { ...file, path: to });
    this.#moveEditor(from, to);
    this.events.push(from, to);
  }

  #moveEditor(from: string, to: string): void {
    const editor = this.editors.get(pathKey(from));
    if (editor === undefined) return;
    this.editors.delete(pathKey(from));
    const moved = new FakeEditor(this, to, editor.text);
    moved.saves = editor.saves;
    this.editors.set(pathKey(to), moved);
  }

  /** Opens a note in an editor whose buffer is the file's text. */
  open(path: string): FakeEditor {
    const file = this.#files.get(pathKey(path));
    if (file === undefined) throw new Error(`no file ${path}`);
    const editor = new FakeEditor(this, file.path, decodeUtf8Strict(file.bytes));
    this.editors.set(pathKey(path), editor);
    return editor;
  }

  text(path: string): string | undefined {
    const file = this.#files.get(pathKey(path));
    return file === undefined ? undefined : decodeUtf8Strict(file.bytes);
  }

  paths(): string[] {
    return [...this.#files.values()].map((f) => f.path).sort();
  }

  // ------------------------------------------------------------ VaultPort

  files(): VaultFileInfo[] {
    return [...this.#files.values()].map((f) => ({
      path: f.path,
      size: f.bytes.length,
      mtime: f.mtime,
    }));
  }

  file(path: string): VaultFileInfo | null {
    const f = this.#files.get(pathKey(path));
    return f === undefined || f.path !== path
      ? null
      : { path: f.path, size: f.bytes.length, mtime: f.mtime };
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.#files.has(pathKey(path)));
  }

  readBinary(path: string): Promise<Uint8Array> {
    this.before('readBinary', path);
    const f = this.#files.get(pathKey(path));
    if (f === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
    const bytes = f.bytes.slice();
    this.before('readBinary:after', path);
    return Promise.resolve(bytes);
  }

  processText(path: string, fn: (text: string) => string): Promise<void> {
    this.before('processText', path);
    const f = this.#files.get(pathKey(path));
    if (f === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
    const before = decodeUtf8Strict(f.bytes);
    const after = fn(before);
    if (after !== before) this.#write(f.path, encodeUtf8(after));
    return Promise.resolve();
  }

  modifyBinary(path: string, bytes: Uint8Array): Promise<void> {
    this.before('modifyBinary:atomic', path);
    const f = this.#files.get(pathKey(path));
    if (f === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
    this.#write(f.path, bytes);
    return Promise.resolve();
  }

  createBinary(path: string, bytes: Uint8Array): Promise<void> {
    this.before('createBinary:atomic', path);
    if (this.#files.has(pathKey(path))) return Promise.reject(new Error(`EEXIST ${path}`));
    this.#write(path, bytes);
    return Promise.resolve();
  }

  /** Calls of `appendBinary`, for tests. */
  appends = 0;

  appendBinary(path: string, bytes: Uint8Array): Promise<void> {
    this.before('appendBinary:atomic', path);
    const f = this.#files.get(pathKey(path));
    if (f === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
    const joined = new Uint8Array(f.bytes.length + bytes.length);
    joined.set(f.bytes);
    joined.set(bytes, f.bytes.length);
    this.#files.set(pathKey(path), { path: f.path, bytes: joined, mtime: this.#tick() });
    this.appends++;
    this.events.push(path);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    this.before('rename:atomic', from);
    const f = this.#files.get(pathKey(from));
    if (f === undefined) return Promise.reject(new Error(`ENOENT ${from}`));
    if (pathKey(from) !== pathKey(to) && this.#files.has(pathKey(to))) {
      return Promise.reject(new Error(`EEXIST ${to}`));
    }
    this.#files.delete(pathKey(from));
    this.#files.set(pathKey(to), { ...f, path: to });
    this.#moveEditor(from, to);
    this.events.push(from, to);
    return Promise.resolve();
  }

  trash(path: string): Promise<void> {
    this.before('trash:atomic', path);
    const f = this.#files.get(pathKey(path));
    if (f === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
    this.#files.delete(pathKey(path));
    this.editors.delete(pathKey(path));
    this.trashed.push(f.path);
    this.events.push(path);
    return Promise.resolve();
  }

  editor(path: string): EditorPort | null {
    return this.editors.get(pathKey(path)) ?? null;
  }

  #write(path: string, bytes: Uint8Array): void {
    this.#files.set(pathKey(path), { path, bytes: bytes.slice(), mtime: this.#tick() });
    const editor = this.editors.get(pathKey(path));
    if (editor !== undefined) {
      // Obsidian reloads a clean editor from disk.
      try {
        editor.text = decodeUtf8Strict(bytes);
      } catch {
        // binary content in an open note: leave the buffer
      }
    }
    this.events.push(path);
  }
}
