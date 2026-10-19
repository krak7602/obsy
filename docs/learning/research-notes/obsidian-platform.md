---
title: Research notes: Obsidian plugin platform
aliases: [obsidian API, iOS lifecycle, requestUrl, SecretStorage]
updated: 2026-10-19
---

# Obsidian plugin platform constraints for a cross-platform sync plugin (obsy), as of October 2026

Research date: 2026-10-19. API facts come from `obsidian.d.ts` in `obsidianmd/obsidian-api` at the `master` branch. Its `package.json` reports version **1.14.4**. The newest public API addition is `TExternalFile` (`@since 1.14.4`). The API `CHANGELOG.md` has had no entries since v1.7.2, so the `@since` tags in the typings are the only reliable change log for 1.8–1.14. Mobile app releases seen: 1.13.1 (2026-06-09), 1.13.2 (2026-07-14), 1.13.4 (2026-07-27), 1.13.5 (2026-08-05), and 1.13.7 (2026-08-11/12).

Abbreviation: **d.ts** = [obsidian.d.ts (obsidian-api master, v1.14.4)](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts).

---

## 1. Execution model on iOS/Android: lifecycle, background limits, resume hooks, timers

### Takeaway
A plugin runs only while the Obsidian app is in the foreground. Obsidian Mobile is a Capacitor/WebView app, and iOS suspends its JavaScript soon after it goes to the background. No public API provides background execution, a resume hook, or a reliable quit hook. Sync must run on startup and on foreground return (`visibilitychange`), finish small units of work quickly, and assume the app can be killed in the middle of a write.

### Cited Findings
- The `Platform` object exposes `isMobileApp` ("We're running the `Capacitor` mobile app"), `isIosApp`, `isAndroidApp`, `isDesktopApp`, `isPhone`, and `isTablet`. Note that `isMacOS` is also true on iPhones and iPads ("a device that pretends to be one (like iPhones and iPads)"). Use `isIosApp` for the iOS check, not `isMacOS`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- The mobile vault adapter is `CapacitorAdapter`: "Implementation of the vault adapter for mobile devices" (`@since 1.7.2`). The desktop adapter is `FileSystemAdapter`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- "The Node.js API, and the Electron API aren't available on mobile devices." Calling them can crash the plugin. — [Mobile development docs](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- Regex lookbehind "is only supported on iOS 16.4 and above". Remote Safari Web Inspector debugging needs iOS 16.4 or later. `this.app.emulateMobile(true)` emulates mobile on desktop. — [Mobile development docs](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- The only app-exit event is `workspace.on('quit')`: "Triggered when the app is about to quit. **Not guaranteed to actually run.** Perform some best effort cleanup here." (`@since 0.10.2`) — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- `Component.registerInterval` registers a `setInterval` that is cancelled on unload (`@since 0.13.8`). Nothing in the API keeps such timers alive in the background. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- `Plugin.onUserEnable()` (`@since 1.7.2`) runs once, when the user explicitly enables the plugin. It is the place for first-run setup. Do not use `onload` for that. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts); [API changelog v1.7.2](https://github.com/obsidianmd/obsidian-api/blob/master/CHANGELOG.md)
- Vault `create` events "also [fire] when the vault is first loaded for each existing file. If you do not wish to receive create events on vault load, register your event handler inside `Workspace.onLayoutReady`." — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- A forum participant says iOS restricts background web-based code, and that Obsidian's Capacitor basis makes background sync hard. Community members describe always-in-sync background sync as out of reach without changes in iOS. These are user statements; no staff statement was found. — [Forum: Make Obsidian Sync work in background (on Mobile)](https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906)
- On 2025-11-16 a user reported that quick notes on iOS/iPadOS are lost when the user locks the device or switches apps before Sync finishes. The user asked Obsidian to adopt `BGContinuedProcessingTask` (iOS/iPadOS 26) for Sync. No staff reply was shown, and nothing shows that it was implemented. — [Forum post #100](https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906/100)
- Remotely Save documents: "Auto sync only works when Obsidian is being opened" and cannot run in the background. In auto-sync and sync-on-save modes, errors "fail silently". — [Remotely Save README](https://raw.githubusercontent.com/remotely-save/remotely-save/master/README.md)
- Self-hosted LiveSync's lifecycle module listens for `visibilitychange` on `activeDocument` and for `focus`/`blur` on the window. On hide, it commits pending file events and then suspends replication. On show, it resumes, and in LiveSync mode it first tears down the continuous replication channel, because a channel can be "stalled-but-not-terminated". Its "keep replication active in background" option is explicitly gated off on mobile (`!this.services.API.isMobile()`). — [LiveSync ModuleObsidianEvents.ts](https://github.com/vrtmrz/obsidian-livesync/blob/6412dd6d6bad877b98d1aa61690698a4a50f6c87/src/modules/essentialObsidian/ModuleObsidianEvents.ts)
- The LiveSync settings doc says that keeping replication active in the background is "Desktop only; uses more battery and network". Its sync triggers are: startup ("Sync all files when opening Obsidian"), save, file open, periodic interval, and continuous LiveSync. — [LiveSync settings.md](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/docs/settings.md)
- Relay (a Yjs-based real-time sync plugin) registers `visibilitychange` and flushes its pending outbound batch when the page is visible again. Its comment says: "While the page is hidden, the PostOffice delivery timer can be throttled or suspended". — [Relay main.ts](https://github.com/No-Instructions/Relay/blob/f0a137da1e02efd3ae39b726344cdefe1d65efb7/src/main.ts)
- Apple DTS states that background networking works only while the app is not suspended ("once suspended, all bets are off"). Background-task extensions give only a short time. Continuous background running is limited to user-visible modes such as audio and location. — [Apple Developer Forums thread 750136](https://developer.apple.com/forums/thread/750136)
- On an iPhone 17 Pro, a user reported crashes when Obsidian is sent to the background. Support asked them to test with plugins disabled. — [Forum: crashes when sent to background on iPhone 17 Pro](https://forum.obsidian.md/t/obsidian-repeatedly-crashes-when-sent-to-the-background-on-iphone-17-pro/116857)

### Inferences
- Treat `document.visibilitychange` (registered with `this.registerDomEvent`) as the de facto "resume/pause" hook. On `hidden`, flush the journal and persist state synchronously and briefly. On `visible`, run a reconciliation scan and reconnect.
- Never rely on the `quit` event, or on a timer that fires while the app is in the background. Design every write and upload to be idempotent and resumable: write a journal entry before you act, then commit.
- After any foreground return, assume that WebSockets and timers may be dead without any error. Use heartbeat- or timeout-driven reconnection; do not wait for a `close` event.
- Do the expensive startup work (full scan, hashing) after `workspace.onLayoutReady`, and spread it across frames, so it does not slow Obsidian's mobile launch.

### Gaps
- No official Obsidian documentation states how long iOS lets Obsidian's JS run after it goes to the background (the `beginBackgroundTask` grace period). Whether Obsidian requests that time for plugins is undocumented.
- No public API exposes `BGContinuedProcessingTask`, background fetch, or push-triggered wake-up for plugins. Nothing indicates that this is planned.

---

## 2. Networking: requestUrl vs fetch, CORS, binary, streaming, WebSocket, TLS/headers

### Takeaway
`requestUrl` is the CORS-free HTTP path on all platforms. It supports custom headers and `string | ArrayBuffer` bodies, but it buffers the whole response. It has no streaming, no progress, no abort, and no timeout parameter. `fetch` streams, but on mobile it is subject to CORS from the `capacitor://localhost` (iOS) or `http://localhost` (Android) origin. Design the server so that it sends correct CORS headers for those origins (and for `app://obsidian.md`), or use only bounded-size `requestUrl` calls. WebSockets work on iOS (Relay uses them), but they die on suspend.

### Cited Findings
- `requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise`. `RequestUrlParam` has only these fields: `url`, `method?`, `contentType?`, `body?: string | ArrayBuffer`, `headers?: Record<string,string>`, and `throw?: boolean` ("Whether to throw an error when the status code is 400+. Defaults to `true`"). There is no timeout, signal, or progress field. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- `RequestUrlResponse` exposes `status`, `headers`, `arrayBuffer`, `json`, and `text`. The whole body is available only as complete buffers. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- A forum feature request (Aug 2024 – Mar 2026) says: "It's not currently possible to stream a CORS http fetch result made with request() and requestUrl()". On mobile these are the only CORS-free options. Desktop workarounds (`node-fetch`, Node `http`) do not work on mobile. As of the last post (2026-03-10), no change and no staff reply had appeared. — [Forum: Support streaming the request() and requestUrl() response body](https://forum.obsidian.md/t/support-streaming-the-request-and-requesturl-response-body/87381)
- Remotely Save's CORS doc says that `requestUrl` (desktop 0.13.25+, mobile 1.1.1+) lets plugins "fully bypass the CORS issue". For plain `fetch`, the server must return `Access-Control-Allow-Origin` for `app://obsidian.md`, `capacitor://localhost`, and `http://localhost`. (The doc is from 2022; the version numbers are old but the origins are still relevant.) — [remotely-save docs/browser_env_cors.md](https://gitea.astro-vps.duckdns.org/bruno/remotely-save/src/branch/master/docs/browser_env_cors.md)
- Capacitor apps have the origin `capacitor://localhost` on iOS and `http://localhost` on Android. — [Ionic CORS FAQ](https://ionicframework.com/docs/faq/cors)
- LiveSync: "Only Secure (HTTPS) connections can be used on Obsidian Mobile" for CouchDB and Object Storage endpoints. Its option to use Obsidian's "internal API" for object storage "might break in future Obsidian versions". — [LiveSync settings.md](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/docs/settings.md)
- Relay uses a WebSocket provider adapted from `y-websocket` on all platforms, iOS included. It has a `messageReconnectTimeout = 30000` (reconnect if no message for 30 s) and exponential, jittered reconnect backoff from 300 ms up to 30 s. A connection counts as stable after 30 s. — [Relay client/provider.ts](https://github.com/No-Instructions/Relay/blob/f0a137da1e02efd3ae39b726344cdefe1d65efb7/src/client/provider.ts)
- Relay disables its `online`/`offline` connectivity monitoring on iOS: "iOS health probes must not control sync connectivity" (`monitorConnectivity: !Platform.isIosApp`). — [Relay main.ts](https://github.com/No-Instructions/Relay/blob/f0a137da1e02efd3ae39b726344cdefe1d65efb7/src/main.ts)
- Apple: networking stops when the app is suspended. — [Apple Developer Forums thread 750136](https://developer.apple.com/forums/thread/750136)

### Inferences
- Use `requestUrl` for control-plane JSON and for small or medium blobs. Because there is no timeout, wrap each call in `Promise.race` with your own timer. You cannot abort the underlying request; you can only ignore its result.
- For large attachments, upload and download in chunks of a bounded size (for example 1–8 MB per request) to limit peak memory, because every `requestUrl` response is fully buffered. Pair the chunks with resumable upload semantics on the server.
- If you need streaming or a WebSocket from mobile, the server must allow the `capacitor://localhost` and `http://localhost` origins (WebSocket handshakes send `Origin` too). Use WebSockets only as a "something changed" notification channel. Keep the actual transfer on request/response with resumable state.
- On iOS, do not trust `navigator.onLine` or `online`/`offline` events (Relay's experience). Use your own heartbeat.
- Custom TLS (self-signed certificates, client certificates, pinning) cannot be set through `requestUrl`. Plan for publicly trusted certificates.

### Gaps
- No official statement exists on maximum `requestUrl` request or response size, or on its default timeout, on iOS.
- No primary source says whether `requestUrl` on iOS uses the native HTTP stack (CapacitorHttp/URLSession) or the WebView. This affects cookie handling and HTTP/2 behavior.
- No primary source was found on WebSocket reliability metrics on iOS Obsidian beyond Relay's code comments.

---

## 3. Vault APIs: Vault vs DataAdapter, events, binary I/O, timestamps, hidden folders, Unicode/case, paths

### Takeaway
Use `Vault` for indexed files (cached, serialized, emits events). Use `vault.adapter` for anything under `configDir` (`.obsidian`) or other dot-paths, which are not indexed and do not emit vault events. Treat vault events as hints, not as a source of truth: they fire for every file at startup, they can be wrong around Unicode normalization (a 2026 regression), and external changes on iOS may not show up until restart. Always reconcile with a scan that compares `stat` and hashes. Obsidian normalizes vault paths to NFC, but files on disk can be NFD.

### Cited Findings
**APIs and guidance**
- Guidelines: "Prefer the Vault API over the Adapter API". Vault "has a caching layer that can speed up file reads" and "performs file operations serially" to avoid race conditions. — [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- `Vault.configDir`: "This value is typically `.obsidian` but it could be different." Do not hard-code `.obsidian`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Vault methods (d.ts): `read` ("directly from disk. Use this if you intend to modify"), `cachedRead`, `readBinary`, `create`/`createBinary` ("@throws Error if file already exists"), `modify`, `modifyBinary`, `append`, `appendBinary` (`@since 1.12.3`), `process` (`@since 1.1.0`, "Atomically read, modify, and save the contents of a note"), `copy` (`@since 1.8.7`), `trash(file, system)`, `delete`, `rename`, `getFileByPath`/`getFolderByPath` (`@since 1.5.7`), and `getAllFolders` (`@since 1.6.6`). — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- DataAdapter methods: `stat` (`@since 0.12.2`), `exists`, `list` ("non-recursive"), `read`/`readBinary`, `write`/`writeBinary`, `append`, `appendBinary` (`@since 1.12.3`), `process` (atomic text read-modify-write), and `trashSystem` ("can fail if the system trash is disabled"). `CapacitorAdapter.getFullPath` and `FileSystemAdapter.getFullPath`/`getBasePath` return absolute paths. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Use `vault.rename` for a plain move. `FileManager.renameFile` also updates links ("To ensure links are automatically renamed, use FileManager.renameFile instead"). — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Guidelines: do not use `getFiles().find(...)` ("inefficient, especially for large vaults"). Use `getFileByPath`. — [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- New in 1.14.4: `TExternalFile extends TFile`, which "Represents a file that is outside the Vault. Can be used with the vault API just like any other file. Do not create these manually." It has `getRealPath()`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

**Timestamps**
- `TFile.stat: FileStats` has `ctime` and `mtime` ("unix timestamp, in milliseconds") and `size`. `adapter.stat()` returns `Stat {type, ctime, mtime, size}`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- `DataWriteOptions { ctime?, mtime? }` can be passed to `create`, `modify`, `process`, `append`, `write`, and the binary variants, so a sync plugin can preserve the remote mtime when it writes: "Omit this if you want to keep the default behavior." — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Remotely Save warns that some `.obsidian` config files get a new mtime every time Obsidian opens. This breaks mtime-based sync of config. — [Remotely Save README](https://raw.githubusercontent.com/remotely-save/remotely-save/master/README.md)

**Events**
- Vault events: `create` (also fired for every existing file at vault load, unless you register it in `onLayoutReady`), `modify`, `delete`, and `rename(file, oldPath)`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- `Plugin.onExternalSettingsChange()` (`@since 1.5.7`): "Called when the `data.json` file is modified on disk externally from Obsidian. This usually means that a Sync service or external program has modified the plugin settings." The manifest `id` must match the plugin folder name, or this callback is not called. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts); [Manifest docs](https://docs.obsidian.md/Reference/Manifest)
- Hidden and config files: LiveSync detects changes under `.obsidian` with **scans** ("Scan for hidden files before replication", periodic scan interval). It does not use vault events for them. Its hidden-file sync is "a separate feature with different setup, selection, and conflict behaviour". — [LiveSync settings.md](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/docs/settings.md)
- Remotely Save skips files and folders that start with `.` or `_` by default. It calls `.obsidian` sync "experimental". — [Remotely Save README](https://raw.githubusercontent.com/remotely-save/remotely-save/master/README.md)
- Desktop watcher regression (Aug 2026): in 1.13.5/1.13.6, editing a note whose name is NFD on disk made it vanish from the vault index (the plugin-visible equivalent is a `delete`). Per the reporter, FSEvents gives the raw NFD name, the listing is NFC-normalized, and the existence check compared the two. A directory mtime change on an NFD-named folder dropped the whole subtree from the index. A forum responder (WhiteNoise) said it "will be fixed 1.13.7". 1.13.4 was unaffected. The root-cause analysis is the reporter's reading of minified code. — [Forum bug report (2026-08-11)](https://forum.obsidian.md/t/macos-notes-with-nfd-normalized-filenames-disappear-from-file-explorer-and-search-when-edited-regression-in-1-13-5-1-13-6-watcher-existence-check-compares-raw-nfd-event-name-against-nfc-normalized-listing/117189)
- External changes on iOS: users report that a Shortcuts edit to an iCloud `.md` file was not reflected in Obsidian iOS until workarounds were applied. Settings changed externally by iCloud "don't take effect until the app restarts". When Obsidian launches an iCloud vault, it asks iCloud for all files, which then triggers downloads of offloaded files. These are user reports. — [Forum: Shortcut edits not reflected on mobile](https://forum.obsidian.md/t/apple-shortcut-to-capture-text-by-editing-md-files-directly-not-reflected-in-mobile-vault-instantly-avaiable-on-laptop/98225); [Forum: iOS app not communicating with macOS](https://forum.obsidian.md/t/obsidian-ios-app-not-communicating-with-macos-desktop-app/73873); [davep blog](https://blog.davep.org/2023/08/10/i-turned-it-off-and-on-again.html)

**Unicode, case, and paths**
- `normalizePath()` "uses forward slashes, removes duplicate, leading and trailing slashes, replaces non-breaking spaces with regular spaces, and applies Unicode NFC normalization". The guidelines require it for user-defined and constructed paths. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts); [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- Obsidian indexes paths as NFC. Files that Obsidian creates get NFC names. Files from Terminal, git, other tools, or HFS+-era volumes are often NFD. Default macOS APFS is case-insensitive, so an NFC lookup resolves to the NFD file on disk. — [Forum bug report](https://forum.obsidian.md/t/macos-notes-with-nfd-normalized-filenames-disappear-from-file-explorer-and-search-when-edited-regression-in-1-13-5-1-13-6-watcher-existence-check-compares-raw-nfd-event-name-against-nfc-normalized-listing/117189)
- Older APFS documentation (2017): iOS has always used a case-sensitive filesystem (HFSX, then APFS from iOS 10.3). macOS defaults to case-insensitive APFS. Case-insensitive APFS is "normalization-preserving, but not normalization-sensitive". Apple later added native normalization to case-sensitive APFS. **This is dated; current defaults were not re-verified.** — [Eclectic Light (2017)](https://eclecticlight.co/2017/04/05/file-problems-in-ios-10-3-and-macos-10-13-whats-in-a-name/); [mjtsai: APFS Native Normalization (2017)](https://mjtsai.com/blog/2017/06/27/apfs-native-normalization)
- LiveSync's handling: new vaults use case-insensitive path identity, and a case-only rename is synced as a rename. "Changing the letter case of a directory name is not supported". An opt-in "Unicode NFC path identity" mode makes composed and decomposed paths the same file, but it "currently supports CouchDB only" and needs a coordinated rebuild. — [LiveSync settings.md](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/docs/settings.md)
- Another sync engine's test suite notes that the same visible filename in two normalization forms becomes a permanent duplicate on both sides when sync is not normalization-aware. — [@filen/sync unicode-normalization test](https://cdn.jsdelivr.net/npm/@filen/sync@0.3.6/tests/scenarios/ad-unicode-normalization.test.ts)

### Inferences
- Use NFC plus a case-folded form as the canonical sync key. Store the actual on-disk name separately. Detect collisions where two files on the case-sensitive iOS side map to one key on the case-insensitive macOS side, and surface them; do not let one overwrite the other.
- Do a case-only rename as a two-step rename (to a temp name, then to the final name) so it works on case-insensitive macOS.
- Event-driven sync must be backed by a full reconciliation pass on startup (after `onLayoutReady`), on every foreground return, and periodically. Compare `{size, mtime}` first and hash only the files that differ.
- Use `adapter.list` recursion plus `adapter.stat` for `configDir` and other dot-folders, and make config sync opt-in per file class. Some config files (`workspace.json` and others whose mtime changes on every launch) should be excluded by default.
- Set `mtime` from remote metadata with `DataWriteOptions` when you write, so the next scan does not see your own write as a local edit. Also keep an "own-write suppression" set keyed by path and hash, because the `modify` events from your own writes still fire.

### Gaps
- No official source documents whether Obsidian iOS runs a live file watcher. It is unknown whether changes by other apps or iCloud while Obsidian is foregrounded generate `modify` events, or are seen only at the next launch or rescan.
- No official maximum path length or filename character rules for Obsidian were found. OS limits and Obsidian's forbidden characters were not verified in this pass.
- No source confirms whether the 1.13.7 fix shipped exactly as described. Staff only stated the intent.

---

## 4. Detecting user edits and applying remote changes safely to open files

### Takeaway
An open editor holds a buffer that is not yet saved. If a file changes on disk under an open editor, Obsidian auto-merges, which has caused user-visible data loss. For a file that is open in an editor, apply remote changes through the `Editor` API (minimal `transaction`/`replaceRange` diffs). For files that are not open, use `vault.process`. Never call `vault.modify` on a file the user is typing in.

### Cited Findings
- Guidelines: to change the active note, use the Editor interface instead of `Vault.modify()`. Editor "maintains information about the active note" (cursor, folds), and `Vault.modify()` discards this. For files that are not open, use `Vault.process` ("modifies the file atomically"). Use `FileManager.processFrontMatter` for frontmatter. — [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- `Editor.transaction(tx: EditorTransaction, origin?: string)` (`@since 0.13.0`) is the batched editor-change API. `workspace.activeEditor` exposes the `editor` and `file` for Markdown and canvas embeds (since v1.1.1). — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts); [API changelog v1.1.1](https://github.com/obsidianmd/obsidian-api/blob/master/CHANGELOG.md)
- Custom views have `requestSave: () => void` ("call `this.requestSave()` when the content is changed"). This shows that editor content reaches disk through a debounced save. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Obsidian 0.11.6 introduced auto-merge: "When a change is made to a note on disk, but you also have changes in Obsidian that hasn't been auto-saved (within 2 seconds), the two versions will now be merged automatically." — [Changelog desktop v0.11.6 (2021)](https://obsidian.md/changelog/2021-03-09-desktop-v0.11.6/)
- Users report that auto-merge ("has been modified externally, merging changes automatically") silently wipes data, and they ask for a toggle. Causes include sync services and plugins that write frontmatter while the user types. A plugin developer advised not writing to a file the user is actively editing. — [Forum: toggle to disable automatic merging](https://forum.obsidian.md/t/editor-add-a-toggle-to-disable-automatic-merging-of-changes-non-obsidian-sync/14874/); [Forum: Notes self-deleting / merged automatically](https://forum.obsidian.md/t/notes-self-deleting-aka-modified-externally-merged-automatically-pop-up/87814); [Forum: has been modified externally](https://forum.obsidian.md/t/has-been-modified-externally-merging-changes-automatically/111594)
- Edits can exist only in memory and never reach disk. Closing within about 1 s of typing has produced zero-byte or lost files (user reports, with staff acknowledgement that quick close can lose data). — [Forum: 0 byte file again](https://forum.obsidian.md/t/0-byte-file-again-note-completely-destroyed/30000/38)
- Relay is Yjs-based: its WebSocket provider is "Adapted from y-websocket", and it has a `merge-hsm` integration module. How exactly it binds CRDT state to the CodeMirror editor was not inspected in this pass. — [Relay client/provider.ts](https://github.com/No-Instructions/Relay/blob/f0a137da1e02efd3ae39b726344cdefe1d65efb7/src/client/provider.ts); [Relay merge-hsm/integration](https://github.com/No-Instructions/Relay/blob/f0a137da1e02efd3ae39b726344cdefe1d65efb7/src/merge-hsm/integration/index.ts)
- LiveSync offers "Sync on file open" ("Forces the file to be synced when opened") and commits pending file events before suspending on hide. — [LiveSync settings.md](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/docs/settings.md); [LiveSync ModuleObsidianEvents.ts](https://github.com/vrtmrz/obsidian-livesync/blob/6412dd6d6bad877b98d1aa61690698a4a50f6c87/src/modules/essentialObsidian/ModuleObsidianEvents.ts)

### Inferences
- Decision rule for incoming remote content for path P:
  1. Find every open `MarkdownView` whose `file.path === P`, using `workspace.getLeavesOfType('markdown')` or iterating with `iterateAllLeaves`. Deferred leaves may not be loaded (see §8).
  2. If P is open, compute a 3-way merge (base = last synced version, local = `editor.getValue()`, remote). Apply the result as minimal `editor.transaction({changes: [...]})` diffs so the cursor and undo history survive. Let Obsidian's normal save persist the result.
  3. If P is not open, use `vault.process(file, fn)` and run the 3-way merge inside `fn`, with `mtime` set from remote metadata.
- For a pending local upload, wait until the editor buffer is flushed: debounce more than 2 s after the last `modify` or `editor-change`, and then read with `vault.read` (not `cachedRead`).
- Also flush on `visibilitychange: hidden`, because iOS may suspend the app at any moment after that.

### Gaps
- No official documentation describes the internal debounce for editor-to-disk saves in current versions (the 2-second figure is from 2021), or the exact behavior of `vault.modify`/`process` when the target file is open in a dirty editor.
- No official API exposes a "dirty" flag for an open `MarkdownView` buffer.

---

## 5. Performance for large vaults and attachments on mobile: hashing, memory, IndexedDB/localStorage, loadData/saveData

### Takeaway
On mobile, every file read loads the whole file into memory (no streaming or range reads). There are known crashes and hangs at about 50 MB per file and with tens of thousands of files. Hash with Web Crypto (`crypto.subtle`), which established mobile sync plugins use, but bound the file size and the concurrency. Store sync state in IndexedDB (the localforage/PouchDB pattern), not in `data.json`. Use `App.saveLocalStorage` only for small per-vault flags.

### Cited Findings
- Remotely Save: "Obsidian API on Mobile has performance issues syncing large files (>= 50 MB)". It offers a "Skip Large Files" option. — [Remotely Save README](https://raw.githubusercontent.com/remotely-save/remotely-save/master/README.md)
- A forum request says that on mobile (Capacitor, no Node) plugins cannot stream files. `readBinary` reads the whole file, and "memory usage surges and Obsidian crashes". It proposes a byte-range `readBinary` and notes that `appendBinary` (1.12.3) now allows partial writes. — [Forum: Add API support for reading and writing binary by chunks or streaming](https://forum.obsidian.md/t/add-api-support-for-reading-and-writing-binary-by-chunks-or-streaming/77384)
- `appendBinary(file|path, data: ArrayBuffer, options?)` exists on `Vault`, `DataAdapter`, and `CapacitorAdapter` (`@since 1.12.3`). This enables chunked **writes** of large downloads. No byte-range **read** API exists in d.ts. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Android bug (Obsidian Mobile 1.10.5, reported 2025-11-30): a single `adapter.writeBinary` of a 50 MB buffer never resolved, and the file kept growing in 50 MB steps. A forum responder asked "Is this still happening?" on 2026-02-19, and no resolution is shown. iOS was not tested. — [Forum: writeBinary on large files never resolves](https://forum.obsidian.md/t/obsidian-mobile-android-adapter-writebinary-on-large-files-never-resolves-and-repeatedly-appends-data/108554)
- iOS crash loop with about 35k files (Obsidian 1.10.6, iOS 26.1, 2026-01-06). The reply: "There is no hardcoded threshold". Causes can be a single note that breaks the parsers, or the total size of notes and links exceeding the memory iOS allows. The suggestion was to look for Markdown notes over 50 KB. — [Forum: iOS crash loop past 30k files](https://forum.obsidian.md/t/ios-obsidian-app-crash-loop-once-passing-30k-files/109666)
- Android users asked for `largeHeap` to avoid OOMs. Others reported crash loops on startup attributed to indexing OOM. — [Forum: Enable largeHeap on Android](https://forum.obsidian.md/t/enable-largeheap-in-obsidian-android-app-to-avoid-ooms/108119); [Forum: crash at startup (indexing OOM)](https://forum.obsidian.md/t/obsidian-crash-at-startup-and-restart-loop-likely-indexing-parser-oom/104351)
- Remotely Save (which supports mobile) uses `window.crypto.subtle` (`importKey`, `deriveBits`, `encrypt`, `decrypt`) for its OpenSSL-compatible encryption. It stores sync state in IndexedDB through `localforage.createInstance` tables (version table, sync plans, previous sync records, file history, and others). — [remotely-save encryptOpenSSL.ts](https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/encryptOpenSSL.ts); [remotely-save localdb.ts](https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/localdb.ts)
- `Plugin.loadData()`/`saveData()` read and write `data.json` "in the plugin folder" (that is, under `configDir/plugins/<id>/`). The whole object is serialized on each save. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- `App.loadLocalStorage(key)`/`saveLocalStorage(key, data)` (`@since 1.8.7`): "Retrieve value from `localStorage` for this vault" / "Save vault-specific value to `localStorage`. If data is `null`, the entry will be cleared." — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- LiveSync has a "Maximum file size" setting (larger files are skipped in both directions), configurable chunk sizes, and on-demand chunk fetch to cap local storage and memory. — [LiveSync settings.md](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/docs/settings.md)
- Guidelines: do not iterate all files to find one (`getFiles().find`). — [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)

### Inferences
- `crypto.subtle.digest('SHA-256', buf)` needs the whole buffer, so you cannot do incremental SHA-256 of a huge file with Web Crypto. Two options: (a) hash files below a size cap in one call, and for larger files use `{size, mtime}` plus a content hash computed once and cached; or (b) use an incremental WASM or JS hash (BLAKE3/xxhash) over the full buffer you already hold. Keep at most one large buffer alive at a time.
- Use a per-file cap (default about 50 MB on mobile, configurable) and a sequential queue for large files on mobile. For downloads, write in pieces with `createBinary` (first chunk) plus `appendBinary` (≥ 1.12.3) to avoid holding a whole file plus copies in memory.
- Keep the sync index (path → hash, mtime, size, remote version) in IndexedDB, namespaced by vault (e.g., using `app.appId` or a vault-random ID). Do not put it in `data.json`: the file is rewritten whole and lives in `.obsidian`, which other sync tools may copy. That causes cross-device state corruption.
- Batch the initial scan (yield every N files) to avoid watchdog kills and UI jank on iOS.

### Gaps
- No primary source gives the iOS WKWebView per-process memory limit as it applies to Obsidian, or IndexedDB quota and eviction behavior for Obsidian iOS. (WebKit can evict storage under pressure; this is not verified for Capacitor apps in this pass.)
- No benchmark of `crypto.subtle.digest` throughput on iOS Obsidian was found.
- No source confirms whether `getResourcePath` plus `fetch` with a `Range` header gives partial reads on mobile. This is a possible workaround, but it is unverified.

---

## 6. Distribution: BRAT, manifest, isDesktopOnly, community directory submission and review policy, updates

### Takeaway
In May 2026 Obsidian moved to a new **Community directory** (community.obsidian.md) with automated security and quality review of **every version**, malware scanning, public scorecards, and planned capability declarations ("network, file system, clipboard"). The developer policies ban client-side telemetry, obfuscation, and self-updating, and they require README disclosure of network use, accounts, and payments. Releases still come from GitHub. BRAT works on mobile for beta installs.

### Cited Findings
- Manifest fields: `id` ("only lowercase letters and hyphens, can't end with `plugin`, and can't contain `obsidian`"; it must match the folder name, or `onExternalSettingsChange` is not called), `name`, `version` (x.y.z SemVer), `minAppVersion` (required), `description`, `author`, `authorUrl`, `fundingUrl`, and `isDesktopOnly` (required; "for example because it uses NodeJS or Electron APIs"). — [Manifest reference](https://docs.obsidian.md/Reference/Manifest)
- Setting `isDesktopOnly: true` prevents installation on mobile. — [Mobile development docs](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- Developer policies (apply to directory-listed plugins). Plugins must not: "Obfuscate code to hide its purpose", "Include client-side telemetry", "Install or update themselves or their dependencies", insert dynamic ads loaded over the internet, or put static ads outside their own UI. They must disclose in the README: required payment, a required account, "Network use. Clearly explain which remote services are used and why they're needed", access to files outside the vault, server-side telemetry (with a privacy-policy link), and closed-source code (handled "on a case by case basis"). They must include a LICENSE. Forks need permission from the original author. Removal can be immediate for malicious, uncooperative, or repeat cases. — [Developer policies (Community directory)](https://docs.obsidian.md/Community+directory/Developer+policies)
- The "future of Obsidian plugins" post (2026-05-12) says: "The new automated review system scans every version for security and code quality, not just the initial submission". This "includes malware scanning". It checks that "the source code follows best practices, and that it is free of known vulnerabilities". "Users and developers can see the status of automated checks with scorecards on every project". "Plugins will declare what they access: network, file system, clipboard, and other capabilities". "Users will be able to see these disclosures before installing". Scorecards will add "disclosures, privacy labels, artifact attestation, manual review results". FAQ: "You can continue to release new versions via GitHub without using the new developer dashboard". A GitHub login is required "For now". There is a local ESLint plugin check and a dashboard preview scan on "any branch, tag, or commit". — [Obsidian blog: The future of Obsidian plugins](https://obsidian.md/blog/future-of-plugins/)
- Secondary coverage: about 2,300 queued submissions were processed at launch. Manual review continues for popular plugins, featured plugins, and plugins the community flags. — [GIGAZINE (2026-05-13)](https://www.gigazine.net/gsc_news/en/20260513-obsidian-plugin-future); [NeuronFeed](https://neuronfeed.com/news/obsidian-launches-ai-powered-plugin-review-system-after-120-million-downloads)
- Plugin guidelines that a reviewer or linter will check: use `this.app`, not the global `app`; show only errors in the console by default; no `innerHTML`/`outerHTML`/`insertAdjacentHTML` with user input; no default hotkeys; sentence-case UI; `registerEvent` for cleanup; do not detach leaves in `onunload`. — [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- BRAT: you add a GitHub repo path, it downloads updates and reloads the plugin, and it can auto-update at startup. It is listed as mobile-compatible. BRAT 1.1.3 improved handling of GitHub rate limits and supports a read-only PAT, including for private repositories. — [BRAT README](https://raw.githubusercontent.com/TfTHacker/obsidian42-brat/main/README.md); [tfthacker.com/BRAT](https://tfthacker.com/BRAT); [BRAT in Obsidian Hub](https://publish.obsidian.md/hub/02+-+Community+Expansions/02.05+All+Community+Expansions/Plugins/obsidian42-brat); [BRAT on community.obsidian.md](https://community.obsidian.md/plugins/obsidian42-brat)

### Inferences
- obsy must ship `isDesktopOnly: false` and must avoid every Node/Electron import in the shared bundle. Desktop-only code paths must be behind `Platform.isDesktopApp` and lazy `require`.
- Set `minAppVersion` according to the features you need: `1.11.4` if you use SecretStorage (§7), `1.12.3` if you use `appendBinary` for chunked downloads. A realistic floor for late 2026 is ≥ 1.12.3.
- The README must disclose the sync server and why it is needed, the account requirement, any payment, and any server-side logging (with a privacy policy link). There must be no client-side analytics, the bundle must not be minified to the point of obfuscation, and the plugin must not download and run code or update itself (for example, no remote WASM fetched at runtime).
- Expect the future capability declaration to need "network" and "file system" (and possibly access outside the vault). Track the manifest schema for a new capabilities field.
- For beta distribution, publish GitHub releases with `main.js`, `manifest.json`, and `styles.css` as assets, and install them with BRAT on both macOS and iOS. Testers on iOS need BRAT installed from the directory first.

### Gaps
- The submission-requirements page URL returned 404 (it moved under "Community directory"). The exact current list of submission requirements and the ESLint rule set (presumably `eslint-plugin-obsidianmd`) were not fetched.
- Details of BRAT's required release assets, prerelease handling, and frozen-version handling were not retrieved; the docs pages fetched were summaries only.
- How Obsidian picks a compatible older version for users below `minAppVersion` (`versions.json`) is not covered in the manifest docs that were fetched.

---

## 7. Security: storing auth tokens (data.json syncs via .obsidian), SecretStorage

### Takeaway
`data.json` is plaintext inside `.obsidian`, and iCloud, Obsidian Sync, git, or obsy itself can copy it. Do not store tokens there. Since **1.11.4** (2026-01-07), `app.secretStorage` gives a per-device, per-vault (on desktop) secret store, and `SecretComponent` gives a settings UI for it. Treat it as device-local, not synced, and with ambiguous vault scoping on mobile.

### Cited Findings
- `App.secretStorage: SecretStorage` (`@since 1.11.4`). `SecretStorage extends Events` provides `setSecret(id, secret)` ("Lowercase alphanumeric ID with optional dashes"; "@throws Error if ID is invalid"), `getSecret(id): string | null`, and `listSecrets(): string[]`. The methods are synchronous. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- `SecretComponent` (`@since 1.11.1`; `setValue` and `onChange` `@since 1.11.4`) has the constructor `(app, containerEl)`. A secret setting-definition type `'secret'` exists from 1.13.2. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Changelog 1.11.4 (desktop, 2026-01-07): "Exposed new SecretStorage and a complementary SecretComponent"; "a new opt-in way for plugins to save keys that might be shared across multiple plugins"; plugins "fetch keys from a shared collection of secrets identified by a user-provided name". — [Obsidian changelog desktop v1.11.4](https://obsidian.md/changelog/2026-01-07-desktop-v1.11.4)
- Official guide: "The actual secret is stored in local storage, keyed to the specific vault". Avoid storing secrets in `data.json` (it is saved in plaintext). Store only the secret's **name** in settings, call `getSecret` at the point of use, and handle `null`. The guide does not mention the OS keychain. — [Secret storage guide](https://docs.obsidian.md/plugins/guides/secret-storage)
- A third-party research note claims encryption at rest through Electron `safeStorage` (Keychain/DPAPI/libsecret), but flags a forum report that desktop secrets may be in LevelDB/localStorage. **Unverified, and it conflicts with the official guide's "local storage" wording.** — [ProfSynapse research note (glama.ai)](https://glama.ai/mcp/servers/@ProfSynapse/nexus/blob/bf2568926b4189b17ae06a7141c3a4a655f74634/docs/preparation/obsidian-secrets-api-research.md); related: [Forum: Linux system secret storage](https://forum.obsidian.md/t/how-does-obsidian-linux-find-system-secret-storage/113465)
- Reported on 2026-08-29 (no staff reply yet): on mobile, secrets with the same name appear to be **shared across vaults**, but they are vault-scoped on desktop. Setting `test-secret` in vault B changed the value read in vault A. — [Forum: SecretStorage shared across vaults on mobile](https://forum.obsidian.md/t/secretstorage-appears-to-be-shared-across-vaults-on-mobile-but-vault-scoped-on-desktop/117793)
- A plugin changelog states that SecretStorage values are not synchronized between devices (secondary source). — [obsidian-gemini-helper 1.21.0 release notes](https://newreleases.io/project/github/takeshy/obsidian-gemini-helper/release/1.21.0)
- Remotely Save warns that `data.json` "contains sensitive information" and should not be shared or committed. — [Remotely Save README](https://raw.githubusercontent.com/remotely-save/remotely-save/master/README.md)
- `onExternalSettingsChange` exists because `data.json` is commonly changed by sync services. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

### Inferences
- Store obsy device tokens in SecretStorage under a vault-unique ID (for example `obsy-<vaultRandomId>`). This avoids the mobile cross-vault collision. Keep only the secret ID in `data.json`. Require `minAppVersion ≥ 1.11.4`, or fall back to `app.saveLocalStorage` (vault-scoped, not synced, but not encrypted) on older versions.
- Use device-bound credentials (one token per device, revocable on the server), because secrets are not synced and every device pairs separately. That fits the storage model well.
- obsy must exclude its own `data.json` (and any secrets) from config sync. Settings that are meant to be shared should go to a separate, explicitly synced file. Implement `onExternalSettingsChange` to reload them.
- Do not assume that SecretStorage is hardware-backed or encrypted until the storage backend is verified on macOS and iOS.

### Gaps
- No official statement says whether SecretStorage uses Keychain on macOS/iOS, whether it is encrypted, or whether it survives an app reinstall. The cross-vault behavior on mobile is unresolved.
- Whether `SecretStorage` emits change events (it `extends Events`) is not documented.

---

## 8. 2025–2026 API and app changes relevant to sync plugins

### Takeaway
The relevant additions are: per-vault localStorage helpers (1.8.7), `vault.copy` (1.8.7), Bases (1.10), SecretStorage (1.11.4), a CLI handler API (1.12.2), `appendBinary` (1.12.3), the declarative settings API (1.13), and `TExternalFile` (1.14.4). Deferred tabs (since 1.7.2) affect the "find open editors" logic. Bases introduces `.base` files that must be synced as ordinary files.

### Cited Findings
- 1.7.2: tabs are deferred by default. `WorkspaceLeaf#isDeferred`/`loadIfDeferred` were added. `Plugin#onUserEnable` was added. — [API changelog v1.7.2](https://github.com/obsidianmd/obsidian-api/blob/master/CHANGELOG.md)
- 1.8.7: `App.loadLocalStorage`/`saveLocalStorage` and `Vault.copy`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- 1.10.0: the Bases API (`registerBasesView`, `BasesView`, `BasesEntry`, value types, `QueryController`), plus `App.renderContext` and `isDarkMode()`. 1.10.2: `createFileForView`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- 1.11.x: `SettingGroup`-style components (`addSetting`, `addSearch`; 1.11.0), `SecretComponent` (1.11.1), and `SecretStorage` (1.11.4). — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts); [changelog 1.11.4](https://obsidian.md/changelog/2026-01-07-desktop-v1.11.4)
- 1.12.2: `registerCliHandler(command, description, flags, handler)`: "Register a CLI handler to handle a command from the CLI". IDs use the format `<plugin-id>` and `<plugin-id>:<action>`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- 1.12.3: `appendBinary` on `Vault`, `DataAdapter`, and `CapacitorAdapter`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- 1.13.0–1.13.2: declarative settings definitions (`SettingPage`, `SettingDefinition*`, controls such as `text`, `toggle`, `dropdown`, `file`, `folder`, `list`, `page`, plus `'secret'` in 1.13.2), `ConfirmationModal`, and `ConfirmationButton`. — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- 1.14.3: `groupOrder` (frontmatter/Bases). 1.14.4: `TExternalFile` (files outside the vault, usable with the vault API). — [d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- 1.13.5/1.13.6 NFD watcher regression, said to be fixed in 1.13.7 (Aug 2026). — [Forum bug report](https://forum.obsidian.md/t/macos-notes-with-nfd-normalized-filenames-disappear-from-file-explorer-and-search-when-edited-regression-in-1-13-5-1-13-6-watcher-existence-check-compares-raw-nfd-event-name-against-nfc-normalized-listing/117189)
- Mobile 1.13.x changelog items found concern UI (share-sheet template variable, tab swipe-to-close, iOS scroll fixes). No mobile file-system or background-execution changes were found. — [Mobile 1.13.2](https://obsidian.md/changelog/2026-07-14-mobile-v1.13.2/); [Mobile 1.13.4](https://obsidian.md/changelog/2026-07-27-mobile-v1.13.4); [Mobile 1.13.5](https://obsidian.md/changelog/2026-08-05-mobile-v1.13.5/)
- May 2026: the Community directory replaced GitHub-PR submission, with automated review of every version and planned capability declarations (§6). — [Obsidian blog](https://obsidian.md/blog/future-of-plugins/)

### Inferences
- Because tabs are deferred, an open-but-deferred tab has no live editor. Check `leaf.isDeferred` and treat such a leaf as "not open" (safe to use `vault.process`). Re-check when `layout-change` or `active-leaf-change` fires.
- `.base` files (and `.canvas` JSON) are text files that the user edits through custom views, not the Markdown `Editor`. Apply remote changes to them with `vault.process` when they are not focused. Do not assume that `MarkdownView` covers every editable file type.
- The CLI handler (1.12.2) could expose `obsy status` and `obsy sync-now` on desktop for diagnostics and automation.
- `TExternalFile` (1.14.4) is new and lightly documented. Do not depend on it for sync.

### Gaps
- No official 1.12/1.13/1.14 desktop changelog text was retrieved, so the meaning of the CLI feature and of `TExternalFile` is inferred from the typings only.
- Whether a mobile 1.14 build had shipped by October 2026 is not confirmed. Search found mobile releases up to 1.13.7.
