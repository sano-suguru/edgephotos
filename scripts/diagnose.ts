// EdgePhotos setup diagnostics (Node >= 22.18). Read-only: it never changes the Cloudflare account.
//
//   pnpm diagnose --env remote-test                      # config + Cloudflare resources (wrangler login)
//   EDGEPHOTOS_URL=https://photos.example.com \
//   EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
//   pnpm diagnose --env remote-test                      # + Access, Worker config, D1 schema, R2 signing
//
// Omit --env for the top-level (production) configuration. --offline checks only wrangler.jsonc.
// The Access token is sent only to EDGEPHOTOS_URL; nothing secret is printed.

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { unstable_readConfig } from 'wrangler'
import {
  type Check,
  checkConfig,
  checkCorsPreflight,
  checkDeployment,
  checkMigrations,
  checkPublicAccess,
  checkSecrets,
} from './lib/diagnose.ts'

const run = promisify(execFile)

async function wrangler(args: string[]): Promise<string> {
  const { stdout } = await run('wrangler', args, {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  return stdout
}

// Runs a check that needs wrangler; a wrangler failure is reported, not thrown.
async function guarded(name: string, fn: () => Promise<Check | Check[]>): Promise<Check[]> {
  try {
    return [await fn()].flat()
  } catch (err) {
    const message = (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err))
    const line = message.split('\n').find((l) => /error|✘/i.test(l)) ?? message.split('\n')[0]
    return [{ name, status: 'fail', detail: `wrangler failed: ${line.replace(/\s+/g, ' ').trim().slice(0, 200)}` }]
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  const envIndex = args.indexOf('--env')
  return {
    env: envIndex >= 0 ? args[envIndex + 1] : undefined,
    offline: args.includes('--offline'),
  }
}

async function accountId(): Promise<string> {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID
  const who = JSON.parse(await wrangler(['whoami', '--json'])) as { accounts?: { id: string }[] }
  if (who.accounts?.length !== 1) throw new Error('several accounts: set CLOUDFLARE_ACCOUNT_ID')
  return who.accounts[0].id
}

async function main() {
  const { env, offline } = parseArgs()
  const envArgs = env ? ['--env', env] : []
  const config = unstable_readConfig({ config: 'wrangler.jsonc', env })
  const database = config.d1_databases.find((d: { binding: string }) => d.binding === 'DB')
  const bucket = config.r2_buckets.find((b: { binding: string }) => b.binding === 'BUCKET')?.bucket_name
  const local = (await readdir(database?.migrations_dir ?? 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  const baseUrl = process.env.EDGEPHOTOS_URL?.replace(/\/$/, '')
  const token = process.env.EDGEPHOTOS_ACCESS_TOKEN || undefined

  console.log(`EdgePhotos diagnose: ${config.name} (${env ? `env ${env}` : 'top-level configuration'})`)
  const checks: Check[] = checkConfig({
    vars: config.vars,
    secretsRequired: config.secrets?.required ?? [],
    previewUrls: config.preview_urls,
    bucketName: bucket,
  })

  if (!offline) {
    checks.push(
      ...(await guarded('worker: secrets', async () => {
        const list = JSON.parse(await wrangler(['secret', 'list', '--format', 'json', ...envArgs])) as {
          name: string
        }[]
        return checkSecrets(list.map((s) => s.name))
      })),
      ...(await guarded('d1: migrations', async () => {
        const out = await wrangler([
          'd1',
          'execute',
          'DB',
          '--remote',
          '--json',
          ...envArgs,
          '--command',
          'SELECT name FROM d1_migrations ORDER BY id',
        ])
        const applied = (JSON.parse(out) as { results: { name: string }[] }[])[0].results.map((r) => r.name)
        return checkMigrations(applied, local)
      })),
      ...(await guarded('r2: public access', async () =>
        checkPublicAccess(
          await wrangler(['r2', 'bucket', 'dev-url', 'get', bucket ?? '']),
          await wrangler(['r2', 'bucket', 'domain', 'list', bucket ?? '']),
        ),
      )),
    )
    if (baseUrl) {
      const origin = new URL(baseUrl).origin
      checks.push(
        ...(await guarded('r2: CORS for upload', async () =>
          checkCorsPreflight(
            fetch,
            `https://${await accountId()}.r2.cloudflarestorage.com/${bucket}/originals/diagnose-preflight`,
            origin,
          ),
        )),
      )
    } else {
      checks.push({
        name: 'r2: CORS for upload',
        status: 'skip',
        detail: 'set EDGEPHOTOS_URL (the APP_ORIGIN) to check',
      })
    }
  }

  if (baseUrl && !offline) {
    checks.push(
      ...(await checkDeployment({
        api: (path, init) => {
          const headers = new Headers(init?.headers)
          return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' })
        },
        blob: (url, init) => fetch(url, { ...init, redirect: 'error' }),
        token,
        latestLocalMigration: local.at(-1),
        origin: new URL(baseUrl).origin,
      })),
    )
  } else if (!offline) {
    checks.push({ name: 'deployment', status: 'skip', detail: 'set EDGEPHOTOS_URL to probe Access and the Worker' })
  }

  const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' } as const
  for (const c of checks) console.log(`${label[c.status]}  ${c.name} — ${c.detail}`)
  const failed = checks.filter((c) => c.status === 'fail').length
  console.log(failed ? `\n${failed} check(s) failed` : '\nno failures')
  if (failed) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'diagnose failed')
  process.exit(1)
})
