import type { BlobSigner } from '../storage/signer'

// Per-request dependencies passed to services. Plain values, no framework types.
export type ServiceContext = {
  db: D1Database
  bucket: R2Bucket
  signer: BlobSigner
  now: () => Date
}
