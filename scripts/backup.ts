// EdgePhotos backup CLI (Node >= 22.18).
//
//   EDGEPHOTOS_URL=https://photos.example.com \
//   EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
//   pnpm backup export ./edgephotos-backup
//
//   pnpm backup restore ./edgephotos-backup   # into an EMPTY EdgePhotos environment
//   pnpm backup verify  ./edgephotos-backup   # compare a live library with the backup manifest
//
// The Access token is sent only to EDGEPHOTOS_URL (as `cf-access-token`), never to presigned R2 URLs,
// and is never written to disk or logs.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  type ApiClient,
  type BlobStore,
  backupLibrary,
  readManifest,
  restoreLibrary,
  verifyLibrary,
} from './lib/backup.ts'

function usage(): never {
  console.error('usage: pnpm backup <export|restore|verify> <directory>')
  process.exit(2)
}

function fsStore(root: string): BlobStore {
  const safe = (path: string) => {
    const full = resolve(root, path)
    if (!full.startsWith(resolve(root))) throw new Error('path escapes backup directory')
    return full
  }
  return {
    async put(path, bytes) {
      const full = safe(path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, bytes)
    },
    async get(path) {
      try {
        return new Uint8Array(await readFile(safe(path)))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
  }
}

function client(): ApiClient {
  const base = process.env.EDGEPHOTOS_URL?.replace(/\/$/, '')
  const token = process.env.EDGEPHOTOS_ACCESS_TOKEN
  if (!base || !/^https?:\/\//.test(base)) {
    console.error('EDGEPHOTOS_URL is required (e.g. https://photos.example.com)')
    process.exit(2)
  }
  return {
    api: (path, init) => {
      const headers = new Headers(init?.headers)
      if (token) headers.set('cf-access-token', token)
      return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
    },
    blob: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  }
}

async function main() {
  const [command, dir] = process.argv.slice(2)
  if (!command || !dir) usage()
  const store = fsStore(join(process.cwd(), dir))
  switch (command) {
    case 'export': {
      const manifest = await backupLibrary(client(), store)
      console.log(`exported ${manifest.assets.length} assets and ${manifest.albums.length} albums`)
      break
    }
    case 'restore': {
      const report = await restoreLibrary(client(), store)
      console.log(`restored ${report.assets} assets and ${report.albums} albums`)
      const verification = await verifyLibrary(client(), await readManifest(store))
      console.log(JSON.stringify(verification, null, 2))
      if (!verification.ok) process.exit(1)
      break
    }
    case 'verify': {
      const verification = await verifyLibrary(client(), await readManifest(store))
      console.log(JSON.stringify(verification, null, 2))
      if (!verification.ok) process.exit(1)
      break
    }
    default:
      usage()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'backup failed')
  process.exit(1)
})
