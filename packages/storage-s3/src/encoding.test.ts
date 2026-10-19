import { describe, expect, it } from 'vite-plus/test';

import {
  decodeListValue,
  encodeKeyPath,
  encodeQuery,
  encodeRfc3986,
  quoteEtag,
  unquoteEtag,
} from './encoding';

describe('encoding', () => {
  it('encodes everything except unreserved characters', () => {
    expect(encodeRfc3986("a-._~!'()*+ /%&=?#é")).toBe(
      'a-._~%21%27%28%29%2A%2B%20%2F%25%26%3D%3F%23%C3%A9',
    );
  });

  it('keeps "/" between key segments', () => {
    expect(encodeKeyPath('log/0000000000000001.json')).toBe('log/0000000000000001.json');
    expect(encodeKeyPath('a b/c+d//e')).toBe('a%20b/c%2Bd//e');
  });

  it('builds a sorted query string and drops undefined values', () => {
    expect(
      encodeQuery({ prefix: 'a b+', 'list-type': '2', 'start-after': undefined, 'max-keys': '7' }),
    ).toBe('list-type=2&max-keys=7&prefix=a%20b%2B');
  });

  it('decodes encoding-type=url values, with "+" as space', () => {
    expect(decodeListValue('a+b%2Bc%20d%2F%C3%A9')).toBe('a b+c d/é');
  });

  it('quotes and unquotes etags', () => {
    expect(unquoteEtag('"abc"')).toBe('abc');
    expect(unquoteEtag('W/"abc"')).toBe('abc');
    expect(unquoteEtag('abc')).toBe('abc');
    expect(quoteEtag('abc')).toBe('"abc"');
    expect(quoteEtag('"abc"')).toBe('"abc"');
  });
});
