// obsy sync plugin. See docs/subsystems/obsidian-plugin.md.
import { webEnvironment } from '@obsy/core';
import { S3Storage } from '@obsy/storage-s3';
import { Notice, Platform, Plugin, TAbstractFile, requestUrl } from 'obsidian';

import {
  normaliseDevice,
  normaliseSettings,
  type DeviceSettings,
  type ObsySettings,
} from './settings';
import { IdbKeyValue, IdbStateStore } from './sync/idb-store';
import { ObsidianVaultPort } from './sync/obsidian-port';
import { SyncScheduler } from './sync/scheduler';
import { SyncService, type SyncStatus } from './sync/service';
import { VaultLocalFiles } from './sync/vault-files';
import { PAIRING_ACTION } from './pairing';
import { createRequestUrlFetch } from './transport/request-url-fetch';
import { VerifyModal, ask } from './ui/modals';
import { JoinWithCodeModal, PairingCodeModal } from './ui/pairing-modals';
import { ProposalsModal } from './ui/proposals-modal';
import { ObsySettingTab } from './ui/settings-tab';

const DEVICE_KEY = 'obsy-device';
/** Sync this long after the last edit. */
const EDIT_DELAY_MS = 2000;
/** Sync this often (on mobile, only while Obsidian is visible). */
const POLL_MS = 30_000;
/** On mobile, files larger than this are written in pieces of this size. */
const MOBILE_CHUNK_BYTES = 4 * 1024 * 1024;
/** On mobile, the default size limit in MB. */
const MOBILE_MAX_FILE_MB = 50;

function randomId(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return [...values].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultDeviceName(): string {
  const kind = Platform.isIosApp ? 'iphone' : Platform.isAndroidApp ? 'android' : 'desktop';
  return `${kind}-${randomId(2)}`;
}

export default class ObsyPlugin extends Plugin {
  config: ObsySettings = normaliseSettings({});
  device: DeviceSettings = {
    localId: '',
    deviceName: '',
    mode: 'off',
    autoSync: true,
    maxFileSizeMB: 0,
  };
  service!: SyncService;
  #scheduler!: SyncScheduler;
  #files!: VaultLocalFiles;
  #port!: ObsidianVaultPort;
  #kv: IdbKeyValue | null = null;
  #statusBar: HTMLElement | null = null;
  /** Set while a mobile app is hidden: a running sync stops at the next safe point. */
  #stopRequested = false;

  override async onload(): Promise<void> {
    this.config = normaliseSettings(await this.loadData());
    this.device = normaliseDevice(this.app.loadLocalStorage(DEVICE_KEY), () => ({
      localId: randomId(8),
      deviceName: defaultDeviceName(),
      mode: 'off',
      autoSync: true,
      maxFileSizeMB: Platform.isMobileApp ? MOBILE_MAX_FILE_MB : 0,
    }));
    this.app.saveLocalStorage(DEVICE_KEY, this.device);

    const port = new ObsidianVaultPort(this.app);
    this.#port = port;
    this.#files = new VaultLocalFiles(
      port,
      Platform.isMobileApp ? { chunkBytes: MOBILE_CHUNK_BYTES } : {},
    );
    this.#kv = await IdbKeyValue.open();
    const store = new IdbStateStore(this.#kv, this.device.localId);
    this.#files.importHashes(await store.loadHashes());

    this.service = new SyncService({
      settings: () => this.config,
      saveSettings: (settings) => this.saveSettings(settings),
      device: () => this.device,
      saveDevice: (device) => this.saveDevice(device),
      storage: () => this.#storage(),
      files: this.#files,
      store,
      env: webEnvironment(),
      saveOpenNotes: () => port.saveOpenNotes(),
      credentials: () => this.#credentials(),
      storeCredentials: (credentials) => this.#storeCredentials(credentials),
      stopRequested: () => this.#stopRequested,
      ask: (question) => ask(this.app, question),
      notify: (message) => {
        new Notice(message);
      },
      status: (status) => this.#showStatus(status),
    });
    this.#scheduler = new SyncScheduler(async () => {
      await this.service.run();
    }, window);

    this.#statusBar = this.addStatusBarItem();
    this.addSettingTab(new ObsySettingTab(this.app, this));
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.syncNow() });
    this.addCommand({
      id: 'verify',
      name: 'Verify this vault against the bucket',
      callback: () => void this.verify(),
    });
    this.addCommand({
      id: 'start-full-sync',
      name: 'Start full sync (end pull-only mode)',
      checkCallback: (checking) => {
        if (this.device.mode !== 'pull-only') return false;
        if (!checking) void this.service.startFullSync();
        return true;
      },
    });
    this.addCommand({
      id: 'toggle-auto-sync',
      name: 'Pause or resume automatic sync',
      callback: () => {
        this.service.setAutoSync(!this.device.autoSync);
        if (this.device.autoSync) this.#scheduler.request(0);
      },
    });
    this.addCommand({
      id: 'review-proposals',
      name: 'Review agent proposals',
      checkCallback: (checking) => {
        if (this.device.mode !== 'full') return false;
        if (!checking) void this.reviewProposals();
        return true;
      },
    });
    this.addCommand({
      id: 'pair-device',
      name: 'Pair another device',
      checkCallback: (checking) => {
        if (this.device.mode === 'off') return false;
        if (!checking) this.showPairingCode();
        return true;
      },
    });
    this.addCommand({
      id: 'join-with-code',
      name: 'Join with a pairing code',
      checkCallback: (checking) => {
        if (this.device.mode !== 'off') return false;
        if (!checking) this.joinWithCode();
        return true;
      },
    });
    // A pairing QR code holds an obsidian://obsy-pair link.
    this.registerObsidianProtocolHandler(PAIRING_ACTION, (params) => {
      const code = params['code'];
      if (typeof code === 'string') this.joinWithCode(code);
    });
    this.service.refreshStatus();

    this.app.workspace.onLayoutReady(() => void this.#start());
  }

  async #start(): Promise<void> {
    await this.#files.removeLeftovers();
    const onChange = (file: TAbstractFile, oldPath?: string): void => {
      const own = this.#files.noteVaultEvent(file.path);
      if (oldPath !== undefined) this.#files.noteVaultEvent(oldPath);
      if (!own) this.#scheduler.touch(EDIT_DELAY_MS);
    };
    this.registerEvent(this.app.vault.on('create', (file) => onChange(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => onChange(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => onChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => onChange(file, oldPath)));
    // Typing in a note tells agents to wait or propose (presence).
    this.registerEvent(
      this.app.workspace.on('editor-change', (_editor, info) => {
        const path = info.file?.path;
        if (path !== undefined && !this.#port.isOwnEdit(path)) this.service.editing(path);
      }),
    );
    // On mobile, sync pauses while the app is hidden: iOS stops plugins
    // seconds later. Desktop keeps syncing, because macOS reports a window
    // behind other windows as hidden, and an edit saved just before the user
    // switches apps must still go out.
    const mobile = Platform.isMobileApp;
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.#stopRequested = false;
        this.#scheduler.resume();
        this.#scheduler.request(0);
      } else if (mobile) {
        // A running sync stops at its next safe point; nothing new starts.
        this.#stopRequested = true;
        this.#scheduler.pause();
      }
    });
    this.registerInterval(
      window.setInterval(() => {
        if (!mobile || document.visibilityState === 'visible') this.#scheduler.request(0);
      }, POLL_MS),
    );
    this.#scheduler.request(0);
  }

  override onunload(): void {
    this.#scheduler.stop();
    this.#kv?.close();
  }

  #credentials(): { accessKeyId: string; secretAccessKey: string } {
    const secrets = this.app.secretStorage;
    const accessKeyId = secrets.getSecret(this.config.accessKeyIdSecret);
    const secretAccessKey = secrets.getSecret(this.config.secretAccessKeySecret);
    if (
      accessKeyId === null ||
      secretAccessKey === null ||
      accessKeyId === '' ||
      secretAccessKey === ''
    ) {
      throw new Error('A credential secret is empty or missing in secret storage.');
    }
    return { accessKeyId, secretAccessKey };
  }

  /**
   * Stores credentials under names unique to this vault and device: on
   * mobile, secrets with the same name may be shared across vaults.
   */
  #storeCredentials(credentials: { accessKeyId: string; secretAccessKey: string }): {
    accessKeyIdSecret: string;
    secretAccessKeySecret: string;
  } {
    const names = {
      accessKeyIdSecret: `obsy-${this.device.localId}-access-key-id`,
      secretAccessKeySecret: `obsy-${this.device.localId}-secret-access-key`,
    };
    this.app.secretStorage.setSecret(names.accessKeyIdSecret, credentials.accessKeyId);
    this.app.secretStorage.setSecret(names.secretAccessKeySecret, credentials.secretAccessKey);
    return names;
  }

  #storage(): S3Storage {
    const { accessKeyId, secretAccessKey } = this.#credentials();
    return new S3Storage({
      endpoint: this.config.endpoint,
      bucket: this.config.bucket,
      region: this.config.region,
      addressing: this.config.addressing,
      prefix: this.config.prefix,
      accessKeyId,
      secretAccessKey,
      fetch: createRequestUrlFetch(requestUrl),
    });
  }

  #showStatus(status: SyncStatus): void {
    if (this.#statusBar === null) return;
    const labels: Record<SyncStatus['state'], string> = {
      off: 'Obsy: off',
      'not-configured': 'Obsy: set up',
      idle: this.device.mode === 'pull-only' ? 'Obsy: pull only' : 'Obsy: synced',
      syncing: 'Obsy: syncing',
      paused: 'Obsy: paused',
      error: 'Obsy: error',
    };
    this.#statusBar.setText(labels[status.state]);
    this.#statusBar.setAttr('aria-label', status.detail);
    this.#statusBar.setAttr('data-tooltip-position', 'top');
  }

  /** A sync that the user asked for. It waits for a running sync, then reports its result. */
  syncNow(): void {
    void this.service.run({ manual: true });
  }

  async verify(): Promise<void> {
    if (this.device.mode === 'off') {
      new Notice('Obsy: connect first.');
      return;
    }
    try {
      const report = await this.service.verify();
      new VerifyModal(this.app, report).open();
    } catch (error) {
      new Notice(`Obsy: verify failed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async reviewProposals(): Promise<void> {
    try {
      const proposals = await this.service.proposals();
      new ProposalsModal(this.app, this.service, proposals).open();
    } catch (error) {
      new Notice(
        `Obsy: could not read proposals. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  showPairingCode(): void {
    try {
      new PairingCodeModal(this.app, this.service.pairingCode()).open();
    } catch (error) {
      new Notice(`Obsy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  joinWithCode(code = ''): void {
    new JoinWithCodeModal(this.app, (value) => this.service.joinWithCode(value), code).open();
  }

  async saveSettings(settings: ObsySettings): Promise<void> {
    this.config = settings;
    await this.saveData(settings);
  }

  saveDevice(device: DeviceSettings): void {
    this.device = { ...device, deviceName: device.deviceName.trim() || this.device.deviceName };
    this.app.saveLocalStorage(DEVICE_KEY, this.device);
  }
}
