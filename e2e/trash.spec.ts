import type { Page } from '@playwright/test'
import { expect, openApp, test, tile, uniqueName, uploadPhoto } from './fixtures'

// Trash, restore, complete deletion and removal from an album, from the viewer, with the undo the toast offers
// (src/web/features/timeline/AssetGrid.tsx). The server side is covered by the workerd tests; what only a
// browser shows is which request each button and each undo sends, and what the grids show afterwards.

// Setup and checks go straight to the API. Callers assert the status, and a body that is not JSON (an error
// page) fails naming the request, so a broken request is reported as that request rather than as a later
// assertion about the grid.
async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p, {
        method: m,
        headers: b === undefined ? undefined : { 'content-type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
      })
      return { status: r.status, text: await r.text() }
    },
    [method, path, body] as const,
  )
  try {
    return { status: res.status, json: (res.text ? JSON.parse(res.text) : null) as T }
  } catch {
    throw new Error(`${method} ${path}: ${res.status} with a body that is not JSON`)
  }
}

async function createAlbum(page: Page, title: string): Promise<string> {
  const res = await api<{ id: string }>(page, 'POST', '/api/v1/albums', { title })
  expect(res.status, `POST /api/v1/albums`).toBeLessThan(300)
  return res.json.id
}

// Where the photo is, read by its ID: not from a list page, which other specs' photos can push it off.
async function state(page: Page, id: string): Promise<'library' | 'trash' | 'gone'> {
  const res = await api<{ trashedAt: string | null }>(page, 'GET', `/api/v1/assets/${id}`)
  if (res.status === 404) return 'gone'
  expect(res.status, `GET /api/v1/assets/${id}`).toBe(200)
  return res.json.trashedAt ? 'trash' : 'library'
}

async function isFavorite(page: Page, id: string): Promise<boolean> {
  const res = await api<{ isFavorite: boolean }>(page, 'GET', `/api/v1/assets/${id}`)
  expect(res.status, `GET /api/v1/assets/${id}`).toBe(200)
  return res.json.isFavorite
}

async function upload(page: Page, prefix: string) {
  const name = `${uniqueName(prefix)}.jpg`
  await uploadPhoto(page, name)
  const id = await tile(page, name).getAttribute('data-asset-id')
  expect(id).toBeTruthy()
  return { name, id: id as string }
}

// The photo viewer, not a confirmation dialog opened over it: only the viewer has the 情報 button.
const viewer = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '情報' }) })

test('a photo moved to the trash from the viewer comes back with the undo', async ({ page }) => {
  await openApp(page)
  const { name, id } = await upload(page, 'trash-undo')

  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: 'ゴミ箱へ移動' }).click()
  await expect(page.getByText(`「${name}」をゴミ箱に移動しました`)).toBeVisible()
  expect(await state(page, id)).toBe('trash')

  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.getByText('元に戻しました')).toBeVisible()
  expect(await state(page, id)).toBe('library')

  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  await expect(tile(page, name)).toBeVisible()
})

test('a restored photo keeps its favorite and its album, and its undo sends it back to the trash', async ({ page }) => {
  await openApp(page)
  const { name, id } = await upload(page, 'restore')
  const album = uniqueName('Restore')
  const albumId = await createAlbum(page, album)

  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: 'お気に入り' }).click()
  await expect(viewer(page).getByRole('button', { name: 'お気に入り' })).toHaveAttribute('aria-pressed', 'true')
  await viewer(page).getByRole('button', { name: 'アルバムに追加' }).click()
  await page.getByRole('menuitem', { name: album }).click()
  await expect(page.getByText(`「${album}」に追加しました`)).toBeVisible()
  await viewer(page).getByRole('button', { name: 'ゴミ箱へ移動' }).click()
  await expect(page.getByText(`「${name}」をゴミ箱に移動しました`)).toBeVisible()

  // The trash is reached from 管理, not from the timeline.
  await openApp(page, '/trash')
  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: '復元' }).click()
  await expect(page.getByText(`「${name}」を復元しました`)).toBeVisible()
  expect(await state(page, id)).toBe('library')

  // Undo from the trash moves it back there, and the trash grid shows it again.
  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.getByText('元に戻しました')).toBeVisible()
  expect(await state(page, id)).toBe('trash')
  if (await viewer(page).isVisible()) await page.keyboard.press('Escape')
  await expect(tile(page, name)).toBeVisible()

  // Restored for good: back on the timeline, still a favorite and still in the album.
  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: '復元' }).click()
  await expect(page.getByText(`「${name}」を復元しました`)).toBeVisible()
  expect(await state(page, id)).toBe('library')
  expect(await isFavorite(page, id)).toBe(true)
  await openApp(page, '/favorites')
  await expect(tile(page, name)).toBeVisible()
  await openApp(page, `/albums/${albumId}`)
  await expect(tile(page, name)).toBeVisible()
})

test('complete deletion asks first: cancelling keeps the photo, confirming removes it for good', async ({ page }) => {
  await openApp(page)
  const { name, id } = await upload(page, 'purge')
  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: 'ゴミ箱へ移動' }).click()
  await expect(page.getByText(`「${name}」をゴミ箱に移動しました`)).toBeVisible()

  await openApp(page, '/trash')
  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: '完全に削除' }).click()
  const confirm = page.getByRole('dialog', { name: '完全に削除しますか？' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'キャンセル' }).click()
  await expect(confirm).toBeHidden()
  expect(await state(page, id)).toBe('trash')

  await viewer(page).getByRole('button', { name: '完全に削除' }).click()
  await confirm.getByRole('button', { name: '完全に削除' }).click()
  await expect(page.getByText('完全に削除しました')).toBeVisible()
  // No undo is offered: the original is gone.
  await expect(page.getByRole('button', { name: '元に戻す' })).toHaveCount(0)
  expect(await state(page, id)).toBe('gone')
  if (await viewer(page).isVisible()) await page.keyboard.press('Escape')
  await expect(tile(page, name)).toHaveCount(0)
})

test('a photo taken out of an album returns to it with the undo, and stays after a reload', async ({ page }) => {
  await openApp(page)
  const { name, id } = await upload(page, 'album-undo')
  const album = uniqueName('Undo')
  const albumId = await createAlbum(page, album)
  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: 'アルバムに追加' }).click()
  await page.getByRole('menuitem', { name: album }).click()
  await expect(page.getByText(`「${album}」に追加しました`)).toBeVisible()

  await openApp(page, `/albums/${albumId}`)
  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: 'アルバムから外す' }).click()
  await expect(page.getByText(`「${name}」をアルバムから外しました`)).toBeVisible()
  await expect(tile(page, name)).toHaveCount(0)
  // Only the album changed: the photo is still on the timeline.
  expect(await state(page, id)).toBe('library')

  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.getByText('元に戻しました')).toBeVisible()
  await expect(tile(page, name)).toBeVisible()
  await page.reload()
  await expect(tile(page, name)).toBeVisible()
})
