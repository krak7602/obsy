import { describe, expect, it } from 'vite-plus/test';

import { describeStorageConformance } from './conformance';
import { MemoryStorage } from './memory-storage';
import { randomYieldScheduler } from './runtime';

describeStorageConformance({
  name: 'MemoryStorage',
  create: () => new MemoryStorage(),
});

let seed = 1;
describeStorageConformance({
  name: 'MemoryStorage (random interleaving, 3-key pages)',
  create: () => new MemoryStorage({ scheduler: randomYieldScheduler(seed++), pageSize: 3 }),
  race: { createWriters: 16, createRounds: 50, logWriters: 8, commitsPerWriter: 20, listLimit: 4 },
});

describe('MemoryStorage details', () => {
  it('gives identical bodies identical etags, like S3 MD5 etags', async () => {
    const storage = new MemoryStorage();
    const bytes = new Uint8Array([1, 2, 3]);
    const a = await storage.putIfAbsent('a', bytes, 'application/octet-stream');
    const b = await storage.putIfAbsent('b', bytes, 'application/octet-stream');
    expect(a.etag).toBe(b.etag);
  });

  it('stores the content type', async () => {
    const storage = new MemoryStorage();
    await storage.putIfAbsent('a', new Uint8Array(), 'application/json');
    expect(storage.contentTypeOf('a')).toBe('application/json');
    expect(storage.size).toBe(1);
  });

  it('returns at most pageSize keys and reports truncated', async () => {
    const storage = new MemoryStorage({ pageSize: 2 });
    for (const key of ['a', 'b', 'c']) await storage.putIfAbsent(key, new Uint8Array(), 'x/y');
    expect(await storage.list('', undefined, 10)).toEqual({ keys: ['a', 'b'], truncated: true });
  });
});
