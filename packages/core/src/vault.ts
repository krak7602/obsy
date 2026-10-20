import { newFileId, newOpId, newVaultId, type Storage, type VaultRecord } from '@obsy/protocol';

import type { Environment } from './host';
import { RemoteVault } from './remote';

interface TimerGlobals {
  setTimeout(callback: () => void, ms: number): unknown;
}

/** The real environment: wall clock, `Math.random`, timers, and random IDs. */
export function webEnvironment(): Environment {
  const timers = globalThis as unknown as TimerGlobals;
  return {
    now: () => new Date(),
    random: () => Math.random(),
    sleep: (ms) =>
      new Promise((resolve) => {
        timers.setTimeout(resolve, ms);
      }),
    newFileId,
    newOpId,
  };
}

/**
 * Creates `vault.json` in an empty bucket prefix, or returns the existing
 * record. Safe to call from several devices at once.
 */
export async function initVault(
  storage: Storage,
  env: Environment,
  settings: Partial<VaultRecord['settings']> = {},
): Promise<VaultRecord> {
  const remote = new RemoteVault(storage, env);
  const existing = await remote.getVault();
  if (existing !== null) return existing;
  return remote.initVault({
    format: 1,
    vaultId: newVaultId(),
    epoch: 1,
    createdAt: env.now().toISOString(),
    settings: {
      retentionDays: settings.retentionDays ?? 180,
      blobSoftDeleteDays: settings.blobSoftDeleteDays ?? 30,
    },
  });
}
