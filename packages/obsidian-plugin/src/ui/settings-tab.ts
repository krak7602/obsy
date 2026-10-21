import { PluginSettingTab } from 'obsidian';
import type { App, Setting, SettingDefinitionItem } from 'obsidian';

import type ObsyPlugin from '../main';
import { maxFileSizeMB, normalisePrefix, normaliseSettings } from '../settings';

const SECRET_DESC =
  'Select or create a secret. Only the name of the secret is stored in the plugin settings. Give each vault its own secret names.';

/** Settings with the declarative settings API: the bucket, this device, and sync actions. */
export class ObsySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    readonly plugin: ObsyPlugin,
  ) {
    super(app, plugin);
  }

  #connected(): boolean {
    return this.plugin.device.mode !== 'off';
  }

  /** Adds a button to a row. When its action finishes, the tab updates. */
  #button(
    setting: Setting,
    label: string,
    action: () => Promise<void> | void,
    style: 'cta' | 'destructive' | 'plain' = 'plain',
  ): void {
    setting.addButton((button) => {
      button.setButtonText(label).onClick(async () => {
        await action();
        this.update();
      });
      if (style === 'cta') button.setCta();
      if (style === 'destructive') button.setDestructive();
    });
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const locked = (): boolean => this.#connected();
    return [
      {
        name: 'Status',
        render: (setting) => {
          setting.setDesc(this.plugin.service.status.detail);
          this.#button(setting, 'Sync now', () => this.plugin.syncNow());
        },
      },
      {
        name: 'Agent proposals',
        desc: 'Changes that agents could not make safely, waiting for your answer.',
        render: (setting) => {
          const count = this.plugin.service.status.proposals;
          setting.setDesc(
            count === null
              ? 'Changes that agents could not make safely. Not checked yet.'
              : `${count} open. Changes that agents could not make safely, waiting for your answer.`,
          );
          this.#button(setting, 'Review', () => this.plugin.reviewProposals());
        },
      },
      {
        type: 'group',
        heading: 'Bucket',
        items: [
          {
            name: 'Endpoint',
            desc: 'S3 API endpoint, without the bucket name. Settings in this group are locked while connected.',
            control: {
              type: 'text',
              key: 'endpoint',
              placeholder: 'https://example.com',
              disabled: locked,
            },
          },
          { name: 'Bucket name', control: { type: 'text', key: 'bucket', disabled: locked } },
          {
            name: 'Region',
            desc: 'Use auto for Cloudflare R2.',
            control: { type: 'text', key: 'region', defaultValue: 'auto', disabled: locked },
          },
          {
            name: 'Addressing',
            control: {
              type: 'dropdown',
              key: 'addressing',
              options: { path: 'Path style', virtual: 'Virtual-hosted style' },
              disabled: locked,
            },
          },
          {
            name: 'Vault prefix',
            desc: 'Where this vault lives in the bucket. Every device of the vault uses the same prefix. Empty means the bucket root.',
            control: {
              type: 'text',
              key: 'prefix',
              placeholder: 'Example: vaults/main/',
              disabled: locked,
            },
          },
          {
            name: 'Access key ID',
            desc: SECRET_DESC,
            control: { type: 'secret', key: 'accessKeyIdSecret', disabled: locked },
          },
          {
            name: 'Secret access key',
            desc: SECRET_DESC,
            control: { type: 'secret', key: 'secretAccessKeySecret', disabled: locked },
          },
        ],
      },
      {
        type: 'group',
        heading: 'This device',
        items: [
          {
            name: 'Device name',
            desc: 'Shown in conflict copy names.',
            control: { type: 'text', key: 'deviceName' },
          },
          {
            name: 'Largest file on this device',
            desc: 'In MB; 0 for no limit. Larger files that this device does not have yet are not downloaded. Files it already syncs, and files made here, sync at any size.',
            control: { type: 'number', key: 'maxFileSizeMB', min: 0, max: 10_000, step: 1 },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Sync',
        items: [
          {
            name: 'Connect',
            desc: 'Join the vault at this prefix in pull-only mode, or create it there if it does not exist. Try it on a copy of a vault first.',
            visible: () => !this.#connected(),
            render: (setting) =>
              this.#button(setting, 'Connect', () => this.plugin.service.connect(), 'cta'),
          },
          {
            name: 'Join with a pairing code',
            desc: 'Fill in the bucket settings and the credential from a code made by Pair another device, then join in pull-only mode.',
            visible: () => !this.#connected(),
            render: (setting) =>
              this.#button(setting, 'Enter code', () => this.plugin.joinWithCode()),
          },
          {
            name: 'Pair another device',
            desc: 'Show a QR code and a code that set up another device for this vault. They hold the bucket credential.',
            visible: () => this.#connected(),
            render: (setting) =>
              this.#button(setting, 'Show pairing code', () => this.plugin.showPairingCode()),
          },
          {
            name: 'Pull-only mode',
            desc: 'Remote changes are applied here, and nothing is sent. Run verify, then start full sync.',
            visible: () => this.plugin.device.mode === 'pull-only',
            render: (setting) =>
              this.#button(
                setting,
                'Start full sync',
                () => this.plugin.service.startFullSync(),
                'cta',
              ),
          },
          {
            name: 'Automatic sync',
            desc: 'Sync on start, when Obsidian comes to the front, after edits, and every 30 seconds.',
            visible: () => this.#connected(),
            control: { type: 'toggle', key: 'autoSync' },
          },
          {
            name: 'Verify',
            desc: 'Compare every file here with the bucket. Changes nothing.',
            visible: () => this.#connected(),
            render: (setting) => this.#button(setting, 'Verify', () => this.plugin.verify()),
          },
          {
            name: 'Disconnect',
            desc: 'Stop syncing this vault and forget its sync state. Files stay as they are.',
            visible: () => this.#connected(),
            render: (setting) =>
              this.#button(
                setting,
                'Disconnect',
                () => this.plugin.service.disconnect(),
                'destructive',
              ),
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === 'deviceName') return this.plugin.device.deviceName;
    if (key === 'autoSync') return this.plugin.device.autoSync;
    if (key === 'maxFileSizeMB') return this.plugin.device.maxFileSizeMB;
    return (this.plugin.config as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'deviceName') {
      if (typeof value === 'string' && value.trim() !== '') {
        this.plugin.saveDevice({ ...this.plugin.device, deviceName: value.trim() });
      }
      return;
    }
    if (key === 'maxFileSizeMB') {
      const device = this.plugin.device;
      this.plugin.saveDevice({
        ...device,
        maxFileSizeMB: maxFileSizeMB(value, device.maxFileSizeMB),
      });
      return;
    }
    if (key === 'autoSync') {
      this.plugin.service.setAutoSync(value === true);
      if (value === true) this.plugin.syncNow();
      return;
    }
    const next: Record<string, unknown> = { ...this.plugin.config, [key]: value };
    if (key === 'prefix' && typeof value === 'string') next['prefix'] = normalisePrefix(value);
    await this.plugin.saveSettings(normaliseSettings(next));
  }
}
