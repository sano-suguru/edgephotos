// EdgePhotos backup CLI (Node >= 22.18).
//
//   EDGEPHOTOS_URL=https://photos.example.com \
//   EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
//   pnpm backup export ./edgephotos-backup            # incremental: only new photos are downloaded
//
//   pnpm backup check   ./edgephotos-backup           # offline: re-hash every file against the manifest
//   pnpm backup restore ./edgephotos-backup [--resume] [--quick]   # into an EMPTY EdgePhotos environment
//   pnpm backup verify  ./edgephotos-backup [--quick] # compare a live library with the backup manifest
//
// The Access token is sent only to EDGEPHOTOS_URL (as `cf-access-token`), never to presigned R2 URLs,
// and is never written to disk or logs.

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { cliClient } from './cli-client.ts'
import {
  BackupError,
  type BlobStore,
  backupLibrary,
  checkBackup,
  readManifest,
  restoreLibrary,
  type VerifyReport,
  verifyLibrary,
} from './lib/backup.ts'

function usage(): never {
  console.error('usage: pnpm backup <export|check|restore|verify> <directory> [--resume] [--quick]')
  process.exit(2)
}

function fsStore(root: string): BlobStore {
  const base = resolve(root)
  const safe = (path: string) => {
    const full = resolve(base, path)
    // `base + sep`: a sibling such as `${base}-other` must not pass.
    if (full === base || !full.startsWith(base + sep)) throw new Error('path escapes backup directory')
    return full
  }
  const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'
  return {
    async put(path, bytes) {
      const full = safe(path)
      await mkdir(dirname(full), { recursive: true })
      // Write beside the target and rename: an interrupted run never leaves a truncated file under the real name.
      const partial = `${full}.partial-${randomUUID()}`
      try {
        // fsync before the rename so a power loss does not leave an empty file under the real name.
        const file = await open(partial, 'w')
        try {
          await file.writeFile(bytes)
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(partial, full)
      } finally {
        await rm(partial, { force: true })
      }
    },
    async get(path) {
      try {
        return new Uint8Array(await readFile(safe(path)))
      } catch (err) {
        if (missing(err)) return null
        throw err
      }
    },
    async size(path) {
      try {
        return (await stat(safe(path))).size
      } catch (err) {
        if (missing(err)) return null
        throw err
      }
    },
  }
}

function printVerification(v: VerifyReport) {
  console.log(JSON.stringify(v, null, 2))
  if (v.ok) console.log('verify: OK — the library matches the backup.')
  else console.error(`verify: ${v.problems.length} problem(s). The backup directory itself is not changed.`)
}

async function main() {
  const [command, dir, ...flags] = process.argv.slice(2)
  if (!command || !dir) usage()
  const unknown = flags.filter((f) => f !== '--resume' && f !== '--quick')
  if (unknown.length > 0) usage()
  const quick = flags.includes('--quick')
  // resolve(), not join(): join() would silently rewrite an absolute path into one under cwd,
  // writing the backup (originals included) inside the repository.
  const store = fsStore(resolve(process.cwd(), dir))
  switch (command) {
    case 'export': {
      const report = await backupLibrary(cliClient(), store)
      console.log(
        `exported ${report.assets} photos and ${report.albums} albums (downloaded ${report.downloaded}, already in the directory ${report.skipped})`,
      )
      if (report.failed.length > 0) {
        console.error(
          `${report.failed.length} photo(s) could not be copied: their stored original is missing or differs from its recorded SHA-256.`,
        )
        for (const f of report.failed) console.error(`  ${f.assetId} ${f.reason}`)
        console.error('The other photos are in the backup. Run `pnpm storage audit --deep` to see what is wrong.')
        process.exit(1)
      }
      break
    }
    case 'check': {
      const report = await checkBackup(store, (line) => console.error(line))
      console.log(JSON.stringify(report, null, 2))
      if (!report.ok) {
        console.error(
          'check: problems found. Delete the listed files and run `pnpm backup export` again to fetch them.',
        )
        process.exit(1)
      }
      break
    }
    case 'restore': {
      const client = cliClient()
      const report = await restoreLibrary(client, store, { resume: flags.includes('--resume') })
      console.log(
        `restored ${report.assets} photos (${report.uploaded} uploaded in this run) and ${report.albums} albums`,
      )
      const verification = await verifyLibrary(client, await readManifest(store), { quick })
      printVerification(verification)
      if (!verification.ok) process.exit(1)
      break
    }
    case 'verify': {
      const verification = await verifyLibrary(cliClient(), await readManifest(store), { quick })
      printVerification(verification)
      if (!verification.ok) process.exit(1)
      break
    }
    default:
      usage()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'backup failed')
  const [command] = process.argv.slice(2)
  if (command === 'restore') {
    console.error(
      'The restore stopped. Photos restored so far are safe in the target library. ' +
        'Fix the cause (for an expired Access token, get a new one) and run the same command with --resume.',
    )
  } else if (command === 'export' && err instanceof BackupError) {
    console.error('The export stopped. Files already written are kept; run the same command again to continue.')
  }
  process.exit(1)
})
