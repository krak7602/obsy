// Obsy probe: a separate plugin (ID `obsy-probe`) that measures the platform
// APIs that obsy depends on, on desktop and on iPhone. It is not the sync
// plugin. See docs/runbooks/platform-probe.md.
import { Notice, Platform, Plugin, apiVersion, normalizePath, requestUrl } from 'obsidian';

import type { SectionId } from './report';
import { ProbeRunner } from './runner';
import type { ProbeHost } from './runner';
import { deleteProbeDatabase } from './sections/indexeddb';
import { isSecretStorage } from './sections/secrets';
import { normaliseSettings } from './settings';
import type { ProbeSettings } from './settings';
import { ProbeSettingTab } from './settings-tab';
import { describeError } from './util';
import { ProbeModal } from './view';

export default class ObsyProbePlugin extends Plugin {
  override settings: ProbeSettings = normaliseSettings({});
  runner: ProbeRunner | undefined;

  override async onload(): Promise<void> {
    this.settings = normaliseSettings(await this.loadData());
    // Save once, so that a newly generated probe prefix stays the same.
    await this.saveData(this.settings);

    const runner = new ProbeRunner(this.#host());
    this.runner = runner;
    runner.lifecycle.record('plugin-load', document.visibilityState);
    for (const type of ['visibilitychange', 'freeze', 'resume']) {
      this.registerDomEvent(document, type as 'visibilitychange', () => {
        runner.lifecycle.record(type, document.visibilityState);
      });
    }
    for (const type of ['pagehide', 'pageshow', 'focus', 'blur']) {
      this.registerDomEvent(window, type as 'focus', () => {
        runner.lifecycle.record(type, document.visibilityState);
      });
    }
    this.app.workspace.onLayoutReady(() => {
      runner.lifecycle.record('layout-ready', document.visibilityState);
      void runner.checkOnLoad();
    });

    this.addSettingTab(new ProbeSettingTab(this.app, this));
    this.addRibbonIcon('activity', 'Open probe', () => {
      this.openProbe();
    });
    this.addCommand({ id: 'open', name: 'Open', callback: () => this.openProbe() });
    this.addCommand({ id: 'run-all', name: 'Run all checks', callback: () => void this.runAll() });
    const sections: [SectionId, string][] = [
      ['storage', 'Run storage checks over requestUrl'],
      ['hashing', 'Run SHA-256 throughput'],
      ['indexedDb', 'Run IndexedDB checks'],
      ['secretStorage', 'Run secret storage checks'],
      ['vaultIo', 'Run vault large-file checks'],
      ['markers', 'Write restart markers'],
      ['background', 'Start background request test'],
    ];
    for (const [id, name] of sections) {
      this.addCommand({
        id: `run-${id.toLowerCase()}`,
        name,
        callback: () => void this.runSection(id),
      });
    }
    this.addCommand({
      id: 'copy-report',
      name: 'Copy report',
      callback: () => void this.copyReport(),
    });
    this.addCommand({
      id: 'save-report',
      name: 'Save report to vault',
      callback: () => void this.saveReportToVault(),
    });
    this.addCommand({
      id: 'delete-data',
      name: 'Delete probe data',
      callback: () => void this.deleteProbeData(),
    });
    this.addCommand({
      id: 'delete-database',
      name: 'Delete the probe database',
      callback: () => void this.deleteDatabase(),
    });
  }

  async deleteDatabase(): Promise<void> {
    try {
      const result = await deleteProbeDatabase();
      new Notice(`Probe database: ${result}.`);
    } catch (error) {
      new Notice(`Probe database: delete failed (${describeError(error)}).`);
    }
  }

  async saveSettings(settings: ProbeSettings): Promise<void> {
    this.settings = settings;
    await this.saveData(settings);
  }

  openProbe(): void {
    if (this.runner === undefined) return;
    new ProbeModal(this.app, this, this.runner).open();
  }

  async runAll(): Promise<void> {
    if (this.runner === undefined) return;
    if (!(await this.runner.runAll())) new Notice('A probe run is already in progress.');
  }

  async runSection(id: SectionId): Promise<void> {
    if (this.runner === undefined) return;
    if (id === 'background') {
      new Notice(
        `Background test started for ${this.settings.backgroundSeconds} s. Switch to another app now, wait, then come back.`,
        10_000,
      );
    }
    if (!(await this.runner.run(id))) new Notice('A probe run is already in progress.');
  }

  async copyReport(): Promise<void> {
    const report = this.runner?.reportJson();
    if (report === undefined) return;
    if ('error' in report) {
      new Notice(report.error);
      return;
    }
    try {
      await navigator.clipboard.writeText(report.json);
      new Notice('Report copied.');
    } catch (error) {
      new Notice(`Copy failed: ${describeError(error)}. Use save report to vault instead.`);
    }
  }

  async saveReportToVault(): Promise<void> {
    const report = this.runner?.reportJson();
    if (report === undefined) return;
    if ('error' in report) {
      new Notice(report.error);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = normalizePath(`Obsy probe report ${stamp}.md`);
    await this.app.vault.create(
      path,
      `# Obsy probe report\n\n\`\`\`json\n${report.json}\n\`\`\`\n`,
    );
    new Notice(`Saved the report to ${path}.`);
  }

  async deleteProbeData(): Promise<void> {
    if (this.runner === undefined) return;
    const lines = await this.runner.deleteProbeData();
    new Notice(lines.join('\n'), 10_000);
  }

  #host(): ProbeHost {
    const adapter = this.app.vault.adapter;
    const secrets = (this.app as { secretStorage?: unknown }).secretStorage;
    const dataPath = normalizePath(`${this.manifest.dir ?? ''}/data.json`);
    // Recorded for the report only; OS detection uses `Platform`.
    const nav = window.navigator;
    return {
      probeVersion: this.manifest.version,
      settings: () => this.settings,
      saveSettings: (settings) => this.saveSettings(settings),
      secrets: isSecretStorage(secrets) ? secrets : undefined,
      requestUrl: (param) => requestUrl(param),
      globalFetch:
        typeof window.fetch === 'function'
          ? (url, init) =>
              window.fetch(url, {
                method: init.method,
                headers: init.headers,
                ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
                ...(init.signal === undefined ? {} : { signal: init.signal as AbortSignal }),
              })
          : undefined,
      adapter,
      readPluginData: async () =>
        (await adapter.exists(dataPath)) ? adapter.read(dataPath) : null,
      countInLocalStorage: (value) => {
        try {
          const storage = window.localStorage;
          let count = 0;
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key !== null && (storage.getItem(key) ?? '').includes(value)) count += 1;
          }
          return count;
        } catch {
          return null;
        }
      },
      localStore: {
        load: (key) => this.app.loadLocalStorage(key) as unknown,
        save: (key, value) => {
          this.app.saveLocalStorage(key, value);
        },
      },
      environment: () => ({
        platform: {
          isDesktopApp: Platform.isDesktopApp,
          isMobileApp: Platform.isMobileApp,
          isIosApp: Platform.isIosApp,
          isAndroidApp: Platform.isAndroidApp,
          isPhone: Platform.isPhone,
          isTablet: Platform.isTablet,
          isMacOS: Platform.isMacOS,
          isWin: Platform.isWin,
          isLinux: Platform.isLinux,
          isSafari: Platform.isSafari,
        },
        apiVersion,
        userAgent: nav.userAgent,
        origin: window.location.origin,
        isSecureContext: window.isSecureContext,
        crossOriginIsolated: window.crossOriginIsolated,
        hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemoryGiB: (nav as { deviceMemory?: number }).deviceMemory ?? null,
        apis: {
          requestUrl: typeof requestUrl === 'function',
          fetch: typeof window.fetch === 'function',
          subtleDigest: typeof window.crypto?.subtle?.digest === 'function',
          indexedDB: typeof window.indexedDB === 'object',
          storageManager: typeof nav.storage === 'object',
          secretStorage: isSecretStorage(secrets),
          appendBinary: typeof adapter.appendBinary === 'function',
          abortController: typeof window.AbortController === 'function',
        },
      }),
      vaultPaths: () => vaultPaths(adapter.getResourcePath('')),
      timers: window,
      visibility: () => document.visibilityState,
    };
  }
}

/** Absolute forms of the vault folder, from its resource URL, for redaction. */
function vaultPaths(resourceUrl: string): string[] {
  const paths = new Set<string>();
  const withoutQuery = resourceUrl.split('?')[0] ?? '';
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)$/i.exec(withoutQuery);
  const path = match?.[1];
  if (path !== undefined) {
    paths.add(path.replace(/\/+$/, ''));
    try {
      paths.add(decodeURIComponent(path).replace(/\/+$/, ''));
    } catch {
      // Keep the encoded form only.
    }
  }
  paths.add(withoutQuery.replace(/\/+$/, ''));
  return [...paths].filter((value) => value.length >= 8);
}
