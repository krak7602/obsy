---
title: iPhone sync test
aliases: [phase 3 test, iOS test, phone test, mobile sync test, pairing test]
updated: 2026-10-21
---

# iPhone sync test

## Current

This page owns the manual phase 3 test: a Mac and an iPhone syncing a scratch vault through a scratch bucket. It checks what the desktop test cannot: iOS suspension, app kills, the phone's file system, and pairing with the camera. The plugin is on [Obsidian plugin](../subsystems/obsidian-plugin.md); desktop and simulator results are in [Mobile sync, phase 3](../learning/mobile-sync-phase3.md).

Status: run once, on 2026-10-21: all 8 steps passed ([results](../learning/mobile-sync-phase3.md#iphone-run)).

> [!warning] Scratch only
> Use a new scratch vault on both devices and a bucket that holds nothing else. Never use a vault in use, and never a vault in iCloud Drive or any other synced folder: obsy and iCloud would both sync it.

### Requirements

- A scratch bucket that the phone can reach, with a token scoped to it: [Make a scratch R2 bucket and a scoped token](storage-conformance.md#make-a-scratch-r2-bucket-and-a-scoped-token).
- Obsidian 1.13.2 or later on the Mac and the iPhone.
- The plugin on both devices. With a beta release: BRAT ([plugin release](plugin-release.md#install-with-brat)). Without one: on the Mac, copy `main.js`, `manifest.json`, and `styles.css` from a build into `.obsidian/plugins/obsy/` of the scratch vault; on the iPhone, use Method C below.

### Method C: install on the iPhone over USB

This worked on 2026-10-21. Obsidian on iOS lets a Mac reach its Documents folder over USB, as Finder file sharing does; each vault stored on the iPhone is a folder there.

1. Install [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) in its own environment, for example `uv venv ~/.cache/obsy-tools/venv && uv pip install --python ~/.cache/obsy-tools/venv/bin/python pymobiledevice3`. It is GPL-3.0: use it as a tool; do not copy its code into this repository.
2. Connect the iPhone with a cable, unlock it, and trust the Mac. In Obsidian on the iPhone, create the vault, stored on the iPhone.
3. Run `pymobiledevice3 apps afc --documents md.obsidian`. In its shell, change to the vault folder, make `.obsidian/plugins/obsy`, and push the three files into it.
4. Restart Obsidian on the iPhone, then turn on the plugin in **Settings → Community plugins**.

### Set up

1. **Mac.** Create a new local vault, for example `sync-test`, with a few notes in folders, one note with a non-ASCII name (`Café.md`), and an image. Install and turn on the plugin. In **Settings → Obsy - Sync Vaults**, fill in the bucket, choose a new prefix such as `scratch/phase3/`, and select or create the two secrets. Select **Connect**, then **Create and upload**.
2. **Mac.** Select **Pair another device**. Do not take a screenshot of it.
3. **iPhone.** Create a new vault **on this iPhone** (Store in iCloud off). Install and turn on the plugin. Scan the QR code with the Camera app and open the link in Obsidian. Answer **Use this code**, then **Join in pull-only mode**. Close the pairing window on the Mac.
4. **iPhone.** Run **Verify**: expect no differences. Then **Start full sync**.

### Steps

Record for each step: pass or fail, and anything unexpected. Obsidian on iOS hides the status bar and automatic syncs show no notice, so judge each step by its end state, and read **Status** in the plugin settings when needed. Run **Verify** on both devices after each step; expect no differences, except files over the size limit, which count as skipped.

| # | Do | Expect |
| --- | --- | --- |
| 1 | iPhone: turn on Airplane Mode. Edit the first line of a note, and create a new note. Mac: edit the last line of the same note and sync. iPhone: turn off Airplane Mode and bring Obsidian to the front. | Both edits are in the note on both devices; the new note reaches the Mac |
| 2 | iPhone: add a large attachment (about 30 MB, for example a video) to a note. About 3 s later, swipe Obsidian away in the app switcher. Open it again and wait. | The Mac gets the file once, with the right size; no file ends in `.obsy-tmp`; no conflict copy of it |
| 3 | Mac: add a file of about 40 MB. iPhone: open Obsidian, and about 3 s later, swipe it away. Open it again and wait. | The file arrives once, complete |
| 4 | Mac: add another large file. iPhone: open Obsidian, and about 2 s later, switch to another app for 30 s, then come back. | The file arrives complete |
| 5 | Mac: create `Notes/Idea.md`. iPhone, before it syncs: create `Notes/idea.md` with other text. Sync both. | One `Notes/Idea.md` and one conflict copy on both devices |
| 6 | iPhone: rename a note by changing only the case of its name. Sync both. | The Mac shows the new case; no duplicate |
| 7 | Mac: add a file of about 60 MB. iPhone: sync. | The iPhone does not download it; the status says one file over the size limit was left out; **Verify** counts it as skipped |
| 8 | iPhone: type in a note without leaving it. Mac: edit another line of the same note and sync. iPhone: wait for a sync. | Both edits are in the note; the cursor stays |

### Report

Send the table with pass or fail and the status texts. Do not send note content, the pairing code, the bucket name, or the endpoint. Afterwards, delete the scratch vault on the iPhone if you do not need it, and revoke the token when the tests are done.

## History

- 2026-10-21: First run, all steps passed; added Method C (USB) and timing-based steps.
- 2026-10-21: Created for phase 3.
