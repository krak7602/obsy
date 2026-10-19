// Small helpers for the probe sections. No `obsidian` value imports, so Node
// tests can load the sections.

export const KIB = 1024;
export const MIB = 1024 * 1024;

/** A monotonic clock in milliseconds. */
export function now(): number {
  return performance.now();
}

/** Rounds to one decimal place. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Megabytes (10^6 bytes) per second. */
export function mbPerSecond(bytes: number, ms: number): number {
  return ms <= 0 ? 0 : round1(bytes / 1e6 / (ms / 1000));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Random lower-case hex with `bytes` bytes of entropy. */
export function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  window.crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** A buffer of `size` random bytes. `getRandomValues` fills at most 64 KiB per call. */
export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65_536) {
    window.crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65_536)));
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(
    await window.crypto.subtle.digest('SHA-256', bytes as BufferSource),
  );
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** `<name>: <message>` for an error, including a short cause chain. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(typeof current === 'string' ? current : (JSON.stringify(current) ?? 'unknown'));
      break;
    }
  }
  return parts.length === 0 ? 'unknown error' : parts.join(' <- ');
}

/** A short label for a size, for example `16 MiB`. */
export function sizeLabel(bytes: number): string {
  if (bytes >= MIB && bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes >= KIB && bytes % KIB === 0) return `${bytes / KIB} KiB`;
  return `${bytes} B`;
}
