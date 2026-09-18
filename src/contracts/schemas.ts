import { z } from '@hono/zod-openapi'

// API schemas shared by the Worker (runtime validation + OpenAPI) and clients (types only).
// Nothing here may reference server secrets or storage credentials.

export const LIMITS = {
  originalMaxBytes: 100 * 1024 * 1024,
  thumbnailMaxBytes: 2 * 1024 * 1024,
  previewMaxBytes: 10 * 1024 * 1024,
  pageMax: 200,
  albumTitleMax: 200,
  filenameMax: 255,
  shareMaxDays: 365,
} as const

export const ORIGINAL_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export const IdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Invalid id')
  .openapi({ example: '0b8f1d3e-4c6a-4f51-9a0e-2b7c5d9e8f10' })

export const ShareIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/, 'Invalid share id')
  .openapi({ example: 'k3Jd8sLw0qPzXv5bNcRt2A' })

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected lowercase hex SHA-256')

// ISO 8601 date-time. The offset is optional because EXIF often lacks timezone information.
export const TakenAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/, 'Expected ISO 8601 date-time')
  .openapi({ example: '2024-05-01T10:20:30+09:00' })

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi('Error')

// ---- Assets ----

// List items carry only the thumbnail URL; the preview URL is signed when one asset is requested.
export const AssetSummarySchema = z
  .object({
    id: IdSchema,
    sha256: Sha256Schema,
    originalSize: z.number().int(),
    contentType: z.enum(ORIGINAL_CONTENT_TYPES),
    filename: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    takenAt: z.string().nullable(),
    isFavorite: z.boolean(),
    trashedAt: z.string().nullable(),
    createdAt: z.string(),
    thumbnailUrl: z.url(),
    urlsExpireAt: z.string(),
  })
  .openapi('AssetSummary')

export const AssetSchema = AssetSummarySchema.extend({ previewUrl: z.url() }).openapi('Asset')

export const AssetPageSchema = z
  .object({ items: z.array(AssetSummarySchema), nextCursor: z.string().nullable() })
  .openapi('AssetPage')

export const AssetPatchSchema = z.object({ isFavorite: z.boolean() }).openapi('AssetPatch')

export const SignedUrlSchema = z.object({ url: z.url(), expiresAt: z.string() }).openapi('SignedUrl')

// ---- Uploads ----

export const UploadReserveSchema = z
  .object({
    original: z.object({
      size: z.number().int().positive().max(LIMITS.originalMaxBytes),
      contentType: z.enum(ORIGINAL_CONTENT_TYPES),
      sha256: Sha256Schema,
    }),
    thumbnail: z.object({ size: z.number().int().positive().max(LIMITS.thumbnailMaxBytes) }),
    preview: z.object({ size: z.number().int().positive().max(LIMITS.previewMaxBytes) }),
    metadata: z
      .object({
        filename: z.string().min(1).max(LIMITS.filenameMax).optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        takenAt: TakenAtSchema.optional(),
        // When the photo was first added to a library. Restore sends the value from the backup so that the
        // timeline order of photos without a capture time survives; other clients omit it (= now).
        createdAt: z.iso.datetime({ offset: true }).optional(),
      })
      .default({}),
  })
  .openapi('UploadReserve')

export const UploadTargetSchema = z
  .object({
    method: z.literal('PUT'),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  })
  .openapi('UploadTarget')

export const UploadReservationSchema = z
  .object({
    upload: z.object({
      id: IdSchema,
      status: z.literal('pending'),
      expiresAt: z.string(),
    }),
    targets: z.object({
      original: UploadTargetSchema,
      thumbnail: UploadTargetSchema,
      preview: UploadTargetSchema,
    }),
  })
  .openapi('UploadReservation')

export const UploadFinalizeResultSchema = z
  .object({
    result: z.enum(['created', 'duplicate']),
    asset: AssetSchema,
  })
  .openapi('UploadFinalizeResult')

// ---- Albums ----

export const AlbumSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    assetCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Album')

export const AlbumListItemSchema = AlbumSchema.extend({
  // With ?covers=true: the newest photo's thumbnail, or null for an empty album. One request for the whole
  // list instead of one per album.
  coverThumbnailUrl: z.url().nullable().optional(),
}).openapi('AlbumListItem')

export const AlbumListSchema = z.object({ items: z.array(AlbumListItemSchema) }).openapi('AlbumList')

export const AlbumInputSchema = z
  .object({ title: z.string().trim().min(1).max(LIMITS.albumTitleMax) })
  .openapi('AlbumInput')

// ---- Shares (owner side) ----

export const ShareSchema = z
  .object({
    id: ShareIdSchema,
    albumId: IdSchema,
    status: z.enum(['active', 'expired', 'revoked']),
    createdAt: z.string(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .openapi('Share')

export const ShareListSchema = z.object({ items: z.array(ShareSchema) }).openapi('ShareList')

export const ShareCreateSchema = z
  .object({ expiresInDays: z.number().int().min(1).max(LIMITS.shareMaxDays) })
  .openapi('ShareCreate')

export const ShareCreatedSchema = z
  .object({
    share: ShareSchema,
    // Returned exactly once. Clients must put it in the URL fragment, never in the query.
    secret: z.string(),
    url: z.url(),
  })
  .openapi('ShareCreated')

// ---- Shares (public capability API) ----

export const SharedAssetSchema = z
  .object({
    id: IdSchema,
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    thumbnailUrl: z.url(),
  })
  .openapi('SharedAsset')

export const SharedAlbumSchema = z
  .object({
    album: z.object({ title: z.string() }),
    expiresAt: z.string(),
    urlsExpireAt: z.string(),
    items: z.array(SharedAssetSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('SharedAlbum')

export const ShareVariantSchema = z.enum(['thumbnail', 'preview'])

// ---- Export ----

export const ExportAssetSchema = z
  .object({
    id: IdSchema,
    sha256: Sha256Schema,
    originalSize: z.number().int(),
    contentType: z.enum(ORIGINAL_CONTENT_TYPES),
    filename: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    takenAt: z.string().nullable(),
    isFavorite: z.boolean(),
    trashedAt: z.string().nullable(),
    createdAt: z.string(),
    objects: z.object({ original: z.string(), thumbnail: z.string(), preview: z.string() }),
  })
  .openapi('ExportAsset')

export const ExportManifestSchema = z
  .object({
    format: z.literal('edgephotos-export'),
    formatVersion: z.literal(1),
    exportedAt: z.string(),
    assets: z.array(ExportAssetSchema),
    albums: z.array(
      z.object({
        id: IdSchema,
        title: z.string(),
        createdAt: z.string(),
        assetIds: z.array(IdSchema),
      }),
    ),
  })
  .openapi('ExportManifest')

// ---- Storage audit / cleanup (docs/decisions.md D-023) ----

export const STORAGE_AUDIT_ISSUE_KINDS = [
  // An asset whose original object is gone or differs from what finalize verified. Data loss.
  'missing_original',
  'original_size_mismatch',
  'original_checksum_mismatch',
  // Deep audit only: R2 has no SHA-256 for this original (stored before D-018). Compare it by download.
  'original_checksum_unrecorded',
  // Thumbnail / preview missing: the photo is intact but shows as broken.
  'missing_derivative',
  // Permanent delete that did not finish (resume it).
  'unfinished_delete',
  // Upload that was never finalized and whose URLs expired. Resolved by cleanup.
  'expired_upload',
  // Objects of an upload that turned out to be a duplicate (or was abandoned). Removed by cleanup.
  'duplicate_leftover',
  // Objects no D1 row refers to. Never removed automatically: D1 may have been rolled back.
  'unreferenced_objects',
  // A key outside the documented layout.
  'unexpected_key',
  // The audit could not list every key of this id (thousands of stray keys under it). Not a clean result.
  'audit_incomplete',
] as const

const StorageVariantSchema = z.enum(['original', 'thumbnail', 'preview'])

export const StorageAuditIssueSchema = z
  .object({
    kind: z.enum(STORAGE_AUDIT_ISSUE_KINDS),
    assetId: IdSchema.nullable(),
    uploadId: IdSchema.optional(),
    objects: z.array(StorageVariantSchema).optional(),
    key: z.string().optional(),
  })
  .openapi('StorageAuditIssue')

export const StorageAuditPageSchema = z
  .object({
    checked: z.object({
      assets: z.number().int(),
      uploadsInProgress: z.number().int(),
      objects: z.number().int(),
      // Originals stored before R2 recorded checksums (deep audit only). Compare them with `pnpm backup verify`.
      checksumsUnrecorded: z.number().int(),
    }),
    issues: z.array(StorageAuditIssueSchema),
    // Pass as `after` for the next page; null when the scan is complete.
    nextAfter: z.string().nullable(),
  })
  .openapi('StorageAuditPage')

export const StorageCleanupResultSchema = z
  .object({
    // Asset ids of interrupted uploads whose objects were complete and valid, now in the library.
    completed: z.array(IdSchema),
    // Interrupted uploads that could never be finalized (objects missing or invalid).
    abandoned: z.number().int(),
    // Upload records whose leftover objects were removed.
    cleared: z.number().int(),
    failed: z.number().int(),
    more: z.boolean(),
  })
  .openapi('StorageCleanupResult')

export type StorageAuditIssue = z.infer<typeof StorageAuditIssueSchema> & { sortKey?: string }
export type StorageAuditPage = z.infer<typeof StorageAuditPageSchema>
export type StorageCleanupResult = z.infer<typeof StorageCleanupResultSchema>
// Paged export. Clients assemble these pages into an ExportManifest (src/contracts/export-manifest.ts); a single
// response for the whole library would not fit a Worker's memory at 100k photos (docs/benchmarks.md).
export const EXPORT_PAGE_MAX = 1000

export const ExportAssetPageSchema = z
  .object({ items: z.array(ExportAssetSchema), nextAfter: IdSchema.nullable() })
  .openapi('ExportAssetPage')

export const ExportAlbumListSchema = z
  .object({ items: z.array(z.object({ id: IdSchema, title: z.string(), createdAt: z.string() })) })
  .openapi('ExportAlbumList')

export const ExportMembershipPageSchema = z
  .object({
    items: z.array(z.object({ albumId: IdSchema, assetId: IdSchema })),
    // `{albumId}/{assetId}` of the last item; null on the last page.
    nextAfter: z.string().nullable(),
  })
  .openapi('ExportMembershipPage')

export type ExportAssetPage = z.infer<typeof ExportAssetPageSchema>
export type ExportAlbumList = z.infer<typeof ExportAlbumListSchema>
export type ExportMembershipPage = z.infer<typeof ExportMembershipPageSchema>
export type AssetSummary = z.infer<typeof AssetSummarySchema>
export type Asset = z.infer<typeof AssetSchema>
export type AssetPage = z.infer<typeof AssetPageSchema>
export type UploadReserve = z.input<typeof UploadReserveSchema>
export type UploadReservation = z.infer<typeof UploadReservationSchema>
export type UploadFinalizeResult = z.infer<typeof UploadFinalizeResultSchema>
export type Album = z.infer<typeof AlbumSchema>
export type AlbumListItem = z.infer<typeof AlbumListItemSchema>
export type Share = z.infer<typeof ShareSchema>
export type ShareCreated = z.infer<typeof ShareCreatedSchema>
export type SharedAlbum = z.infer<typeof SharedAlbumSchema>
export type SignedUrl = z.infer<typeof SignedUrlSchema>
export type ExportManifest = z.infer<typeof ExportManifestSchema>
export type ApiError = z.infer<typeof ErrorSchema>
