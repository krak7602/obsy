import { withRetry, type Environment } from '@obsy/core';
import {
  PRESENCE_PREFIX,
  PROPOSAL_PREFIX,
  RESOLUTION_PREFIX,
  ProtocolError,
  decodePresence,
  decodeProposal,
  decodeResolution,
  encodeRecord,
  isPreconditionFailed,
  parsePresenceKey,
  parseProposalKey,
  presenceKey,
  proposalKey,
  resolutionKey,
  type Presence,
  type Proposal,
  type Resolution,
  type Storage,
} from '@obsy/protocol';

/**
 * Proposal, resolution, and presence records in the bucket. See
 * docs/subsystems/agent-sdk.md#proposals and #presence.
 */

async function listAll(storage: Storage, env: Environment, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await withRetry(env, () => storage.list(prefix, startAfter, 1000));
    keys.push(...page.keys);
    if (!page.truncated || page.keys.length === 0) return keys;
    startAfter = page.keys.at(-1);
  }
}

/** Proposal IDs, split into open and resolved. Two list requests (more past 1,000 keys). */
export async function proposalIds(
  storage: Storage,
  env: Environment,
): Promise<{ open: string[]; resolved: string[] }> {
  const [proposals, resolutions] = await Promise.all([
    listAll(storage, env, PROPOSAL_PREFIX),
    listAll(storage, env, RESOLUTION_PREFIX),
  ]);
  const resolved = new Set(
    resolutions.map(parseProposalKey).filter((id): id is string => id !== null),
  );
  const open: string[] = [];
  for (const id of proposals.map(parseProposalKey)) {
    if (id !== null && !resolved.has(id)) open.push(id);
  }
  return { open, resolved: [...resolved] };
}

export async function readProposal(
  storage: Storage,
  env: Environment,
  id: string,
): Promise<Proposal | null> {
  const object = await withRetry(env, () => storage.get(proposalKey(id)));
  return object === null ? null : decodeProposal(object.body, id);
}

export async function readResolution(
  storage: Storage,
  env: Environment,
  id: string,
): Promise<Resolution | null> {
  const object = await withRetry(env, () => storage.get(resolutionKey(id)));
  return object === null ? null : decodeResolution(object.body, id);
}

/** Stores a proposal record. Its content blob must exist. */
export async function writeProposal(
  storage: Storage,
  env: Environment,
  proposal: Proposal,
): Promise<void> {
  try {
    await withRetry(env, () =>
      storage.putIfAbsent(proposalKey(proposal.id), encodeRecord(proposal), 'application/json'),
    );
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    // A retried request that had applied: the record must be ours.
    const existing = await readProposal(storage, env, proposal.id);
    if (existing === null || existing.hash !== proposal.hash || existing.path !== proposal.path)
      throw new ProtocolError(`proposal ${proposal.id} exists with other content`);
  }
}

/**
 * Stores a resolution once. Returns the resolution that exists afterwards:
 * ours, or one that another writer stored first.
 */
export async function writeResolution(
  storage: Storage,
  env: Environment,
  resolution: Resolution,
): Promise<Resolution> {
  try {
    await withRetry(env, () =>
      storage.putIfAbsent(
        resolutionKey(resolution.id),
        encodeRecord(resolution),
        'application/json',
      ),
    );
    return resolution;
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    const existing = await readResolution(storage, env, resolution.id);
    if (existing === null)
      throw new ProtocolError(`resolution ${resolution.id} missing after a failed create`);
    return existing;
  }
}

/**
 * Every device's presence record. Presence is advisory: a record that does
 * not parse is left out, not treated as corruption.
 */
export async function readPresence(storage: Storage, env: Environment): Promise<Presence[]> {
  const out: Presence[] = [];
  for (const key of await listAll(storage, env, PRESENCE_PREFIX)) {
    const device = parsePresenceKey(key);
    if (device === null) continue;
    const object = await withRetry(env, () => storage.get(key));
    if (object === null) continue;
    try {
      out.push(decodePresence(object.body, device));
    } catch {
      // Ignore a damaged record.
    }
  }
  return out;
}

/**
 * Writes one device's presence record. Only that device writes the key, so
 * the etag of the last write is usually current: one request per write.
 */
export class PresenceWriter {
  #etag: string | null = null;

  constructor(
    readonly storage: Storage,
    readonly env: Environment,
    readonly device: string,
  ) {}

  async write(path: string | null, time: Date): Promise<void> {
    const key = presenceKey(this.device);
    const record: Presence = { format: 1, device: this.device, time: time.toISOString(), path };
    const body = encodeRecord(record);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const etag = this.#etag;
        const result = await withRetry(this.env, () =>
          etag === null
            ? this.storage.putIfAbsent(key, body, 'application/json')
            : this.storage.putIfMatch(key, body, etag, 'application/json'),
        );
        this.#etag = result.etag;
        return;
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
        const current = await withRetry(this.env, () => this.storage.get(key));
        this.#etag = current?.etag ?? null;
      }
    }
    throw new ProtocolError(`presence ${this.device} kept changing`);
  }
}
