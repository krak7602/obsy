import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';

import type ObsyProbePlugin from './main';
import { guessProvider } from './report';
import type { SectionId } from './report';
import { SECTION_TITLES } from './runner';
import type { ProbeRunner } from './runner';

const BUTTONS: readonly SectionId[] = [
  'environment',
  'storage',
  'hashing',
  'indexedDb',
  'secretStorage',
  'vaultIo',
  'markers',
  'background',
];

/** The probe view: run buttons, progress, and the redacted report with a copy button. */
export class ProbeModal extends Modal {
  #unsubscribe: (() => void) | undefined;
  #statusEl: HTMLElement | undefined;
  #logEl: HTMLElement | undefined;
  #reportEl: HTMLTextAreaElement | undefined;
  #buttons: HTMLButtonElement[] = [];

  constructor(
    app: App,
    readonly probe: ObsyProbePlugin,
    readonly runner: ProbeRunner,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('obsy-probe');
    this.setTitle('Obsy probe');
    contentEl.createEl('p', {
      cls: 'obsy-probe-warning',
      text: 'Use a scratch vault and a scratch bucket only. Never run the probe in a real vault.',
    });
    this.#statusEl = contentEl.createDiv({ cls: 'obsy-probe-status' });

    const actions = contentEl.createDiv({ cls: 'obsy-probe-actions' });
    const runAll = actions.createEl('button', { text: 'Run all', cls: 'mod-cta' });
    runAll.addEventListener('click', () => {
      void this.probe.runAll();
    });
    this.#buttons.push(runAll);
    for (const id of BUTTONS) {
      const button = actions.createEl('button', { text: SECTION_TITLES[id] });
      button.addEventListener('click', () => {
        void this.probe.runSection(id);
      });
      this.#buttons.push(button);
    }

    contentEl.createEl('h3', { text: 'Progress' });
    this.#logEl = contentEl.createEl('pre', { cls: 'obsy-probe-log' });

    contentEl.createEl('h3', { text: 'Report' });
    this.#reportEl = contentEl.createEl('textarea', { cls: 'obsy-probe-report' });
    this.#reportEl.readOnly = true;
    this.#reportEl.rows = 12;

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Copy report')
          .setCta()
          .onClick(() => {
            void this.#copy();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Save report to vault').onClick(() => {
          void this.probe.saveReportToVault();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('Delete probe data')
          .setDestructive()
          .onClick(() => {
            void this.probe.deleteProbeData();
          }),
      );

    this.#unsubscribe = this.runner.subscribe(() => {
      this.#render();
    });
    this.#render();
  }

  override onClose(): void {
    this.#unsubscribe?.();
    this.contentEl.empty();
  }

  async #copy(): Promise<void> {
    const report = this.runner.reportJson();
    if ('error' in report) {
      new Notice(report.error);
      return;
    }
    try {
      await navigator.clipboard.writeText(report.json);
      new Notice('Report copied.');
    } catch {
      // Clipboard access can fail on mobile; select the text for a manual copy.
      this.#reportEl?.focus();
      this.#reportEl?.select();
      new Notice('Copy failed. The report text is selected; copy it by hand.');
    }
  }

  #render(): void {
    const { runner } = this;
    const settings = this.probe.settings;
    const config = runner.storageConfig();
    const busy = runner.busy;
    this.#statusEl?.setText(
      [
        `Provider: ${guessProvider(settings.endpoint)}`,
        `credentials ${config.accessKeyId !== '' && config.secretAccessKey !== '' ? 'found' : 'missing'}`,
        busy === null ? 'idle' : `running: ${busy === 'run-all' ? 'run all' : busy}`,
      ].join(' · '),
    );
    for (const button of this.#buttons) button.disabled = busy !== null;
    if (this.#logEl !== undefined) {
      this.#logEl.setText(runner.logLines.slice(-14).join('\n'));
    }
    if (this.#reportEl !== undefined) {
      const report = runner.reportJson();
      this.#reportEl.value = 'error' in report ? report.error : report.json;
    }
  }
}
