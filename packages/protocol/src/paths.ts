import { utf8ByteLength } from './keys';

/**
 * Vault paths: relative, `/`-separated paths of files in a vault, stored as
 * written. See docs/subsystems/protocol.md#records.
 */

/** Longest vault path in UTF-8 bytes. Leaves room under the 1,024-byte key limit. */
export const MAX_PATH_BYTES = 768;

/** Returns why `path` is not a valid vault path, or `null` when it is valid. */
export function vaultPathProblem(path: unknown): string | null {
  if (typeof path !== 'string') return 'not a string';
  if (path.length === 0) return 'empty';
  for (let i = 0; i < path.length; i++) {
    const unit = path.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return 'contains a control character';
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = path.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return 'contains a lone surrogate';
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return 'contains a lone surrogate';
    }
  }
  if (path.includes('\\')) return 'contains a backslash';
  for (const segment of path.split('/')) {
    if (segment === '') return 'has an empty segment';
    if (segment === '.' || segment === '..') return `has a "${segment}" segment`;
  }
  if (utf8ByteLength(path) > MAX_PATH_BYTES) return `longer than ${MAX_PATH_BYTES} bytes`;
  return null;
}

export function isVaultPath(path: unknown): path is string {
  return vaultPathProblem(path) === null;
}

/**
 * The matching key of a path: Unicode NFC, then lower case, then NFC again.
 * Two live files may not share a key, so that macOS and iOS case and
 * normalisation twins cannot exist. Lower case is a simple, locale-free
 * stand-in for case folding.
 */
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase().normalize('NFC');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The path of a conflict copy: `Name (conflict <device> <YYYYMMDDHHmm>).ext`
 * in the same folder. `time` is formatted in UTC. `device` is the device
 * name; characters that are unsafe in a file name are replaced with `-`.
 */
export function conflictCopyPath(path: string, device: string, time: Date): string {
  const slash = path.lastIndexOf('/');
  const folder = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const stamp =
    `${time.getUTCFullYear()}${pad2(time.getUTCMonth() + 1)}${pad2(time.getUTCDate())}` +
    `${pad2(time.getUTCHours())}${pad2(time.getUTCMinutes())}`;
  let safeDevice = '';
  for (let i = 0; i < device.length; i++) {
    const code = device.charCodeAt(i);
    const char = device.charAt(i);
    safeDevice += code < 0x20 || code === 0x7f || '\\/:*?"<>|#^[]'.includes(char) ? '-' : char;
  }
  safeDevice = safeDevice.trim() || 'device';
  return `${folder}${stem} (conflict ${safeDevice} ${stamp})${extension}`;
}

/**
 * A conflict copy path that is free. `taken` tells whether a path key is
 * in use. Adds ` 2`, ` 3`, … before the extension until the path is free.
 */
export function freeConflictCopyPath(
  path: string,
  device: string,
  time: Date,
  taken: (key: string) => boolean,
): string {
  const first = conflictCopyPath(path, device, time);
  if (!taken(pathKey(first))) return first;
  const dot = first.lastIndexOf('.');
  const close = first.lastIndexOf(')');
  const at = dot > close ? dot : first.length;
  for (let n = 2; ; n++) {
    const candidate = `${first.slice(0, at)} ${n}${first.slice(at)}`;
    if (!taken(pathKey(candidate))) return candidate;
  }
}
