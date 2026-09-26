import type { Page } from '@playwright/test'
import { expect, openApp, test, tile, uniqueName, uploadPhoto } from './fixtures'

// Trash, restore, complete deletion and removal from an album, from the viewer, with the undo the toast offers
// (src/web/features/timeline/AssetGrid.tsx). The server side is covered by the workerd tests; what only a
// browser shows is which request each button and each undo sends, and what the grids show afterwards.

type Listed = { id: string; filename: string | null; isFavorite: boolean }

async function listed(page: Page, query = ''): Promise<Listed[]> {
  return page.evaluate(async (q) => {
    const res = await fetch(`/api/v1/assets${q}`)
    return ((await res.json()) as { items: Listed[] }).items
  }, query)
}

const inTimeline = async (page: Page, name: string) => (await listed(page)).some((a) => a.filename === name)
const inTrash = async (page: Page, name: string) =>
  (await listed(page, '?trashed=true')).some((a) => a.filename === name)

// The photo viewer, not a confirmation dialog opened over it: only the viewer has the 情報 button.
const viewer = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '情報' }) })

test('a photo moved to the trash from the viewer comes back with the undo', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('trash-undo')}.jpg`
  await uploadPhoto(page, name)

  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: 'ゴミ箱へ移動' }).click()
  await expect(page.getByText(`「${name}」をゴミ箱に移動しました`)).toBeVisible()
  expect(await inTrash(page, name)).toBe(true)

  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.getByText('元に戻しました')).toBeVisible()
  expect(await inTimeline(page, name)).toBe(true)
  expect(await inTrash(page, name)).toBe(false)

  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  await expect(tile(page, name)).toBeVisible()
})

test('a restored photo keeps its favorite and its album, and its undo sends it back to the trash', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('restore')}.jpg`
  const album = uniqueName('Restore')
  await uploadPhoto(page, name)
  await page.evaluate(async (title) => {
    await fetch('/api/v1/albums', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  }, album)

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
  expect(await inTrash(page, name)).toBe(false)

  // Undo from the trash moves it back there, and the trash grid shows it again.
  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.getByText('元に戻しました')).toBeVisible()
  expect(await inTrash(page, name)).toBe(true)
  if (await viewer(page).isVisible()) await page.keyboard.press('Escape')
  await expect(tile(page, name)).toBeVisible()

  // Restored for good: back on the timeline, still a favorite and still in the album.
  await tile(page, name).click()
  await viewer(page).getByRole('button', { name: '復元' }).click()
  await expect(page.getByText(`「${name}」を復元しました`)).toBeVisible()
  const restored = (await listed(page)).find((a) => a.filename === name)
  expect(restored?.isFavorite).toBe(true)
  await openApp(page, '/favorites')
  await expect(tile(page, name)).toBeVisible()
  await openApp(page, '/albums')
  await page.getByRole('link', { name: new RegExp(album) }).click()
  await expect(tile(page, name)).toBeVisible()
})

test('complete deletion asks first: cancelling keeps the photo, confirming removes it for good', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('purge')}.jpg`
  await uploadPhoto(page, name)
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
  expect(await inTrash(page, name)).toBe(true)

  await viewer(page).getByRole('button', { name: '完全に削除' }).click()
  await confirm.getByRole('button', { name: '完全に削除' }).click()
  await expect(page.getByText('完全に削除しました')).toBeVisible()
  // No undo is offered: the original is gone.
  await expect(page.getByRole('button', { name: '元に戻す' })).toHaveCount(0)
  expect(await inTrash(page, name)).toBe(false)
  expect(await inTimeline(page, name)).toBe(false)
  if (await viewer(page).isVisible()) await page.keyboard.press('Escape')
  await expect(tile(page, name)).toHaveCount(0)
})

test('a photo taken out of an album returns to it with the undo, and stays after a reload', async ({ page }) => {
  await openApp(page)
  const name = `${uniqueName('album-undo')}.jpg`
  const album = uniqueName('Undo')
  await uploadPhoto(page, name)
  const albumId = await page.evaluate(async (title) => {
    const res = await fetch('/api/v1/albums', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    return ((await res.json()) as { id: string }).id
  }, album)
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
  expect(await inTimeline(page, name)).toBe(true)

  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.getByText('元に戻しました')).toBeVisible()
  await expect(tile(page, name)).toBeVisible()
  await page.reload()
  await expect(tile(page, name)).toBeVisible()
})
