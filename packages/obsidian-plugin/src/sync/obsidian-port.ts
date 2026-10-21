import { FileSystemAdapter, MarkdownView, TFile, TFolder, normalizePath } from 'obsidian';
import type { App } from 'obsidian';

import { toArrayBuffer } from '../transport/request-url-fetch';
import type { EditorPort, VaultFileInfo, VaultPort } from './vault-port';

/** The parts of Node's `fs` that `symlinks` uses. Desktop only. */
interface DirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
interface NodeFs {
  readonly promises: {
    readdir(path: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  };
}

/** Node's `fs` on desktop, through Electron's `require`; null elsewhere. */
function nodeFs(): NodeFs | null {
  const load = (window as unknown as { require?: (id: string) => unknown }).require;
  return typeof load === 'function' ? (load('fs') as NodeFs) : null;
}

/** `VaultPort` on the Obsidian vault and workspace. */
export class ObsidianVaultPort implements VaultPort {
  /** The note and time of the last editor change that obsy made itself. */
  #ownEdit: { path: string; at: number } | null = null;

  constructor(readonly app: App) {}

  /** True when an editor change in `path` is likely obsy's own (applied in the last second). */
  isOwnEdit(path: string): boolean {
    const own = this.#ownEdit;
    return own !== null && own.path === path && Date.now() - own.at < 1000;
  }

  files(): VaultFileInfo[] {
    return this.app.vault
      .getFiles()
      .map((file) => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime }));
  }

  #file(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  #require(path: string): TFile {
    const file = this.#file(path);
    if (file === null) throw new Error(`No file at ${path}`);
    return file;
  }

  file(path: string): VaultFileInfo | null {
    const file = this.#file(path);
    return file === null ? null : { path: file.path, size: file.stat.size, mtime: file.stat.mtime };
  }

  exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.app.vault.readBinary(this.#require(path)));
  }

  async processText(path: string, fn: (text: string) => string): Promise<void> {
    await this.app.vault.process(this.#require(path), fn);
  }

  async modifyBinary(path: string, bytes: Uint8Array): Promise<void> {
    await this.app.vault.modifyBinary(this.#require(path), toArrayBuffer(bytes));
  }

  async #ensureParent(path: string): Promise<void> {
    const slash = path.lastIndexOf('/');
    if (slash <= 0) return;
    const parent = path.slice(0, slash);
    const existing = this.app.vault.getAbstractFileByPath(parent);
    if (existing instanceof TFolder) return;
    if (existing !== null) throw new Error(`${parent} is a file, not a folder`);
    await this.#ensureParent(parent);
    try {
      await this.app.vault.createFolder(parent);
    } catch (error) {
      // Another writer may have created it meanwhile.
      if (!(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error;
    }
  }

  async createBinary(path: string, bytes: Uint8Array): Promise<void> {
    await this.#ensureParent(path);
    await this.app.vault.createBinary(path, toArrayBuffer(bytes));
  }

  async appendBinary(path: string, bytes: Uint8Array): Promise<void> {
    await this.app.vault.appendBinary(this.#require(path), toArrayBuffer(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.#ensureParent(to);
    // `vault.rename`, not `fileManager.renameFile`: a remote rename must not
    // edit links in other notes. The device that made it has already done so.
    await this.app.vault.rename(this.#require(from), to);
  }

  async trash(path: string): Promise<void> {
    // The user's deletion preference: system trash, the vault's .trash
    // folder, or a permanent delete. obsy removes only content that the
    // bucket history holds.
    await this.app.fileManager.trashFile(this.#require(path));
  }

  editor(path: string): EditorPort | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== path) continue;
      if (view.getMode() !== 'source') continue;
      const editor = view.editor;
      return {
        getText: () => editor.getValue(),
        replace: (from, to, text) => {
          this.#ownEdit = { path, at: Date.now() };
          editor.transaction({
            changes: [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text }],
          });
        },
        save: () => view.save(),
      };
    }
    return null;
  }

  async symlinks(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    const fs = nodeFs();
    // On iOS and Android the adapter is not a FileSystemAdapter, and users
    // cannot make symbolic links in an app's folder.
    if (!(adapter instanceof FileSystemAdapter) || fs === null) return [];
    const root = adapter.getBasePath();
    const found: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        // Obsidian does not index dot names, and the config folder is one.
        if (entry.name.startsWith('.')) continue;
        const path = `${prefix}${entry.name}`;
        if (entry.isSymbolicLink()) found.push(path);
        else if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, `${path}/`);
      }
    };
    await walk(root, '');
    return found.sort();
  }

  /** Saves every open note, so that the sync sees what the user typed. */
  async saveOpenNotes(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file !== null) await view.save();
    }
  }
}
