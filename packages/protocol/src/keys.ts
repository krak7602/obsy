import { InvalidKey } from './errors';

/** S3 and R2 limit a full object key to 1,024 bytes of UTF-8. */
export const MAX_KEY_BYTES = 1024;

/**
 * Compares two keys in Unicode code point order, which equals UTF-8 byte
 * order. S3 and R2 list keys in this order. JavaScript's `<` compares UTF-16
 * code units, which differs for characters above U+FFFF.
 */
export function compareKeys(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.charCodeAt(index);
    const right = b.charCodeAt(index);
    if (left !== right) return codePointOrderUnit(left) - codePointOrderUnit(right);
  }
  return a.length - b.length;
}

// Moves surrogates (U+D800..U+DFFF) above U+E000..U+FFFF so that UTF-16 code
// unit comparison gives code point order.
function codePointOrderUnit(unit: number): number {
  if (unit < 0xd800) return unit;
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000;
}

/** The UTF-8 length of `value` in bytes. Lone surrogates count as 3 bytes. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Throws `InvalidKey` unless `key` is safe to use with every supported
 * provider:
 *
 * - not empty, and at most `MAX_KEY_BYTES` bytes of UTF-8;
 * - well-formed Unicode (no lone surrogates);
 * - no control characters (U+0000..U+001F, U+007F);
 * - does not start with `/`;
 * - no `.` or `..` path segment, because URL parsers remove them.
 *
 * Adapters with a root prefix check the full key as well.
 */
export function checkStorageKey(key: string): void {
  if (key.length === 0) throw new InvalidKey('Key is empty');
  checkCharacters(key, 'Key');
  if (key.startsWith('/')) throw new InvalidKey('Key starts with "/"');
  for (const segment of key.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new InvalidKey(`Key has a "${segment}" path segment`);
    }
  }
  if (utf8ByteLength(key) > MAX_KEY_BYTES) {
    throw new InvalidKey(`Key is longer than ${MAX_KEY_BYTES} bytes of UTF-8`);
  }
}

/** Throws `InvalidKey` unless `prefix` is a valid list prefix. An empty prefix is valid. */
export function checkStoragePrefix(prefix: string): void {
  checkCharacters(prefix, 'Prefix');
  if (prefix.startsWith('/')) throw new InvalidKey('Prefix starts with "/"');
  if (utf8ByteLength(prefix) > MAX_KEY_BYTES) {
    throw new InvalidKey(`Prefix is longer than ${MAX_KEY_BYTES} bytes of UTF-8`);
  }
}

function checkCharacters(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) {
      throw new InvalidKey(`${label} has a control character at index ${index}`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new InvalidKey(`${label} has a lone surrogate at index ${index}`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new InvalidKey(`${label} has a lone surrogate at index ${index}`);
    }
  }
}
