#!/usr/bin/env node
/**
 * The `obsy` command. See docs/runbooks/cli.md, or run `obsy --help`.
 */
import { readFile } from 'node:fs/promises';

import { main } from './cli';

async function readStdin(): Promise<Uint8Array> {
  if (process.stdin.isTTY) return new Uint8Array();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdoutBytes: (bytes) => process.stdout.write(bytes),
  stdin: readStdin,
  readFile: async (path) => new Uint8Array(await readFile(path)),
});
process.exitCode = code;
