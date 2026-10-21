import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SeededEnvironment } from '@obsy/core';
import { decodeUtf8Strict, encodeUtf8 } from '@obsy/protocol';
import { MemoryStorage } from '@obsy/storage-testkit';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { main, type CliIo } from './cli';

const ENV = {
  OBSY_S3_ENDPOINT: 'https://s3.example.test',
  OBSY_S3_BUCKET: 'example',
  OBSY_S3_ACCESS_KEY_ID: 'id-value',
  OBSY_S3_SECRET_ACCESS_KEY: 'secret-value',
  OBSY_AGENT: 'planner',
};

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'obsy-cli-test-'));
  temps.push(dir);
  return dir;
}

function harness(env: Record<string, string | undefined> = ENV) {
  const bucket = new MemoryStorage();
  const environment = new SeededEnvironment(3);
  let input: Uint8Array = new Uint8Array();
  const out = { stdout: '', stderr: '', bytes: [] as Uint8Array[] };
  const io: CliIo = {
    env,
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    stdoutBytes: (bytes) => {
      out.bytes.push(bytes);
    },
    stdin: () => Promise.resolve(input),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    storage: () => bucket,
    environment,
  };
  const obsy = async (args: string[], stdin?: string): Promise<number> => {
    out.stdout = '';
    out.stderr = '';
    out.bytes = [];
    input = encodeUtf8(stdin ?? '');
    return main(args, io);
  };
  return { obsy, out, bucket };
}

describe('obsy CLI', () => {
  it('names missing variables without printing values', async () => {
    const { obsy, out } = harness({ OBSY_S3_SECRET_ACCESS_KEY: 'secret-value' });
    expect(await obsy(['status'])).toBe(2);
    expect(out.stderr).toContain('OBSY_S3_ENDPOINT, OBSY_S3_BUCKET, OBSY_S3_ACCESS_KEY_ID');
    expect(out.stderr).not.toContain('secret-value');
    expect(await obsy(['nonsense'])).toBe(2);
    expect(await obsy(['--bogus'])).toBe(2);
    expect(await obsy(['--help'])).toBe(0);
  });

  it('creates a vault, appends, reads, and shows history', async () => {
    const { obsy, out } = harness();
    expect(await obsy(['init'])).toBe(0);
    expect(out.stdout).toMatch(/^created vault v_/);
    expect(await obsy(['init'])).toBe(0);
    expect(out.stdout).toMatch(/^the prefix already has vault/);
    expect(
      await obsy([
        'append',
        'daily/d.md',
        '--section',
        '## Log',
        '--run',
        'r1',
        '--',
        '- one',
        '- two',
      ]),
    ).toBe(0);
    expect(out.stdout).toBe('committed: daily/d.md at seq 1\n');
    expect(await obsy(['append', 'daily/d.md', '--section', '## Log'], '- three\n')).toBe(0);
    expect(await obsy(['cat', 'daily/d.md'])).toBe(0);
    expect(decodeUtf8Strict(out.bytes[0] as Uint8Array)).toBe('## Log\n- one\n- two\n- three\n');
    expect(await obsy(['history', 'daily/d.md'])).toBe(0);
    expect(out.stdout.split('\n')[1]).toContain('agent planner run r1\tput\tdaily/d.md');
    expect(await obsy(['ls', '--json'])).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject([{ path: 'daily/d.md', rev: 2 }]);
    expect(await obsy(['cat', 'missing.md'])).toBe(1);
  });

  it('needs an agent ID for writes', async () => {
    const { obsy, out } = harness({ ...ENV, OBSY_AGENT: undefined });
    await obsy(['init']);
    expect(await obsy(['append', 'a.md', 'x'])).toBe(2);
    expect(out.stderr).toContain('--agent or OBSY_AGENT');
    expect(await obsy(['append', 'a.md', 'x', '--agent', 'bot'])).toBe(0);
  });

  it('replaces blocks, proposes, and the owner accepts and undoes', async () => {
    const { obsy, out } = harness();
    await obsy(['init']);
    expect(await obsy(['block', 'n.md', 'w', '--insert', '--json'], 'Sunny\n')).toBe(0);
    const first = JSON.parse(out.stdout) as { status: string; blockHash: string; seq: number };
    expect(first.status).toBe('committed');
    expect(await obsy(['block', 'n.md', 'w', '--expect', first.blockHash], 'Rain\n')).toBe(0);
    expect(out.stdout).toMatch(/^committed: n\.md at seq 2 \(block hash [0-9a-f]{16}\)/);
    expect(await obsy(['block', 'n.md', 'w', '--expect', first.blockHash], 'Snow\n')).toBe(0);
    expect(out.stdout).toMatch(/^proposed: p_[a-z2-7]{24} \(block-edited\)\n$/);
    const id = /proposed: (p_[a-z2-7]{24})/.exec(out.stdout)?.[1] as string;
    expect(await obsy(['proposals'])).toBe(0);
    expect(out.stdout).toContain(`${id}\t`);
    expect(await obsy(['proposals', 'show', id])).toBe(0);
    expect(out.stdout).toContain('\n- Rain\n');
    expect(out.stdout).toContain('\n+ Snow\n');
    expect(await obsy(['proposals', 'accept', id])).toBe(0);
    expect(out.stdout).toBe('accepted at seq 3\n');
    expect(await obsy(['undo', '3'])).toBe(0);
    expect(out.stdout).toBe('undone: commit 3 reversed by commit 4 (1 files)\n');
    expect(await obsy(['cat', 'n.md'])).toBe(0);
    expect(decodeUtf8Strict(out.bytes[0] as Uint8Array)).toContain('\nRain\n');
    expect(await obsy(['status'])).toBe(0);
    expect(out.stdout).toContain('head seq 4: 1 files');
    expect(out.stdout).toContain('open proposals: 0');
  });

  it('exports a seq into a new folder and verifies a folder', async () => {
    const { obsy, out } = harness();
    await obsy(['init']);
    await obsy(['create', 'a.md'], 'one\n');
    await obsy(['create', 'deep/b.md'], 'two\n');
    await obsy(['append', 'a.md', 'more']);
    const dir = join(await tempDir(), 'export');
    expect(await obsy(['export', dir, '--seq', '2'])).toBe(0);
    expect(out.stdout).toBe('exported seq 2: 2 files, 8 bytes\n');
    expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe('one\n');
    expect(await obsy(['export', dir])).toBe(1);
    expect(out.stderr).toContain('is not empty');
    // The folder holds seq 2; the head is at 3.
    expect(await obsy(['verify', dir])).toBe(1);
    expect(out.stdout).toContain('content\ta.md');
    await writeFile(join(dir, 'a.md'), 'one\nmore\n');
    await writeFile(join(dir, '.hidden'), 'not synced');
    expect(await obsy(['verify', dir])).toBe(0);
    expect(out.stdout).toContain('no differences');
  });

  it('reads variables from --env-file, and the environment wins', async () => {
    const dir = await tempDir();
    const file = join(dir, '.env');
    await writeFile(file, 'OBSY_S3_ENDPOINT=https://other.example.test\nOBSY_AGENT=from-file\n');
    const { obsy, out } = harness({ ...ENV, OBSY_S3_ENDPOINT: undefined, OBSY_AGENT: 'from-env' });
    expect(await obsy(['init', '--env-file', file])).toBe(0);
    expect(await obsy(['append', 'a.md', 'x', '--env-file', file])).toBe(0);
    expect(await obsy(['history', 'a.md', '--env-file', file])).toBe(0);
    expect(out.stdout).toContain('agent from-env');
  });
});
