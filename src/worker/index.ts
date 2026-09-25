import { type AppOptions, createApp } from './app'
import type { Env } from './env'

let cached: { env: Env; app: Promise<ReturnType<typeof createApp>> } | undefined

async function buildApp(env: Env) {
  const options: AppOptions = { env }
  // Local development wiring. `import.meta.env.DEV` is statically false in production builds, so this
  // branch and its dynamic imports (dev JWKS, local blob URLs) are dropped from the deployed Worker.
  if (import.meta.env.DEV) {
    if (env.DEV_ACCESS_JWKS) {
      const { createLocalJWKSet } = await import('jose')
      const keys = createLocalJWKSet(JSON.parse(env.DEV_ACCESS_JWKS))
      options.accessKeys = () => keys
    }
    options.devCspNonce = env.DEV_CSP_NONCE
    if (env.DEV_BLOB_SIGNING_KEY && env.APP_ORIGIN) {
      const local = await import('./storage/local-blobs')
      options.signer = local.createLocalSigner(env.APP_ORIGIN, env.DEV_BLOB_SIGNING_KEY)
      options.localRoutes = {
        prefix: local.LOCAL_BLOB_PREFIX,
        app: local.localBlobRoutes(env.BUCKET, env.DEV_BLOB_SIGNING_KEY),
      }
    }
  }
  return createApp(options)
}

function appFor(env: Env) {
  if (cached?.env !== env) cached = { env, app: buildApp(env) }
  return cached.app
}

export default {
  async fetch(request, env, ctx) {
    return (await appFor(env)).fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
