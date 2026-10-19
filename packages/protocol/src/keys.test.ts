import { describe, expect, it } from 'vite-plus/test';

import { isStorageError } from './errors';
import { checkStorageKey, checkStoragePrefix, compareKeys, utf8ByteLength } from './keys';

function utf8Bytes(value: string): number[] {
  // Encode by hand, so that the test does not depend on TextEncoder.
  const bytes: number[] = [];
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

function compareBytes(a: number[], b: number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

describe('compareKeys', () => {
  it('orders by code point, not by UTF-16 code unit', () => {
    // U+FF5E (fullwidth tilde) is one code unit 0xFF5E. U+1F600 is the
    // surrogate pair 0xD83D 0xDE00. Code units put the emoji first; code
    // points and UTF-8 bytes put it last.
    const tilde = 'a～';
    const emoji = 'a\u{1F600}';
    expect(tilde > emoji).toBe(true);
    expect(compareKeys(tilde, emoji)).toBeLessThan(0);
  });

  it('matches UTF-8 byte order on a mixed sample', () => {
    const sample = [
      'log/0000000000000010.json',
      'log/0000000000000002.json',
      'log/',
      'logs',
      'a b',
      'a+b',
      'a%b',
      'Z',
      'z',
      'é',
      'é',
      '',
      '�',
      '\u{10000}',
      '\u{1F600}',
      '',
    ];
    const byCodePoint = [...sample].sort(compareKeys);
    const byBytes = [...sample].sort((a, b) => compareBytes(utf8Bytes(a), utf8Bytes(b)));
    expect(byCodePoint).toEqual(byBytes);
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes', () => {
    for (const value of ['', 'abc', 'é', '€', '\u{1F600}', 'a/é/\u{1F600}']) {
      expect(utf8ByteLength(value)).toBe(utf8Bytes(value).length);
    }
  });
});

describe('checkStorageKey', () => {
  it('accepts protocol keys and unusual characters', () => {
    for (const key of [
      'vault.json',
      'log/0000000000000001.json',
      'blobs/sha256/ab',
      'a b+c%d&e<f>g"h\'i#j?k=l~m!n*o(p)q:r@s$t,u;v[w]x{y}z|\\^`',
      'notes/é/é/\u{1F600}',
      '...',
      'x.',
    ]) {
      expect(() => checkStorageKey(key)).not.toThrow();
    }
  });

  it('rejects unsafe keys with InvalidKey', () => {
    for (const key of [
      '',
      '/leading',
      'a//b',
      'trailing/',
      'a/./b',
      'a/../b',
      '..',
      'a/.',
      'tab\there',
      'new\nline',
      'del\u007f',
      'lone\uD800',
      'lone\uDC00x',
      'x'.repeat(1025),
      'é'.repeat(513),
    ]) {
      let caught: unknown;
      try {
        checkStorageKey(key);
      } catch (error) {
        caught = error;
      }
      expect({ key, invalid: isStorageError(caught, 'invalid-key') }).toEqual({
        key,
        invalid: true,
      });
    }
  });

  it('accepts a key of exactly 1,024 bytes', () => {
    expect(() => checkStorageKey('x'.repeat(1024))).not.toThrow();
    expect(() => checkStorageKey('é'.repeat(512))).not.toThrow();
  });
});

describe('checkStoragePrefix', () => {
  it('accepts an empty prefix and rejects control characters', () => {
    expect(() => checkStoragePrefix('')).not.toThrow();
    expect(() => checkStoragePrefix('log/')).not.toThrow();
    expect(() => checkStoragePrefix('a\u0000')).toThrow('control character');
    expect(() => checkStoragePrefix('/x')).toThrow('starts with');
  });
});
