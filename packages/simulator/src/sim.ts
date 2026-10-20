import {
  AgentWriter,
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
    syncsStarted: number;
    pullOnlySyncs: number;
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
  readonly agent: AgentWriter;
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
    syncsStarted: 0,
    pullOnlySyncs: 0,
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
      });
      this.devices.push({ name, files, engine, online: true });
    }
    this.agent = new AgentWriter(this.#storage('agent'), this.env, { id: 'agent' });
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
    this.scheduler.spawn(device.name, async () => {
      const report = await device.engine.sync({ pullOnly });
      this.stats.syncsDone++;
      this.stats.commits += report.commits;
      this.stats.conflictCopies += report.conflictCopies;
    });
  }

  startAgent(): void {
    if (this.scheduler.running('agent')) return;
    const line = `- ${this.token('g')}`;
    this.scheduler.spawn('agent', async () => {
      await this.agent.appendLine(DAILY, line);
      this.stats.agentWrites++;
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
      this.scheduler.trace.push(`user ${device.name} create ${path}`);
      return;
    }
    const path = r.pick(existing) as string;
    const lines = decodeUtf8Strict(snapshot.get(path) as Uint8Array)
      .split('\n')
      .filter((line) => line !== '');
    const save = async (next: string[]): Promise<void> => {
      await files.userWrite(path, encodeUtf8(next.map((line) => `${line}\n`).join('')));
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

    // 3. No agent commit without a matching base: an agent only appends to the head.
    const replay = new Manifest(vault.epoch);
    for (const commit of commits) {
      if (commit.actor.kind === 'agent') {
        for (const op of commit.ops) {
          if (op.type !== 'put') throw new Error('agent made a non-put op');
          if (op.baseRev !== null) {
            const before = replay.file(op.fileId);
            if (before === undefined) throw new Error('agent edit of an unknown file');
            const next = await content(op.hash);
            if (!next.startsWith(await content(before.hash))) {
              throw new Error(`agent commit ${commit.seq} did not keep the head content`);
            }
          }
        }
      }
      replay.apply(commit);
    }

    // 4. Devices converge: every device holds exactly the head files.
    const head = new Map<string, string>();
    for (const [, entry] of manifest.liveFiles()) head.set(entry.path, await content(entry.hash));
    for (const device of this.devices) {
      const local = device.files.snapshot();
      const localPaths = [...local.keys()].sort();
      const headPaths = [...head.keys()].sort();
      if (JSON.stringify(localPaths) !== JSON.stringify(headPaths)) {
        throw new Error(
          `${device.name} has ${JSON.stringify(localPaths)}, head has ${JSON.stringify(headPaths)}`,
        );
      }
      for (const [path, bytes] of local) {
        if (decodeUtf8Strict(bytes) !== head.get(path))
          throw new Error(`${device.name} differs at ${path}`);
      }
    }

    // 5. No silent loss: every token that no user removed is in a live file.
    const live = [...head.values()].join('\n');
    const present = new Set(live.match(/[a-z]\d+/g) ?? []);
    for (const token of this.tokens) {
      if (!this.removed.has(token) && !present.has(token))
        throw new Error(`token ${token} was lost`);
    }
  }
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
      else if (roll < 0.94) world.startAgent();
      else if (roll < 0.946) world.crash(device);
      else if (roll < 0.97) {
        device.online = !device.online;
        world.scheduler.trace.push(`${device.name} ${device.online ? 'online' : 'offline'}`);
      } else if (roll < 0.985) await world.deliverDelayed();
      else world.env.advance(60_000 * (1 + r.int(30)));
      await world.scheduler.settle();
      for (const owner of ['mac', 'phone', 'agent']) {
        const error = world.scheduler.takeError(owner);
        if (error !== undefined) world.stats.syncErrors++;
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
  return error instanceof Error && error.name === 'TransientStorageError';
}
