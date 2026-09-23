import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DerivativeRepair, StorageAuditIssue, StorageAuditPage } from '../../src/contracts/schemas'
import { objectKey } from '../../src/worker/storage/keys'
import { call, callJson, makeApp, photo, putObject, sha256, syntheticJpeg, syntheticPng, uploadPhoto } from '../helpers'

// Repairing a missing thumbnail / preview must never put the original at risk (docs/decisions.md D-026).
// Every test here asserts what the repair did NOT change as much as what it fixed.

type App = Awaited<ReturnType<typeof makeApp>>

async function resetStorage() {
  await env.DB.batch(
    ['album_assets', 'albums', 'shares', 'uploads', 'assets', 'settings'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  for (;;) {
    const listed = await env.BUCKET.list()
    if (listed.objects.length === 0) break
    await env.BUCKET.delete(listed.objects.map((o) => o.key))
  }
}

async function auditAll(app: App): Promise<StorageAuditIssue[]> {
  const issues: StorageAuditIssue[] = []
  let after: string | null = null
  do {
    const qs = new URLSearchParams({ limit: '200' })
    if (after) qs.set('after', after)
    const page: StorageAuditPage = await callJson(app, 'GET', `/api/v1/storage/audit?${qs}`, { expect: 200 })
    issues.push(...page.issues)
    after = page.nextAfter
  } while (after)
  return issues
}

const repair = (app: App, assetId: string, expect = 200) =>
  callJson<DerivativeRepair>(app, 'POST', `/api/v1/assets/${assetId}/derivatives/repair`, { expect })

// Everything about the photo that a repair must leave exactly as it was.
async function snapshot(assetId: string) {
  const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first()
  const albumRows = await env.DB.prepare('SELECT * FROM album_assets WHERE asset_id = ? ORDER BY album_id')
    .bind(assetId)
    .all()
  const uploadRows = await env.DB.prepare('SELECT * FROM uploads WHERE asset_id = ?').bind(assetId).all()
  const head = await env.BUCKET.head(objectKey(assetId, 'original'))
  const body = await env.BUCKET.get(objectKey(assetId, 'original'))
  return {
    asset,
    albums: albumRows.results,
    uploads: uploadRows.results,
    original: head && {
      size: head.size,
      etag: head.etag,
      checksum: head.checksums.sha256 ? [...new Uint8Array(head.checksums.sha256)] : null,
    },
    // The bytes themselves, not just the metadata R2 reports about them.
    originalSha256: body ? await sha256(new Uint8Array(await body.arrayBuffer())) : null,
  }
}

async function derivativeState(assetId: string) {
  const state: Record<string, { size: number; etag: string } | null> = {}
  for (const variant of ['thumbnail', 'preview'] as const) {
    const head = await env.BUCKET.head(objectKey(assetId, variant))
    state[variant] = head && { size: head.size, etag: head.etag }
  }
  return state
}

describe('derivative repair', () => {
  let app: App

  beforeEach(async () => {
    await resetStorage()
    app = await makeApp()
  })

  describe('the failure it exists for', () => {
    for (const missing of [['thumbnail'], ['preview'], ['thumbnail', 'preview']] as const) {
      it(`repairs a photo whose ${missing.join(' and ')} went missing, without touching the original`, async () => {
        const { result } = await uploadPhoto(app)
        const id = result.asset.id
        const before = await snapshot(id)

        // The damage the storage audit can already see, but could not fix without a delete + re-upload.
        for (const variant of missing) await env.BUCKET.delete(objectKey(id, variant))
        expect(await auditAll(app)).toEqual([{ kind: 'missing_derivative', assetId: id, objects: [...missing] }])

        const first = await repair(app, id)
        expect(first.status).toBe('incomplete')
        expect(first.missing).toEqual([...missing])
        expect(first.source).toBeTruthy()
        expect(Object.keys(first.targets)).toEqual([...missing])

        // The browser rebuilds the derivatives from the original it just downloaded.
        const source = await app.request(first.source?.url as string)
        expect(source.status).toBe(200)
        expect(await sha256(new Uint8Array(await source.arrayBuffer()))).toBe(before.originalSha256)
        for (const variant of missing) {
          const res = await putObject(app, first.targets[variant] as never, syntheticJpeg())
          expect(res.status).toBe(200)
        }

        const second = await repair(app, id)
        expect(second.status).toBe('ok')
        expect(second.missing).toEqual([])
        expect(second.source).toBeUndefined()

        expect(await auditAll(app)).toEqual([])
        expect(await snapshot(id)).toEqual(before)
      })
    }
  })

  describe('the original', () => {
    it('is never offered for writing: the repair signs PUTs for derivative keys only', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      await env.BUCKET.delete(objectKey(id, 'preview'))

      const res = await repair(app, id)
      const urls = Object.values(res.targets).map((t) => t.url)
      expect(urls).toHaveLength(2)
      for (const url of [...urls, res.source?.url as string]) {
        expect(url).not.toContain('originals')
      }
      // The signed GET for the original is a read; it cannot be replayed as a write.
      const written = await app.request(res.source?.url as string, { method: 'PUT', body: 'x' })
      expect(written.status).toBe(403)
      expect(await sha256(new Uint8Array(await (await env.BUCKET.get(objectKey(id, 'original')))!.arrayBuffer()))).toBe(
        result.asset.sha256,
      )
    })

    it('refuses to hand out a repair when the original is missing', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'original'))
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))

      const res = await call(app, 'POST', `/api/v1/assets/${id}/derivatives/repair`)
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: { code: string; details?: { problem?: string } } }
      expect(body.error.code).toBe('REPAIR_SOURCE_UNUSABLE')
      expect(body.error.details?.problem).toBe('missing')
    })

    it('refuses to hand out a repair when the stored original is not the uploaded file', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))

      // Same size, different bytes: only the recorded SHA-256 tells them apart.
      const tampered = syntheticJpeg({ exif: true, padding: 128 })
      expect(tampered.byteLength).toBe(result.asset.originalSize)
      await env.BUCKET.put(objectKey(id, 'original'), tampered as Uint8Array<ArrayBuffer>, {
        sha256: await sha256(tampered),
      })

      const res = await call(app, 'POST', `/api/v1/assets/${id}/derivatives/repair`)
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: { code: string; details?: { problem?: string } } }
      expect(body.error.details?.problem).toBe('checksum_mismatch')
    })

    it('deletes nothing when it refuses: an unusable derivative outlives a damaged original', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      // A thumbnail that would be rejected, on a photo whose original is gone.
      await env.BUCKET.put(objectKey(id, 'thumbnail'), syntheticJpeg({ exif: true }) as Uint8Array<ArrayBuffer>)
      await env.BUCKET.delete(objectKey(id, 'original'))
      const derivativesBefore = await derivativeState(id)

      const res = await call(app, 'POST', `/api/v1/assets/${id}/derivatives/repair`)
      expect(res.status).toBe(409)
      // Removing it would gain nothing: without the original nothing can take its place.
      expect(await derivativeState(id)).toEqual(derivativesBefore)
    })

    it('refuses to hand out a repair when the stored original has the wrong size', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      await env.BUCKET.put(objectKey(id, 'original'), syntheticJpeg({ padding: 999 }) as Uint8Array<ArrayBuffer>)

      const res = await call(app, 'POST', `/api/v1/assets/${id}/derivatives/repair`)
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: { code: string; details?: { problem?: string } } }
      expect(body.error.details?.problem).toBe('size_mismatch')
    })
  })

  describe('a healthy photo', () => {
    it('is reported ok and its derivatives are left byte-for-byte alone', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      const before = await snapshot(id)
      const derivativesBefore = await derivativeState(id)

      const res = await repair(app, id)
      expect(res.status).toBe('ok')
      expect(res.missing).toEqual([])
      expect(res.rejected).toEqual([])
      expect(res.targets).toEqual({})
      expect(res.source).toBeUndefined()

      expect(await derivativeState(id)).toEqual(derivativesBefore)
      expect(await snapshot(id)).toEqual(before)
      expect(await auditAll(app)).toEqual([])
    })
  })

  describe('a derivative that was written but is not usable', () => {
    const cases = [
      { name: 'carries EXIF', bytes: () => syntheticJpeg({ exif: true }), problem: 'metadata_segment' },
      {
        name: 'carries a comment (COM)',
        bytes: () => syntheticJpeg({ segments: [[0xfe, 'fictional']] }),
        problem: 'metadata_segment',
      },
      { name: 'is not a JPEG', bytes: () => syntheticPng(), problem: 'not_jpeg' },
      { name: 'stops mid-header (partial PUT)', bytes: () => syntheticJpeg().slice(0, 12), problem: 'truncated' },
      // An empty object must not survive: If-None-Match: * would block every later repair of that key.
      { name: 'is empty (a PUT that sent no body)', bytes: () => new Uint8Array(0), problem: 'not_jpeg' },
    ]

    for (const c of cases) {
      it(`${c.name}: is reported and replaced in place, never deleted`, async () => {
        const { result } = await uploadPhoto(app)
        const id = result.asset.id
        const before = await snapshot(id)
        await env.BUCKET.delete(objectKey(id, 'thumbnail'))

        const first = await repair(app, id)
        const put = await putObject(app, first.targets.thumbnail as never, c.bytes())
        expect(put.status).toBe(200)

        const second = await repair(app, id)
        expect(second.rejected).toEqual([{ object: 'thumbnail', problem: c.problem }])
        expect(second.missing).toEqual(['thumbnail'])
        // Not deleted: the target replaces exactly this object instead.
        const stillThere = await env.BUCKET.head(objectKey(id, 'thumbnail'))
        expect(stillThere).not.toBeNull()
        expect(second.targets.thumbnail?.headers['if-match']).toBe(stillThere?.httpEtag)
        expect(second.targets.thumbnail?.headers['if-none-match']).toBeUndefined()
        expect(await snapshot(id)).toEqual(before)

        // The replacing target overwrites the unusable object with a good one.
        expect((await putObject(app, second.targets.thumbnail as never, syntheticJpeg())).status).toBe(200)
        expect((await repair(app, id)).status).toBe('ok')
        expect(await auditAll(app)).toEqual([])
      })
    }

    it('rejects a thumbnail larger than the contract allows', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      const first = await repair(app, id)
      const huge = syntheticJpeg({ padding: 2 * 1024 * 1024 })

      expect((await putObject(app, first.targets.thumbnail as never, huge)).status).toBe(200)
      const second = await repair(app, id)
      expect(second.rejected).toEqual([{ object: 'thumbnail', problem: 'too_large' }])
      expect(await env.BUCKET.head(objectKey(id, 'thumbnail'))).not.toBeNull()
      expect((await putObject(app, second.targets.thumbnail as never, syntheticJpeg())).status).toBe(200)
      expect((await repair(app, id)).status).toBe('ok')
    })
  })

  describe('retries and concurrency', () => {
    it('is idempotent: calling it again without PUTting anything reports the same work', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'preview'))

      const a = await repair(app, id)
      const b = await repair(app, id)
      expect(b.missing).toEqual(a.missing)
      expect(b.status).toBe('incomplete')
      expect(Object.keys(b.targets)).toEqual(['preview'])
    })

    it('lets the loser of a concurrent repair see 412 without corrupting the winner', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))

      // Two tabs each hold a repair for the same photo.
      const tabA = await repair(app, id)
      const tabB = await repair(app, id)

      const winner = syntheticJpeg()
      expect((await putObject(app, tabA.targets.thumbnail as never, winner)).status).toBe(200)
      // If-None-Match: * means the second tab cannot overwrite what the first one stored.
      expect((await putObject(app, tabB.targets.thumbnail as never, syntheticJpeg())).status).toBe(412)

      const stored = await env.BUCKET.get(objectKey(id, 'thumbnail'))
      expect(await sha256(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer()))).toBe(await sha256(winner))
      expect((await repair(app, id)).status).toBe('ok')
      expect(await auditAll(app)).toEqual([])
    })

    // Two repairs inspect the SAME unusable object; one gets the photo fixed, and the other then acts on the
    // view it took earlier. What is pinned here is that a stale view can only be refused, never destructive:
    // the straggler's target is bound to the object it inspected, so it cannot touch the newer one.
    // This is why an unusable derivative is replaced rather than deleted first. A delete is unconditional in
    // R2, so a straggler that deleted "the broken object" would remove whatever is at that key by then --
    // including the good thumbnail the other repair just wrote. The interleaving itself is not reproducible
    // here (the local runtime serializes requests, as noted in services/uploads.ts); the condition on the
    // target is what makes it impossible (docs/decisions.md D-026).
    it('cannot undo a newer repair: a straggler holding a stale view of a broken object is refused', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      const before = await snapshot(id)
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      // Both tabs find the same unusable thumbnail.
      await putObject(app, (await repair(app, id)).targets.thumbnail as never, syntheticJpeg({ exif: true }))

      const straggler = await repair(app, id)
      const winner = await repair(app, id)
      expect(straggler.rejected).toEqual([{ object: 'thumbnail', problem: 'metadata_segment' }])
      expect(winner.rejected).toEqual([{ object: 'thumbnail', problem: 'metadata_segment' }])

      // The winner repairs the photo.
      const good = syntheticJpeg()
      expect((await putObject(app, winner.targets.thumbnail as never, good)).status).toBe(200)
      expect((await repair(app, id)).status).toBe('ok')
      const repaired = await derivativeState(id)

      // The straggler now acts on a view of the world that is out of date.
      expect((await putObject(app, straggler.targets.thumbnail as never, syntheticJpeg())).status).toBe(412)

      // The good thumbnail is still there, byte for byte, and the photo is still healthy.
      expect(await derivativeState(id)).toEqual(repaired)
      const stored = await env.BUCKET.get(objectKey(id, 'thumbnail'))
      expect(await sha256(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer()))).toBe(await sha256(good))
      expect((await repair(app, id)).status).toBe('ok')
      expect(await auditAll(app)).toEqual([])
      expect(await snapshot(id)).toEqual(before)
    })

    it('never overwrites a derivative that is already valid', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      const first = await repair(app, id)
      expect((await putObject(app, first.targets.thumbnail as never, syntheticJpeg())).status).toBe(200)
      const settled = await derivativeState(id)

      // A stale target from before the key was filled cannot replace it.
      expect((await putObject(app, first.targets.thumbnail as never, syntheticJpeg())).status).toBe(412)
      expect(await derivativeState(id)).toEqual(settled)
    })
  })

  describe('deletion races', () => {
    it('refuses a repair for a photo that was permanently deleted', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      await callJson(app, 'POST', `/api/v1/assets/${id}/trash`, { expect: 200 })
      await call(app, 'DELETE', `/api/v1/assets/${id}`)

      const res = await call(app, 'POST', `/api/v1/assets/${id}/derivatives/repair`)
      expect(res.status).toBe(404)
    })

    it('repairs a photo in the trash without taking it out of the trash', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      const trashed = await callJson<{ trashedAt: string }>(app, 'POST', `/api/v1/assets/${id}/trash`, { expect: 200 })
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      const before = await snapshot(id)

      const res = await repair(app, id)
      expect((await putObject(app, res.targets.thumbnail as never, syntheticJpeg())).status).toBe(200)
      expect((await repair(app, id)).status).toBe('ok')

      const after = await callJson<{ trashedAt: string }>(app, 'GET', `/api/v1/assets/${id}`, { expect: 200 })
      expect(after.trashedAt).toBe(trashed.trashedAt)
      expect(await snapshot(id)).toEqual(before)
    })

    it('leaves only derivative objects behind when the photo is purged mid-repair', async () => {
      const { result } = await uploadPhoto(app)
      const id = result.asset.id
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      const res = await repair(app, id)

      // The owner deletes the photo while the browser is still rendering.
      await callJson(app, 'POST', `/api/v1/assets/${id}/trash`, { expect: 200 })
      await call(app, 'DELETE', `/api/v1/assets/${id}`)
      // The late PUT lands on a key nothing refers to any more.
      await putObject(app, res.targets.thumbnail as never, syntheticJpeg())

      // The original stays deleted and the audit reports the leftover it already knows how to classify.
      expect(await env.BUCKET.head(objectKey(id, 'original'))).toBeNull()
      expect(await auditAll(app)).toEqual([{ kind: 'unreferenced_objects', assetId: id, objects: ['thumbnail'] }])
      await call(app, 'POST', `/api/v1/assets/${id}/derivatives/repair`).then((r) => expect(r.status).toBe(404))
    })
  })

  describe('the request itself', () => {
    it('takes only an asset id: no client-supplied key reaches storage', async () => {
      const res = await call(app, 'POST', '/api/v1/assets/originals%2Fevil/derivatives/repair')
      expect(res.status).toBe(400)
    })

    it('requires the owner', async () => {
      const { result } = await uploadPhoto(app)
      const res = await call(app, 'POST', `/api/v1/assets/${result.asset.id}/derivatives/repair`, { token: null })
      expect(res.status).toBe(401)
    })

    it('is a write, so it is refused from another origin', async () => {
      const { result } = await uploadPhoto(app)
      const res = await call(app, 'POST', `/api/v1/assets/${result.asset.id}/derivatives/repair`, {
        headers: { origin: 'https://evil.example' },
      })
      expect(res.status).toBe(403)
    })

    it('reports an unknown photo as not found', async () => {
      const res = await call(app, 'POST', '/api/v1/assets/0b8f1d3e-4c6a-4f51-9a0e-2b7c5d9e8f10/derivatives/repair')
      expect(res.status).toBe(404)
    })
  })

  describe('album membership and favorites', () => {
    it('survives a repair unchanged', async () => {
      const { result } = await uploadPhoto(app, await photo())
      const id = result.asset.id
      const album = await callJson<{ id: string }>(app, 'POST', '/api/v1/albums', {
        expect: 201,
        body: { title: 'Repair' },
      })
      await call(app, 'PUT', `/api/v1/albums/${album.id}/assets/${id}`)
      await callJson(app, 'PATCH', `/api/v1/assets/${id}`, { expect: 200, body: { isFavorite: true } })
      await env.BUCKET.delete(objectKey(id, 'thumbnail'))
      await env.BUCKET.delete(objectKey(id, 'preview'))
      const before = await snapshot(id)

      const res = await repair(app, id)
      for (const variant of ['thumbnail', 'preview'] as const) {
        await putObject(app, res.targets[variant] as never, syntheticJpeg())
      }
      expect((await repair(app, id)).status).toBe('ok')

      expect(await snapshot(id)).toEqual(before)
      const asset = await callJson<{ isFavorite: boolean }>(app, 'GET', `/api/v1/assets/${id}`, { expect: 200 })
      expect(asset.isFavorite).toBe(true)
      const page = await callJson<{ items: { id: string }[] }>(app, 'GET', `/api/v1/albums/${album.id}/assets`, {
        expect: 200,
      })
      expect(page.items.map((i) => i.id)).toEqual([id])
    })
  })
})
