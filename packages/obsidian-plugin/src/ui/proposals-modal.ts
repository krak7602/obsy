import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';

import { lineDiff, type ProposalDetail } from '@obsy/agent';
import type { ProposalReason } from '@obsy/protocol';

import type { SyncService } from '../sync/service';

const REASONS: Record<ProposalReason, string> = {
  requested: 'The agent asked for a review.',
  'anchor-missing': 'The heading or block that the change needs is missing.',
  'anchor-ambiguous': 'The place for the change is not clear.',
  'block-edited': "Someone edited the agent's block, so the block is theirs now.",
  'not-owned': 'Someone else changed the file.',
  editing: 'A device was editing the note.',
};

/** Shows open agent proposals with their changes, to accept or reject. */
export class ProposalsModal extends Modal {
  #proposals: ProposalDetail[];
  #busy = false;

  constructor(
    app: App,
    readonly service: SyncService,
    proposals: ProposalDetail[],
  ) {
    super(app);
    this.#proposals = proposals;
  }

  override onOpen(): void {
    this.setTitle('Agent proposals');
    this.#render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  #render(): void {
    const el = this.contentEl;
    el.empty();
    if (this.#proposals.length === 0) {
      el.createEl('p', { text: 'No open proposals.' });
      return;
    }
    for (const detail of this.#proposals) this.#renderOne(el, detail);
  }

  #renderOne(el: HTMLElement, detail: ProposalDetail): void {
    const p = detail.proposal;
    new Setting(el)
      .setName(p.path)
      .setDesc(`From ${p.actor.id}, ${new Date(p.createdAt).toLocaleString()}.`)
      .setHeading();
    el.createEl('p', { text: REASONS[p.reason] });
    if (p.rationale !== '') el.createEl('p', { text: p.rationale, cls: 'obsy-rationale' });
    if (p.fileId !== null && detail.head === null) {
      el.createEl('p', { text: 'The note was deleted since.' });
    } else if (p.baseRev !== null && detail.head !== null && detail.head.rev !== p.baseRev) {
      el.createEl('p', { text: 'The note changed since. Accepting merges the changes.' });
    }
    const diff = el.createDiv({ cls: 'obsy-diff' });
    if (detail.proposedText === null) {
      diff.createDiv({ text: 'Binary content.' });
    } else {
      for (const line of lineDiff(detail.baseText ?? '', detail.proposedText)) {
        const cls =
          line.kind === '+'
            ? 'obsy-diff-add'
            : line.kind === '-'
              ? 'obsy-diff-del'
              : line.kind === '…'
                ? 'obsy-diff-skip'
                : 'obsy-diff-same';
        diff.createDiv({ text: line.kind === '…' ? line.text : line.text || ' ', cls });
      }
    }
    new Setting(el)
      .addButton((button) =>
        button.setButtonText('Reject').onClick(() => void this.#act(p.id, 'reject')),
      )
      .addButton((button) =>
        button
          .setButtonText('Accept')
          .setCta()
          .onClick(() => void this.#act(p.id, 'accept')),
      );
  }

  async #act(id: string, action: 'accept' | 'reject'): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (action === 'reject') {
        const resolution = await this.service.rejectProposal(id);
        new Notice(
          resolution.outcome === 'rejected'
            ? 'Obsy: proposal rejected.'
            : 'Obsy: it was accepted before.',
        );
      } else {
        const result = await this.service.acceptProposal(id);
        if (result.status === 'conflict') {
          new Notice('Obsy: the proposal conflicts with later edits. It stays open.');
          return;
        }
        new Notice(
          result.status === 'resolved'
            ? `Obsy: it was ${result.resolution.outcome} before.`
            : result.merged
              ? 'Obsy: proposal accepted and merged with later edits.'
              : 'Obsy: proposal accepted.',
        );
      }
      this.#proposals = this.#proposals.filter((d) => d.proposal.id !== id);
      this.#render();
    } catch (error) {
      new Notice(`Obsy: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#busy = false;
    }
  }
}
