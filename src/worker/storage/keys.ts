// R2 object layout. Keys contain only server-generated ids: never filenames, emails,
// capture dates or share secrets.

export type Variant = 'original' | 'thumbnail' | 'preview'

export const DERIVATIVE_VERSION = 'v1'

const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function objectKey(assetId: string, variant: Variant): string {
  if (!ASSET_ID_RE.test(assetId)) throw new Error('invalid asset id for object key')
  switch (variant) {
    case 'original':
      return `originals/${assetId}`
    case 'thumbnail':
      return `derivatives/${DERIVATIVE_VERSION}/${assetId}/thumbnail.jpg`
    case 'preview':
      return `derivatives/${DERIVATIVE_VERSION}/${assetId}/preview.jpg`
  }
}

export function assetObjectKeys(assetId: string) {
  return {
    original: objectKey(assetId, 'original'),
    thumbnail: objectKey(assetId, 'thumbnail'),
    preview: objectKey(assetId, 'preview'),
  }
}
