import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import {
  AlbumInputSchema,
  AlbumListSchema,
  AlbumSchema,
  AssetPageSchema,
  AssetPatchSchema,
  AssetSchema,
  ErrorSchema,
  ExportManifestSchema,
  IdSchema,
  LIMITS,
  ShareCreatedSchema,
  ShareCreateSchema,
  SharedAlbumSchema,
  ShareIdSchema,
  ShareListSchema,
  ShareSchema,
  ShareVariantSchema,
  SignedUrlSchema,
  UploadFinalizeResultSchema,
  UploadReservationSchema,
  UploadReserveSchema,
} from '../contracts/schemas'
import { type AccessKeyResolver, type AppPrincipal, authenticateAccess, remoteAccessKeys } from './auth/access'
import { type AppConfig, type Env, normalizeOrigin, readAppConfig } from './env'
import { ApiError, errorResponse, requestId } from './http/errors'
import {
  checkWriteOrigin,
  PRIVATE_HEADERS,
  SHARE_HEADERS,
  shareContentSecurityPolicy,
  withHeaders,
} from './http/security'
import * as albums from './services/albums'
import * as assets from './services/assets'
import type { ServiceContext } from './services/context'
import { buildExport, diagnostics } from './services/export'
import * as shares from './services/shares'
import * as uploads from './services/uploads'
import { LOCAL_BLOB_PREFIX, localBlobRoutes } from './storage/local-blobs'
import { type BlobSigner, createR2Signer, readR2SignerConfig } from './storage/signer'

export type AppOptions = {
  env: Env
  now?: () => Date
  accessKeys?: AccessKeyResolver
  // Overrides the R2 SigV4 signer. Used for local development and tests only.
  signer?: BlobSigner
  // Mounts the local blob endpoint that backs `signer` when it is a local signer.
  localBlobSecret?: string
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
  403: { description: 'Not the owner or origin not allowed', content: { 'application/json': { schema: ErrorSchema } } },
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

const misconfigured = () => new ApiError(503, 'SERVER_MISCONFIGURED', 'Server configuration is incomplete.')

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageMax).default(60),
  cursor: z.string().max(512).optional(),
})

const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional()

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
    // Log only non-sensitive facts: never headers, tokens, URLs or bodies.
    console.error(JSON.stringify({ level: 'error', requestId: requestId(c), route: c.req.routePath, name: err.name }))
    return errorResponse(c, new ApiError(500, 'INTERNAL', 'Internal error.'))
  })
  app.notFound((c) => errorResponse(c, new ApiError(404, 'NOT_FOUND', 'Not found.')))

  if (options.signer && options.localBlobSecret) {
    app.route(LOCAL_BLOB_PREFIX, localBlobRoutes(env.BUCKET, options.localBlobSecret, now))
  }

  // ---------------- Private API: /api/v1/* ----------------

  app.use('/api/v1/*', withHeaders(PRIVATE_HEADERS))
  app.use('/api/v1/*', async (c, next) => {
    const config = readAppConfig(env)
    if (!config) throw misconfigured()
    const auth = await authenticateAccess(c.req.header('cf-access-jwt-assertion'), config.access, accessKeys)
    if (!auth.ok) {
      if (auth.reason === 'not_owner') throw new ApiError(403, 'FORBIDDEN', 'Not allowed.')
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.')
    }
    checkWriteOrigin(c.req.method, c.req.raw.headers, config.appOrigin)
    const signer = resolveSigner()
    if (!signer) throw misconfigured()
    c.set('principal', auth.principal)
    c.set('config', config)
    c.set('services', { db: env.DB, bucket: env.BUCKET, signer, now })
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
        200: json(z.object({ email: z.string(), subject: z.string(), authSource: z.literal('cloudflare-access') }), 'Current principal'),
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
    async (c) => c.json(await uploads.reserveUpload(svc(c), c.req.valid('json')), 201),
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
      const q = c.req.valid('query')
      const page = await assets.listAssets(svc(c), q)
      const items = await Promise.all(page.rows.map((r) => assets.toAsset(svc(c), r)))
      return c.json({ items, nextCursor: page.nextCursor }, 200)
    },
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
      responses: { 200: json(AlbumListSchema, 'Albums'), ...errorResponses },
    }),
    async (c) => c.json({ items: await albums.listAlbums(svc(c).db) }, 200),
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
    async (c) =>
      c.json(await albums.renameAlbum(svc(c), c.req.valid('param').albumId, c.req.valid('json').title), 200),
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
      await albums.getAlbum(svc(c).db, albumId)
      const page = await assets.listAssets(svc(c), { ...c.req.valid('query'), albumId })
      const items = await Promise.all(page.rows.map((r) => assets.toAsset(svc(c), r)))
      return c.json({ items, nextCursor: page.nextCursor }, 200)
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
        409: json(ErrorSchema, 'Share expired'),
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json(await shares.regenerateShare(svc(c), c.get('config').appOrigin, c.req.valid('param').shareId), 201),
  )

  // Export & diagnostics
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/export',
      tags: tag('export'),
      responses: { 200: json(ExportManifestSchema, 'Portable metadata export'), ...errorResponses },
    }),
    async (c) => c.json(await buildExport(svc(c).db, now()), 200),
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
              albums: z.number(),
            }),
            lastExportAt: z.string().nullable(),
            latestMigration: z.string().nullable(),
          }),
          'Non-sensitive library diagnostics',
        ),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await diagnostics(svc(c).db), 200),
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
    if (!signer) throw misconfigured()
    c.set('services', { db: env.DB, bucket: env.BUCKET, signer, now })
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

  // Share page shell. Served by the Worker so share-specific headers always apply.
  app.get('/share/:shareId{[A-Za-z0-9_-]{22}}', async (c) => {
    if (!env.ASSETS) throw new ApiError(404, 'NOT_FOUND', 'Not found.')
    const asset = await env.ASSETS.fetch(new URL('/share.html', c.req.url))
    const res = new Response(asset.body, asset)
    const r2 = readR2SignerConfig(env)
    const imgSources = r2 ? [`https://${r2.accountId}.r2.cloudflarestorage.com`] : []
    const origin = normalizeOrigin(env.APP_ORIGIN)
    if (options.signer && origin) imgSources.push(origin)
    for (const [k, v] of Object.entries(SHARE_HEADERS)) res.headers.set(k, v)
    res.headers.set('Content-Security-Policy', shareContentSecurityPolicy(imgSources))
    return res
  })

  return app
}

export type App = ReturnType<typeof createApp>
