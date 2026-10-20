import {
  RemoteVault,
  SafetyRailError,
  SyncEngine,
  initVault,
  verifyLocal,
  type Environment,
  type SafetyRails,
  type SyncReport,
  type VerifyReport,
} from '@obsy/core';
import { ProtocolError, isStorageError, type Storage } from '@obsy/protocol';

import type { DeviceSettings, ObsySettings } from '../settings';
import { actorIdFor, missingSettings } from '../settings';
import type { IdbStateStore } from './idb-store';
import type { VaultLocalFiles } from './vault-files';

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
  #status: SyncStatus = { state: 'off', detail: 'Not connected.', lastSync: null, unsent: 0 };
  #queue: Promise<unknown> = Promise.resolve();

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
    return new SyncEngine({
      storage,
      local: this.host.files,
      state: this.host.store,
      env: this.host.env,
      actorId: actorIdFor(device.deviceName),
      deviceName: device.deviceName,
      rails: RAILS,
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

  async #connect(): Promise<void> {
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
    this.#set('off', 'Not connected.', { unsent: 0 });
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

  async #run(options: RunOptions): Promise<SyncReport | null> {
    const device = this.host.device();
    if (device.mode === 'off') {
      this.#set('off', 'Not connected.');
      return null;
    }
    if (!options.manual && !device.autoSync) return null;
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
        ...(options.allowMassDelete === true ? { allowMassDelete: true } : {}),
      });
      await this.#afterSync();
      this.#set('idle', this.#summary(report), { lastSync: Date.now(), unsent: report.unsent });
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
    const text = parts.length === 0 ? 'Up to date' : parts.join(', ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }

  async #failed(error: unknown, options: RunOptions): Promise<null> {
    if (error instanceof SafetyRailError) {
      this.host.saveDevice({ ...this.host.device(), autoSync: false });
      this.#set('paused', `Stopped: ${error.message}.`);
      const where =
        error.rail === 'local-deletes'
          ? 'on this device (they go to the vault trash)'
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

  /** Compares the vault with the head in the bucket. */
  verify(): Promise<VerifyReport> {
    return this.#exclusive(async () => {
      await this.host.saveOpenNotes();
      return verifyLocal(this.host.storage(), this.host.env, this.host.files);
    });
  }
}
