// Pairing codes. A code carries everything a new device needs to join a
// vault: the bucket settings, the credential, and the vault ID. It is a
// secret: anyone with it can read and change the vault. It is shown once,
// never stored, and never logged.

/** What a pairing code carries. */
export interface PairingInfo {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly addressing: 'path' | 'virtual';
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The vault that the new device must find at the prefix. */
  readonly vaultId: string;
}

const PREFIX = 'obsy1:';
/** The `obsidian://` action that opens a pairing code. */
export const PAIRING_ACTION = 'obsy-pair';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodePairingCode(info: PairingInfo): string {
  const json = JSON.stringify({ v: 1, ...info });
  return PREFIX + toBase64Url(new TextEncoder().encode(json));
}

/** The `obsidian://` link for a QR code. Opening it on a device with obsy starts a join. */
export function pairingLink(code: string): string {
  return `obsidian://${PAIRING_ACTION}?code=${encodeURIComponent(code)}`;
}

/** The pairing code in `input`: the code itself, or a pairing link. Throws a readable error. */
export function decodePairingCode(input: string): PairingInfo {
  let text = input.trim();
  const link = /[?&]code=([^&\s]+)/.exec(text);
  if (link !== null) text = decodeURIComponent(link[1] as string);
  if (!text.startsWith(PREFIX)) throw new Error('This is not an obsy pairing code.');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(text.slice(PREFIX.length))),
    ) as Record<string, unknown>;
  } catch {
    throw new Error('The pairing code is damaged. Copy it again.');
  }
  if (data['v'] !== 1) throw new Error('The pairing code is from another version of obsy.');
  const string = (key: string, pattern?: RegExp): string => {
    const value = data[key];
    if (typeof value !== 'string' || (pattern !== undefined && !pattern.test(value))) {
      throw new Error(`The pairing code has no valid ${key}.`);
    }
    return value;
  };
  const addressing = string('addressing');
  if (addressing !== 'path' && addressing !== 'virtual') {
    throw new Error('The pairing code has no valid addressing.');
  }
  return {
    endpoint: string('endpoint', /^https?:\/\/[^/\s]+/),
    bucket: string('bucket', /^\S+$/),
    region: string('region', /^\S+$/),
    addressing,
    prefix: string('prefix', /^(|.*\/)$/),
    accessKeyId: string('accessKeyId', /^\S+$/),
    secretAccessKey: string('secretAccessKey', /^\S+$/),
    vaultId: string('vaultId', /^v_[a-z2-7]{24}$/),
  };
}
