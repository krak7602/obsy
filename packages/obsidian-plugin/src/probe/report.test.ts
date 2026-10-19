import { describe, expect, it } from 'vite-plus/test';

import {
  RedactionError,
  checkRedacted,
  endpointHost,
  guessProvider,
  redactString,
  redactValue,
  sensitiveValues,
} from './report';

// Made-up values in the shape of real ones. None of them is a real account,
// bucket, or credential.
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const BUCKET = 'obsy-probe';
const KEY_ID = 'fake-access-key-id-42';
const SECRET = 'fake/secret+access=key';

const sensitive = sensitiveValues([
  { value: ENDPOINT, placeholder: '<endpoint>', match: 'substring' },
  { value: `${ACCOUNT}.r2.cloudflarestorage.com`, placeholder: '<endpoint-host>', match: 'token' },
  { value: ACCOUNT, placeholder: '<account-id>', match: 'token' },
  { value: BUCKET, placeholder: '<bucket>', match: 'token' },
  { value: KEY_ID, placeholder: '<access-key-id>', match: 'substring' },
  { value: SECRET, placeholder: '<secret-access-key>', match: 'substring' },
  { value: '/Users/someone/Vaults/Scratch', placeholder: '<vault-path>', match: 'substring' },
]);

describe('redaction', () => {
  it('replaces each sensitive value and its URL-encoded form', () => {
    expect(redactString(`key ${KEY_ID} and ${encodeURIComponent(SECRET)}`, sensitive)).toBe(
      'key <access-key-id> and <secret-access-key>',
    );
  });

  it('matches bucket names only as whole names', () => {
    expect(redactString('schema obsy-probe-report', sensitive)).toBe('schema obsy-probe-report');
    expect(redactString('<BucketName>obsy-probe</BucketName>', sensitive)).toBe(
      '<BucketName><bucket></BucketName>',
    );
    expect(redactString('bucket "OBSY-PROBE" missing', sensitive)).toBe(
      'bucket "<bucket>" missing',
    );
  });

  it('replaces URLs, hex account IDs, AWS key IDs, and absolute paths', () => {
    expect(redactString(`fetch ${ENDPOINT}/obsy-probe/a?x=1 failed`, sensitive)).toBe(
      'fetch <endpoint>/<bucket>/a?x=1 failed',
    );
    expect(redactString('see https://other.example/x', [])).toBe('see <url>');
    expect(redactString('id ffffffffffffffffffffffffffffffff here', [])).toBe('id <hex32> here');
    expect(redactString('AKIAABCDEFGHIJKLMNOP', [])).toBe('<aws-access-key-id>');
    expect(redactString('account 123456789012', [])).toBe('account <number12>');
    expect(redactString('ENOENT /var/mobile/Containers/x/y.md', [])).toBe('ENOENT <path>');
    expect(redactString('at /Users/someone/Vaults/Scratch/.obsy-probe/a.bin', sensitive)).toBe(
      'at <vault-path>/.obsy-probe/a.bin',
    );
  });

  it('keeps the WebView origins', () => {
    for (const origin of ['capacitor://localhost', 'app://obsidian.md', 'http://localhost']) {
      expect(redactString(origin, [])).toBe(origin);
    }
    expect(redactString('capacitor://localhost/_capacitor_file_/var/mobile/a', [])).toBe('<url>');
  });

  it('redacts object keys and nested values', () => {
    expect(
      redactValue({ [BUCKET]: [{ note: `secret ${SECRET}` }], count: 3, ok: true }, sensitive),
    ).toEqual({ '<bucket>': [{ note: 'secret <secret-access-key>' }], count: 3, ok: true });
  });

  it('refuses JSON that still holds a sensitive value', () => {
    expect(() => checkRedacted(JSON.stringify({ a: SECRET }), sensitive)).toThrow(RedactionError);
    expect(() => checkRedacted(JSON.stringify({ a: 'bucket obsy-probe' }), sensitive)).toThrow(
      /<bucket>/,
    );
    expect(() =>
      checkRedacted(JSON.stringify({ schema: 'obsy-probe-report' }), sensitive),
    ).not.toThrow();
    // JSON escapes a backslash, so check the escaped form too.
    const windows = sensitiveValues([
      { value: 'C:\\Vaults\\Scratch', placeholder: '<vault-path>', match: 'substring' },
    ]);
    expect(() => checkRedacted(JSON.stringify({ a: 'C:\\Vaults\\Scratch\\x' }), windows)).toThrow(
      RedactionError,
    );
  });

  it('ignores values shorter than three characters', () => {
    expect(sensitiveValues([{ value: 'ab', placeholder: '<x>', match: 'substring' }])).toEqual([]);
  });
});

describe('guessProvider', () => {
  it.each([
    [ENDPOINT, 'r2'],
    [`${ENDPOINT}/`, 'r2'],
    ['https://s3.eu-west-1.amazonaws.com', 'aws-s3'],
    ['https://s3.amazonaws.com', 'aws-s3'],
    ['http://127.0.0.1:9000', 'other'],
    ['not a url', 'other'],
    ['', 'unset'],
  ])('%s is %s', (endpoint, provider) => {
    expect(guessProvider(endpoint)).toBe(provider);
  });

  it('reads the host with its port', () => {
    expect(endpointHost('http://127.0.0.1:9000/base')).toBe('127.0.0.1:9000');
  });
});
