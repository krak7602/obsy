import { MarkdownView, TFile, TFolder, normalizePath } from 'obsidian';
import type { App } from 'obsidian';

import { toArrayBuffer } from '../transport/request-url-fetch';
import type { EditorPort, VaultFileInfo, VaultPort } from './vault-port';

/** `VaultPort` on the Obsidian vault and workspace. */
export class ObsidianVaultPort implements VaultPort {
  constructor(readonly app: App) {}

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
          editor.transaction({
            changes: [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text }],
          });
        },
        save: () => view.save(),
      };
    }
    return null;
  }

  /** Saves every open note, so that the sync sees what the user typed. */
  async saveOpenNotes(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file !== null) await view.save();
    }
  }
}
