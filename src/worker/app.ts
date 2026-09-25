import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context, Hono } from 'hono'
import {
  AlbumInputSchema,
  AlbumListSchema,
  AlbumSchema,
  AssetMonthsSchema,
  AssetPageSchema,
  AssetPatchSchema,
  AssetSchema,
  DerivativeRepairSchema,
  ErrorSchema,
  EXPORT_PAGE_MAX,
  ExportAlbumListSchema,
  ExportAssetPageSchema,
  ExportMembershipPageSchema,
  IdSchema,
  LIMITS,
  RestoreUploadReserveSchema,
  ShareCreatedSchema,
  ShareCreateSchema,
  SharedAlbumSchema,
  ShareIdSchema,
  ShareListSchema,
  ShareSchema,
  ShareVariantSchema,
  SignedUrlSchema,
  StorageAuditPageSchema,
  StorageCleanupResultSchema,
  UploadFinalizeResultSchema,
  UploadReservationSchema,
  UploadReserveSchema,
} from '../contracts/schemas'
import { type AccessKeyResolver, type AppPrincipal, authenticateAccess, remoteAccessKeys } from './auth/access'
import { createDb } from './db'
import { type AppConfig, appConfigProblems, type Env, readAppConfig } from './env'
import { ApiError, errorResponse, requestId } from './http/errors'
import {
  checkWriteOrigin,
  PRIVATE_HEADERS,
  privateContentSecurityPolicy,
  SHARE_HEADERS,
  shareContentSecurityPolicy,
  withHeaders,
} from './http/security'
import * as albums from './services/albums'
import * as assets from './services/assets'
import type { ServiceContext } from './services/context'
import { diagnostics, exportAlbums, exportAssetsPage, exportMembershipsPage, recordBackup } from './services/export'
import { repairDerivatives } from './services/repair'
import * as shares from './services/shares'
import { auditStorage, cleanupUploads } from './services/storage-audit'
import * as uploads from './services/uploads'
import { type BlobSigner, createR2Signer, r2SignerConfigProblems, readR2SignerConfig } from './storage/signer'

export type AppOptions = {
  env: Env
  now?: () => Date
  accessKeys?: AccessKeyResolver
  // Overrides the R2 SigV4 signer. Used for local development and tests only.
  signer?: BlobSigner
  // Extra routes mounted before everything else (local development blob endpoint and tests only).
  localRoutes?: { prefix: string; app: Hono }
  // `vite dev` only: the nonce its client puts on the <style>/<script> tags it injects.
  devCspNonce?: string
}

type Vars = {
  principal: AppPrincipal
  config: AppConfig
  services: ServiceContext
  requestId: string
}

type AppEnv = { Variables: Vars }

const errorResponses = {
  400: { description: 'Invalid request', content: { 'application/json': { schema: ErrorSchema } } },
  401: { description: 'Not authenticated', content: { 'application/json': { schema: ErrorSchema } } },
  403: {
    description: 'Not a household member or origin not allowed',
    content: { 'application/json': { schema: ErrorSchema } },
  },
  404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
  503: { description: 'Server misconfigured', content: { 'application/json': { schema: ErrorSchema } } },
} as const

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
})

// The response stays opaque; the log names the settings (never their values) so the operator can fix them.
function misconfigured(c: Context, env: Env, withSigner: boolean) {
  const settings = [...appConfigProblems(env), ...(withSigner ? r2SignerConfigProblems(env) : [])]
  console.warn(JSON.stringify({ level: 'warn', requestId: requestId(c), problem: 'misconfigured', settings }))
  return new ApiError(503, 'SERVER_MISCONFIGURED', 'Server configuration is incomplete.')
}

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageMax).default(60),
  cursor: z.string().max(512).optional(),
  // 'newer' reads the page above the cursor. Without a cursor there is nothing above the newest photo,
  // so the combination is rejected rather than silently read as the first page.
  direction: z.enum(['older', 'newer']).optional(),
})

// Without a cursor there is nothing above the newest photo, so the combination is refused instead of being
// read as the first page. Checked here rather than with `.refine`, which would leave the query schema no
// longer an object for OpenAPI and `.extend`.
function checkedPageQuery<T extends { cursor?: string; direction?: 'older' | 'newer' }>(q: T): T {
  if (q.direction === 'newer' && q.cursor === undefined) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'direction=newer needs a cursor.')
  }
  return q
}

const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional()

// A page load, not a subresource: only these get the app for a path that is not a file. A missing image,
// script or JSON stays a 404 instead of turning into a 200 text/html app. Browsers say so with
// Sec-Fetch-Mode; a client without it (curl, an old browser) is asked by Accept instead.
function isDocumentRequest(headers: Headers): boolean {
  const mode = headers.get('sec-fetch-mode')
  if (mode !== null) return mode === 'navigate'
  return (headers.get('accept') ?? '').includes('text/html')
}

export function createApp(options: AppOptions) {
  const { env } = options
  const now = options.now ?? (() => new Date())
  const accessKeys = options.accessKeys ?? remoteAccessKeys

  const resolveSigner = (): BlobSigner | null => {
    if (options.signer) return options.signer
    const r2 = readR2SignerConfig(env)
    return r2 ? createR2Signer(r2, now) : null
  }

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return errorResponse(
          c,
          new ApiError(400, 'VALIDATION_FAILED', 'Request validation failed.', {
            issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          }),
        )
      }
    },
  })

  app.onError((err, c) => {
    if (err instanceof ApiError) return errorResponse(c, err)
    // Log only non-sensitive facts: never headers, tokens, URLs or bodies. Not err.message either:
    // DrizzleQueryError messages include bound query parameters.
    console.error(JSON.stringify({ level: 'error', requestId: requestId(c), route: c.req.routePath, name: err.name }))
    return errorResponse(c, new ApiError(500, 'INTERNAL', 'Internal error.'))
  })
  app.notFound((c) => errorResponse(c, new ApiError(404, 'NOT_FOUND', 'Not found.')))

  if (options.localRoutes) app.route(options.localRoutes.prefix, options.localRoutes.app)

  // ---------------- Private API: /api/v1/* ----------------

  app.use('/api/v1/*', withHeaders(PRIVATE_HEADERS))
  app.use('/api/v1/*', async (c, next) => {
    const config = readAppConfig(env)
    if (!config) throw misconfigured(c, env, !options.signer)
    const auth = await authenticateAccess(c.req.header('cf-access-jwt-assertion'), config.access, accessKeys)
    if (!auth.ok) {
      if (auth.reason === 'not_member') throw new ApiError(403, 'FORBIDDEN', 'Not allowed.')
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.')
    }
    checkWriteOrigin(c.req.method, c.req.raw.headers, config.appOrigin)
    const signer = resolveSigner()
    if (!signer) throw misconfigured(c, env, true)
    c.set('principal', auth.principal)
    c.set('config', config)
    c.set('services', { db: createDb(env.DB), bucket: env.BUCKET, signer, now })
    await next()
  })

  const svc = (c: Context<AppEnv>) => c.get('services')

  const tag = (name: string) => [name]

  // Session
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/me',
      tags: tag('session'),
      responses: {
        200: json(
          z.object({ email: z.string(), subject: z.string(), authSource: z.literal('cloudflare-access') }),
          'Current household member',
        ),
        ...errorResponses,
      },
    }),
    (c) => c.json(c.get('principal'), 200),
  )

  // Uploads
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/uploads',
      tags: tag('uploads'),
      request: { body: jsonBody(UploadReserveSchema) },
      responses: {
        201: json(UploadReservationSchema, 'Upload reserved; PUT each target, then finalize'),
        409: json(ErrorSchema, 'Duplicate original'),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await uploads.reserveUpload(svc(c), c.req.valid('json'), c.get('principal').email), 201),
  )

  // Restore's reservation (D-034). Finalize is the same as for any upload.
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/restore/uploads',
      tags: tag('uploads'),
      request: { body: jsonBody(RestoreUploadReserveSchema) },
      responses: {
        201: json(UploadReservationSchema, 'Upload reserved with the uploader the backup recorded'),
        409: json(ErrorSchema, 'Duplicate original'),
        ...errorResponses,
      },
    }),
    async (c) => {
      const input = c.req.valid('json')
      return c.json(await uploads.reserveUpload(svc(c), input, input.uploadedBy), 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/uploads/{uploadId}/finalize',
      tags: tag('uploads'),
      request: { params: z.object({ uploadId: IdSchema }) },
      responses: {
        200: json(UploadFinalizeResultSchema, 'Asset is ready (idempotent)'),
        409: json(ErrorSchema, 'Objects missing'),
        410: json(ErrorSchema, 'Resulting asset was deleted'),
        422: json(ErrorSchema, 'Objects do not match the reservation'),
        ...errorResponses,
      },
    }),
    async (c) => {
      const outcome = await uploads.finalizeUpload(svc(c), c.req.valid('param').uploadId)
      return c.json({ result: outcome.result, asset: await assets.toAsset(svc(c), outcome.asset) }, 200)
    },
  )

  // Assets
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/assets',
      tags: tag('assets'),
      request: {
        query: PageQuery.extend({ favorite: boolQuery, trashed: boolQuery }),
      },
      responses: { 200: json(AssetPageSchema, 'Timeline page, newest first'), ...errorResponses },
    }),
    async (c) => {
      const q = checkedPageQuery(c.req.valid('query'))
      const page = await assets.listAssets(svc(c), q)
      const items = await Promise.all(page.rows.map((r) => assets.toAssetSummary(svc(c), r)))
      return c.json({ items, nextCursor: page.nextCursor, prevCursor: page.prevCursor }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/assets/months',
      tags: tag('assets'),
      responses: { 200: json(AssetMonthsSchema, 'Months that have a photo, newest first'), ...errorResponses },
    }),
    async (c) => c.json({ items: await assets.listMonths(svc(c)) }, 200),
  )

  const AssetParams = z.object({ assetId: IdSchema })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/assets/{assetId}',
      tags: tag('assets'),
      request: { params: AssetParams },
      responses: { 200: json(AssetSchema, 'Asset'), ...errorResponses },
    }),
    async (c) => {
      const row = await assets.requireReadyAsset(svc(c).db, c.req.valid('param').assetId)
      return c.json(await assets.toAsset(svc(c), row), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/assets/{assetId}',
      tags: tag('assets'),
      request: { params: AssetParams, body: jsonBody(AssetPatchSchema) },
      responses: { 200: json(AssetSchema, 'Updated asset'), ...errorResponses },
    }),
    async (c) => {
      const row = await assets.setFavorite(svc(c), c.req.valid('param').assetId, c.req.valid('json').isFavorite)
      return c.json(await assets.toAsset(svc(c), row), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/assets/{assetId}/original',
      tags: tag('assets'),
      request: { params: AssetParams },
      responses: { 200: json(SignedUrlSchema, 'Short-lived URL for the unmodified original'), ...errorResponses },
    }),
    async (c) => c.json(await assets.originalUrl(svc(c), c.req.valid('param').assetId), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/assets/{assetId}/derivatives/repair',
      tags: tag('assets'),
      request: { params: AssetParams },
      responses: {
        200: json(
          DerivativeRepairSchema,
          'Rebuilds a missing thumbnail / preview. Idempotent: PUT what it asks for and call it again. ' +
            'The original is only ever read, never written or deleted.',
        ),
        409: json(ErrorSchema, 'The original is missing or is not the file that was uploaded'),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await repairDerivatives(svc(c), c.req.valid('param').assetId), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/assets/{assetId}/trash',
      tags: tag('assets'),
      request: { params: AssetParams },
      responses: { 200: json(AssetSchema, 'Asset moved to trash'), ...errorResponses },
    }),
    async (c) => {
      const row = await assets.trashAsset(svc(c), c.req.valid('param').assetId)
      return c.json(await assets.toAsset(svc(c), row), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/assets/{assetId}/restore',
      tags: tag('assets'),
      request: { params: AssetParams },
      responses: { 200: json(AssetSchema, 'Asset restored from trash'), ...errorResponses },
    }),
    async (c) => {
      const row = await assets.restoreAsset(svc(c), c.req.valid('param').assetId)
      return c.json(await assets.toAsset(svc(c), row), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/assets/{assetId}',
      tags: tag('assets'),
      request: { params: AssetParams },
      responses: {
        204: { description: 'Permanently deleted (safe to retry)' },
        409: json(ErrorSchema, 'Asset is not in trash'),
        ...errorResponses,
      },
    }),
    async (c) => {
      await assets.purgeAsset(svc(c), c.req.valid('param').assetId)
      return c.body(null, 204)
    },
  )

  // Albums
  const AlbumParams = z.object({ albumId: IdSchema })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/albums',
      tags: tag('albums'),
      request: { query: z.object({ covers: boolQuery }) },
      responses: { 200: json(AlbumListSchema, 'Albums, newest first'), ...errorResponses },
    }),
    async (c) =>
      c.json({ items: await albums.listAlbums(svc(c), { covers: c.req.valid('query').covers ?? false }) }, 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/albums',
      tags: tag('albums'),
      request: { body: jsonBody(AlbumInputSchema) },
      responses: { 201: json(AlbumSchema, 'Created album'), ...errorResponses },
    }),
    async (c) => c.json(await albums.createAlbum(svc(c), c.req.valid('json').title), 201),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/albums/{albumId}',
      tags: tag('albums'),
      request: { params: AlbumParams },
      responses: { 200: json(AlbumSchema, 'Album'), ...errorResponses },
    }),
    async (c) => c.json(await albums.getAlbum(svc(c).db, c.req.valid('param').albumId), 200),
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/albums/{albumId}',
      tags: tag('albums'),
      request: { params: AlbumParams, body: jsonBody(AlbumInputSchema) },
      responses: { 200: json(AlbumSchema, 'Renamed album'), ...errorResponses },
    }),
    async (c) => c.json(await albums.renameAlbum(svc(c), c.req.valid('param').albumId, c.req.valid('json').title), 200),
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/albums/{albumId}',
      tags: tag('albums'),
      request: { params: AlbumParams },
      responses: { 204: { description: 'Album deleted and its shares revoked' }, ...errorResponses },
    }),
    async (c) => {
      await albums.deleteAlbum(svc(c), c.req.valid('param').albumId)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/albums/{albumId}/assets',
      tags: tag('albums'),
      request: { params: AlbumParams, query: PageQuery },
      responses: { 200: json(AssetPageSchema, 'Album assets'), ...errorResponses },
    }),
    async (c) => {
      const { albumId } = c.req.valid('param')
      await albums.requireAlbumId(svc(c).db, albumId)
      const page = await assets.listAssets(svc(c), { ...checkedPageQuery(c.req.valid('query')), albumId })
      const items = await Promise.all(page.rows.map((r) => assets.toAssetSummary(svc(c), r)))
      return c.json({ items, nextCursor: page.nextCursor, prevCursor: page.prevCursor }, 200)
    },
  )

  const MemberParams = z.object({ albumId: IdSchema, assetId: IdSchema })

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/albums/{albumId}/assets/{assetId}',
      tags: tag('albums'),
      request: { params: MemberParams },
      responses: {
        204: { description: 'Asset is in the album (idempotent)' },
        409: json(ErrorSchema, 'Asset is trashed'),
        ...errorResponses,
      },
    }),
    async (c) => {
      const p = c.req.valid('param')
      await albums.addAssetToAlbum(svc(c), p.albumId, p.assetId)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/albums/{albumId}/assets/{assetId}',
      tags: tag('albums'),
      request: { params: MemberParams },
      responses: { 204: { description: 'Asset is not in the album (idempotent)' }, ...errorResponses },
    }),
    async (c) => {
      const p = c.req.valid('param')
      await albums.removeAssetFromAlbum(svc(c), p.albumId, p.assetId)
      return c.body(null, 204)
    },
  )

  // Shares (owner)
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/albums/{albumId}/shares',
      tags: tag('shares'),
      request: { params: AlbumParams },
      responses: { 200: json(ShareListSchema, 'Shares of the album'), ...errorResponses },
    }),
    async (c) => c.json({ items: await shares.listShares(svc(c), c.req.valid('param').albumId) }, 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/albums/{albumId}/shares',
      tags: tag('shares'),
      request: { params: AlbumParams, body: jsonBody(ShareCreateSchema) },
      responses: { 201: json(ShareCreatedSchema, 'Share created; the secret is shown once'), ...errorResponses },
    }),
    async (c) =>
      c.json(
        await shares.createShare(
          svc(c),
          c.get('config').appOrigin,
          c.req.valid('param').albumId,
          c.req.valid('json').expiresInDays,
        ),
        201,
      ),
  )

  const ShareParams = z.object({ shareId: ShareIdSchema })

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/shares/{shareId}/revoke',
      tags: tag('shares'),
      request: { params: ShareParams },
      responses: { 200: json(ShareSchema, 'Share revoked (idempotent)'), ...errorResponses },
    }),
    async (c) => c.json(await shares.revokeShare(svc(c), c.req.valid('param').shareId), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/shares/{shareId}/regenerate',
      tags: tag('shares'),
      request: { params: ShareParams },
      responses: {
        201: json(ShareCreatedSchema, 'Old link revoked, new link issued'),
        409: json(ErrorSchema, 'The share is already revoked or expired; no new link is issued'),
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json(await shares.regenerateShare(svc(c), c.get('config').appOrigin, c.req.valid('param').shareId), 201),
  )

  // Export & diagnostics
  const ExportPageQuery = z.object({
    limit: z.coerce.number().int().min(1).max(EXPORT_PAGE_MAX).default(EXPORT_PAGE_MAX),
  })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/export/assets',
      tags: tag('export'),
      request: { query: ExportPageQuery.extend({ after: IdSchema.optional() }) },
      responses: {
        200: json(ExportAssetPageSchema, 'Ready assets ordered by id'),
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid('query')
      return c.json(await exportAssetsPage(svc(c).db, q.after, q.limit), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/backup/complete',
      tags: tag('export'),
      responses: {
        200: json(
          z.object({ lastBackupAt: z.string() }),
          'Records that `pnpm backup export` finished without a failed photo. Reading the export pages records nothing.',
        ),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await recordBackup(svc(c).db, now()), 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/export/albums',
      tags: tag('export'),
      responses: { 200: json(ExportAlbumListSchema, 'Albums, oldest first'), ...errorResponses },
    }),
    async (c) => c.json(await exportAlbums(svc(c).db), 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/export/album-assets',
      tags: tag('export'),
      request: {
        query: ExportPageQuery.extend({
          after: z
            .string()
            .regex(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            )
            .optional(),
        }),
      },
      responses: { 200: json(ExportMembershipPageSchema, 'Album membership of ready assets'), ...errorResponses },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const [albumId, assetId] = q.after?.split('/') ?? []
      const after = q.after ? { albumId, assetId } : null
      return c.json(await exportMembershipsPage(svc(c).db, after, q.limit), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/diagnostics',
      tags: tag('export'),
      responses: {
        200: json(
          z.object({
            counts: z.object({
              assets: z.number(),
              trashed: z.number(),
              purging: z.number(),
              pendingUploads: z.number(),
              expiredUploads: z.number(),
              albums: z.number(),
            }),
            lastBackupAt: z.string().nullable(),
            latestMigration: z.string().nullable(),
            // Permanent deletes that did not finish (oldest first, at most 100). DELETE each to resume.
            purgingAssetIds: z.array(IdSchema),
          }),
          'Non-sensitive library diagnostics',
        ),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await diagnostics(svc(c).db, now()), 200),
  )

  // Storage reconciliation (docs/decisions.md D-023)
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/storage/audit',
      tags: tag('storage'),
      request: {
        query: z.object({
          after: z.string().max(1024).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
          deep: boolQuery,
        }),
      },
      responses: {
        200: json(StorageAuditPageSchema, 'One page of the D1 / R2 comparison, ordered by asset id (read-only)'),
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid('query')
      return c.json(await auditStorage(svc(c), { after: q.after, limit: q.limit, deep: q.deep ?? false }), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/storage/cleanup',
      tags: tag('storage'),
      request: {
        body: {
          required: false,
          content: {
            'application/json': { schema: z.object({ limit: z.number().int().min(1).max(50).default(25) }) },
          },
        },
      },
      responses: {
        200: json(
          StorageCleanupResultSchema,
          'Resolves interrupted uploads older than a day. Never deletes an asset or an unreferenced object.',
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid('json') as { limit?: number } | undefined
      return c.json(await cleanupUploads(svc(c), body?.limit ?? 25), 200)
    },
  )

  // OpenAPI document (private).
  app.doc31('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'EdgePhotos API',
      version: '1.0.0',
      description:
        'Private API requires a Cloudflare Access assertion for the configured owner. Share API requires `Authorization: Bearer <share secret>`.',
    },
  })

  // ---------------- Public share capability API: /share/api/v1/* ----------------

  const shareApp = new OpenAPIHono<AppEnv>({ defaultHook: app.defaultHook as never })
  shareApp.use('*', withHeaders(SHARE_HEADERS))
  shareApp.use('*', async (c, next) => {
    const signer = resolveSigner()
    if (!signer) throw misconfigured(c, env, true)
    c.set('services', { db: createDb(env.DB), bucket: env.BUCKET, signer, now })
    await next()
  })

  shareApp.openapi(
    createRoute({
      method: 'get',
      path: '/shares/{shareId}',
      tags: tag('share-public'),
      request: { params: ShareParams, query: PageQuery },
      responses: { 200: json(SharedAlbumSchema, 'Shared album contents'), ...errorResponses },
    }),
    async (c) =>
      c.json(
        await shares.sharedAlbum(
          svc(c),
          c.req.valid('param').shareId,
          c.req.header('authorization'),
          c.req.valid('query'),
        ),
        200,
      ),
  )

  shareApp.openapi(
    createRoute({
      method: 'get',
      path: '/shares/{shareId}/assets/{assetId}/{variant}',
      tags: tag('share-public'),
      request: { params: z.object({ shareId: ShareIdSchema, assetId: IdSchema, variant: ShareVariantSchema }) },
      responses: { 200: json(SignedUrlSchema, 'Short-lived derivative URL'), ...errorResponses },
    }),
    async (c) => {
      const p = c.req.valid('param')
      return c.json(
        await shares.sharedVariantUrl(svc(c), p.shareId, c.req.header('authorization'), p.assetId, p.variant),
        200,
      )
    },
  )

  app.route('/share/api/v1', shareApp)
  app.openAPIRegistry.definitions.push(
    ...shareApp.openAPIRegistry.definitions.map((d) =>
      d.type === 'route' ? { ...d, route: { ...d.route, path: `/share/api/v1${d.route.path}` } } : d,
    ),
  )

  // The R2 S3 endpoint presigned URLs point at: one account, never a wildcard. Local development has no
  // R2 settings and signs same-origin /__local URLs, which 'self' already allows.
  const r2Sources = () => {
    const r2 = readR2SignerConfig(env)
    return r2 ? [`https://${r2.accountId}.r2.cloudflarestorage.com`] : []
  }

  // Share page shell. Served by the Worker so share-specific headers always apply.
  app.get('/share/:shareId{[A-Za-z0-9_-]{22}}', async (c) => {
    if (!env.ASSETS) throw new ApiError(404, 'NOT_FOUND', 'Not found.')
    const asset = await env.ASSETS.fetch(new URL('/share', c.req.url))
    const res = new Response(asset.body, asset)
    for (const [k, v] of Object.entries(SHARE_HEADERS)) res.headers.set(k, v)
    res.headers.set('Content-Security-Policy', shareContentSecurityPolicy(r2Sources(), options.devCspNonce))
    return res
  })

  // Private app shell. run_worker_first sends every path except /share/assets/* here, so each HTML
  // document of the private app (/, /albums/..., and any unknown path) carries the CSP. The SPA fallback
  // is done here, not by the assets (not_found_handling is "none"): the assets would also answer a miss
  // under /share/assets/*, which is outside Access and never reaches the Worker, with the app and no CSP.
  // Unmatched API, share and dev blob paths stay JSON 404s instead of becoming the app.
  app.get('*', async (c) => {
    if (!env.ASSETS || /^\/+(api|share|__local)(\/|\.|$)/i.test(c.req.path)) {
      throw new ApiError(404, 'NOT_FOUND', 'Not found.')
    }
    let asset = await env.ASSETS.fetch(c.req.raw)
    if (asset.status === 404 && isDocumentRequest(c.req.raw.headers)) {
      asset = await env.ASSETS.fetch(new URL('/', c.req.url))
    }
    const res = new Response(asset.body, asset)
    res.headers.set('Referrer-Policy', 'no-referrer')
    res.headers.set('X-Content-Type-Options', 'nosniff')
    res.headers.set('Content-Security-Policy', privateContentSecurityPolicy(r2Sources(), options.devCspNonce))
    return res
  })

  return app
}

export type App = ReturnType<typeof createApp>
