import type { Db } from '../db'
import type { BlobSigner } from '../storage/signer'
import type { DerivativeServices } from './derivatives'

// Per-request dependencies passed to services. Plain values, no framework types.
export type ServiceContext = {
  db: Db
  bucket: R2Bucket
  signer: BlobSigner
  now: () => Date
  // Images + queue for server-rendered derivatives (D-042). Null when the deployment has not bound both.
  derivatives: DerivativeServices | null
}
