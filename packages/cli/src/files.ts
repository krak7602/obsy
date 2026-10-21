import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type { LocalFile, LocalFiles } from '@obsy/core';
import type { ContentHash } from '@obsy/protocol';

/** Files Obsidian does not list, and so obsy does not sync: dot names and temporary files. */
function isSynced(path: string): boolean {
  return !path.split('/').some((segment) => segment.startsWith('.')) && !path.endsWith('.obsy-tmp');
}

function sha256(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * A folder as `LocalFiles`, read only: `verify` compares it with the head.
 * The write methods refuse, so that no command can change the folder by
 * mistake.
 */
export class FolderFiles implements LocalFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async list(): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const path = relative(this.root, full).split(sep).join('/');
        if (!isSynced(path)) continue;
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const bytes = await readFile(full);
          out.push({ path, hash: sha256(bytes), size: bytes.length });
        }
      }
    };
    await walk(this.root);
    return out;
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.#full(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  write(): Promise<boolean> {
    return Promise.reject(new Error('FolderFiles is read only'));
  }

  remove(): Promise<boolean> {
    return Promise.reject(new Error('FolderFiles is read only'));
  }

  move(): Promise<boolean> {
    return Promise.reject(new Error('FolderFiles is read only'));
  }

  #full(path: string): string {
    const full = resolve(this.root, ...path.split('/'));
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new Error(`${path} is outside the folder`);
    return full;
  }
}

/** Throws unless `dir` is missing or empty, then creates it. */
export async function prepareEmptyFolder(dir: string): Promise<string> {
  const root = resolve(dir);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
    if ((await readdir(root)).length > 0) throw new Error(`${dir} is not empty`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true });
  }
  return root;
}

/** Writes one file under `root`. Never writes outside it. */
export async function writeUnder(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const parts = path.split('/');
  const full = resolve(root, ...parts);
  if (!full.startsWith(root + sep)) throw new Error(`${path} is outside the folder`);
  await mkdir(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  await writeFile(full, bytes, { flag: 'wx' });
}
