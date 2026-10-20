// A generated scratch vault, and helpers that read a vault folder from disk.
// Test-only code.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { seededRandom } from '@obsy/storage-testkit/portable';

/** The smallest valid PNG: one transparent pixel. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const WORDS = ['river', 'lamp', 'orbit', 'maple', 'quiet', 'signal', 'paper', 'cobalt', 'harbor'];

function write(root: string, path: string, content: string | Uint8Array): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Writes a vault of about 40 notes and a few attachments to `root`. Deterministic. */
export function generateVault(root: string): void {
  const random = seededRandom(7);
  const word = (): string => WORDS[Math.floor(random() * WORDS.length)] as string;
  const paragraph = (n: number): string =>
    Array.from({ length: n }, () => `${word()} ${word()} ${word()}.`).join(' ');

  for (let day = 1; day <= 12; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    write(
      root,
      `Daily/${date}.md`,
      `---\ndate: ${date}\ntags: [daily]\n---\n# ${date}\n\n- [ ] ${word()}\n- [x] ${word()}\n\n${paragraph(3)}\n`,
    );
  }
  for (const project of ['Alpha', 'Beta', 'Gamma']) {
    write(
      root,
      `Projects/${project}/plan.md`,
      `# ${project} plan\n\n${paragraph(5)}\n\n## Steps\n1. ${word()}\n2. ${word()}\n3. ${word()}\n`,
    );
    write(
      root,
      `Projects/${project}/notes.md`,
      `# ${project} notes\n\nSee [[${project}/plan]].\n\n${paragraph(4)}\n`,
    );
  }
  for (let i = 1; i <= 12; i++)
    write(root, `Inbox/idea ${i}.md`, `# Idea ${i}\n\n${paragraph(2)}\n`);
  write(root, 'Notes/café.md', `# Café\n\n${paragraph(2)}\n`);
  write(root, 'Notes/naïve résumé.md', `# Résumé\n\n${paragraph(2)}\n`);
  write(root, 'Notes/🌱 garden.md', `# Garden\n\n${paragraph(2)}\n`);
  write(root, 'Notes/windows.md', `# Windows line ends\r\n\r\n${paragraph(2)}\r\n`);
  write(root, 'Notes/bom.md', `﻿# Byte order mark\n\n${paragraph(2)}\n`);
  write(
    root,
    'Notes/long.md',
    Array.from({ length: 400 }, (_, i) => `Line ${i}: ${paragraph(1)}`).join('\n') + '\n',
  );
  write(
    root,
    'Board.canvas',
    JSON.stringify(
      {
        nodes: [{ id: 'a', type: 'text', text: 'hi', x: 0, y: 0, width: 200, height: 60 }],
        edges: [],
      },
      null,
      '\t',
    ),
  );
  write(root, 'Attachments/pixel.png', PIXEL_PNG);
  const blob = new Uint8Array(256 * 1024);
  for (let i = 0; i < blob.length; i++) blob[i] = Math.floor(random() * 256);
  write(root, 'Attachments/data.bin', blob);
  write(root, 'Welcome.md', '# Welcome\n\nA generated scratch vault for the obsy desktop test.\n');
}

/** Copies a vault's files, without dot folders such as `.obsidian` and `.trash`. */
export function copyVault(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (source) =>
      !relative(from, source)
        .split(sep)
        .some((part) => part.startsWith('.')),
  });
}

/** Vault path to SHA-256 hex of every file, without dot paths, as Obsidian indexes them. */
export function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        out.set(
          relative(root, full).split(sep).join('/'),
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        );
    }
  };
  walk(root);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Files in the vault's `.trash` folder. */
export function trashed(root: string): string[] {
  try {
    return readdirSync(join(root, '.trash'), { recursive: true })
      .map(String)
      .filter((name) => statSync(join(root, '.trash', name)).isFile())
      .sort();
  } catch {
    return [];
  }
}
