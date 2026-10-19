// Conformance against a live R2 or S3 bucket. Use a scratch bucket. The run
// writes only under a fresh `obsy-conformance/<run id>/` sub-prefix and
// deletes only that sub-prefix afterwards.
//
// Settings come from the environment or from the ignored `.env.local` file at
// the repository root. See docs/runbooks/storage-conformance.md.
import { fileURLToPath } from 'node:url';

import { describeS3Run, liveRunOptions } from './harness';

describeS3Run(
  liveRunOptions(fileURLToPath(new URL('../../../.env.local', import.meta.url))),
  'live R2/S3 (not configured; set OBSY_S3_* in .env.local)',
);
