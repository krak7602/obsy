import { PluginSettingTab } from 'obsidian';
import type { App, SettingDefinitionItem } from 'obsidian';

import type ObsyProbePlugin from './main';
import type { ProbeSettings } from './settings';
import { VAULT_IO_SIZES_MIB, normaliseSettings } from './settings';

const PREFIX_PATTERN = /^obsy-probe\/[a-z0-9-]{1,64}\/$/;

/** Probe settings, with the declarative settings API (1.13.0+). */
export class ProbeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    readonly probe: ObsyProbePlugin,
  ) {
    super(app, probe);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Use scratch storage only',
        desc: 'Use a scratch vault and a bucket that holds nothing else. Every run writes only under the probe prefix and deletes what it wrote.',
      },
      {
        type: 'group',
        heading: 'Scratch bucket',
        items: [
          {
            name: 'Endpoint',
            desc: 'S3 API endpoint without the bucket name. For R2 this is the account endpoint shown in the dashboard.',
            control: { type: 'text', key: 'endpoint', placeholder: 'https://example.com' },
          },
          { name: 'Bucket', control: { type: 'text', key: 'bucket' } },
          {
            name: 'Region',
            desc: 'Use auto for R2.',
            control: { type: 'text', key: 'region', defaultValue: 'auto' },
          },
          {
            name: 'Addressing',
            control: {
              type: 'dropdown',
              key: 'addressing',
              options: { path: 'Path style', virtual: 'Virtual-hosted style' },
            },
          },
          {
            name: 'Prefix',
            desc: 'Probe-only prefix. It must have the form obsy-probe/<id>/.',
            control: {
              type: 'text',
              key: 'prefix',
              validate: (value: string) =>
                PREFIX_PATTERN.test(value)
                  ? undefined
                  : 'Use obsy-probe/ and an ID of lower-case letters, digits, or dashes, ending in /.',
            },
          },
          {
            name: 'Access key ID',
            desc: 'Select or create a secret. Only the name of the secret is stored in the plugin settings.',
            control: { type: 'secret', key: 'accessKeyIdSecret' },
          },
          {
            name: 'Secret access key',
            desc: 'Select or create a secret. Only the name of the secret is stored in the plugin settings.',
            control: { type: 'secret', key: 'secretAccessKeySecret' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Run options',
        items: [
          {
            name: 'Full conformance suite',
            desc: 'Also run both races at their default size. This sends several hundred more requests.',
            control: { type: 'toggle', key: 'fullSuite' },
          },
          {
            name: 'Vault file size',
            desc: 'Size of the test file in the vault test, in MiB.',
            control: {
              type: 'dropdown',
              key: 'vaultIoMiB',
              options: Object.fromEntries(
                VAULT_IO_SIZES_MIB.map((size) => [String(size), `${size} MiB`]),
              ),
            },
          },
          {
            name: 'Background test length',
            desc: 'Seconds that the background test keeps requests running.',
            control: { type: 'number', key: 'backgroundSeconds', min: 10, max: 600, step: 1 },
          },
        ],
      },
      {
        name: 'Open the probe',
        action: () => {
          this.probe.openProbe();
        },
      },
    ];
  }

  override getControlValue(key: string): unknown {
    const value = this.probe.settings[key as keyof ProbeSettings];
    return key === 'vaultIoMiB' && typeof value === 'number' ? String(value) : value;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const next: Record<string, unknown> = { ...this.probe.settings };
    next[key] = key === 'vaultIoMiB' ? Number(value) : value;
    await this.probe.saveSettings(normaliseSettings(next));
  }
}
