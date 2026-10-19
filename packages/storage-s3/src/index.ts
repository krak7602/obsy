/**
 * `Storage` over the S3 API for obsy. Works with Cloudflare R2 and AWS S3.
 * See docs/subsystems/storage.md.
 */
export { S3Storage } from './s3-storage';
export type { S3StorageOptions } from './s3-storage';
export type { FetchLike, FetchRequestInit, FetchResponseLike } from './web';
