import type { JWTVerifyGetKey } from 'jose'
import { createLocalJWKSet } from 'jose'
import { type AppOptions, createApp } from './app'
import type { Env } from './env'
import { createLocalSigner } from './storage/local-blobs'

let cached: { env: Env; app: ReturnType<typeof createApp> } | undefined

function appFor(env: Env) {
  if (cached?.env === env) return cached.app
  const options: AppOptions = { env }
  // Local development wiring. `import.meta.env.DEV` is statically false in production builds,
  // so this branch (dev JWKS + local blob URLs) is removed from the deployed Worker.
  if (import.meta.env.DEV) {
    if (env.DEV_ACCESS_JWKS) {
      const keys: JWTVerifyGetKey = createLocalJWKSet(JSON.parse(env.DEV_ACCESS_JWKS))
      options.accessKeys = () => keys
    }
    if (env.DEV_BLOB_SIGNING_KEY && env.APP_ORIGIN) {
      options.signer = createLocalSigner(env.APP_ORIGIN, env.DEV_BLOB_SIGNING_KEY)
      options.localBlobSecret = env.DEV_BLOB_SIGNING_KEY
    }
  }
  const app = createApp(options)
  cached = { env, app }
  return app
}

export default {
  fetch(request, env, ctx) {
    return appFor(env).fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
