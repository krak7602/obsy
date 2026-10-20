// Settings. `ObsySettings` is stored in the plugin's data.json, which is in
// the vault's config folder. Credentials are never stored there: the two
// `*Secret` fields hold only the names of entries in Obsidian's
// SecretStorage. `DeviceSettings` is stored per vault and device in the
// app's local storage, so it does not travel with a copy of the vault.

export interface ObsySettings {
  /** S3 API endpoint without the bucket, for example `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  /** Signing region. `auto` for R2. */
  region: string;
  addressing: 'path' | 'virtual';
  /** The vault's prefix in the bucket: empty, or ending in `/`. */
  prefix: string;
  /** Name of the SecretStorage entry that holds the access key ID. */
  accessKeyIdSecret: string;
  /** Name of the SecretStorage entry that holds the secret access key. */
  secretAccessKeySecret: string;
  /**
   * The ID of the bucket vault that this folder last synced with. Sync
   * stops and asks when the device state names another vault: the vault
   * folder may have been replaced.
   */
  vaultId: string | null;
}

/** `off`: not connected. `pull-only`: apply remote changes, send nothing. `full`: two-way sync. */
export type SyncMode = 'off' | 'pull-only' | 'full';

export interface DeviceSettings {
  /** Unique per vault and device. Names the IndexedDB state. */
  localId: string;
  /** Shown in conflict copy names and used as the actor ID. */
  deviceName: string;
  mode: SyncMode;
  /** Automatic sync is on (the default) or paused by the user or a safety rail. */
  autoSync: boolean;
}

export const DEFAULT_SETTINGS: ObsySettings = {
  endpoint: '',
  bucket: '',
  region: 'auto',
  addressing: 'path',
  prefix: '',
  accessKeyIdSecret: '',
  secretAccessKeySecret: '',
  vaultId: null,
};

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** Settings from data.json, with defaults for missing or malformed values. */
export function normaliseSettings(raw: unknown): ObsySettings {
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const addressing = data['addressing'] === 'virtual' ? 'virtual' : 'path';
  const vaultId = typeof data['vaultId'] === 'string' ? data['vaultId'] : null;
  return {
    endpoint: text(data['endpoint'], DEFAULT_SETTINGS.endpoint).replace(/\/+$/, ''),
    bucket: text(data['bucket'], DEFAULT_SETTINGS.bucket),
    region: text(data['region'], DEFAULT_SETTINGS.region) || DEFAULT_SETTINGS.region,
    addressing,
    prefix: normalisePrefix(text(data['prefix'], DEFAULT_SETTINGS.prefix)),
    accessKeyIdSecret: text(data['accessKeyIdSecret'], ''),
    secretAccessKeySecret: text(data['secretAccessKeySecret'], ''),
    vaultId,
  };
}

/** `vaults/main` becomes `vaults/main/`; leading slashes are dropped. */
export function normalisePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (trimmed === '') return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** An actor ID from a device name: 1 to 64 of `A-Z a-z 0-9 . _ -`. */
export function actorIdFor(deviceName: string): string {
  const id = deviceName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return id === '' ? 'device' : id;
}

/** Device settings from local storage, with new values where missing. */
export function normaliseDevice(raw: unknown, fresh: () => DeviceSettings): DeviceSettings {
  const base = fresh();
  if (typeof raw !== 'object' || raw === null) return base;
  const data = raw as Record<string, unknown>;
  const mode = data['mode'];
  return {
    localId:
      typeof data['localId'] === 'string' && /^[a-z0-9]{8,64}$/.test(data['localId'])
        ? data['localId']
        : base.localId,
    deviceName:
      typeof data['deviceName'] === 'string' && data['deviceName'].trim() !== ''
        ? data['deviceName'].trim()
        : base.deviceName,
    mode: mode === 'pull-only' || mode === 'full' ? mode : 'off',
    autoSync: data['autoSync'] !== false,
  };
}

/** What is missing before the plugin can reach the bucket, or an empty list. */
export function missingSettings(settings: ObsySettings): string[] {
  const missing: string[] = [];
  if (!/^https?:\/\/[^/]+/.test(settings.endpoint)) missing.push('endpoint');
  if (settings.bucket === '') missing.push('bucket');
  if (settings.accessKeyIdSecret === '') missing.push('access key ID');
  if (settings.secretAccessKeySecret === '') missing.push('secret access key');
  return missing;
}
