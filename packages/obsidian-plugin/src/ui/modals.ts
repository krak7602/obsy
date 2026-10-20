import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

import type { VerifyReport } from '@obsy/core';

import type { Question } from '../sync/service';

/** Asks a yes or no question. Resolves false when closed without an answer. */
export function ask(app: App, question: Question): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.setTitle(question.title);
        for (const line of question.lines) this.contentEl.createEl('p', { text: line });
        new Setting(this.contentEl)
          .addButton((button) =>
            button.setButtonText('Cancel').onClick(() => {
              this.close();
            }),
          )
          .addButton((button) => {
            button.setButtonText(question.confirm).onClick(() => {
              answered = true;
              this.close();
            });
            if (question.risky) button.setDestructive();
            else button.setCta();
          });
      }

      override onClose(): void {
        this.contentEl.empty();
        resolve(answered);
      }
    })(app);
    modal.open();
  });
}

const PROBLEM_LABELS = {
  missing: 'In the bucket, missing here',
  extra: 'Here, not in the bucket',
  content: 'Content differs',
  path: 'Name differs in case or Unicode form',
} as const;

/** Shows a verify report. */
export class VerifyModal extends Modal {
  constructor(
    app: App,
    readonly report: VerifyReport,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { report } = this;
    this.setTitle(
      report.problems.length === 0 ? 'Vault matches the bucket' : 'Vault differs from the bucket',
    );
    this.contentEl.createEl('p', {
      text: `Compared ${report.localFiles} files here with ${report.headFiles} files in the bucket at commit ${report.seq}.`,
    });
    if (report.problems.length === 0) {
      this.contentEl.createEl('p', { text: 'No differences.' });
      return;
    }
    for (const kind of ['missing', 'extra', 'content', 'path'] as const) {
      const paths = report.problems.filter((p) => p.problem === kind).map((p) => p.path);
      if (paths.length === 0) continue;
      new Setting(this.contentEl).setName(`${PROBLEM_LABELS[kind]} (${paths.length})`).setHeading();
      const list = this.contentEl.createEl('ul');
      for (const path of paths.slice(0, 100)) list.createEl('li', { text: path });
      if (paths.length > 100) list.createEl('li', { text: `and ${paths.length - 100} more` });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
