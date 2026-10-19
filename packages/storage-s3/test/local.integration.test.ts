// Conformance against a local S3-compatible server in Docker. This is a local
// harness target, not a supported provider. Run it with
// `pnpm run test:s3-local`; see docs/runbooks/storage-conformance.md.
import { fileURLToPath } from 'node:url';

import { describeS3Run, localRunOptions } from './harness';

describeS3Run(
  localRunOptions(fileURLToPath(new URL('../.env.s3-local', import.meta.url))),
  'local S3 server (not started; run pnpm run test:s3-local)',
);
