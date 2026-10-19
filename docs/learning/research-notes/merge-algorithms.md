---
title: Research notes: merge algorithms
aliases: [CRDT, three-way merge, diff3, OT]
updated: 2026-10-19
---

# Merge and sync approaches for offline-edited Markdown (multi-device + agent writer), late 2026

Scope: merge/sync techniques for "obsy" (Mac + iPhone Obsidian clients, Cloudflare Worker/Durable Object server, AI agent writing the same Markdown files). Research date: 2026-10-19.

Evidence labels used below:
- **[Source]**: a primary or secondary web source, linked.
- **[npm registry, 2026-10-19]**: values read with `npm view <pkg> version license time.modified` on 2026-10-19.
- **[Local experiment, 2026-10-19]**: small scripts run during this research with git 2.55.0, Node 24.21.0, `@sanity/diff-match-patch` 3.2.1, `node-diff3` 3.2.1, `yjs` 13.6.33. They are observed behaviour for one small input, not benchmarks. Inputs: base = `# Todo\n\n- buy milk\n- call bob\n`; side A appends `- pay rent`; side B appends `- book flight`.

---

## 1. CRDTs for text: maturity, size, performance, history growth, persistence, JS/TS fit (Obsidian plugin incl. iOS WebView + Cloudflare Worker)

### Takeaway
Yjs (MIT, pure JS, about 20 KB min+gz), Loro (MIT, Rust→WASM, 1.x stable format), and Automerge 3 (MIT, Rust→WASM, 10x+ lower memory than v2) are the three mature, maintained options in late 2026. Diamond Types / Eg-walker is the strongest research result but its JS package is stale. json-joy changed to AGPL-3.0 at v18. For a Worker plus an iOS plugin, Yjs is the lightest. Loro and Automerge each add about 1.1 MB gzipped (about 3.4–3.6 MB raw) of WASM.

### Cited Findings

**Current versions and licenses (all checked 2026-10-19)**
- `yjs` 13.6.33, MIT, last modified 2026-09-23. No Yjs v14 release was found. — [npm registry, 2026-10-19]; [Yjs repo](https://github.com/yjs/yjs) ("Yjs and all related projects are MIT licensed")
- `loro-crdt` 1.16.4, MIT, last modified 2026-09-30. — [npm registry, 2026-10-19]; [Loro repo](https://github.com/loro-dev/loro)
- `@automerge/automerge` 3.5.0, MIT, last modified 2026-09-16. — [npm registry, 2026-10-19]
- `diamond-types-web` 1.0.2, license "ISC OR Apache-2.0" on npm, **last modified 2023-05-15** (stale). The README says "ISC license" and calls the project "The world's fastest CRDT. WIP". The cargo package is outdated, and the version "only supports plain text editing". — [npm registry, 2026-10-19]; [diamond-types repo](https://github.com/josephg/diamond-types)
- `json-joy` 18.30.0 is **AGPL-3.0-only**. Versions 16.0.0 and 17.0.0 were Apache-2.0; 18.0.0 onward is AGPL-3.0-only. Secondary listings that still say Apache-2.0 are out of date. — [npm registry, 2026-10-19]; older listing: [libraries.io json-joy 16.0.0](https://libraries.io/npm/json-joy/16.0.0)
- json-joy describes itself as focused on a JSON CRDT protocol. It claims "the fastest list CRDT implementation in JavaScript" and "the fastest text OT implementation in JavaScript" (self-claims, not independent). Its Peritext rich-text work was NLnet-funded as an "early research demo" (2023-02 to 2024-02). — [json-joy npm](https://npmjs.com/package/json-joy); [NLnet JSON-Joy](https://nlnet.nl/project/JSON-Joy/)

**Algorithms and maturity**
- Loro 1.0 was announced 2024-10-23 with a stable data format. The new storage format improves load speed about 10x (one benchmark: 16 ms → 1 ms; 0.37 ms with a shallow snapshot). Its text/list CRDT is based on Fugue. Rich text follows the Peritext criteria. Bindings: Rust, JS (WASM), Swift. — [Loro 1.0 blog](https://loro.dev/blog/v1.0)
- The Loro repo says it adapts Eg-walker from Diamond Types "to reduce computation and space usage". It also offers a "Shallow Snapshot that works like Git shallow clone". — [Loro repo](https://github.com/loro-dev/loro)
- Automerge 3.0 (July 2025) cuts memory "by over 10x" and sometimes much more. Example: pasting Moby Dick used about 700 MB in Automerge 2 and about 1.3 MB in Automerge 3. It keeps the Automerge 2 file format, and the API is "nearly fully backwards compatible". The `Text` class was removed: plain strings are now collaborative text, and `RawString` was renamed `ImmutableString`. — [Automerge 3.0 blog](https://automerge.org/blog/automerge-3/); [migration guide](https://automerge.org/docs/guides/migrating-from-automerge-2-to-automerge-3/)
- Ink & Switch says Automerge 3 keeps history in memory in the compressed columnar on-disk format. They report savings of up to 100x in some cases and much faster loads. — [Ink & Switch Dispatch 011](https://inkandswitch.com/newsletter/dispatch-011)
- Eg-walker (Gentle & Kleppmann, EuroSys 2025, Best Artifact Award) uses "an order of magnitude less memory in the steady state" than existing CRDTs. Loading is "orders of magnitude faster". Merging long-running branches is orders of magnitude faster than OT, and the worst case is comparable to CRDTs. — [arXiv 2409.14252](https://arxiv.org/abs/2409.14252); [Kleppmann publications](https://martin.kleppmann.com/)
- Peritext (Litt, Lim, Kleppmann, van Hardenberg; CSCW 2022) is a rich-text CRDT that stores formatting as marks anchored to characters, separate from the text. It argues that Markdown control characters inside a plain-text CRDT can break intent: in its example, two users concurrently bold "fox" and the merge leaves it non-bold. The only implementation described on the page is a TypeScript prototype on a simplified Automerge. — [Ink & Switch Peritext](https://www.inkandswitch.com/peritext/)

**Yjs API and persistence**
- Y.Text exposes only `insert`, `delete`, `format`, and `applyDelta`. Persistence uses binary updates: `encodeStateAsUpdate`, `encodeStateVector`, `applyUpdate`, `mergeUpdates`, and `diffUpdate` (which works on updates without loading a doc). `doc.gc = false` keeps deleted content so that old versions can be restored. Listed Cloudflare provider: `yjs-cf-ws-provider` (Durable Objects). PartyKit/y-partykit is also listed. — [Yjs repo](https://github.com/yjs/yjs)

**Benchmarks (OLDER data: library versions from 2023–2024)**
- dmonad/crdt-benchmarks, B4 real-world editing trace, latest table on the page (Yjs 13.6.11, ywasm 0.9.3, Loro 0.10.1, Automerge 2.1.10; Node 20.5.0):
  - Yjs: bundle 20,100 B gz, doc 159,929 B, parse 39 ms, mem 3.2 MB.
  - ywasm: 213,833 B gz, parse 16 ms.
  - Loro 0.10.1: 399,276 B gz, doc 258,228 B, parse 13 ms.
  - Automerge 2.1.10: 604,118 B gz, doc 129,116 B, parse 1,805 ms.
  - B4×100: Yjs doc 15.99 MB, mem 327 MB, parse 2.6 s. Loro doc 25.8 MB, parse 1.3 s. Automerge was skipped.
  - These figures predate Loro 1.x and Automerge 3, so they understate current Loro and Automerge performance. — [crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks)
- Measured artifact sizes, 2026-10-19:
  - `loro_wasm_bg.wasm` (loro-crdt 1.16.4): 3,397,123 B raw, about 1,124,329 B gzip -9.
  - `automerge.wasm` (3.5.0): 3,644,225 B raw, about 1,136,563 B gz.
  - `yjs.mjs` 13.6.33 dist (unminified): 300,059 B raw, 62,692 B gz.
  - Source: files downloaded from unpkg and measured locally — [unpkg loro-crdt](https://unpkg.com/loro-crdt@1.16.4/web/loro_wasm_bg.wasm), [unpkg automerge](https://unpkg.com/@automerge/automerge@3.5.0/dist/automerge.wasm)

**Cloudflare Worker constraints (current docs)**
- Worker script size: 64 MiB uncompressed on Free and Paid, with "no compressed size limit". Memory: 128 MB per isolate, including WASM allocations. Global-scope startup: 1 s. — [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### Inferences
- **Worker fit.** All three mature libraries fit the 64 MiB script limit. The 128 MB per-isolate limit is shared by every document a Durable Object holds in memory, so a vault-wide CRDT DO with full history for many notes needs care. Yjs B4×100 used about 327 MB in older benchmarks. One DO per note, or lazy loading, avoids this.
- **iOS fit.** WASM in the Obsidian iOS WebView is plausible: Loro and Automerge ship web builds. But about 1.1 MB gz of WASM adds startup cost on mobile. Pure-JS Yjs is the lowest-risk dependency for an Obsidian mobile plugin.
- **History growth.** CRDT history grows with every edit unless GC or shallow snapshots are used. Loro's shallow snapshot and Yjs `gc=true` trim it, but trimming limits how far back offline peers can merge. For a personal vault with long offline periods, this is a real design tension.
- **Licenses.** Avoid json-joy ≥18 unless AGPL is acceptable. Diamond Types JS is not production-current.

### Gaps
- No fresh 2026 independent benchmark comparing Yjs 13.6.x, Loro 1.16, and Automerge 3.5 was found. The crdt-benchmarks table on the page uses 2023–2024 versions.
- Whether Yjs uses YATA and Automerge uses RGA in their current versions, and whether Diamond Types uses FugueMax, was not confirmed from a primary source in this session.
- No primary evidence was found about WASM startup time inside the Obsidian iOS app specifically.
- Older Cloudflare docs had smaller compressed-size limits (recalled, not re-verified). The current page says 64 MiB uncompressed.

---

## 2. Applying a CRDT to plain files changed outside the CRDT ("diff a new file into the CRDT") and failure modes

### Takeaway
It works only by diffing the old CRDT text against the new file contents and turning the diff into insert/delete operations. Merge quality is then bounded by the quality of that 2-way diff. The most dangerous failure for obsy is **duplicate text**: if two replicas each diff the same external change into the CRDT, the CRDT treats them as two concurrent inserts and keeps both. A wholesale "set text" without a diff also duplicates or bloats content.

### Cited Findings
- **Yjs has no setText.** Y.Text offers only insert/delete/format/applyDelta, so the application must compute the changes itself. Replacing the whole text costs a large update; a diff costs a small one. — [discuss.yjs.dev #2461](https://discuss.yjs.dev/t/does-a-huge-text-with-tiny-changes-overriding-lead-an-entire-document-sync/2461)
- **Whole-string insert duplicates.** A user inserted a new string at index 0 without deleting the old one and got old text followed by new text. — [discuss.yjs.dev #2101](https://discuss.yjs.dev/t/y-text-an-actual-delta-function-that-would-work-with-settext-gettext/2101)
- **Common pattern and ambiguity.** The usual approach is fast-diff → Yjs delta (retain/insert/delete). For repeated strings (`foofoo` → `foofoofoo`), the diff cannot know where the insert happened. It picks a left-to-right answer, not the user's real cursor position. — [discuss.yjs.dev #2358](https://discuss.yjs.dev/t/plain-text-input-component-with-y-text/2358)
- **Loro has built-in diff-in.** `LoroText.update(text)` "will calculate the minimal difference and apply it", using Myers' diff. It "could take a long time for large texts (e.g. > 50_000 characters)", in which case use `updateByLine`, which is "line-based, … more efficient but less precise". — `loro-crdt` 1.16.4 type definitions, [unpkg loro_wasm.d.ts](https://unpkg.com/loro-crdt@latest/web/loro_wasm.d.ts)
- **Automerge has `updateText`.** It is for cases where only the whole new value is available. It works out the changes and converts them to splice operations. — [Automerge text docs](https://automerge.org/docs/reference/documents/text/)
- **Concurrent inserts are all kept.** Automerge guarantees the same order of concurrent inserts at one position on all nodes, and both insertions survive. — [Automerge conflicts docs](https://automerge.org/docs/reference/documents/conflicts/)
- **Diff quality bounds merge quality.** A third-party merge project notes that when only end states are visible, merge quality "depends entirely on the quality of the underlying 2-way diffs". This is a search snippet; the page returned 403 when fetched. — [reconcile (schmelczer)](https://home.schmelczer.dev/git/andras/reconcile)
- **Diff-in plugin example.** The "shared vault" Obsidian plugin records Yjs incremental updates derived from Markdown diffs. If its CRDT cache is missing, it seeds the cache from current file contents. — [shared-vault plugin](https://community.obsidian.md/plugins/shared-vault)
- **Interleaving anomaly.** Several published text algorithms (CRDT and OT) can interleave concurrently inserted text at one position character by character. — [Kleppmann et al., PaPoC 2019](https://martin.kleppmann.com/2019/03/25/papoc-interleaving-anomalies.html)
  - The 2019 errata say its non-interleaving definition cannot be guaranteed by any algorithm, and the Section 3.1 algorithm does not guarantee convergence. — [PaPoC 2019 PDF](https://www.cl.cam.ac.uk/~arb33/papers/KleppmannEtAl-InterleavingAnomalies-PaPoC2019.pdf)
  - Fugue/FugueMax (Weidner & Kleppmann, IEEE TPDS 36(11), Nov 2025) defines "maximal non-interleaving". FugueMax satisfies it, and its performance is comparable to state-of-the-art CRDT libraries. — [arXiv 2305.00583](https://arxiv.org/pdf/2305.00583); [Kleppmann 2025 post](https://martin.kleppmann.com/2025/11/01/fugue-minimizing-interleaving.html)
  - A TU Darmstadt thesis abstract claims that maximal non-interleaving can still interleave when deletions are involved (secondary, unverified). — [TU Darmstadt](https://tuprints.ulb.tu-darmstadt.de/handle/tuda/12137)
- **[Local experiment, 2026-10-19] Yjs duplicates an identical change.** Two Yjs replicas started from the same base. Each inserted the identical line `- pay rent\n` at the end, which simulates both devices independently diffing the same external file change into the CRDT. After the updates were exchanged, the merged text contained `- pay rent` **twice**. — [yjs 13.6.33](https://github.com/yjs/yjs)

### Inferences
- **Echo loop risk for obsy.** A file can reach a device through obsy, iCloud, git, or the agent's own write path. If a device then diffs that file into its CRDT as a new local edit, and another replica already has the same content as CRDT ops, the result is duplicated paragraphs. A diff-in design therefore needs strict provenance. Only one writer may translate a given disk change into ops, and the file's base version must be tracked so that already-known content is not re-inserted. This is the main hidden cost of "CRDT over plain files".
- **Wholesale replacement.** If a file is replaced wholesale (for example, an agent writes a full new note body), a character-level Myers diff can produce fragmented ops. These fragments interleave badly with concurrent edits. Line-level diff-in (Loro `updateByLine`) gives coarser but saner ops for Markdown.
- **Tombstones.** Tombstone and history growth follow from every external rewrite: each full rewrite that the diff cannot align adds deleted items. In Yjs these stay as GC'd tombstone structs; in Loro and Automerge they stay as history unless trimmed.
- **Accepting a CRDT means accepting no conflicts.** CRDTs never surface conflicts; they always produce some merged text. For an agent writer, "silently merged but semantically wrong" is worse than a visible conflict.

### Gaps
- No primary write-up was found on how Relay (System 3) converts on-disk edits into Yjs ops. The repo README does not say.
- No quantitative study of tombstone growth from repeated diff-in of whole-file rewrites was found.

---

## 3. Three-way merge for text: diff3/git merge-file, diff-match-patch, node-diff3, diff algorithms, line vs character granularity, conflict surfacing

### Takeaway
A real three-way merge (base, ours, theirs) is the right primitive for file-level sync. Base-aware merge treats identical changes on both sides as one change. Plain diff3 conflicts on the most common Markdown case for obsy: two writers append different lines at the same spot, such as the agent and the user both adding to a list or a daily note. diff-match-patch's fuzzy patching merges that case cleanly, but it can silently duplicate text when the same edit already exists on the other side. The safest design is line-level diff3 with a small set of Markdown-aware auto-resolutions (for example, union for pure-insert conflicts) and a fallback to visible conflict output.

### Cited Findings
- **git merge-file options.** `git merge-file` supports `--diff3` and `--zdiff3` conflict styles (default from `merge.conflictStyle`). `--diff-algorithm` accepts patience, minimal, histogram, or myers. The default is myers. "histogram" can help avoid mismerges from matching meaningless lines (for example, braces from different functions). — [git-merge-file docs](https://www.kernel.org/pub/software/scm/git/docs/git-merge-file.html)
- **node-diff3 3.2.1 (MIT, modified 2026-06-03).**
  - 3-way functions: `diff3Merge`, `merge` (emits `<<<<<<<`/`=======`/`>>>>>>>`), `mergeDiff3` (adds `|||||||` base sections, "similar to git-diff3"), `mergeDigIn`.
  - 2-way functions: `diffPatch`, `patch`, `invertPatch`.
  - It is LCS-based. String inputs are split on whitespace by default (word-level); pass line arrays for line-level merges.
  - Sources: [node-diff3 repo](https://github.com/bhousel/node-diff3); [npm registry, 2026-10-19]
- **diff-match-patch.**
  - Apache-2.0; the Google repo was archived 2024-08-05.
  - `patch_apply(patches, text1)` applies patches "on a best-effort basis" to text that may not match exactly. It uses fuzzy Match_Distance (default 1000) and Match_Threshold (default 0.5); Patch_DeleteThreshold governs large deletes. It returns `[text2, results]`, and the per-patch boolean results are "not too useful" because large patches are split.
  - Sources: [diff-match-patch repo](https://github.com/google/diff-match-patch); [API wiki](https://github.com/google/diff-match-patch/wiki/API)
- **Maintained fork.** `@sanity/diff-match-patch` 3.2.1 is Apache-2.0 and was modified 2026-09-21. The original `diff-match-patch` npm package is 1.0.5, last modified 2022. — [npm registry, 2026-10-19]
- **[Local experiment, 2026-10-19] Different appends at the same spot (A appends `- pay rent`, B appends `- book flight`).**
  - `git merge-file --diff3` produced a **conflict** (exit 1).
  - `node-diff3.mergeDiff3` on line arrays produced a **conflict**.
  - `git merge-file --union` produced both lines.
  - diff-match-patch (`makePatches(base, A)` applied to B) merged cleanly to both lines.
  - Sources: [git-merge-file docs](https://www.kernel.org/pub/software/scm/git/docs/git-merge-file.html); [node-diff3](https://github.com/bhousel/node-diff3); [@sanity/diff-match-patch npm](https://www.npmjs.com/package/@sanity/diff-match-patch)
- **[Local experiment, 2026-10-19] Same edit on both sides (A and B both append `- pay rent`).**
  - `git merge-file` produced a clean result with one `- pay rent` (exit 0).
  - diff-match-patch, applying patch(base→A) onto A, produced `- pay rent` **twice**.
  - Source: same libraries as above.
- **Conflict surfacing in other tools.** Syncthing does not merge. It keeps one copy and renames the other with a `.sync-conflict-<date>-<time>-<deviceID>` suffix. The older-mtime copy loses; on a tie, the device-ID comparison decides. Conflict copies sync to every device. — [Syncthing: Understanding Synchronization](https://docs.syncthing.net/users/syncing)
  - The current docs say a deletion can win and the modified file becomes a conflict copy. The v1.0.0 FAQ said the modified file always wins. — [Syncthing v1.0.0 FAQ](https://docs.syncthing.net/v1.0.0/users/faq.html)

### Inferences
- **Line-level diff3 suits Markdown.** Markdown is line-oriented (list items, headings, paragraphs as lines), so line-level diff3 gives understandable results and clean conflict regions. Character-level merges (diff-match-patch) avoid more conflicts but can create subtle corruption: duplicated or misplaced sentences, broken list or table syntax. These errors go unnoticed for a long time.
- **Base-awareness matters for safety.** It is what makes identical concurrent edits idempotent. diff-match-patch's fuzzy patch-on-top lacks this property in the general case, and duplication is exactly the failure Obsidian Sync users report (section 5).
- **Auto-resolvable pattern.** "Both sides inserted different content at the same anchor, with no deletions" is common for agent + user appends. It is safe to auto-resolve by concatenation (union) in a deterministic order, for example server-arrival order. Real overlapping modify/modify or modify/delete regions should be surfaced.
- **Surfacing options.** Conflict markers inside the note keep everything in one file and are visible in Obsidian, but they corrupt rendering and can break frontmatter YAML. Conflict copies (Syncthing style) keep both files clean but are easy to miss and multiply. A hybrid works well for notes: markers in the body, never inside frontmatter; for frontmatter, use a key-wise merge or a conflict copy.
- **Diff algorithm.** histogram/patience diffs are preferable to Myers for Markdown with many blank lines or repeated `- ` bullets, which act as meaningless anchors. This is an analogy to git's stated rationale and was not separately tested.

### Gaps
- No published evaluation of diff3 vs diff-match-patch merge quality on Markdown corpora was found.
- No JS library implementing histogram diff alongside a diff3 merge was confirmed in this session. node-diff3 is LCS-based. git's xdiff is C.

---

## 4. Operational transformation: relevance for this use case

### Takeaway
Mostly not relevant. OT needs a central server to order a stream of fine-grained operations captured inside an editor session. obsy's main problem is files changed offline and outside editor sessions, where only before/after snapshots exist. Eg-walker shows that OT-style approaches are slow to merge long offline branches.

### Cited Findings
- **OT and long offline branches.** Eg-walker's abstract states that OT is slow to merge files that diverged through long offline editing. Eg-walker merges long-running branches orders of magnitude faster than OT. — [arXiv 2409.14252](https://arxiv.org/abs/2409.14252)
- **OT also interleaves.** The interleaving problem affects OT as well as CRDTs. — [Kleppmann 2025 Fugue post](https://martin.kleppmann.com/2025/11/01/fugue-minimizing-interleaving.html)
- **JS implementations still exist.** json-joy markets "the fastest text OT implementation in JavaScript" (self-claim), but it is now AGPL-3.0-only. — [json-joy npm](https://npmjs.com/package/json-joy); [npm registry, 2026-10-19]

### Inferences
- OT would add operation capture inside Obsidian's editor and still need a separate path for disk edits and agent writes. It gives no advantage over three-way merge for snapshot-based changes, and it is harder to implement correctly.

### Gaps
- No 2024–2026 source arguing for OT in local-first file sync was found.

---

## 5. Hybrid designs and who uses what

### Takeaway
Shipping file-sync products use file-level versions plus either a fuzzy or 3-way text merge (Obsidian Sync, Self-hosted LiveSync) or conflict copies (Syncthing). Relay uses Yjs CRDTs for real-time collaboration. No product found here uses CRDT as the only source of truth for files that are also edited outside the app, without a diff-in layer. Obsidian itself added an opt-in "create conflict file" mode in 1.9.7, after user reports of silent duplicates and overwrites.

### Cited Findings
- **Obsidian Sync defaults.** Obsidian Sync merges Markdown with Google's diff-match-patch. Other files, including canvas, use "last modified wins". Settings JSON is merged by applying local keys on top of remote keys. — [Obsidian Help: Troubleshoot Sync](https://obsidian.md/help/sync/troubleshoot)
- **Obsidian 1.9.7 option.** Users can choose "Automatically merge" (default) or "Create conflict file". The setting is per device. The docs acknowledge that the automatic merge "may sometimes create duplicate text or formatting problems". — [Obsidian Help: Troubleshoot Sync](https://obsidian.md/help/sync/troubleshoot); [Obsidian help mirror](https://www.mintlify.com/obsidianmd/obsidian-help/sync/troubleshoot)
- **Startup-generated notes.** If a note is created locally on startup (Daily notes, Templater) and a remote copy arrives shortly after, Sync "will keep the remote version without merging". File recovery is the remedy. — [Obsidian Help: Troubleshoot Sync](https://obsidian.md/help/sync/troubleshoot)
- **User reports and staff reply (Dec 2024–Jan 2025).** Users reported newer data overwritten by older data, and old and new content both duplicated in one note. An Obsidian representative (WhiteNoise) said: "Prioritizing newer changes is not always the right choice". They said diff-match-patch was archived because it is complete, and that Obsidian relies on sync history for recovery. Merge conflicts happen only when devices diverge from a common point, and a notification is shown. — [Obsidian forum: Robust Sync Conflict Resolution](https://forum.obsidian.md/t/robust-sync-conflict-resolution/93544)
- **Self-hosted LiveSync** (CouchDB or object storage) auto-merges simple conflicts. In v0.25.80 (July 2026), non-overlapping edits merge automatically. Overlapping delete-vs-edit cases stay visible for manual resolution. A newer incoming text is applied without conflict only if it "clearly extends the existing local text". The project warns that it is "not a backup solution". — [newreleases: livesync 0.25.80](https://newreleases.io/project/github/vrtmrz/obsidian-livesync/release/0.25.80); [LiveSync README](https://cdn.jsdelivr.net/gh/vrtmrz/obsidian-livesync@main/README.md)
- **Relay (System 3)** uses Yjs CRDTs on designated folders and is local-first, with the server relaying edits. Plugin: MIT. Relay Server: an MIT fork of y-sweet. Login, permissions, and billing server: proprietary. — [Relay repo](https://github.com/No-Instructions/Relay)
- **Syncthing:** conflict copies only, with no merge (details in section 3). — [Syncthing docs](https://docs.syncthing.net/users/syncing)
- **Git:** a line-based 3-way merge with conflict markers, configurable diff algorithm and conflict style. — [git-merge-file docs](https://www.kernel.org/pub/software/scm/git/docs/git-merge-file.html)

### Inferences
- **Product landscape converges.** It points to file-level versioned sync with base-aware merge and a visible conflict fallback as the robust default. CRDTs are kept for live co-editing sessions (Relay).
- **Obsidian Sync's failures are instructive.** Duplicates and older-overwrites-newer are consistent with fuzzy 2-way patch application. This is an inference: Obsidian does not document whether it uses a stored base. The startup-race rule shows that a sync engine must special-case "file created on both sides at nearly the same time" (Daily notes). An agent that creates daily notes will hit the same race.
- **Dropbox and iCloud** behave like Syncthing (conflict copies). That was not re-verified in this session; see Gaps.

### Gaps
- Dropbox and iCloud Drive conflict-copy behaviour was not fetched from primary docs in this session.
- Whether Obsidian Sync keeps a common-ancestor base for its diff-match-patch merge is not documented publicly.

---

## 6. AI-era developments (2024–2026)

### Takeaway
No AI or structured merge tool changes the core recommendation. Mergiraf (structured, tree-sitter based) does **not** support Markdown. LLM-assisted merge is at RFC/research stage (for example, LLMinus for the Linux kernel). It is useful as an optional "suggest a resolution" step, never as an automatic merge for user notes. The relevant research advances are Eg-walker (EuroSys 2025), Fugue/FugueMax (TPDS 2025), Automerge 3's memory work (2025), and Loro 1.x (2024–2026).

### Cited Findings
- **Mergiraf** is a syntax-aware 3-way merge driver for git. Its supported list covers many programming languages, plus JSON, YAML, TOML, HTML, XML, INI, and others. **Markdown is not listed.** — [Mergiraf supported languages](https://mergiraf.org/languages.html)
  - Mergiraf is GPL-3.0 per secondary listings, and R support was added in March 2026. — [docs.rs mergiraf](https://docs.rs/mergiraf); [lib.rs mergiraf](https://lib.rs/crates/mergiraf)
- **LLMinus** (Sasha Levin, NVIDIA): RFC Dec 2025, RFC v2 11 Jan 2026. It uses embeddings over historical kernel conflict resolutions to build LLM prompts. v2 adds build-failure detection for merges that are textually clean. It is still an RFC. — [LKML RFC v2](https://lkml.iu.edu/2601.1/06258.html); [Phoronix](https://phoronix.com/news/llminus-rfc-v2); [LWN](https://lwn.net/Articles/1053714/)
- **Earlier academic work (older):**
  - Microsoft Research ISSTA 2022 paper on pre-trained language models for textual and semantic merge conflicts. — [Microsoft Research](https://microsoft.com/en-us/research/?p=864348)
  - CHATMERGE (classifier + ChatGPT). — [IEEE Xplore](https://ieeexplore.ieee.org/document/10366637)
- **CRDT research results 2024–2026:**
  - Eg-walker (EuroSys 2025). — [arXiv 2409.14252](https://arxiv.org/abs/2409.14252)
  - Fugue/FugueMax (IEEE TPDS Nov 2025). — [Kleppmann 2025](https://martin.kleppmann.com/2025/11/01/fugue-minimizing-interleaving.html)
  - Automerge 3 (July 2025). — [Automerge blog](https://automerge.org/blog/automerge-3/)
  - Loro 1.0 (Oct 2024); 1.16.4 current. — [Loro blog](https://loro.dev/blog/v1.0); [npm registry, 2026-10-19]
- **Obsidian native conflict-file option** (1.9.7) is a 2025 product move toward visible conflicts. — [Obsidian Help](https://obsidian.md/help/sync/troubleshoot)

### Inferences
- **Markdown-aware merge has to be built.** A small custom layer on top of line diff3 is realistic: parse frontmatter separately, treat list items and headings as units, and auto-union pure inserts. No off-the-shelf Markdown-aware merge library was found.
- **LLM role in obsy.** obsy already has an agent, so an LLM can propose a resolution for a surfaced conflict. Keep the deterministic diff3 output and both inputs as the record. Never let the LLM decide silently.

### Gaps
- No Markdown-specific semantic or structured merge tool (open source, 2024–2026) was found.
- Searches did not surface new 2026 text-CRDT papers beyond Eg-walker and Fugue. This may reflect search limits rather than absence.

---

## 7. Concrete recommendation for obsy, with trade-offs and libraries

### Takeaway
Use **file-level versioned sync with server-assigned monotonically increasing versions per file, a stored base, and a deterministic line-level three-way merge on the server (Durable Object)**. Auto-resolve pure-insert conflicts by union. Otherwise produce a visible conflict, with markers in the body or a conflict copy, and never inside frontmatter. The agent writes through the same versioned API as any device. Add a CRDT only later, and only for live co-editing sessions. Do not use a CRDT as the persistent source of truth for files edited outside the editor.

### Cited Findings (supporting evidence collected above)
- **Base-aware 3-way merge handles identical edits.** In the test it merged identical concurrent edits once; diff-match-patch patch-on-top duplicated them. — [Local experiment, 2026-10-19]; [git-merge-file docs](https://www.kernel.org/pub/software/scm/git/docs/git-merge-file.html)
- **A CRDT duplicates identical inserts from two replicas.** This is the diff-in echo risk. — [Local experiment, 2026-10-19]; [Automerge conflicts docs](https://automerge.org/docs/reference/documents/conflicts/)
- **Products have moved toward visible conflicts.** Obsidian acknowledged duplicate-text risk and added a conflict-file option. LiveSync moved to "merge non-overlapping, keep overlapping visible" in July 2026. — [Obsidian Help](https://obsidian.md/help/sync/troubleshoot); [LiveSync 0.25.80](https://newreleases.io/project/github/vrtmrz/obsidian-livesync/release/0.25.80)
- **Worker memory limit.** 128 MB per isolate constrains a vault-wide in-memory CRDT. — [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)

### Recommended design (inference, built on the evidence above)
1. **Server state per file:** `{path, version (server-assigned integer), contentHash, content blob (or R2 pointer), lastWriter (device/agent id), tombstone flag}` plus retained prior versions for history and recovery. The DO serialises writes per vault or per file.
2. **Client write protocol:** a client sends `PUT path, baseVersion, newContent`.
   - If `baseVersion == current`: fast-forward and assign a new version.
   - Else: the server loads base = content@baseVersion and runs `merge3(base, current, incoming)`.
   - Clean merge: store it as a new version and return the merged content so the client rewrites its file.
   - Conflict: run the policy below.
   - Identical content: no-op. Hash-compare first to make retries and echo writes idempotent. This removes the duplicate-insert class of bugs.
3. **Merge granularity:** use line-level diff3 (histogram- or patience-like anchoring if available) on the body.
   - Frontmatter: parse YAML and merge key-wise. Non-conflicting keys union. For a conflicting key, keep the server value and record the other in a conflict log or copy. Never put markers in YAML.
   - Pure-insert-at-same-anchor regions: auto-union in deterministic order.
   - Within a conflicting paragraph-line, optionally try a word/char-level diff3 (node-diff3 with whitespace tokenisation) as a second pass, and accept it only if clean.
4. **Conflict policy:** default to keeping both versions visibly.
   - Option A: git-style markers with base (`mergeDiff3`) in the note body.
   - Option B: a sibling `note (conflict <device> <date>).md` copy, like Obsidian's 1.9.7 option and Syncthing.
   - Make it a vault setting. The agent can propose a resolution, but a user or explicit rule must accept it.
5. **Agent writes:** use the same `baseVersion` contract. The agent must read before it writes and must not blind-overwrite. For append-only agent actions (daily-note check-ins), offer a server-side "append to section" operation that commutes trivially. This avoids most agent–user conflicts.
6. **Creation races:** "file created on two devices without a base" (daily notes, templates) has no common ancestor. Use an empty base, so diff3 becomes a two-sided union or conflict. Alternatively, let the server create the canonical daily note and have clients defer template creation until after the first pull. Obsidian Sync shows this case needs explicit handling.
7. **Optional live co-editing later:** a Yjs room per open note (DO per note). On session start, seed it from the server version. On session end or idle, snapshot it back as a normal versioned write with the session's start version as base. The CRDT is ephemeral, which avoids long-term tombstone growth and the diff-in echo problem.

### Trade-offs
- **Three-way file-level merge.**
  - Pros: simple; deterministic; auditable (every version stored); works for disk edits, agent writes, and wholesale replacement; no extra runtime on iOS; no history growth except chosen retention; visible conflicts preserve data.
  - Cons: no real-time co-editing; occasional manual conflicts; requires the server to store base versions as long as any client might reference them (a client offline for months needs its base, so define retention or fall back to empty-base merge plus a conflict copy).
- **CRDT-first (Yjs/Loro/Automerge).**
  - Pros: no manual conflicts; real-time collaboration.
  - Cons: silent semantic mis-merges and duplicate text from diff-in; history/tombstone growth across thousands of notes; WASM weight (Loro/Automerge about 1.1 MB gz) on iOS; 128 MB DO memory budget; much harder correctness reasoning when other apps edit files.
- **diff-match-patch fuzzy merge (Obsidian Sync style).**
  - Pros: few visible conflicts.
  - Cons: documented duplicate-text and older-overwrites-newer reports; the upstream library is archived.

### Libraries (with licenses)
- **Three-way merge:** `node-diff3` 3.2.1, MIT — [repo](https://github.com/bhousel/node-diff3). Pure JS, runs in a Worker and an Obsidian plugin. Provides `diff3Merge`, `mergeDiff3` with base markers, and configurable tokenisation.
- **Optional char-level diff / patch utilities:** `@sanity/diff-match-patch` 3.2.1, Apache-2.0 (maintained fork; upstream `google/diff-match-patch` is Apache-2.0 and archived) — [npm](https://www.npmjs.com/package/@sanity/diff-match-patch), [upstream](https://github.com/google/diff-match-patch). Use it for diffs and display, not for blind fuzzy merging.
- **Optional live co-editing:** `yjs` 13.6.33, MIT, about 20 KB min+gz (older benchmark) — [repo](https://github.com/yjs/yjs). Durable Object providers exist (`yjs-cf-ws-provider`, PartyKit/y-partykit), as listed in the Yjs README.
- **Alternatives if a persistent CRDT is ever needed:**
  - `loro-crdt` 1.16.4, MIT: Fugue + Eg-walker ideas; `updateByLine` for diff-in; shallow snapshots — [repo](https://github.com/loro-dev/loro).
  - `@automerge/automerge` 3.5.0, MIT: `updateText` for diff-in — [blog](https://automerge.org/blog/automerge-3/).
- **Avoid or watch:**
  - `json-joy` ≥18: AGPL-3.0-only.
  - `diamond-types` / `diamond-types-web`: ISC (npm: "ISC OR Apache-2.0"); JS package stale since 2023; README says WIP.
  - `mergiraf`: GPL-3.0 per secondary listings; no Markdown support; Rust CLI.
- **Reference tool:** git `merge-file` (GPL-2.0, as part of git) is useful as a test oracle for the JS merge implementation, not as a runtime dependency on a Worker.

### Gaps
- The recommended design was not prototyped end to end. Only the small merge experiments above ran.
- Durable Object per-value or storage limits were not fetched; check them before deciding whether content lives in DO storage or R2.
- The git license (GPL-2.0) is stated from general knowledge and was not re-fetched in this session.
