// Probe settings, stored in the probe's data.json. Credentials are never
// stored here: the two `*Secret` fields hold only the names of entries in
// Obsidian's SecretStorage.
import type { StoredMarker } from './sections/indexeddb';
import { randomHex } from './util';

export interface ProbeSettings {
  endpoint: string;
  bucket: string;
  region: string;
  addressing: 'path' | 'virtual';
  /** Probe-only prefix, `obsy-probe/<id>/`. */
  prefix: string;
  /** Name of the SecretStorage entry that holds the access key ID. */
  accessKeyIdSecret: string;
  /** Name of the SecretStorage entry that holds the secret access key. */
  secretAccessKeySecret: string;
  /** Run the whole conformance suite, with both races at default size. */
  fullSuite: boolean;
  vaultIoMiB: number;
  backgroundSeconds: number;
  /** The last restart marker, compared with the other stores on the next load. */
  lastMarker: StoredMarker | null;
}

export const VAULT_IO_SIZES_MIB = [4, 16, 50];

export function newProbePrefix(): string {
  return `obsy-probe/${randomHex(4)}/`;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** Settings from data.json, with defaults for missing or malformed fields. */
export function normaliseSettings(raw: unknown): ProbeSettings {
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const marker = data['lastMarker'] as Partial<StoredMarker> | null | undefined;
  const vaultIoMiB = Number(data['vaultIoMiB']);
  const backgroundSeconds = Number(data['backgroundSeconds']);
  const prefix = text(data['prefix'], '');
  return {
    endpoint: text(data['endpoint'], '').replace(/\/+$/, ''),
    bucket: text(data['bucket'], ''),
    region: text(data['region'], 'auto') || 'auto',
    addressing: data['addressing'] === 'virtual' ? 'virtual' : 'path',
    prefix: prefix === '' ? newProbePrefix() : prefix,
    accessKeyIdSecret: text(data['accessKeyIdSecret'], ''),
    secretAccessKeySecret: text(data['secretAccessKeySecret'], ''),
    fullSuite: data['fullSuite'] === true,
    vaultIoMiB: VAULT_IO_SIZES_MIB.includes(vaultIoMiB) ? vaultIoMiB : 16,
    backgroundSeconds:
      Number.isInteger(backgroundSeconds) && backgroundSeconds >= 10 && backgroundSeconds <= 600
        ? backgroundSeconds
        : 60,
    lastMarker:
      typeof marker?.token === 'string' && typeof marker.writtenAt === 'string'
        ? { token: marker.token, writtenAt: marker.writtenAt }
        : null,
  };
}
