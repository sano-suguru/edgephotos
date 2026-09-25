import { randomBytes } from 'node:crypto'
import { cloudflare } from '@cloudflare/vite-plugin'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type PluginOption } from 'vite'
import { createDevAccess } from './scripts/vite-dev-access.ts'

export default defineConfig(async ({ command }) => {
  const plugins: PluginOption[] = []
  let devVars: Record<string, string> | undefined
  // `vite dev` injects <script>/<style> tags. They carry this nonce, and the Worker adds it to the CSP, so
  // dev runs under the production policy instead of one relaxed with 'unsafe-inline'.
  const devCspNonce = command === 'serve' ? randomBytes(16).toString('base64url') : undefined

  if (command === 'serve') {
    const devAccess = await createDevAccess(
      process.env.DEV_HOUSEHOLD_EMAILS ?? 'you@localhost.test,partner@localhost.test',
    )
    devVars = { ...devAccess.vars, DEV_CSP_NONCE: devCspNonce as string }
    // Must run before the Cloudflare plugin so the emulated Access header reaches the Worker.
    plugins.push(devAccess.plugin)
  }

  plugins.push(
    preact(),
    tailwindcss(),
    cloudflare({
      config: devVars ? (config) => ({ vars: { ...config.vars, ...devVars } }) : undefined,
      // Browser E2E runs against its own throwaway local D1/R2 (see playwright.config.ts).
      persistState: process.env.EDGEPHOTOS_STATE_DIR ? { path: process.env.EDGEPHOTOS_STATE_DIR } : undefined,
    }),
  )

  return {
    plugins,
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    html: devCspNonce ? { cspNonce: devCspNonce } : undefined,
    environments: {
      client: {
        build: {
          // Static JS/CSS is emitted under /share/assets so the public share page can load it while the
          // Cloudflare Access bypass stays limited to /share/* (see docs/decisions.md D-011).
          assetsDir: 'share/assets',
          rollupOptions: { input: { app: 'index.html', share: 'share.html' } },
        },
      },
    },
  }
})
