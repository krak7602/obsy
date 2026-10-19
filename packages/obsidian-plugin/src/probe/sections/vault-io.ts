// Vault adapter large-file I/O: write and read one large binary file in a
// probe-only folder, whole and in chunks, verify it by hash, then delete it.
import type { Log, SectionOutput } from '../section';
import { statusOf, step } from '../section';
import { MIB, mbPerSecond, now, randomBytes, sha256Hex, sizeLabel } from '../util';

/** The `DataAdapter` methods that the section uses. */
export interface VaultAdapterLike {
  exists(normalizedPath: string): Promise<boolean>;
  mkdir(normalizedPath: string): Promise<void>;
  writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void>;
  appendBinary?(normalizedPath: string, data: ArrayBuffer): Promise<void>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  stat(normalizedPath: string): Promise<{ size: number } | null>;
  remove(normalizedPath: string): Promise<void>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
}

/** The probe-only folder at the vault root. The dot keeps it out of the file explorer. */
export const PROBE_FOLDER = '.obsy-probe';

export interface VaultIoSectionInput {
  adapter: VaultAdapterLike;
  sizeBytes: number;
  chunkBytes?: number;
  log: Log;
}

/** The whole buffer as its own `ArrayBuffer`. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export async function runVaultIoSection(input: VaultIoSectionInput): Promise<SectionOutput> {
  const { adapter } = input;
  const size = input.sizeBytes;
  const chunk = input.chunkBytes ?? MIB;
  const whole = `${PROBE_FOLDER}/whole.bin`;
  const chunked = `${PROBE_FOLDER}/chunked.bin`;
  input.log(`Vault files: ${sizeLabel(size)}`);

  const bytes = randomBytes(size);
  const expected = await sha256Hex(bytes);
  if (!(await adapter.exists(PROBE_FOLDER))) await adapter.mkdir(PROBE_FOLDER);

  const steps = [];
  try {
    steps.push(
      await step(`writeBinary ${sizeLabel(size)} in one call`, async () => {
        const data = bufferOf(bytes);
        const started = now();
        await adapter.writeBinary(whole, data);
        const ms = now() - started;
        return { passed: true, ms: Math.round(ms), MBps: mbPerSecond(size, ms) };
      }),
    );
    steps.push(
      await step(`readBinary ${sizeLabel(size)} and compare hashes`, async () => {
        const started = now();
        const read = await adapter.readBinary(whole);
        const ms = now() - started;
        return {
          passed: read.byteLength === size && (await sha256Hex(read)) === expected,
          readBytes: read.byteLength,
          ms: Math.round(ms),
          MBps: mbPerSecond(size, ms),
        };
      }),
    );
    const append = adapter.appendBinary?.bind(adapter);
    steps.push(
      await step(`writeBinary then appendBinary in ${sizeLabel(chunk)} chunks`, async () => {
        if (append === undefined) return { passed: false, appendBinary: false };
        const started = now();
        await adapter.writeBinary(chunked, bufferOf(bytes.subarray(0, Math.min(chunk, size))));
        for (let offset = chunk; offset < size; offset += chunk) {
          await append(chunked, bufferOf(bytes.subarray(offset, Math.min(size, offset + chunk))));
        }
        const ms = now() - started;
        const stat = await adapter.stat(chunked);
        const read = await adapter.readBinary(chunked);
        return {
          passed: stat?.size === size && (await sha256Hex(read)) === expected,
          chunks: Math.ceil(size / chunk),
          statSize: stat?.size ?? null,
          ms: Math.round(ms),
          MBps: mbPerSecond(size, ms),
        };
      }),
    );
  } finally {
    steps.push(
      await step('remove the files and the folder', async () => {
        for (const path of [whole, chunked])
          if (await adapter.exists(path)) await adapter.remove(path);
        await adapter.rmdir(PROBE_FOLDER, true);
        return { passed: !(await adapter.exists(PROBE_FOLDER)) };
      }),
    );
  }
  return {
    status: statusOf(steps),
    data: { sizeBytes: size, chunkBytes: chunk, rangedReadApi: false, steps },
    errors: [],
  };
}
