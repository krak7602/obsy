// A test Worker for the live R2 binding run. It runs `R2Storage` against a
// real R2 binding and answers one `Storage` call per request, so that the
// conformance suite and the race harness can run from Node. It refuses
// requests without the run's bearer token, and it touches only keys under
// `obsy-conformance/`. The run script deploys it and deletes it afterwards.
// See docs/runbooks/storage-conformance.md#live-r2-binding-run.
import { R2Storage, type R2BucketLike } from '../src/index';
import { errorToWire, fromBase64, toBase64 } from './wire';
import type { WireCall, WireReply } from './wire';

interface Env {
  readonly BUCKET: R2BucketLike;
  readonly OBSY_TOKEN?: string;
}

/** Every key the Worker reads or writes is under this prefix. */
const ROOT = 'obsy-conformance/';

const encoder = new TextEncoder();

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** Compares the bearer token in constant time. No token configured: refuse. */
async function authorised(request: Request, token: string | undefined): Promise<boolean> {
  if (token === undefined || token.length < 32) return false;
  const [given, expected] = await Promise.all([
    digest(request.headers.get('authorization') ?? ''),
    digest(`Bearer ${token}`),
  ]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (given[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}

async function answer(bucket: R2BucketLike, call: WireCall): Promise<WireReply> {
  try {
    if (call.op === 'ping') return { ok: true, value: null };
    const root = new R2Storage(bucket, { prefix: ROOT });
    const storage = call.root === '' ? root : root.withPrefix(call.root);
    switch (call.op) {
      case 'get': {
        const object = await storage.get(call.key);
        const value = object === null ? null : { etag: object.etag, body: toBase64(object.body) };
        return { ok: true, value };
      }
      case 'putIfAbsent':
        return {
          ok: true,
          value: await storage.putIfAbsent(call.key, fromBase64(call.body), call.contentType),
        };
      case 'putIfMatch':
        return {
          ok: true,
          value: await storage.putIfMatch(
            call.key,
            fromBase64(call.body),
            call.etag,
            call.contentType,
          ),
        };
      case 'list':
        return { ok: true, value: await storage.list(call.prefix, call.startAfter, call.limit) };
      case 'delete':
        await storage.delete(call.key);
        return { ok: true, value: null };
    }
  } catch (error) {
    return { ok: false, error: errorToWire(error) };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST' || !(await authorised(request, env.OBSY_TOKEN))) {
      return new Response(null, { status: 404 });
    }
    const call = (await request.json()) as WireCall;
    return new Response(JSON.stringify(await answer(env.BUCKET, call)), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
