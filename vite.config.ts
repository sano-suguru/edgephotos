import { cloudflare } from '@cloudflare/vite-plugin'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type PluginOption } from 'vite'
import { createDevAccess } from './scripts/vite-dev-access.ts'

export default defineConfig(async ({ command }) => {
  const plugins: PluginOption[] = []
  let devVars: Record<string, string> | undefined

  if (command === 'serve') {
    const devAccess = await createDevAccess(process.env.DEV_OWNER_EMAIL ?? 'owner@localhost.test')
    devVars = devAccess.vars
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
