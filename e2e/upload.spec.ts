import { expect, test } from '@playwright/test'
import {
  expectImageLoaded,
  heicFixture,
  makeJpeg,
  naturalSize,
  openApp,
  tile,
  uniqueName,
  uploadFiles,
  uploadPanel,
  uploadPhoto,
  uploadRow,
} from './fixtures'

test('uploads a photo with browser-made derivatives, and takes HEIC where it can decode it', async ({
  page,
  browserName,
}) => {
  await openApp(page)
  const name = `${uniqueName('large')}.jpg`
  const rows = await uploadFiles(page, [
    { name, mimeType: 'image/jpeg', buffer: await makeJpeg(page, 3000, 2000) },
    { name: 'camera.heic', mimeType: 'image/heic', buffer: heicFixture() },
  ])
  // finalize only succeeds if the canvas JPEGs carry no EXIF/XMP/IPTC segment (WebKit adds them, D-020).
  expect(rows.get(name)).toContain('完了')

  // Whether the HEIC is taken is a decode-capability question, answered by a probe, not by the engine name.
  // WebKit decodes HEVC-coded HEIC; Chromium does not, and says so before anything is reserved or stored.
  if (browserName === 'webkit') {
    expect(rows.get('camera.heic')).toContain('完了')
    const stored = await page.evaluate(async () => {
      const res = await fetch('/api/v1/assets?limit=200')
      const body = await res.json()
      return body.items.find((i: { filename: string }) => i.filename === 'camera.heic')
    })
    // The bytes are stored as they arrived, and EXIF Orientation 6 on a 64x32 original means the recorded
    // size is the displayed one.
    expect(stored.contentType).toBe('image/heic')
    expect([stored.width, stored.height]).toEqual([32, 64])
  } else {
    // A failure keeps the summary (and its rows) until dismissed.
    await expect(uploadRow(page, 'camera.heic')).toContainText('このブラウザでは HEIC を処理できません')
  }

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
  await page.clock.fastForward('00:06')
  await expect(uploadPanel(page)).toBeHidden()

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
