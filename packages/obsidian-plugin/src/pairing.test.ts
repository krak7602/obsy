import { describe, expect, it } from 'vite-plus/test';

import { decodePairingCode, encodePairingCode, pairingLink, type PairingInfo } from './pairing';

const info: PairingInfo = {
  endpoint: 'https://example.com',
  bucket: 'notes',
  region: 'auto',
  addressing: 'path',
  prefix: 'vaults/main/',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret/with+chars=',
  vaultId: 'v_abcdefghijklmnopqrstuvwx',
};

describe('pairing codes', () => {
  it('round-trips as a code and as a link', () => {
    const code = encodePairingCode(info);
    expect(code).toMatch(/^obsy1:[A-Za-z0-9_-]+$/);
    expect(decodePairingCode(code)).toEqual(info);
    expect(decodePairingCode(`  ${pairingLink(code)}\n`)).toEqual(info);
  });

  it('rejects other text, damage, and missing fields with readable errors', () => {
    expect(() => decodePairingCode('hello')).toThrow('not an obsy pairing code');
    expect(() => decodePairingCode('obsy1:!!!')).toThrow('damaged');
    const noVault = encodePairingCode({ ...info, vaultId: 'nope' });
    expect(() => decodePairingCode(noVault)).toThrow('valid vaultId');
    const badEndpoint = encodePairingCode({ ...info, endpoint: 'ftp://x' });
    expect(() => decodePairingCode(badEndpoint)).toThrow('valid endpoint');
  });
});
