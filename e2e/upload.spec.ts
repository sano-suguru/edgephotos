import { expect, test } from '@playwright/test'
import {
  canDecodeHeic,
  expectImageLoaded,
  makeJpeg,
  naturalSize,
  openApp,
  tile,
  uniqueHeic,
  uniqueName,
  uploadFiles,
  uploadPanel,
  uploadPhoto,
  uploadRow,
} from './fixtures'

test('uploads a photo with browser-made derivatives, and takes HEIC where it can decode it', async ({ page }) => {
  await openApp(page)
  // The same question the app asks: some engines decode HEIC on one platform and not on another.
  const heicDecodes = await canDecodeHeic(page)
  const name = `${uniqueName('large')}.jpg`
  const heicName = `${uniqueName('camera')}.heic`
  const rows = await uploadFiles(page, [
    { name, mimeType: 'image/jpeg', buffer: await makeJpeg(page, 3000, 2000) },
    { name: heicName, mimeType: 'image/heic', buffer: uniqueHeic() },
  ])
  // finalize only succeeds if the canvas JPEGs carry no EXIF/XMP/IPTC segment (WebKit adds them, D-020).
  expect(rows.get(name)).toContain('完了')

  // The month navigation reads the real library through the same API (D-031). A canvas JPEG has no capture
  // time, so the photo just uploaded belongs to this month in UTC.
  await page.getByRole('button', { name: '年月で移動' }).click()
  const thisMonth = new Date().toISOString().slice(0, 7)
  await expect(page.getByRole('dialog').locator(`button[data-month="${thisMonth}"]`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  // Whether the HEIC is taken is a decode-capability question. An engine without a decoder says so before
  // anything is reserved or stored.
  if (heicDecodes) {
    expect(rows.get(heicName)).toContain('完了')
    const stored = await page.evaluate(async (filename) => {
      const res = await fetch('/api/v1/assets?limit=200')
      const body = await res.json()
      return body.items.find((i: { filename: string }) => i.filename === filename)
    }, heicName)
    // The bytes are stored as they arrived, and EXIF Orientation 6 on a 64x32 original means the recorded
    // size is the displayed one.
    expect(stored.contentType).toBe('image/heic')
    expect([stored.width, stored.height]).toEqual([32, 64])
    // And the derivative itself is the right way up, not only the recorded size: a 64x32 original with
    // EXIF Orientation 6 makes a portrait thumbnail (below the 512 limit, so it is never upscaled).
    // Its EXIF puts it in 2019, so it sits at the bottom of the timeline; thumbnails there load lazily.
    await tile(page, heicName).scrollIntoViewIfNeeded()
    const heicThumbnail = tile(page, heicName).locator('img')
    await expectImageLoaded(heicThumbnail)
    expect(await naturalSize(heicThumbnail)).toEqual({ width: 32, height: 64 })
    // The capture time comes from the HEIC's own EXIF, so the timeline can order it by when it was taken.
    expect(stored.takenAt).toBe('2019-07-14T09:30:05')

    // The picker does not always say what it handed over. HEIC bytes under a type that claims nothing are
    // still that photo.
    const opaqueName = `${uniqueName('unlabelled')}.heic`
    const opaque = await uploadFiles(page, [
      { name: opaqueName, mimeType: 'application/octet-stream', buffer: uniqueHeic() },
    ])
    expect(opaque.get(opaqueName)).toContain('完了')
    const byBytes = await page.evaluate(async (filename) => {
      const res = await fetch('/api/v1/assets?limit=200')
      return (await res.json()).items.find((i: { filename: string }) => i.filename === filename)
    }, opaqueName)
    expect(byBytes.contentType).toBe('image/heic')
  } else {
    // A failure keeps the summary (and its rows) until dismissed.
    await expect(uploadRow(page, heicName)).toContainText('このブラウザでは HEIC を処理できません')
  }

  // Two files a HEIC decoder is happy to overlook, and one rule: nothing half-there is stored.
  const full = uniqueHeic()
  // Half the file. WebKit decodes this to a picture; the boxes still say the second half never arrived.
  const half = { name: 'half.heic', mimeType: 'image/heic', buffer: full.subarray(0, full.length >> 1) }
  // Header kept, everything after it padding. Nothing here is a box, and exifr never returns from it.
  const hollow = Buffer.concat([full.subarray(0, 36), Buffer.alloc(full.length - 36)])
  const rejected = await uploadFiles(page, [half, { name: 'hollow.heic', mimeType: 'image/heic', buffer: hollow }])
  for (const name of ['half.heic', 'hollow.heic']) {
    // Without a decoder the refusal comes earlier, before the file is even read.
    expect(rejected.get(name)).toContain(
      heicDecodes ? '最後まで揃っていません' : 'このブラウザでは HEIC を処理できません',
    )
  }
  const stored = await page.evaluate(() => fetch('/api/v1/assets?limit=200').then((r) => r.json()))
  const names = stored.items.map((i: { filename: string }) => i.filename)
  expect(names).not.toContain('half.heic')
  expect(names).not.toContain('hollow.heic')

  const thumbnail = tile(page, name).locator('img')
  await expectImageLoaded(thumbnail)
  expect(await naturalSize(thumbnail)).toEqual({ width: 512, height: 341 })

  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  // Details stay out of the way until asked for.
  await viewer.getByRole('button', { name: '情報', exact: true }).click()
  await expect(viewer.getByRole('complementary', { name: '写真の情報' })).toContainText('3000×2000')
  // The cached thumbnail shows first; the preview replaces it once its URL is fetched.
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 2048, height: 1365 })

  await page.reload()
  await expectImageLoaded(tile(page, name).locator('img'))
})

test('a clean upload summary clears itself, but not while another upload runs or after a failure', async ({ page }) => {
  await page.clock.install()
  await openApp(page)
  const first = `${uniqueName('clean-a')}.jpg`
  const second = `${uniqueName('clean-b')}.jpg`
  const secondBuffer = await makeJpeg(page, 320, 240)
  await uploadPhoto(page, first)

  // Start the next photo right away and hold its storage PUTs: the pending clear must not run meanwhile.
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/__local/blobs/**', async (route) => {
    if (route.request().method() === 'PUT') await held
    return route.continue()
  })
  await page.locator('input[type=file]').setInputFiles([{ name: second, mimeType: 'image/jpeg', buffer: secondBuffer }])
  await expect(uploadRow(page, second)).toContainText('転送中')
  await page.clock.fastForward('00:30')
  await expect(uploadRow(page, first)).toContainText('完了')
  await expect(uploadRow(page, second)).toContainText('転送中')

  release()
  await expect(uploadRow(page, second)).toContainText('完了')
  await expect(uploadPanel(page)).toBeVisible()
  // The dismissal is scheduled by an effect that runs after the row shows 完了, so advancing the clock once
  // can land before the timer exists and then never fire it. Keep advancing until the summary goes.
  await expect
    .poll(async () => {
      await page.clock.fastForward('00:06')
      return uploadPanel(page).isVisible()
    })
    .toBe(false)

  // Bytes that claim to be HEIC but are not: refused from the bytes, in every engine.
  await uploadFiles(page, [{ name: 'broken.heic', mimeType: 'image/heic', buffer: Buffer.from('not a real HEIC') }])
  await page.clock.fastForward('00:30')
  await expect(uploadRow(page, 'broken.heic')).toContainText('対応していない形式です')
  await expect(page.getByRole('button', { name: /再試行/ })).toHaveCount(0)
})

test('recovers after the presigned image URLs expire', async ({ page }) => {
  // Presigned GETs live 600 s (docs/security.md §6). Storage answers an expired signature with 403;
  // emulate that for every URL the page received before the clock jump.
  const issued = new Set<string>()
  const collect = (value: unknown) => {
    if (typeof value === 'string' && value.includes('/__local/blobs/')) issued.add(value)
    else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v)
  }
  page.on('response', async (res) => {
    if (res.url().includes('/api/v1/') && res.headers()['content-type']?.includes('json')) {
      collect(await res.json().catch(() => null))
    }
  })

  // A thumbnail that only starts loading after the URLs lapsed (lazy loading below the fold, a tab left
  // open): hold its request until the clock jump, then answer like expired storage.
  let stale: Set<string> | null = null
  let jumped!: () => void
  const afterJump = new Promise<void>((resolve) => {
    jumped = resolve
  })
  const isThumbnail = (url: string) => {
    const payload = url.split('/').pop()?.split('.')[0] ?? ''
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).k.endsWith('/thumbnail.jpg')
  }
  await page.route('**/__local/blobs/**', async (route) => {
    const url = route.request().url()
    if (route.request().method() !== 'GET') return route.continue()
    if (!stale && isThumbnail(url)) await afterJump
    if (stale?.has(url)) return route.fulfill({ status: 403, body: 'Request has expired' })
    return route.continue()
  })

  await page.clock.install()
  await openApp(page)
  const name = `${uniqueName('stale')}.jpg`
  const thumbnailRequested = page.waitForRequest(
    (req) => req.url().includes('/__local/blobs/') && isThumbnail(req.url()),
  )
  await uploadPhoto(page, name)
  await thumbnailRequested

  stale = new Set(issued)
  await page.clock.fastForward('11:00')
  jumped()
  await expectImageLoaded(tile(page, name).locator('img'))
  expect(stale.has((await tile(page, name).locator('img').getAttribute('src')) ?? '')).toBe(false)

  // Past expiry once more. A thumbnail that was already shown fails later (e.g. the browser dropped the
  // decoded image and refetched its old URL): it alone must get a fresh URL.
  stale = new Set(issued)
  await page.clock.fastForward('11:00')
  const shownThumbnail = tile(page, name).locator('img')
  const before = await shownThumbnail.getAttribute('src')
  await shownThumbnail.evaluate((img) => img.dispatchEvent(new Event('error')))
  await expect.poll(() => shownThumbnail.getAttribute('src')).not.toBe(before)
  await expectImageLoaded(shownThumbnail)
  expect(stale.has((await shownThumbnail.getAttribute('src')) ?? '')).toBe(false)

  // The viewer signs its preview URL when it opens, so it is fresh even after the page sat idle.
  stale = new Set(issued)
  await page.clock.fastForward('11:00')
  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 800, height: 600 })
  expect(stale.has((await viewer.locator('img').getAttribute('src')) ?? '')).toBe(false)
})

// The asset a presigned local-blob URL belongs to: its key is `originals/{assetId}` or
// `derivatives/v1/{assetId}/...`, so every object of one photo answers with the same id.
function assetOf(url: string): string {
  const payload = url.split('/').pop()?.split('.')[0] ?? ''
  const key: string = JSON.parse(Buffer.from(payload, 'base64url').toString()).k
  return key.replace(/^originals\/|^derivatives\/v1\//, '').split('/')[0]
}

test('keeps the photos a batch stored and retries only the one storage refused', async ({ page }) => {
  await openApp(page)
  const names = [`${uniqueName('batch-a')}.jpg`, `${uniqueName('batch-b')}.jpg`]

  // Storage refuses every object of whichever photo reaches it first, the way an expired signature does.
  // Which one that is depends on the order the two transfers interleave, so the test reads it off the rows.
  let doomed: string | null = null
  let refusing = true
  await page.route('**/__local/blobs/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const asset = assetOf(route.request().url())
    doomed ??= asset
    if (refusing && asset === doomed) return route.fulfill({ status: 403, body: 'Request has expired' })
    return route.continue()
  })

  const rows = await uploadFiles(
    page,
    await Promise.all(
      names.map(async (name) => ({ name, mimeType: 'image/jpeg', buffer: await makeJpeg(page, 640, 480) })),
    ),
  )
  const failed = names.filter((n) => rows.get(n)?.includes('失敗'))
  const stored = names.filter((n) => rows.get(n)?.includes('完了'))
  expect([failed.length, stored.length]).toEqual([1, 1])

  // One failure is one failure: the photo that was stored is in the timeline and counted as added.
  await expect(uploadPanel(page)).toContainText('1 枚を追加しました、1 枚は追加できませんでした')
  await expectImageLoaded(tile(page, stored[0]).locator('img'))
  await expect(tile(page, failed[0])).toHaveCount(0)

  refusing = false
  await page.getByRole('button', { name: '失敗した 1 枚を再試行' }).click()
  await expect(uploadRow(page, failed[0])).toContainText('完了', { timeout: 30_000 })
  await expectImageLoaded(tile(page, failed[0]).locator('img'))

  // The retry finished the reservation the first attempt left behind: one asset per photo, not three.
  const items = await page.evaluate(async (wanted: string[]) => {
    const res = await fetch('/api/v1/assets?limit=200')
    const body = (await res.json()) as { items: { filename: string }[] }
    return body.items.filter((i) => wanted.includes(i.filename)).map((i) => i.filename)
  }, names)
  expect(items.sort()).toEqual([...names].sort())
})
