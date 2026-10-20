import {
  Manifest,
  ProtocolError,
  decodeUtf8Strict,
  encodeUtf8,
  hashContent,
  type Actor,
  type Commit,
  type Op,
  type Storage,
} from '@obsy/protocol';

import type { Environment } from './host';
import { RemoteVault } from './remote';

export type AgentResult = 'appended' | 'created' | 'skipped';

/**
 * Narrow agent writes against the head. An agent never merges: it reads the
 * head, computes its change from it, and commits with `baseRev` equal to
 * the head revision. A lost claim makes it read the new head and compute
 * the change again. Phase 1 has only `appendLine`; the full operation set
 * is in docs/subsystems/agent-sdk.md.
 */
export class AgentWriter {
  readonly #remote: RemoteVault;
  readonly #actor: Actor;
  #manifest: Manifest | null = null;

  constructor(
    storage: Storage,
    readonly env: Environment,
    actor: { readonly id: string; readonly run?: string },
    readonly maxAttempts = 20,
  ) {
    this.#remote = new RemoteVault(storage, env);
    this.#actor =
      actor.run === undefined
        ? { kind: 'agent', id: actor.id }
        : { kind: 'agent', id: actor.id, run: actor.run };
  }

  /**
   * Appends `line` to the file at `path`, or creates the file with it.
   * Skips (`skipped`) when the path holds a file that is not UTF-8 text.
   */
  async appendLine(path: string, line: string): Promise<AgentResult> {
    const vault = await this.#remote.getVault();
    if (vault === null) throw new ProtocolError('The bucket has no vault.json.');
    if (this.#manifest === null || this.#manifest.epoch !== vault.epoch)
      this.#manifest = new Manifest(vault.epoch);
    const manifest = this.#manifest;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      await this.#remote.catchUp(manifest);
      const fileId = manifest.liveAt(path);
      let op: Op;
      let bytes: Uint8Array;
      if (fileId === undefined) {
        bytes = encodeUtf8(`${line}\n`);
        op = {
          type: 'put',
          fileId: this.env.newFileId(),
          path,
          baseRev: null,
          hash: await hashContent(bytes),
          size: bytes.length,
        };
      } else {
        const head = manifest.file(fileId);
        if (head === undefined) throw new ProtocolError(`unknown file ${fileId}`);
        let text: string;
        try {
          text = decodeUtf8Strict(await this.#remote.getBlob(head.hash));
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          return 'skipped';
        }
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        bytes = encodeUtf8(`${text}${separator}${line}\n`);
        op = {
          type: 'put',
          fileId,
          path: head.path,
          baseRev: head.rev,
          hash: await hashContent(bytes),
          size: bytes.length,
        };
      }
      await this.#remote.putBlob(bytes, op.hash);
      const commit: Commit = {
        format: 1,
        seq: manifest.seq + 1,
        epoch: manifest.epoch,
        opId: this.env.newOpId(this.#actor.id),
        actor: this.#actor,
        time: this.env.now().toISOString(),
        ops: [op],
      };
      const result = await this.#remote.claim(commit.seq, JSON.stringify(commit), commit.opId);
      if (result.won) {
        manifest.apply(commit);
        return op.baseRev === null ? 'created' : 'appended';
      }
    }
    throw new ProtocolError(`agent append to ${path} lost ${this.maxAttempts} races`);
  }
}
