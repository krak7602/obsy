import {
  PresenceWriter,
  VaultAdmin,
  proposalIds,
  type AcceptResult,
  type ProposalDetail,
} from '@obsy/agent';
import {
  RemoteVault,
  SafetyRailError,
  SyncEngine,
  SyncStopped,
  initVault,
  verifyLocal,
  type Environment,
  type SafetyRails,
  type SyncReport,
  type VerifyReport,
} from '@obsy/core';
import { ProtocolError, isStorageError, type Resolution, type Storage } from '@obsy/protocol';

import { decodePairingCode, encodePairingCode, type PairingInfo } from '../pairing';
import type { DeviceSettings, ObsySettings } from '../settings';
import { actorIdFor, maxFileSizeBytes, missingSettings } from '../settings';
import type { IdbStateStore } from './idb-store';
import type { VaultLocalFiles } from './vault-files';

/** A presence record for one note is written at most this often while the user types. */
export const PRESENCE_EVERY_MS = 30_000;
/** Automatic syncs look for new agent proposals at most this often. */
export const PROPOSALS_EVERY_MS = 5 * 60_000;

/** The rails from docs/subsystems/obsidian-plugin.md#deletes-and-safety-rails. */
export const RAILS: SafetyRails = { maxFiles: 50, maxFraction: 0.2, minFiles: 10 };

export type StatusState = 'off' | 'not-configured' | 'idle' | 'syncing' | 'paused' | 'error';

export interface SyncStatus {
  readonly state: StatusState;
  /** One sentence for the status bar tooltip and the settings tab. */
  readonly detail: string;
  /** When the last sync finished without an error, in ms since the epoch. */
  readonly lastSync: number | null;
  /** Local changes that a pull-only sync did not send. */
  readonly unsent: number;
  /** Files left out by this device's size limit. */
  readonly skipped: number;
  /** Open agent proposals at the last check, or null before the first. */
  readonly proposals: number | null;
}

/** The two credential values, from SecretStorage. */
export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** A question for the user, with the label of the button that answers yes. */
export interface Question {
  readonly title: string;
  readonly lines: readonly string[];
  readonly confirm: string;
  /** True when yes deletes or overwrites something. */
  readonly risky: boolean;
}

/** What the service needs from the plugin. The plugin implements it on Obsidian. */
export interface ServiceHost {
  settings(): ObsySettings;
  saveSettings(settings: ObsySettings): Promise<void>;
  device(): DeviceSettings;
  saveDevice(device: DeviceSettings): void;
  /** A `Storage` for the configured bucket and prefix. Throws when a credential is missing. */
  storage(): Storage;
  readonly files: VaultLocalFiles;
  readonly store: IdbStateStore;
  readonly env: Environment;
  saveOpenNotes(): Promise<void>;
  /** The configured credential values. Throws when a secret is empty or missing. */
  credentials(): Credentials;
  /** Stores credentials under this vault's own secret names and returns the names. */
  storeCredentials(credentials: Credentials): {
    accessKeyIdSecret: string;
    secretAccessKeySecret: string;
  };
  /** True when a running sync should stop at the next safe point (the app is going to the background). */
  stopRequested(): boolean;
  ask(question: Question): Promise<boolean>;
  notify(message: string): void;
  status(status: SyncStatus): void;
}

/** The device state names another vault than the folder's marker. */
class MarkerMismatch extends Error {
  constructor(
    readonly stateVaultId: string,
    readonly markerVaultId: string | null,
  ) {
    super('The vault folder does not carry the marker of the vault that this device synced');
  }
}

export interface RunOptions {
  /** A run that the user started: report the result, even when nothing changed. */
  readonly manual?: boolean;
  readonly allowMassDelete?: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One device's sync: connect, sync runs, verify, and the questions that
 * the safety rails raise. Operations run one at a time, in call order, so
 * that two engines never work on the same state.
 */
export class SyncService {
  #status: SyncStatus = {
    state: 'off',
    detail: 'Not connected.',
    lastSync: null,
    unsent: 0,
    skipped: 0,
    proposals: null,
  };
  #queue: Promise<unknown> = Promise.resolve();
  #presence: { readonly writer: PresenceWriter; readonly key: string } | null = null;
  #lastPresence: { readonly path: string; readonly at: number } | null = null;
  #presenceBusy = false;
  #proposalsCheckedAt = Number.NEGATIVE_INFINITY;
  #knownProposals = new Set<string>();

  constructor(readonly host: ServiceHost) {}

  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action, action);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  get status(): SyncStatus {
    return this.#status;
  }

  #set(state: StatusState, detail: string, extra: Partial<SyncStatus> = {}): void {
    this.#status = { ...this.#status, state, detail, ...extra };
    this.host.status(this.#status);
  }

  /** Shows the status that the settings allow, without syncing. */
  refreshStatus(): void {
    const device = this.host.device();
    const missing = missingSettings(this.host.settings());
    if (device.mode === 'off') this.#set('off', 'Not connected.');
    else if (missing.length > 0) this.#set('not-configured', `Missing: ${missing.join(', ')}.`);
    else if (!device.autoSync) this.#set('paused', 'Automatic sync is paused.');
    else
      this.#set('idle', this.#status.detail === 'Not connected.' ? 'Ready.' : this.#status.detail);
  }

  #engine(storage: Storage): SyncEngine {
    const device = this.host.device();
    const maxFileSize = maxFileSizeBytes(device);
    return new SyncEngine({
      storage,
      local: this.host.files,
      state: this.host.store,
      env: this.host.env,
      actorId: actorIdFor(device.deviceName),
      deviceName: device.deviceName,
      rails: RAILS,
      ...(maxFileSize === undefined ? {} : { maxFileSize }),
    });
  }

  /**
   * Connects this vault to the bucket prefix. With a vault there, this
   * device joins in pull-only mode. Without one, it asks, then creates the
   * vault and syncs in full mode.
   */
  connect(): Promise<void> {
    return this.#exclusive(() => this.#connect());
  }

  /** `expectVaultId`: join only this vault (from a pairing code); never create one. */
  async #connect(expectVaultId?: string): Promise<void> {
    const missing = missingSettings(this.host.settings());
    if (missing.length > 0) {
      this.host.notify(`Obsy: set ${missing.join(', ')} first.`);
      return;
    }
    let storage: Storage;
    try {
      storage = this.host.storage();
      const existing = await new RemoteVault(storage, this.host.env).getVault();
      let mode: DeviceSettings['mode'] = 'pull-only';
      if (expectVaultId !== undefined && existing?.vaultId !== expectVaultId) {
        throw new Error(
          existing === null
            ? 'The bucket has no vault at the prefix that the pairing code names.'
            : 'The bucket prefix holds another vault than the one the pairing code names.',
        );
      }
      if (existing !== null) {
        const yes = await this.host.ask({
          title: 'Join the vault in the bucket?',
          lines: [
            'obsy will download the vault into this one, in pull-only mode: nothing is sent yet.',
            'Files here that equal a bucket file are kept. A file that differs is renamed to a conflict copy, and the bucket version takes its path.',
            'When the pull is done, run Verify, then start full sync.',
          ],
          confirm: 'Join in pull-only mode',
          risky: false,
        });
        if (!yes) return;
      } else {
        const yes = await this.host.ask({
          title: 'Create a vault in the bucket?',
          lines: [
            'The bucket has no obsy vault at this prefix.',
            'obsy will create one and upload the files of this vault.',
          ],
          confirm: 'Create and upload',
          risky: false,
        });
        if (!yes) return;
        await initVault(storage, this.host.env);
        mode = 'full';
      }
      // A new connection starts from the bucket: reconcile every file by content.
      await this.host.store.clear();
      await this.host.saveSettings({ ...this.host.settings(), vaultId: null });
      this.host.saveDevice({ ...this.host.device(), mode, autoSync: true });
    } catch (error) {
      this.#set('error', `Connect failed: ${describe(error)}`);
      this.host.notify(`Obsy: connect failed. ${describe(error)}`);
      return;
    }
    await this.#run({ manual: true });
  }

  /** Stops syncing and forgets the device state. Files stay as they are. */
  disconnect(): Promise<void> {
    return this.#exclusive(() => this.#disconnect());
  }

  async #disconnect(): Promise<void> {
    this.host.saveDevice({ ...this.host.device(), mode: 'off' });
    await this.host.store.clear();
    await this.host.saveSettings({ ...this.host.settings(), vaultId: null });
    this.#set('off', 'Not connected.', { unsent: 0, skipped: 0 });
  }

  /**
   * A pairing code for another device: the bucket settings, the credential,
   * and the vault ID. Only while connected. The caller shows it once and
   * never stores it.
   */
  pairingCode(): string {
    const settings = this.host.settings();
    if (this.host.device().mode === 'off' || settings.vaultId === null) {
      throw new Error('Connect and sync this vault first.');
    }
    return encodePairingCode({
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      addressing: settings.addressing,
      prefix: settings.prefix,
      ...this.host.credentials(),
      vaultId: settings.vaultId,
    });
  }

  /**
   * Joins the vault that a pairing code names: asks, stores the credential
   * under this vault's own secret names, fills in the settings, and joins in
   * pull-only mode. Only while not connected.
   */
  joinWithCode(input: string): Promise<void> {
    return this.#exclusive(async () => {
      if (this.host.device().mode !== 'off') {
        this.host.notify('Obsy: disconnect this vault before you join with a pairing code.');
        return;
      }
      let info: PairingInfo;
      try {
        info = decodePairingCode(input);
      } catch (error) {
        this.host.notify(`Obsy: ${describe(error)}`);
        return;
      }
      const host = /^https?:\/\/([^/]+)/.exec(info.endpoint)?.[1] ?? info.endpoint;
      const yes = await this.host.ask({
        title: 'Join with this pairing code?',
        lines: [
          `Bucket ${info.bucket} at ${host}, prefix ${info.prefix === '' ? '(bucket root)' : info.prefix}.`,
          "obsy stores the credential in this vault's secret storage and fills in the settings. Then it joins in pull-only mode.",
        ],
        confirm: 'Use this code',
        risky: false,
      });
      if (!yes) return;
      const names = this.host.storeCredentials({
        accessKeyId: info.accessKeyId,
        secretAccessKey: info.secretAccessKey,
      });
      await this.host.saveSettings({
        ...this.host.settings(),
        endpoint: info.endpoint,
        bucket: info.bucket,
        region: info.region,
        addressing: info.addressing,
        prefix: info.prefix,
        ...names,
        vaultId: null,
      });
      await this.#connect(info.vaultId);
    });
  }

  /** Ends pull-only mode: from now on, local changes are sent. */
  startFullSync(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.host.device().mode !== 'pull-only') return;
      this.host.saveDevice({ ...this.host.device(), mode: 'full' });
      await this.#run({ manual: true });
    });
  }

  setAutoSync(on: boolean): void {
    this.host.saveDevice({ ...this.host.device(), autoSync: on });
    this.refreshStatus();
  }

  /** One sync run. Never throws; the outcome is in the status. */
  run(options: RunOptions = {}): Promise<SyncReport | null> {
    return this.#exclusive(() => this.#run(options));
  }

  /** With `force`, it runs even while automatic sync is paused, without the notice of a manual run. */
  async #run(options: RunOptions, force = false): Promise<SyncReport | null> {
    const device = this.host.device();
    if (device.mode === 'off') {
      this.#set('off', 'Not connected.');
      return null;
    }
    if (!force && !options.manual && !device.autoSync) return null;
    const missing = missingSettings(this.host.settings());
    if (missing.length > 0) {
      this.#set('not-configured', `Missing: ${missing.join(', ')}.`);
      return null;
    }
    this.#set('syncing', 'Syncing…');
    try {
      const storage = this.host.storage();
      await this.host.saveOpenNotes();
      await this.#checkMarker();
      const report = await this.#engine(storage).sync({
        pullOnly: device.mode === 'pull-only',
        shouldStop: () => this.host.stopRequested(),
        ...(options.allowMassDelete === true ? { allowMassDelete: true } : {}),
      });
      await this.#afterSync();
      if (device.mode === 'full') {
        // Proposals are secondary: a failed check does not fail the sync.
        await this.#checkProposals(storage, options.manual === true).catch(() => undefined);
      }
      this.#set('idle', this.#summary(report), {
        lastSync: Date.now(),
        unsent: report.unsent,
        skipped: report.skipped,
      });
      if (options.manual === true) this.host.notify(`Obsy: ${this.#summary(report)}`);
      return report;
    } catch (error) {
      return this.#failed(error, options);
    }
  }

  async #checkMarker(): Promise<void> {
    const state = await this.host.store.load();
    const marker = this.host.settings().vaultId;
    if (state !== null && marker !== state.vaultId) throw new MarkerMismatch(state.vaultId, marker);
  }

  async #afterSync(): Promise<void> {
    const state = await this.host.store.load();
    const settings = this.host.settings();
    if (state !== null && settings.vaultId !== state.vaultId) {
      await this.host.saveSettings({ ...settings, vaultId: state.vaultId });
    }
    const hashes = this.host.files.takeChangedHashes();
    if (hashes !== null) await this.host.store.saveHashes(hashes);
  }

  #summary(report: SyncReport): string {
    const parts: string[] = [];
    if (report.commits > 0)
      parts.push(`sent ${report.commits} commit${report.commits === 1 ? '' : 's'}`);
    if (report.localChanges > 0)
      parts.push(`${report.localChanges} local change${report.localChanges === 1 ? '' : 's'}`);
    if (report.conflictCopies > 0) {
      parts.push(
        `${report.conflictCopies} conflict cop${report.conflictCopies === 1 ? 'y' : 'ies'}`,
      );
    }
    if (report.unsent > 0)
      parts.push(
        `pull only: ${report.unsent} local change${report.unsent === 1 ? '' : 's'} not sent`,
      );
    else if (!report.settled) parts.push('not settled yet, will retry');
    if (report.skipped > 0) {
      parts.push(
        `${report.skipped} file${report.skipped === 1 ? '' : 's'} over the size limit left out`,
      );
    }
    const text = parts.length === 0 ? 'Up to date' : parts.join(', ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }

  async #failed(error: unknown, options: RunOptions): Promise<null> {
    if (error instanceof SyncStopped) {
      // Its state is saved; the next sync, when the app is back, goes on.
      await this.#afterSync().catch(() => undefined);
      this.#set('idle', 'Stopped while Obsidian was in the background; continues when it is back.');
      return null;
    }
    if (error instanceof SafetyRailError) {
      this.host.saveDevice({ ...this.host.device(), autoSync: false });
      this.#set('paused', `Stopped: ${error.message}.`);
      const where =
        error.rail === 'local-deletes'
          ? 'on this device (as your Obsidian setting for deleted files says)'
          : 'in the bucket (history keeps them)';
      const yes = await this.host.ask({
        title: 'Obsy stopped a sync',
        lines:
          error.rail === 'empty-vault'
            ? [
                `${error.message}.`,
                'If the vault folder was moved or emptied by mistake, cancel and restore it.',
                `Continue only if you deleted every file on purpose: the ${error.count} files will be deleted in the bucket.`,
              ]
            : [
                `${error.message}.`,
                `Continue only if these deletes are intended. The files will be deleted ${where}.`,
                'Automatic sync stays paused until you decide.',
              ],
        confirm: `Delete ${error.count} files`,
        risky: true,
      });
      if (!yes) return null;
      this.host.saveDevice({ ...this.host.device(), autoSync: true });
      await this.#run({ manual: true, allowMassDelete: true });
      return null;
    }
    if (error instanceof MarkerMismatch) {
      this.host.saveDevice({ ...this.host.device(), autoSync: false });
      this.#set('paused', 'Stopped: the vault folder marker does not match.');
      const yes = await this.host.ask({
        title: 'Is this the same vault folder?',
        lines: [
          'This device synced a vault, but the vault folder does not carry its marker. The folder may have been replaced or restored from a backup.',
          'If you continue, obsy compares every file with the bucket. Files missing here may be deleted in the bucket; large deletes still stop and ask.',
        ],
        confirm: 'Continue',
        risky: true,
      });
      if (!yes) return null;
      await this.host.saveSettings({ ...this.host.settings(), vaultId: error.stateVaultId });
      this.host.saveDevice({ ...this.host.device(), autoSync: true });
      await this.#run({ manual: true });
      return null;
    }
    const message = describe(error);
    if (error instanceof ProtocolError) {
      // The bucket breaks the protocol: stop until a person looks.
      this.host.saveDevice({ ...this.host.device(), autoSync: false });
      this.#set('error', `Stopped: ${message}`);
      this.host.notify(`Obsy stopped: ${message}`);
      return null;
    }
    if (isStorageError(error, 'transient')) {
      this.#set('error', `Bucket not reachable; will retry. ${message}`);
      if (options.manual === true) this.host.notify(`Obsy: bucket not reachable. ${message}`);
      return null;
    }
    if (isStorageError(error, 'fatal')) {
      // For example, credentials that the bucket rejects. Retrying does not help.
      this.host.saveDevice({ ...this.host.device(), autoSync: false });
      this.#set('error', `Stopped: ${message}`);
      this.host.notify(`Obsy stopped: ${message}`);
      return null;
    }
    this.#set('error', `Sync failed: ${message}`);
    if (options.manual === true) this.host.notify(`Obsy: sync failed. ${message}`);
    return null;
  }

  // ---------------------------------------------------------------- agents

  /**
   * The user is editing `path`. Tells agents, through this device's presence
   * record, at most every 30 s per note, so that they wait or propose
   * instead of changing the note under the user. Only in full mode.
   * Presence is advisory: a failed write is not reported.
   */
  editing(path: string): void {
    if (this.host.device().mode !== 'full' || missingSettings(this.host.settings()).length > 0)
      return;
    const now = this.host.env.now().getTime();
    const last = this.#lastPresence;
    if (this.#presenceBusy || (last?.path === path && now - last.at < PRESENCE_EVERY_MS)) return;
    this.#lastPresence = { path, at: now };
    this.#presenceBusy = true;
    void this.#writePresence(path, new Date(now)).finally(() => {
      this.#presenceBusy = false;
    });
  }

  async #writePresence(path: string, time: Date): Promise<void> {
    try {
      const settings = this.host.settings();
      const id = actorIdFor(this.host.device().deviceName);
      const key = JSON.stringify([settings.endpoint, settings.bucket, settings.prefix, id]);
      if (this.#presence?.key !== key) {
        this.#presence = {
          writer: new PresenceWriter(this.host.storage(), this.host.env, id),
          key,
        };
      }
      await this.#presence.writer.write(path, time);
    } catch {
      // Try again at the next edit.
      this.#lastPresence = null;
    }
  }

  /** Counts open proposals, at most every five minutes unless `force`. Tells the user about new ones. */
  async #checkProposals(storage: Storage, force: boolean): Promise<void> {
    const now = this.host.env.now().getTime();
    if (!force && now - this.#proposalsCheckedAt < PROPOSALS_EVERY_MS) return;
    this.#proposalsCheckedAt = now;
    const { open } = await proposalIds(storage, this.host.env);
    const fresh = open.filter((id) => !this.#knownProposals.has(id));
    this.#knownProposals = new Set(open);
    this.#status = { ...this.#status, proposals: open.length };
    if (fresh.length > 0) {
      const count = `${open.length} agent proposal${open.length === 1 ? '' : 's'}`;
      this.host.notify(`Obsy: ${count} to review. Run "Review agent proposals".`);
    }
  }

  #admin(storage: Storage): VaultAdmin {
    return new VaultAdmin({
      storage,
      env: this.host.env,
      actor: { kind: 'device', id: actorIdFor(this.host.device().deviceName) },
    });
  }

  /** Open proposals with their content, oldest first. */
  proposals(): Promise<ProposalDetail[]> {
    return this.#exclusive(async () => {
      const storage = this.host.storage();
      const admin = this.#admin(storage);
      const out: ProposalDetail[] = [];
      for (const proposal of await admin.openProposals()) {
        const detail = await admin.proposal(proposal.id);
        if (detail !== null) out.push(detail);
      }
      this.#knownProposals = new Set(out.map((d) => d.proposal.id));
      this.#set(this.#status.state, this.#status.detail, { proposals: out.length });
      return out;
    });
  }

  /**
   * Accepts a proposal: syncs first, so that edits made here are in the
   * bucket and the proposal merges with them; then commits it as this
   * device, and syncs again to bring it here. Only in full mode.
   */
  acceptProposal(id: string): Promise<AcceptResult> {
    return this.#exclusive(async () => {
      if (this.host.device().mode !== 'full')
        throw new Error('Accepting a proposal needs full sync mode.');
      await this.#run({}, true);
      const storage = this.host.storage();
      const result = await this.#admin(storage).accept(id);
      await this.#run({}, true);
      await this.#recount(storage);
      return result;
    });
  }

  rejectProposal(id: string): Promise<Resolution> {
    return this.#exclusive(async () => {
      if (this.host.device().mode !== 'full')
        throw new Error('Rejecting a proposal needs full sync mode.');
      const storage = this.host.storage();
      const resolution = await this.#admin(storage).reject(id);
      await this.#recount(storage);
      return resolution;
    });
  }

  async #recount(storage: Storage): Promise<void> {
    await this.#checkProposals(storage, true).catch(() => undefined);
    this.#set(this.#status.state, this.#status.detail);
  }

  /** Compares the vault with the head in the bucket. */
  verify(): Promise<VerifyReport> {
    return this.#exclusive(async () => {
      await this.host.saveOpenNotes();
      const max = maxFileSizeBytes(this.host.device());
      return verifyLocal(
        this.host.storage(),
        this.host.env,
        this.host.files,
        max === undefined ? {} : { maxFileSize: max },
      );
    });
  }
}
