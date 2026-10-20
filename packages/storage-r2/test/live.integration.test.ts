// Conformance of `R2Storage` against a real R2 binding, through a deployed
// test Worker. Run it with `pnpm run test:r2-live`, which deploys the Worker,
// sets OBSY_R2_WORKER_URL and OBSY_R2_WORKER_TOKEN, and deletes the Worker
// afterwards. The run writes only under `obsy-conformance/<run id>/` and
// deletes only that sub-prefix. See docs/runbooks/storage-conformance.md.
import { describeR2Run } from './live-run';

describeR2Run(process.env['OBSY_R2_WORKER_URL'], process.env['OBSY_R2_WORKER_TOKEN']);
