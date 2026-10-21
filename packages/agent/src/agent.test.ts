import {
  MemoryLocalFiles,
  MemoryStateStore,
  SeededEnvironment,
  SyncEngine,
  initVault,
} from '@obsy/core';
import {
  LOG_PREFIX,
  decodeCommit,
  decodeUtf8Strict,
  encodeUtf8,
  logKey,
  type Commit,
  type Storage,
} from '@obsy/protocol';
import { MemoryStorage } from '@obsy/storage-testkit';
import { describe, expect, it } from 'vite-plus/test';

import { VaultAdmin } from './admin';
import { AgentInputError, AgentRateLimited, VaultAgent, type VaultAgentOptions } from './agent';
import { PresenceWriter } from './records';

const DAILY = 'daily/2026-10-21.md';

/** Runs `hook` once, just before the next claim of a log entry. */
class HookStorage implements Storage {
  hook: (() => Promise<void>) | null = null;

  constructor(readonly inner: MemoryStorage) {}

  get(key: string): ReturnType<Storage['get']> {
    return this.inner.get(key);
  }
  async putIfAbsent(
    key: string,
    body: Uint8Array,
    type: string,
  ): ReturnType<Storage['putIfAbsent']> {
    const hook = this.hook;
    if (key.startsWith(LOG_PREFIX) && hook !== null) {
      this.hook = null;
      await hook();
    }
    return this.inner.putIfAbsent(key, body, type);
  }
  putIfMatch(
    key: string,
    body: Uint8Array,
    etag: string,
    type: string,
  ): ReturnType<Storage['putIfMatch']> {
    return this.inner.putIfMatch(key, body, etag, type);
  }
  list(prefix: string, startAfter?: string, limit?: number): ReturnType<Storage['list']> {
    return this.inner.list(prefix, startAfter, limit);
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

async function setup(agentOptions: Partial<VaultAgentOptions> = {}) {
  const bucket = new MemoryStorage();
  const storage = new HookStorage(bucket);
  const env = new SeededEnvironment(7);
  await initVault(bucket, env);
  const files = new MemoryLocalFiles();
  const device = new SyncEngine({
    storage: bucket,
    local: files,
    state: new MemoryStateStore(),
    env,
    actorId: 'mac',
    deviceName: 'mac',
  });
  const agent = new VaultAgent({
    storage,
    env,
    actor: { id: 'planner', run: 'run-1' },
    presence: { mode: 'ignore' },
    ...agentOptions,
  });
  const admin = new VaultAdmin({ storage: bucket, env, actor: { kind: 'device', id: 'owner' } });
  const text = (path: string): string | undefined => {
    const bytes = files.get(path);
    return bytes === undefined ? undefined : decodeUtf8Strict(bytes);
  };
  const write = (path: string, content: string): Promise<void> =>
    files.userWrite(path, encodeUtf8(content));
  const commitAt = async (seq: number): Promise<Commit> =>
    decodeCommit(((await bucket.get(logKey(seq))) as { body: Uint8Array }).body, seq);
  return { bucket, storage, env, files, device, agent, admin, text, write, commitAt };
}

describe('VaultAgent writes', () => {
  it('creates a file once, by path key, and records provenance', async () => {
    const { agent, commitAt } = await setup();
    const first = await agent.createIfAbsent('Notes/Plan.md', 'hello\n', { toolCall: 'tc-1' });
    expect(first.status).toBe('committed');
    expect((await agent.createIfAbsent('notes/plan.md', 'other\n')).status).toBe('exists');
    expect((await commitAt(1)).actor).toEqual({
      kind: 'agent',
      id: 'planner',
      run: 'run-1',
      toolCall: 'tc-1',
    });
  });

  it('appends to a section, creating the file and the heading', async () => {
    const { agent, device, text, write } = await setup();
    expect((await agent.appendToSection(DAILY, ['## Agent'], ['- 08:00 first'])).status).toBe(
      'committed',
    );
    await device.sync();
    expect(text(DAILY)).toBe('## Agent\n- 08:00 first\n');
    await write(DAILY, '# Today\n\n## Agent\n- 08:00 first\n\n## Notes\nmine\n');
    await device.sync();
    await agent.appendToSection(DAILY, ['## Agent'], ['- 09:00 second']);
    await device.sync();
    expect(text(DAILY)).toBe(
      '# Today\n\n## Agent\n- 08:00 first\n- 09:00 second\n\n## Notes\nmine\n',
    );
  });

  it('computes again on the new head after losing a claim', async () => {
    const { agent, device, storage, text, write } = await setup();
    await write(DAILY, '## Log\n- a\n\n## Notes\nx\n');
    await device.sync();
    // The owner edits elsewhere and commits just before the agent claims.
    storage.hook = async () => {
      await write(DAILY, '## Log\n- a\n\n## Notes\nx\ny\n');
      await device.sync();
    };
    const result = await agent.appendToSection(DAILY, ['Log'], ['- agent']);
    expect(result.status).toBe('committed');
    await device.sync();
    expect(text(DAILY)).toBe('## Log\n- a\n- agent\n\n## Notes\nx\ny\n');
  });

  it('proposes when a heading is ambiguous, once per retry', async () => {
    const { agent, admin } = await setup();
    await agent.createIfAbsent(DAILY, '# A\n## Log\n# B\n## Log\n');
    const first = await agent.appendToSection(DAILY, ['Log'], ['- x']);
    const again = await agent.appendToSection(DAILY, ['Log'], ['- x']);
    expect(first).toMatchObject({ status: 'proposed', reason: 'anchor-ambiguous' });
    expect(again).toEqual(first);
    expect(await admin.openProposals()).toHaveLength(1);
  });

  it('skips binary files and rejects bad input', async () => {
    const { agent } = await setup();
    await agent.createIfAbsent('img.png', new Uint8Array([0xff, 0xfe, 0x00]));
    expect(await agent.appendToSection('img.png', [], ['x'])).toEqual({
      status: 'skipped',
      reason: 'not-text',
    });
    await expect(agent.appendToSection(DAILY, [], ['a\nb'])).rejects.toThrow(AgentInputError);
    await expect(agent.appendToSection(DAILY, [], ['<!-- obsy:agent id=x -->'])).rejects.toThrow(
      AgentInputError,
    );
    await expect(agent.createIfAbsent('../x.md', '')).rejects.toThrow(AgentInputError);
    await expect(agent.replaceBlock(DAILY, 'bad id', 'x')).rejects.toThrow(AgentInputError);
  });

  it('keeps to its hourly limits', async () => {
    const { agent, env } = await setup({ limits: { commitsPerHour: 2, filesPerHour: 2 } });
    await agent.appendToSection('a.md', [], ['1']);
    await agent.appendToSection('a.md', [], ['2']);
    await expect(agent.appendToSection('a.md', [], ['3'])).rejects.toThrow(AgentRateLimited);
    env.advance(3_600_001);
    await agent.appendToSection('a.md', [], ['3']);
    await agent.appendToSection('b.md', [], ['1']);
    await expect(agent.appendToSection('c.md', [], ['1'])).rejects.toThrow(AgentRateLimited);
  });

  it('lists files and history', async () => {
    const { agent, device, write } = await setup();
    await agent.appendToSection('a.md', [], ['1']);
    await device.sync();
    await write('a.md', '1\nmine\n');
    await device.sync();
    await agent.appendToSection('a.md', [], ['2']);
    expect((await agent.list()).map((f) => f.path)).toEqual(['a.md']);
    const history = await agent.history('a.md');
    expect(history.map((r) => [r.rev, r.actor.id])).toEqual([
      [3, 'planner'],
      [2, 'mac'],
      [1, 'planner'],
    ]);
    expect((await agent.read('A.md'))?.text).toBe('1\nmine\n2\n');
  });
});

describe('VaultAgent replaceIfUnchanged', () => {
  it('replaces only at the revision it read, across devices and lost claims', async () => {
    const { agent, device, storage, text, write } = await setup();
    expect(await agent.replaceIfUnchanged(DAILY, '# Day\n', { baseRev: null })).toMatchObject({
      status: 'committed',
    });
    expect(await agent.replaceIfUnchanged(DAILY, 'again\n', { baseRev: null })).toEqual({
      status: 'changed',
      rev: 1,
    });
    await device.sync();
    const read = await agent.read(DAILY);
    if (read === null) throw new Error('no file');
    // A device edit after the read: nothing is written.
    await write(DAILY, '# Day\nmine\n');
    await device.sync();
    expect(await agent.replaceIfUnchanged(DAILY, '# Day\n- plan\n', { baseRev: read.rev })).toEqual(
      { status: 'changed', rev: 2 },
    );
    // A commit to another file wins the claim: the agent claims again and commits.
    storage.hook = async () => {
      await write('other.md', 'x\n');
      await device.sync();
    };
    const fresh = await agent.read(DAILY);
    const result = await agent.replaceIfUnchanged(DAILY, '# Day\nmine\n- plan\n', {
      baseRev: fresh?.rev ?? null,
    });
    expect(result).toMatchObject({ status: 'committed', seq: 4 });
    // The same file changed right before the claim: changed, nothing written.
    storage.hook = async () => {
      await device.sync();
      await write(DAILY, '# Day\nmine, edited\n- plan\n');
      await device.sync();
    };
    expect(await agent.replaceIfUnchanged(DAILY, '# Day\n- replaced\n', { baseRev: 4 })).toEqual({
      status: 'changed',
      rev: 5,
    });
    await device.sync();
    expect(text(DAILY)).toBe('# Day\nmine, edited\n- plan\n');
    await expect(agent.replaceIfUnchanged(DAILY, 'x', { baseRev: 0 })).rejects.toThrow(
      AgentInputError,
    );
  });
});

describe('VaultAgent blocks', () => {
  it('inserts, replaces, and leaves an unchanged block alone', async () => {
    const { agent, device, text } = await setup();
    const inserted = await agent.replaceBlock(DAILY, 'weather', 'Sunny', {
      insert: { section: ['## Weather'] },
    });
    expect(inserted.status).toBe('committed');
    const replaced = await agent.replaceBlock(
      DAILY,
      'weather',
      'Rain',
      'blockHash' in inserted && inserted.blockHash !== undefined
        ? { expectedHash: inserted.blockHash }
        : {},
    );
    expect(replaced.status).toBe('committed');
    expect((await agent.replaceBlock(DAILY, 'weather', 'Rain')).status).toBe('unchanged');
    await device.sync();
    expect(text(DAILY)).toMatch(
      /^## Weather\n<!-- obsy:agent id=weather hash=[0-9a-f]{16} -->\nRain\n<!-- \/obsy:agent id=weather -->\n$/,
    );
  });

  it('proposes after a person edits the block, or when the block is missing', async () => {
    const { agent, admin, device, text, write } = await setup();
    await agent.replaceBlock(DAILY, 'w', 'Sunny', { insert: {} });
    await device.sync();
    await write(DAILY, (text(DAILY) as string).replace('Sunny', 'Sunny, says me'));
    await device.sync();
    const result = await agent.replaceBlock(DAILY, 'w', 'Rain');
    expect(result).toMatchObject({ status: 'proposed', reason: 'block-edited' });
    expect(await agent.replaceBlock('other.md', 'w', 'x')).toEqual({
      status: 'skipped',
      reason: 'missing',
    });
    await agent.createIfAbsent('other.md', 'text\n');
    expect(await agent.replaceBlock('other.md', 'w', 'x')).toMatchObject({
      status: 'proposed',
      reason: 'anchor-missing',
    });
    // The person's text is untouched.
    await device.sync();
    expect(text(DAILY)).toContain('Sunny, says me');
    expect(await admin.openProposals()).toHaveLength(2);
  });

  it('proposes when the block holds other content than the agent last wrote', async () => {
    const { agent } = await setup();
    await agent.replaceBlock(DAILY, 'w', 'one', { insert: {} });
    expect(
      await agent.replaceBlock(DAILY, 'w', 'two', { expectedHash: '0000000000000000' }),
    ).toMatchObject({ status: 'proposed', reason: 'block-edited' });
  });
});

describe('presence', () => {
  it('proposes, waits, or ignores while a device edits the note', async () => {
    const { agent: _unused, bucket, env } = await setup();
    const make = (mode: 'propose' | 'wait' | 'ignore') =>
      new VaultAgent({
        storage: bucket,
        env,
        actor: { id: `agent-${mode}` },
        presence: { mode, windowMs: 120_000, maxWaitMs: 600_000, pollMs: 30_000 },
      });
    await make('ignore').createIfAbsent(DAILY, '- a\n');
    await new PresenceWriter(bucket, env, 'mac').write(DAILY, env.now());
    expect(await make('propose').appendToSection(DAILY, [], ['- p'])).toMatchObject({
      status: 'proposed',
      reason: 'editing',
    });
    expect((await make('ignore').appendToSection(DAILY, [], ['- i'])).status).toBe('committed');
    // Waiting moves the seeded clock past the window; then it commits.
    const before = env.now().getTime();
    expect((await make('wait').appendToSection(DAILY, [], ['- w'])).status).toBe('committed');
    expect(env.now().getTime() - before).toBeGreaterThanOrEqual(120_000);
  });

  it('proposes after the longest wait', async () => {
    const { bucket, env } = await setup();
    const agent = new VaultAgent({
      storage: bucket,
      env,
      actor: { id: 'a' },
      presence: { mode: 'wait', maxWaitMs: 60_000, pollMs: 30_000, windowMs: 10_000_000 },
    });
    await agent.createIfAbsent(DAILY, '- a\n');
    await new PresenceWriter(bucket, env, 'phone').write(DAILY, env.now());
    expect(await agent.appendToSection(DAILY, [], ['- w'])).toMatchObject({ reason: 'editing' });
  });
});

describe('VaultAdmin proposals', () => {
  it('accepts as is, merged with later edits, or not at all on a conflict', async () => {
    const { agent, admin, device, text, write } = await setup();
    await write(DAILY, '# A\n## Log\n# B\n## Log\n\n## Notes\nx\n');
    await device.sync();
    const proposed = await agent.appendToSection(DAILY, ['Log'], ['- agent']);
    if (proposed.status !== 'proposed') throw new Error('expected a proposal');
    // The owner edits elsewhere before accepting: a clean merge.
    await write(DAILY, '# A\n## Log\n# B\n## Log\n\n## Notes\nx\ny\n');
    await device.sync();
    const accepted = await admin.accept(proposed.proposalId);
    expect(accepted).toMatchObject({ status: 'accepted', merged: true });
    await device.sync();
    expect(text(DAILY)).toBe('# A\n## Log\n# B\n## Log\n\n## Notes\nx\ny\n- agent\n');
    expect(await admin.accept(proposed.proposalId)).toMatchObject({ status: 'resolved' });
    expect(await admin.openProposals()).toHaveLength(0);

    // A conflicting edit at the same place keeps the proposal open.
    const second = await agent.proposePatch(DAILY, 'replaced\n', { rationale: 'tidy' });
    if (second.status !== 'proposed') throw new Error('expected a proposal');
    await write(DAILY, 'mine\n');
    await device.sync();
    expect(await admin.accept(second.proposalId)).toEqual({
      status: 'conflict',
      reason: 'conflict',
    });
    expect((await admin.reject(second.proposalId)).outcome).toBe('rejected');
    expect(await admin.openProposals()).toHaveLength(0);
  });

  it('accepts a proposed new file, and shows the details', async () => {
    const { agent, admin, device, text } = await setup();
    const proposed = await agent.proposePatch('new.md', 'fresh\n', { rationale: 'why' });
    if (proposed.status !== 'proposed') throw new Error('expected a proposal');
    const detail = await admin.proposal(proposed.proposalId);
    expect(detail).toMatchObject({ baseText: null, proposedText: 'fresh\n', head: null });
    expect(detail?.proposal.rationale).toBe('why');
    expect((await admin.accept(proposed.proposalId)).status).toBe('accepted');
    await device.sync();
    expect(text('new.md')).toBe('fresh\n');
  });
});

describe('VaultAdmin undo', () => {
  it('reverts an agent append three-way, keeping later edits', async () => {
    const { agent, admin, device, text, write } = await setup();
    await write(DAILY, '- a\n\n## Notes\nx\n');
    await device.sync();
    const appended = await agent.appendToSection(DAILY, [], ['- agent']);
    if (appended.status !== 'committed') throw new Error('expected a commit');
    await device.sync();
    await write(DAILY, 'top\n' + (text(DAILY) as string));
    await device.sync();
    expect(await admin.undo(appended.seq)).toMatchObject({ status: 'committed', files: 1 });
    await device.sync();
    expect(text(DAILY)).toBe('top\n- a\n\n## Notes\nx\n');
    expect(await admin.undo(appended.seq)).toEqual({ status: 'unchanged' });
  });

  it('removes a created file, moves back, restores a deleted file', async () => {
    const { agent, admin, device, files, text, write, commitAt } = await setup();
    const created = await agent.createIfAbsent('new.md', 'n\n');
    if (created.status !== 'committed') throw new Error('expected a commit');
    expect((await admin.undo(created.seq)).status).toBe('committed');
    await device.sync();
    expect(text('new.md')).toBeUndefined();

    await write('a.md', 'a\n');
    await device.sync();
    files.userMove('a.md', 'b.md');
    const moved = await device.sync();
    expect(moved.commits).toBe(1);
    const moveSeq = (await agent.reader.head()).seq;
    expect((await commitAt(moveSeq)).ops[0]?.type).toBe('move');
    expect((await admin.undo(moveSeq)).status).toBe('committed');
    await device.sync();
    expect(text('a.md')).toBe('a\n');

    files.userRemove('a.md');
    await device.sync();
    const deleteSeq = (await agent.reader.head()).seq;
    expect((await admin.undo(deleteSeq)).status).toBe('committed');
    await device.sync();
    expect(text('a.md')).toBe('a\n');
  });

  it('refuses when a later edit conflicts', async () => {
    const { agent, admin, device, text, write } = await setup();
    await write('a.md', 'one\n');
    await device.sync();
    const appended = await agent.appendToSection('a.md', [], ['two']);
    if (appended.status !== 'committed') throw new Error('expected a commit');
    await device.sync();
    await write('a.md', (text('a.md') as string).replace('two', 'two, edited'));
    await device.sync();
    expect(await admin.undo(appended.seq)).toEqual({
      status: 'refused',
      problems: [{ fileId: appended.fileId, path: 'a.md', reason: 'conflict' }],
    });
  });
});
