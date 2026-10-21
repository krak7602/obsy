import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { encode } from 'uqr';

import { pairingLink } from '../pairing';

/** Draws a QR code of `text` on a canvas. Dark modules on white, with a quiet zone. */
function drawQr(parent: HTMLElement, text: string): void {
  const qr = encode(text, { ecc: 'M', border: 4 });
  const scale = Math.max(3, Math.floor(360 / qr.size));
  const canvas = parent.createEl('canvas', { cls: 'obsy-qr' });
  canvas.width = qr.size * scale;
  canvas.height = qr.size * scale;
  const context = canvas.getContext('2d');
  if (context === null) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) context.fillRect(x * scale, y * scale, scale, scale);
    });
  });
}

/**
 * Shows a pairing code once: as a QR code of an `obsidian://` link, which a
 * phone camera opens in Obsidian, and as text to copy. The code is not
 * stored.
 */
export class PairingCodeModal extends Modal {
  constructor(
    app: App,
    readonly code: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle('Pair another device');
    this.contentEl.createEl('p', {
      text: 'This code holds the bucket credential. Anyone with it can read and change this vault. Show it only to your own devices, and close this window when done.',
    });
    this.contentEl.createEl('p', {
      text: 'On the other device, open a new, empty vault with obsy installed. Scan the code with the camera, or copy the code and paste it there.',
    });
    drawQr(this.contentEl, pairingLink(this.code));
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText('Copy code').onClick(async () => {
        await navigator.clipboard.writeText(this.code);
        new Notice('Pairing code copied. Paste it on the other device, then clear the clipboard.');
      }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Asks for a pairing code, then calls `join` with it. */
export class JoinWithCodeModal extends Modal {
  #code: string;

  constructor(
    app: App,
    readonly join: (code: string) => Promise<void>,
    initial = '',
  ) {
    super(app);
    this.#code = initial;
  }

  override onOpen(): void {
    this.setTitle('Join with a pairing code');
    this.contentEl.createEl('p', {
      text: 'Paste the pairing code from a device that syncs the vault. Use a new, empty vault here.',
    });
    new Setting(this.contentEl).setName('Pairing code').addTextArea((area) => {
      area.setValue(this.#code).onChange((value) => {
        this.#code = value;
      });
      area.inputEl.rows = 4;
      area.inputEl.addClass('obsy-pairing-input');
    });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Join')
        .setCta()
        .onClick(() => {
          const code = this.#code;
          this.close();
          void this.join(code);
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
