import { api } from '../../lib/api/client'
import { renderDerivatives, sha256Hex } from '../../lib/image'
import { putSigned } from '../../lib/storage-transfer'
import type { RepairDeps } from './repair'

// Wires the pure repair loop (./repair.ts) to the browser: the API, a checked download of the original, the
// upload pipeline's renderer, and the upload pipeline's PUT.

export class SourceMismatchError extends Error {}

// The repair is only as trustworthy as the bytes it rebuilds from, so the download is compared with the
// digest R2 verified when the photo was uploaded (D-018) before anything is decoded. A truncated or
// substituted download is refused here rather than turned into a wrong thumbnail.
export const repairDeps: RepairDeps = {
  repair: (assetId) => api.repairDerivatives(assetId),
  fetchOriginal: async (source) => {
    // Presigned URL: the signature is the credential, so no cookies or Access assertion go with it.
    const res = await fetch(source.url, { credentials: 'omit' })
    if (!res.ok) throw new SourceMismatchError(`Could not read the original (${res.status})`)
    const bytes = await res.arrayBuffer()
    if ((await sha256Hex(bytes)) !== source.sha256) throw new SourceMismatchError('The original did not match')
    return new Blob([bytes], { type: source.contentType })
  },
  render: renderDerivatives,
  put: putSigned,
}
