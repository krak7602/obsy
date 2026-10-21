import {
  PresenceWriter,
  VaultAdmin,
  VaultAgent,
  proposalIds,
  readProposal,
  readResolution,
} from '@obsy/agent';
import {
  MemoryLocalFiles,
  SeededEnvironment,
  SyncEngine,
  initVault,
  type DeviceState,
  type StateStore,
} from '@obsy/core';
import {
  LOG_PREFIX,
  Manifest,
  blobKey,
  decodeCommit,
  decodeUtf8Strict,
  decodeVaultRecord,
  encodeUtf8,
  hashContent,
  logKey,
  parseLogKey,
  pathKey,
  VAULT_KEY,
  type Commit,
  type ContentHash,
  type Storage,
} from '@obsy/protocol';
import { MemoryStorage } from '@obsy/storage-testkit';

import { FaultyStorage, NO_FAULTS, type FaultRates } from './faulty-storage';
import { Random, Scheduler } from './scheduler';

export interface SimOptions {
  readonly seed: number;
  /** Simulation steps before the quiet phase. Default 600. */
  readonly steps?: number;
  readonly faults?: FaultRates;
}

export interface SimResult {
  readonly seed: number;
  readonly ok: boolean;
  /** The broken invariant, when `ok` is false. */
  readonly failure?: string;
  readonly stats: {
    commits: number;
    quietCommits: number;
    userActions: number;
    crashes: number;
    conflictCopies: number;
    agentWrites: number;
    /** Agent operations that ended as a proposal. */
    agentProposals: number;
    ownerAccepts: number;
    ownerRejects: number;
    ownerUndos: number;
    syncsStarted: number;
    pullOnlySyncs: number;
    stoppedSyncs: number;
    /** Sum over finished syncs of files left out by the phone's size limit. */
    skippedFiles: number;
    syncsDone: number;
    syncErrors: number;
  };
  /** The scheduler trace, for replaying a failure. */
  readonly trace: readonly string[];
}

export const DEFAULT_FAULTS: FaultRates = { beforeApply: 0.03, lostResponse: 0.03, delayed: 0.02 };

/** Paths that users pick from. Includes case and normalisation twins and a binary type. */
const PATHS = [
  'a.md',
  'A.md',
  'b.md',
  'notes/idea.md',
  'notes/Idea.md',
  'café.md',
  'café.md',
  'daily/2026-10-20.md',
  'img.png',
  'deep/x/y.md',
];
const DAILY = 'daily/2026-10-20.md';

/** The actor ID of the owner's maintenance actions (accept, reject, undo). */
const OWNER = 'owner';

/** A token in note text: a letter for its kind (user text, binary, agent) and a counter. */
const TOKEN = /(?<![0-9a-z])[tbg]\d+(?![0-9a-z])/g;

function tokensOf(text: string): Set<string> {
  return new Set(text.match(TOKEN) ?? []);
}

/**
 * The phone's `maxFileSize`, in bytes: about five lines. Files grow past it,
 * so the phone has files it holds over the limit, head files it does not
 * take on, and local files it does not send.
 */
const PHONE_MAX_FILE_SIZE = 40;

class SimStateStore implements StateStore {
  #state: string | null = null;

  constructor(
    readonly scheduler: Scheduler,
    readonly owner: string,
  ) {}

  async load(): Promise<DeviceState | null> {
    await this.scheduler.wait(this.owner, 'state load');
    return this.#state === null ? null : (JSON.parse(this.#state) as DeviceState);
  }

  async save(state: DeviceState): Promise<void> {
    await this.scheduler.wait(this.owner, 'state save');
    this.#state = JSON.stringify(state);
  }
}

interface Device {
  readonly name: string;
  readonly files: MemoryLocalFiles;
  readonly engine: SyncEngine;
  readonly presence: PresenceWriter;
  readonly maxFileSize: number;
  online: boolean;
}

/** One line of user text: a unique token, so that loss can be detected. */
type Token = string;

class World {
  readonly random: Random;
  readonly scheduler: Scheduler;
  readonly bucket = new MemoryStorage();
  readonly env: SeededEnvironment;
  readonly faults: { rates: FaultRates };
  readonly delayed: (() => Promise<void>)[] = [];
  readonly devices: Device[] = [];
  /** `agent` waits while a device edits the note; `bot` proposes instead. */
  readonly agents: readonly VaultAgent[];
  /** The owner answers proposals and undoes agent commits. */
  readonly owner: VaultAdmin;
  /** Tokens that a user removed. Every other token must survive. */
  readonly removed = new Set<Token>();
  readonly tokens = new Set<Token>();
  #counter = 0;
  readonly stats = {
    commits: 0,
    quietCommits: 0,
    userActions: 0,
    crashes: 0,
    conflictCopies: 0,
    agentWrites: 0,
    agentProposals: 0,
    ownerAccepts: 0,
    ownerRejects: 0,
    ownerUndos: 0,
    syncsStarted: 0,
    pullOnlySyncs: 0,
    stoppedSyncs: 0,
    skippedFiles: 0,
    syncsDone: 0,
    syncErrors: 0,
  };
  readonly errors: string[] = [];

  constructor(seed: number, rates: FaultRates) {
    this.random = new Random(seed);
    this.scheduler = new Scheduler(this.random);
    this.env = new SeededEnvironment(seed);
    this.faults = { rates };
    for (const name of ['mac', 'phone']) {
      const storage = this.#storage(name);
      const files = new MemoryLocalFiles(() => this.scheduler.wait(name, 'local'));
      const maxFileSize = name === 'phone' ? PHONE_MAX_FILE_SIZE : Number.POSITIVE_INFINITY;
      const engine = new SyncEngine({
        storage,
        local: files,
        state: new SimStateStore(this.scheduler, name),
        env: this.env,
        actorId: name,
        deviceName: name,
        // Limits too high to trip, so that the rail check runs on every pass.
        // Simulated users often delete every file.
        rails: { maxFiles: 1000, minFiles: 1000, emptyVault: false },
        ...(name === 'phone' ? { maxFileSize } : {}),
      });
      // Presence writes happen during user actions, outside any task, so
      // they use their own scheduler owner.
      const presence = new PresenceWriter(this.#storage(`${name}-presence`), this.env, name);
      this.devices.push({ name, files, engine, presence, maxFileSize, online: true });
    }
    // Limits high enough not to trip; the check runs on every commit.
    const limits = { commitsPerHour: 1000, filesPerHour: 1000 };
    this.agents = [
      new VaultAgent({
        storage: this.#storage('agent'),
        env: this.env,
        actor: { id: 'agent', run: 'sim' },
        presence: { mode: 'wait', windowMs: 120_000, maxWaitMs: 300_000, pollMs: 60_000 },
        limits,
      }),
      new VaultAgent({
        storage: this.#storage('bot'),
        env: this.env,
        actor: { id: 'bot' },
        presence: { mode: 'propose' },
        limits,
      }),
    ];
    this.owner = new VaultAdmin({
      storage: this.#storage('owner'),
      env: this.env,
      actor: { kind: 'device', id: OWNER },
    });
  }

  #storage(owner: string): Storage {
    return new FaultyStorage(
      this.bucket,
      this.scheduler,
      owner,
      this.random,
      this.faults,
      this.delayed,
    );
  }

  token(prefix: string): Token {
    this.#counter++;
    const token = `${prefix}${this.#counter}`;
    this.tokens.add(token);
    return token;
  }

  // ------------------------------------------------------------ actors

  startSync(device: Device): void {
    if (!device.online || this.scheduler.running(device.name)) return;
    this.stats.syncsStarted++;
    // Some syncs are pull-only, as on a device that joins a vault.
    const pullOnly = this.random.next() < 0.2;
    if (pullOnly) this.stats.pullOnlySyncs++;
    // Some syncs are asked to stop at a safe point, as when iOS hides the app.
    const stopping = this.random.next() < 0.1;
    const shouldStop = (): boolean => stopping && this.random.next() < 0.2;
    this.scheduler.spawn(device.name, async () => {
      const report = await device.engine.sync({ pullOnly, shouldStop });
      this.stats.syncsDone++;
      this.stats.skippedFiles += report.skipped;
      this.stats.commits += report.commits;
      this.stats.conflictCopies += report.conflictCopies;
    });
  }

  startAgent(): void {
    const index = this.random.int(this.agents.length);
    const owner = index === 0 ? 'agent' : 'bot';
    if (this.scheduler.running(owner)) return;
    const agent = this.agents[index] as VaultAgent;
    const r = this.random;
    const line = `- ${this.token('g')}`;
    const roll = r.next();
    const textPaths = PATHS.filter((path) => !path.endsWith('.png'));
    let label: string;
    let run: () => Promise<{ status: string }>;
    if (roll < 0.35) {
      label = `append section ${DAILY}`;
      run = () => agent.appendToSection(DAILY, ['## Agent'], [line]);
    } else if (roll < 0.5) {
      const path = r.pick(textPaths) as string;
      label = `append ${path}`;
      run = () => agent.appendToSection(path, [], [line], { ifMissing: 'skip' });
    } else if (roll < 0.7) {
      const path = r.chance(0.7) ? DAILY : 'b.md';
      const content = r.chance(0.5) ? line : `${line}\n- ${this.token('g')}`;
      label = `block ${path}`;
      run = () => agent.replaceBlock(path, 'w', content, { insert: { section: ['## Agent'] } });
    } else if (roll < 0.8) {
      const path = r.pick(textPaths) as string;
      label = `create ${path}`;
      run = () => agent.createIfAbsent(path, `${line}\n`);
    } else if (roll < 0.9) {
      // Whole-note rewrite from what it read, as an agent that plans a
      // daily note does: it keeps every user line, may drop one of its own
      // lines, and adds one.
      const path = r.chance(0.7) ? DAILY : (r.pick(textPaths) as string);
      const dropOwn = r.chance(0.5);
      label = `replace ${path}`;
      run = async () => {
        const current = await agent.read(path);
        if (current !== null && current.text === null) return { status: 'skipped' };
        let lines = (current?.text ?? '').split('\n').filter((l) => l !== '');
        if (dropOwn) {
          const own = lines.findIndex((l) => /^- g\d+$/.test(l));
          if (own >= 0) lines = [...lines.slice(0, own), ...lines.slice(own + 1)];
        }
        lines.push(line);
        return agent.replaceIfUnchanged(path, lines.map((l) => `${l}\n`).join(''), {
          baseRev: current?.rev ?? null,
        });
      };
    } else {
      const path = r.pick(textPaths) as string;
      label = `propose ${path}`;
      run = async () => {
        const current = await agent.read(path);
        const text = current?.text ?? '';
        return agent.proposePatch(path, `${text}${line}\n`, {
          ...(current === null ? {} : { baseRev: current.rev }),
          rationale: 'sim',
        });
      };
    }
    this.scheduler.trace.push(`${owner} ${label}`);
    this.scheduler.spawn(owner, async () => {
      const result = await run();
      if (result.status === 'committed') this.stats.agentWrites++;
      if (result.status === 'proposed') this.stats.agentProposals++;
    });
  }

  /** The owner accepts or rejects an open proposal, or undoes an agent commit. */
  startOwner(): void {
    if (this.scheduler.running('owner')) return;
    const r = this.random;
    const roll = r.next();
    this.scheduler.spawn('owner', async () => {
      if (roll < 0.6) {
        const open = await this.owner.openProposals();
        const proposal = r.pick(open);
        if (proposal === undefined) return;
        if (r.chance(0.8)) {
          this.scheduler.trace.push(`owner accept ${proposal.id}`);
          const result = await this.owner.accept(proposal.id);
          if (result.status === 'accepted') this.stats.ownerAccepts++;
        } else {
          this.scheduler.trace.push(`owner reject ${proposal.id}`);
          await this.owner.reject(proposal.id);
          this.stats.ownerRejects++;
        }
        return;
      }
      const head = await this.owner.reader.head();
      if (head.seq === 0) return;
      const seq = 1 + r.int(head.seq);
      const commit = await this.owner.reader.commit(seq);
      if (commit.actor.kind !== 'agent') return;
      this.scheduler.trace.push(`owner undo ${seq}`);
      const result = await this.owner.undo(seq);
      if (result.status === 'committed') this.stats.ownerUndos++;
    });
  }

  crash(device: Device): void {
    if (!this.scheduler.running(device.name)) return;
    this.scheduler.crash(device.name);
    this.stats.crashes++;
  }

  async userAction(device: Device): Promise<void> {
    const files = device.files;
    const snapshot = files.snapshot();
    const existing = [...snapshot.keys()];
    const r = this.random;
    this.stats.userActions++;
    const kind = r.int(10);
    if (existing.length === 0 || kind === 0) {
      const path = r.pick(PATHS) as string;
      if (files.get(path) !== undefined) return;
      const content = path.endsWith('.png') ? `BIN ${this.token('b')}\n` : `- ${this.token('t')}\n`;
      await files.userWrite(path, encodeUtf8(content));
      await this.#editing(device, path);
      this.scheduler.trace.push(`user ${device.name} create ${path}`);
      return;
    }
    const path = r.pick(existing) as string;
    const lines = decodeUtf8Strict(snapshot.get(path) as Uint8Array)
      .split('\n')
      .filter((line) => line !== '');
    const save = async (next: string[]): Promise<void> => {
      await files.userWrite(path, encodeUtf8(next.map((line) => `${line}\n`).join('')));
      await this.#editing(device, path);
    };
    const forget = (line: string): void => {
      const token = /([a-z]\d+)$/.exec(line)?.[1];
      if (token !== undefined) this.removed.add(token);
    };
    if (path.endsWith('.png')) {
      if (kind <= 6) {
        lines.forEach(forget);
        await save([`BIN ${this.token('b')}`]);
        this.scheduler.trace.push(`user ${device.name} rewrite ${path}`);
        return;
      }
    }
    switch (kind) {
      case 1:
      case 2:
        await save([...lines, `- ${this.token('t')}`]);
        break;
      case 3: {
        const at = r.int(lines.length + 1);
        await save([...lines.slice(0, at), `- ${this.token('t')}`, ...lines.slice(at)]);
        break;
      }
      case 4: {
        if (lines.length === 0) return;
        const at = r.int(lines.length);
        forget(lines[at] as string);
        await save([...lines.slice(0, at), `- ${this.token('t')}`, ...lines.slice(at + 1)]);
        break;
      }
      case 5: {
        if (lines.length === 0) return;
        const at = r.int(lines.length);
        forget(lines[at] as string);
        await save([...lines.slice(0, at), ...lines.slice(at + 1)]);
        break;
      }
      case 6:
      case 7: {
        const to = r.pick(PATHS) as string;
        if (to.endsWith('.png') !== path.endsWith('.png')) return;
        if (files.userMove(path, to))
          this.scheduler.trace.push(`user ${device.name} move ${path} ${to}`);
        return;
      }
      case 8: {
        lines.forEach(forget);
        files.userRemove(path);
        this.scheduler.trace.push(`user ${device.name} remove ${path}`);
        return;
      }
      default:
        await save([...lines, `- ${this.token('t')}`]);
    }
    this.scheduler.trace.push(`user ${device.name} edit ${path}`);
  }

  /** Records that the device's user edits `path` now. Presence is advisory: failures are ignored. */
  async #editing(device: Device, path: string): Promise<void> {
    try {
      await device.presence.write(path, this.env.now());
    } catch (error) {
      if (!isExpected(error)) throw error;
    }
  }

  async deliverDelayed(): Promise<void> {
    if (this.delayed.length === 0) return;
    const index = this.random.int(this.delayed.length);
    const [write] = this.delayed.splice(index, 1);
    this.scheduler.trace.push('delayed write lands');
    await write?.();
  }

  // ------------------------------------------------------------ quiet phase

  /** No faults, everyone online, until every device has nothing to do. */
  async quiesce(): Promise<void> {
    this.faults.rates = NO_FAULTS;
    await this.scheduler.drain();
    while (this.delayed.length > 0) await this.deliverDelayed();
    for (const device of this.devices) device.online = true;
    for (let round = 0; round < 12; round++) {
      const before = this.stats.quietCommits;
      let changes = 0;
      for (const device of this.devices) {
        let report: Awaited<ReturnType<SyncEngine['sync']>> | undefined;
        this.scheduler.spawn(device.name, async () => {
          report = await device.engine.sync();
        });
        await this.scheduler.drain();
        const error = this.scheduler.takeError(device.name);
        if (error !== undefined) throw error;
        if (report === undefined) throw new Error(`${device.name} sync did not finish`);
        this.stats.quietCommits += report.commits;
        this.stats.conflictCopies += report.conflictCopies;
        changes += report.commits + report.localChanges;
        if (!report.settled) changes++;
      }
      if (changes === 0 && this.stats.quietCommits === before) return;
    }
    throw new Error('devices did not settle in the quiet phase');
  }

  // ------------------------------------------------------------ invariants

  async check(): Promise<void> {
    const bucket = this.bucket;
    const vaultObject = await bucket.get(VAULT_KEY);
    if (vaultObject === null) throw new Error('vault.json is missing');
    const vault = decodeVaultRecord(vaultObject.body);

    // 1. The log is gap-free, every commit keeps the rules, every blob exists and matches.
    const manifest = new Manifest(vault.epoch);
    const commits: Commit[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await bucket.list(LOG_PREFIX, startAfter, 1000);
      for (const key of page.keys) {
        const seq = parseLogKey(key);
        if (seq !== manifest.seq + 1) throw new Error(`log gap at ${key}`);
        const object = await bucket.get(logKey(seq));
        const commit = decodeCommit((object as { body: Uint8Array }).body, seq);
        manifest.apply(commit);
        commits.push(commit);
      }
      if (!page.truncated) break;
      startAfter = page.keys.at(-1);
    }
    const blobText = new Map<ContentHash, string>();
    const content = async (hash: ContentHash): Promise<string> => {
      const cached = blobText.get(hash);
      if (cached !== undefined) return cached;
      const object = await bucket.get(blobKey(hash));
      if (object === null) throw new Error(`blob ${hash} is missing`);
      if ((await hashContent(object.body)) !== hash) throw new Error(`blob ${hash} does not match`);
      const text = decodeUtf8Strict(object.body);
      blobText.set(hash, text);
      return text;
    };

    // 2. Replaying a journal never commits twice: every opId is unique.
    const opIds = new Set<string>();
    for (const commit of commits) {
      if (opIds.has(commit.opId)) throw new Error(`opId ${commit.opId} committed twice`);
      opIds.add(commit.opId);
    }

    // 3. Agents never remove a user's text, and the owner removes only
    // agent text, or text that an accepted proposal removed. Tokens that
    // agents committed must survive like user tokens, unless an agent
    // replaced its own block or the owner removed them.
    const acceptedProposals = new Map<number, { base: Set<string>; proposed: Set<string> }>();
    const proposalList = await proposalIds(bucket, this.env);
    for (const id of [...proposalList.open, ...proposalList.resolved]) {
      const proposal = await readProposal(bucket, this.env, id);
      if (proposal === null) throw new Error(`resolution of a missing proposal ${id}`);
      const proposed = tokensOf(await content(proposal.hash));
      const resolution = await readResolution(bucket, this.env, id);
      if (resolution?.seq !== undefined) {
        const base =
          proposal.baseHash === null
            ? new Set<string>()
            : tokensOf(await content(proposal.baseHash));
        acceptedProposals.set(resolution.seq, { base, proposed });
      }
    }
    const replay = new Manifest(vault.epoch);
    // Deletes each device sent: device, path key, and the content deleted.
    const deleted = new Set<string>();
    const agentTokens = new Set<string>();
    // Tokens that an agent's own block replace, an undo, or an accepted proposal removed.
    const removedByAgents = new Set<string>();
    for (const commit of commits) {
      for (const op of commit.ops) {
        const before = replay.file(op.fileId);
        if (op.type === 'delete' && before !== undefined)
          deleted.add(`${commit.actor.id}|${pathKey(op.path)}|${before.hash}`);
        if (op.type === 'move') continue;
        const old =
          before === undefined || before.deleted
            ? new Set<string>()
            : tokensOf(await content(before.hash));
        const next = op.type === 'put' ? tokensOf(await content(op.hash)) : new Set<string>();
        const gone = [...old].filter((token) => !next.has(token));
        if (commit.actor.kind === 'agent') {
          if (op.type !== 'put') throw new Error(`agent commit ${commit.seq} has a ${op.type} op`);
          for (const token of next) if (token.startsWith('g')) agentTokens.add(token);
          const userGone = gone.filter((token) => !token.startsWith('g'));
          if (userGone.length > 0)
            throw new Error(`agent commit ${commit.seq} removed user text ${userGone.join(' ')}`);
          for (const token of gone) removedByAgents.add(token);
        } else if (commit.actor.id === OWNER) {
          const accepted = acceptedProposals.get(commit.seq);
          for (const token of gone) {
            const allowed =
              accepted === undefined
                ? token.startsWith('g')
                : accepted.base.has(token) && !accepted.proposed.has(token);
            if (!allowed) throw new Error(`owner commit ${commit.seq} removed ${token}`);
            removedByAgents.add(token);
          }
          for (const token of next) if (token.startsWith('g')) agentTokens.add(token);
        }
      }
      replay.apply(commit);
    }

    // 4. Devices converge: every device holds exactly the head files. A
    // device with a size limit may lack a head file over the limit that it
    // never held.
    const head = new Map<string, string>();
    const headByKey = new Map<string, { path: string; size: number }>();
    for (const [, entry] of manifest.liveFiles()) {
      head.set(entry.path, await content(entry.hash));
      headByKey.set(pathKey(entry.path), { path: entry.path, size: entry.size });
    }
    for (const device of this.devices) {
      const local = device.files.snapshot();
      // 4a. A device never deletes in the bucket a file that it keeps. Empty
      // files all have the same content, so they are not checked.
      for (const [path, bytes] of local) {
        if (bytes.length === 0 || head.get(path) === decodeUtf8Strict(bytes)) continue;
        if (deleted.has(`${device.name}|${pathKey(path)}|${await hashContent(bytes)}`)) {
          throw new Error(`${device.name} deleted ${path} in the bucket but kept it`);
        }
      }
      for (const [path, bytes] of local) {
        if (head.get(path) !== decodeUtf8Strict(bytes)) {
          throw new Error(`${device.name} differs at ${path}`);
        }
      }
      for (const entry of headByKey.values()) {
        if (local.get(entry.path) === undefined && entry.size <= device.maxFileSize) {
          throw new Error(`${device.name} lacks ${entry.path} (${entry.size} bytes)`);
        }
      }
    }

    // 5. No silent loss: every user token, and every committed agent
    // token, is in a live file, unless a user removed it, or an agent's
    // block replace, an undo, or an accepted proposal removed it (checked
    // in 3).
    const present = tokensOf([...head.values()].join('\n'));
    for (const token of this.tokens) {
      if (token.startsWith('g')) continue;
      // An accepted proposal may remove user text: the owner chose that.
      if (!this.removed.has(token) && !removedByAgents.has(token) && !present.has(token))
        throw new Error(`token ${token} was lost${await lastSeen(commits, token, content)}`);
    }
    for (const token of agentTokens) {
      if (!this.removed.has(token) && !removedByAgents.has(token) && !present.has(token))
        throw new Error(`agent token ${token} was lost${await lastSeen(commits, token, content)}`);
    }
  }
}

/**
 * For a failure message: the last commit whose files held `token`, and the
 * next commit that changed one of those files.
 */
async function lastSeen(
  commits: readonly Commit[],
  token: string,
  content: (hash: ContentHash) => Promise<string>,
): Promise<string> {
  const manifest = new Manifest(commits[0]?.epoch ?? 1);
  let holders: string[] = [];
  let last = '';
  for (const commit of commits) {
    manifest.apply(commit);
    const now: string[] = [];
    for (const [fileId, entry] of manifest.liveFiles()) {
      if (tokensOf(await content(entry.hash)).has(token)) now.push(fileId);
    }
    if (now.length > 0) {
      holders = now;
      last = `; last held at seq ${commit.seq}`;
    } else if (holders.length > 0) {
      const op = commit.ops.find((o) => holders.includes(o.fileId));
      return `${last}; removed by seq ${commit.seq} (${commit.actor.kind} ${commit.actor.id}, ${op?.type ?? '?'} ${op === undefined ? '' : op.type === 'move' ? op.to : op.path})`;
    }
  }
  return last === '' ? '; never committed' : `${last}; still held at the end of the log`;
}

/** Runs one seed and checks the invariants. */
export async function simulate(options: SimOptions): Promise<SimResult> {
  const world = new World(options.seed, options.faults ?? DEFAULT_FAULTS);
  const r = world.random;
  try {
    await initVault(world.bucket, world.env);
    const steps = options.steps ?? 600;
    for (let i = 0; i < steps; i++) {
      const roll = r.next();
      const device = r.pick(world.devices) as (typeof world.devices)[number];
      if (roll < 0.62) await world.scheduler.step();
      else if (roll < 0.8) await world.userAction(device);
      else if (roll < 0.9) world.startSync(device);
      else if (roll < 0.935) world.startAgent();
      else if (roll < 0.94) world.startOwner();
      else if (roll < 0.946) world.crash(device);
      else if (roll < 0.97) {
        device.online = !device.online;
        world.scheduler.trace.push(`${device.name} ${device.online ? 'online' : 'offline'}`);
      } else if (roll < 0.985) await world.deliverDelayed();
      else world.env.advance(60_000 * (1 + r.int(30)));
      await world.scheduler.settle();
      for (const owner of ['mac', 'phone', 'agent', 'bot', 'owner']) {
        const error = world.scheduler.takeError(owner);
        if (error !== undefined) world.stats.syncErrors++;
        if (error instanceof Error && error.name === 'SyncStopped') world.stats.stoppedSyncs++;
        if (error !== undefined && !isExpected(error)) throw error;
      }
    }
    await world.quiesce();
    await world.check();
    return { seed: options.seed, ok: true, stats: world.stats, trace: world.scheduler.trace };
  } catch (error) {
    const failure =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
    return {
      seed: options.seed,
      ok: false,
      failure,
      stats: world.stats,
      trace: world.scheduler.trace,
    };
  }
}

/** Errors that a sync may end with under faults; the next sync recovers. */
function isExpected(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TransientStorageError' || error.name === 'SyncStopped')
  );
}
