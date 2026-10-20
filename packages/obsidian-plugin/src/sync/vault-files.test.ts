import { encodeUtf8, hashContent } from '@obsy/protocol';
import { describe, expect, it } from 'vite-plus/test';

import { FakeVault } from '../testing/fake-vault';
import { TEMP_SUFFIX, VaultLocalFiles, minimalEdit } from './vault-files';

const hashOf = (text: string): ReturnType<typeof hashContent> => hashContent(encodeUtf8(text));

function setup(): { vault: FakeVault; files: VaultLocalFiles; now: { t: number } } {
  const vault = new FakeVault();
  const now = { t: 0 };
  const files = new VaultLocalFiles(vault, {
    now: () => now.t,
    exclude: (path) => path.startsWith('private/'),
  });
  return { vault, files, now };
}

describe('minimalEdit', () => {
  it('replaces only the changed middle', () => {
    expect(minimalEdit('one\ntwo\nthree\n', 'one\n2\nthree\n')).toEqual({
      from: 4,
      to: 7,
      text: '2',
    });
    expect(minimalEdit('abc', 'abc')).toBeNull();
    expect(minimalEdit('', 'x')).toEqual({ from: 0, to: 0, text: 'x' });
    expect(minimalEdit('abc', 'abcd')).toEqual({ from: 3, to: 3, text: 'd' });
  });

  it('never splits a surrogate pair', () => {
    // U+1F600 and U+1F601 share the high surrogate.
    const edit = minimalEdit('a\u{1F600}b', 'a\u{1F601}b');
    expect(edit).toEqual({ from: 1, to: 3, text: '\u{1F601}' });
    const after = 'x\u{1F600}';
    const tail = minimalEdit('x\u{1F600}', after.slice(0, 1) + '\u{1F601}');
    expect(tail).toEqual({ from: 1, to: 3, text: '\u{1F601}' });
  });
});

describe('VaultLocalFiles', () => {
  it('lists files with hashes, reusing a hash while size and mtime match', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'a\n');
    vault.userWrite('private/secret.md', 'x\n');
    vault.userWrite(`b.md${TEMP_SUFFIX}`, 'partial');
    let reads = 0;
    vault.before = (call) => {
      if (call === 'readBinary') reads++;
    };
    expect(await files.list()).toEqual([{ path: 'a.md', hash: await hashOf('a\n'), size: 2 }]);
    expect(reads).toBe(1);
    await files.list();
    expect(reads).toBe(1);
    vault.userWrite('a.md', 'A\n');
    expect((await files.list())[0]?.hash).toBe(await hashOf('A\n'));
    expect(reads).toBe(2);
    expect(files.takeChangedHashes()).toMatchObject({ 'a.md': { size: 2 } });
    expect(files.takeChangedHashes()).toBeNull();
  });

  it('writes only when the content hash matches', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'one\n');
    expect(await files.write('a.md', encodeUtf8('two\n'), await hashOf('other\n'))).toBe(false);
    expect(vault.text('a.md')).toBe('one\n');
    expect(await files.write('a.md', encodeUtf8('two\n'), await hashOf('one\n'))).toBe(true);
    expect(vault.text('a.md')).toBe('two\n');
  });

  it('does not write when the user saves between the check and the write', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'one\n');
    vault.before = (call) => {
      if (call === 'processText') vault.userWrite('a.md', 'user\n');
    };
    expect(await files.write('a.md', encodeUtf8('two\n'), await hashOf('one\n'))).toBe(false);
    expect(vault.text('a.md')).toBe('user\n');
  });

  it('applies a change to an open note as one editor transaction', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'one\ntwo\nthree\n');
    const editor = vault.open('a.md');
    const ok = await files.write(
      'a.md',
      encodeUtf8('one\n2\nthree\n'),
      await hashOf('one\ntwo\nthree\n'),
    );
    expect(ok).toBe(true);
    expect(editor.transactions).toBe(1);
    expect(editor.text).toBe('one\n2\nthree\n');
    expect(vault.text('a.md')).toBe('one\n2\nthree\n');
  });

  it('refuses to change an open note with unsaved edits', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'one\n');
    const editor = vault.open('a.md');
    editor.text = 'one\ntyping';
    expect(await files.write('a.md', encodeUtf8('two\n'), await hashOf('one\n'))).toBe(false);
    expect(await files.remove('a.md', await hashOf('one\n'))).toBe(false);
    expect(editor.text).toBe('one\ntyping');
    expect(vault.text('a.md')).toBe('one\n');
  });

  it('writes the file itself when the editor does not save', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'one\n');
    const editor = vault.open('a.md');
    editor.saves = false;
    expect(await files.write('a.md', encodeUtf8('two\n'), await hashOf('one\n'))).toBe(true);
    expect(vault.text('a.md')).toBe('two\n');
  });

  it('writes CRLF notes on disk, not through the editor', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'one\r\n');
    const editor = vault.open('a.md');
    expect(await files.write('a.md', encodeUtf8('two\r\n'), await hashOf('one\r\n'))).toBe(true);
    expect(editor.transactions).toBe(0);
    expect(vault.text('a.md')).toBe('two\r\n');
  });

  it('writes binary content and text with a byte order mark as bytes', async () => {
    const { vault, files } = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]);
    vault.userWrite('img.png', png);
    const next = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xfe]);
    expect(await files.write('img.png', next, await hashContent(png))).toBe(true);
    expect(await files.read('img.png')).toEqual(next);
    vault.userWrite('bom.md', '﻿hello\n');
    expect(await files.write('bom.md', encodeUtf8('﻿bye\n'), await hashOf('﻿hello\n'))).toBe(true);
    expect(vault.text('bom.md')).toBe('﻿bye\n');
  });

  it('creates through a temporary file and refuses a taken path key', async () => {
    const { vault, files } = setup();
    vault.userWrite('Note.md', 'mine\n');
    await files.list();
    expect(await files.write('note.md', encodeUtf8('theirs\n'), null)).toBe(false);
    expect(vault.text('Note.md')).toBe('mine\n');
    expect(await files.write('new/deep.md', encodeUtf8('x\n'), null)).toBe(true);
    expect(vault.paths()).toEqual(['Note.md', 'new/deep.md']);
    expect(vault.events).toContain(`new/deep.md${TEMP_SUFFIX}`);
  });

  it('sees a file that the user created after the last list', async () => {
    const { vault, files } = setup();
    await files.list();
    vault.userWrite('a.md', 'user\n');
    expect(await files.write('A.md', encodeUtf8('remote\n'), null)).toBe(false);
    expect(vault.text('a.md')).toBe('user\n');
  });

  it('marks its own writes so that their vault events are ignored', async () => {
    const { vault, files, now } = setup();
    vault.userWrite('a.md', 'one\n');
    await files.write('a.md', encodeUtf8('two\n'), await hashOf('one\n'));
    expect(files.noteVaultEvent('a.md')).toBe(true);
    now.t += 10_000;
    expect(files.noteVaultEvent('a.md')).toBe(false);
    expect(files.noteVaultEvent('b.md')).toBe(false);
  });

  it('moves removed files to the trash', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'a\n');
    expect(await files.remove('a.md', await hashOf('changed\n'))).toBe(false);
    expect(await files.remove('a.md', await hashOf('a\n'))).toBe(true);
    expect(vault.paths()).toEqual([]);
    expect(vault.trashed).toEqual(['a.md']);
  });

  it('renames only onto a free path key, and allows a case change', async () => {
    const { vault, files } = setup();
    vault.userWrite('a.md', 'a\n');
    vault.userWrite('B.md', 'b\n');
    const hash = await hashOf('a\n');
    expect(await files.move('a.md', 'b.md', hash)).toBe(false);
    expect(await files.move('a.md', 'A.md', hash)).toBe(true);
    expect(await files.move('A.md', 'folder/c.md', hash)).toBe(true);
    expect(vault.paths()).toEqual(['B.md', 'folder/c.md']);
  });

  it('leaves case twins out of the list', async () => {
    const vault = new FakeVault();
    const files = new VaultLocalFiles(vault);
    // A case-sensitive file system can hold both.
    vault.userWrite('a.md', 'a\n');
    vault.files = () => [
      { path: 'a.md', size: 2, mtime: 1 },
      { path: 'A.md', size: 2, mtime: 1 },
    ];
    expect((await files.list()).map((f) => f.path)).toEqual(['A.md']);
    expect(files.twins).toEqual(['a.md']);
  });

  it('trashes leftover temporary files', async () => {
    const { vault, files } = setup();
    vault.userWrite(`a.md${TEMP_SUFFIX}`, 'partial');
    vault.userWrite('b.md', 'b\n');
    expect(await files.removeLeftovers()).toBe(1);
    expect(vault.paths()).toEqual(['b.md']);
  });
});
