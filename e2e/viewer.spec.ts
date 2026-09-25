import { statSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { naturalSize, openApp, tile, uniqueName, uploadPhoto } from './fixtures'

test('a preview that cannot be fetched says so and can be retried', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('no-preview')}.jpg`
  await uploadPhoto(page, name)
  const id = await tile(page, name).getAttribute('data-asset-id')
  let failing = true
  // Only the asset detail request that signs the preview URL (not the list, favorite or neighbour prefetch).
  await page.route(
    (url) => url.pathname === `/api/v1/assets/${id}`,
    (route) =>
      failing && route.request().method() === 'GET'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        : route.continue(),
  )

  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  await expect(viewer.getByRole('status').filter({ hasText: '高画質で表示できませんでした' })).toBeVisible()
  // The thumbnail stays on screen meanwhile.
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 512, height: 384 })

  failing = false
  await viewer.getByRole('button', { name: '再試行' }).click()
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 800, height: 600 })
  await expect(viewer.getByText('高画質で表示できませんでした')).toBeHidden()
})

test('a preview URL that fails twice falls back to the thumbnail with a notice', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('bad-preview')}.jpg`
  await uploadPhoto(page, name)
  let failing = true
  // Storage refuses the preview itself (e.g. an expired signature), on the first URL and on the re-signed one.
  // A URL refused once stays refused; only a URL signed after the outage works.
  const refused = new Set<string>()
  await page.route('**/__local/blobs/**', (route) => {
    const url = route.request().url()
    const payload = url.split('/').pop()?.split('.')[0] ?? ''
    const key = JSON.parse(Buffer.from(payload, 'base64url').toString()).k as string
    if (key.endsWith('/preview.jpg') && failing) refused.add(url)
    return refused.has(url) ? route.fulfill({ status: 403, body: 'Request has expired' }) : route.continue()
  })

  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  await expect(viewer.getByText('高画質で表示できませんでした')).toBeVisible()
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 512, height: 384 })

  failing = false
  await viewer.getByRole('button', { name: '再試行' }).click()
  await expect.poll(() => naturalSize(viewer.locator('img'))).toEqual({ width: 800, height: 600 })
})

test('a long album menu stays inside the viewport and scrolls from the keyboard', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('menu')}.jpg`
  await uploadPhoto(page, name)
  const prefix = uniqueName('Many')
  await page.evaluate(async (prefix) => {
    for (let i = 0; i < 30; i++) {
      const res = await fetch('/api/v1/albums', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `${prefix}-${i}` }),
      })
      if (!res.ok) throw new Error(`album ${res.status}`)
    }
  }, prefix)
  await page.setViewportSize({ width: 1024, height: 480 })

  // The viewer loads the album list when it opens; the menu is only complete after that.
  const albumsLoaded = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/albums')
  await tile(page, name).click()
  await albumsLoaded
  const trigger = page.getByRole('dialog', { name }).getByRole('button', { name: 'アルバムに追加' })
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const box = await menu.boundingBox()
  expect(box).toBeTruthy()
  if (box) {
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(480)
  }
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  const items = menu.getByRole('menuitem')
  expect(await items.count()).toBeGreaterThanOrEqual(30)
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('End')
  await expect(items.last()).toBeFocused()
  await expect(items.last()).toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('the info panel names who added the photo, and says so when that was not recorded', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('uploader')}.jpg`
  await uploadPhoto(page, name)
  const id = await tile(page, name).getAttribute('data-asset-id')

  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  await viewer.getByRole('button', { name: '情報', exact: true }).click()
  const info = viewer.getByRole('complementary', { name: '写真の情報' })
  // vite dev signs in as the first DEV_HOUSEHOLD_EMAILS entry (vite.config.ts).
  await expect(info.getByRole('definition').last()).toHaveText('you@localhost.test')
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  // A photo stored before attribution existed comes back with uploadedBy null, in the list and on its own.
  const legacy = (asset: { id: string }) => (asset.id === id ? { ...asset, uploadedBy: null } : asset)
  await page.route(
    (url) => url.pathname.startsWith('/api/v1/assets'),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      const json = Array.isArray(body.items) ? { ...body, items: body.items.map(legacy) } : legacy(body)
      return route.fulfill({ response, json })
    },
  )
  await page.reload()
  await tile(page, name).click()
  await viewer.getByRole('button', { name: '情報', exact: true }).click()
  await expect(info.getByRole('definition').last()).toHaveText('記録なし')
  await expect(info).not.toContainText('you@localhost.test')
  // The viewer may still be prefetching a neighbour through the route when the test ends.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

// The URL of the original is a bearer credential. Saving it must not open a tab on that URL, which would put it
// in the address bar and the browser history (docs/security.md §6).
test('saving the original downloads it without navigating to its presigned URL', async ({ page, context }) => {
  await openApp(page)
  const name = `${uniqueName('save-original')}.jpg`
  await uploadPhoto(page, name)
  const opened: string[] = []
  context.on('page', (p) => opened.push(p.url()))
  const navigations: string[] = []
  page.on('framenavigated', (frame) => navigations.push(frame.url()))

  await tile(page, name).click()
  const viewer = page.getByRole('dialog', { name })
  await viewer.getByRole('button', { name: 'その他の操作' }).click()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '保存したファイルをダウンロード' }).click()
  const download = await downloaded

  expect(download.suggestedFilename()).toBe(name)
  expect(download.url()).toMatch(/^blob:/)
  const path = await download.path()
  expect(statSync(path).size).toBeGreaterThan(0)
  expect(opened).toEqual([])
  expect(navigations.filter((url) => url.includes('/__local/blobs/'))).toEqual([])
})
