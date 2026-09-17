import { expect, test } from '@playwright/test'
import { expectImageLoaded, openApp, tile, uniqueName, uploadPhoto } from './fixtures'

test('a guest opens a shared album and loses access after revoke', async ({ page, browser }) => {
  await openApp(page)
  const photo = `${uniqueName('shared')}.jpg`
  await uploadPhoto(page, photo)

  // Create an album and add the photo from the viewer's menu.
  const title = uniqueName('Album')
  await page.getByRole('link', { name: 'アルバム' }).click()
  await page.getByRole('button', { name: '新規アルバム' }).click()
  await page.getByRole('dialog', { name: '新規アルバム' }).getByLabel('タイトル').fill(title)
  await page.getByRole('button', { name: '作成' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  const albumPath = new URL(page.url()).pathname

  await page.getByRole('link', { name: 'タイムライン' }).click()
  await tile(page, photo).click()
  const viewer = page.getByRole('dialog', { name: photo })
  await viewer.getByRole('button', { name: 'アルバムに追加' }).click()
  await page.getByRole('menuitem', { name: title }).click()
  await expect(viewer.getByRole('status')).toContainText(`「${title}」に追加しました`)
  await page.keyboard.press('Escape')

  await page.goto(albumPath)
  await page.getByRole('button', { name: '共有' }).click()
  const sharing = page.getByRole('dialog', { name: '共有リンク' })
  await sharing.getByRole('button', { name: 'リンクを発行' }).click()
  const url = await sharing.getByLabel('共有リンク').inputValue()
  expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/)

  // A separate context: no owner session, no shared cookies or storage.
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  const shareRequests: { authorization?: string; cookie?: string }[] = []
  guest.on('request', (req) => {
    if (req.url().includes('/share/api/')) shareRequests.push(req.headers())
  })
  // The thumbnail only starts loading after its URL (at most 300 s) has expired: hold the request past a
  // clock jump, then answer like expired storage. The page must fetch the album again for a fresh URL.
  let stale: string | null = null
  let jumped!: () => void
  const afterJump = new Promise<void>((resolve) => {
    jumped = resolve
  })
  await guest.route('**/__local/blobs/**', async (route) => {
    const requested = route.request().url()
    stale ??= requested
    if (requested === stale) {
      await afterJump
      return route.fulfill({ status: 403, body: 'Request has expired' })
    }
    return route.continue()
  })
  await guest.clock.install()
  await guest.goto(url)
  await expect(guest.getByRole('heading', { name: title })).toBeVisible()
  const thumbnail = guest.getByRole('button', { name: '拡大表示' }).locator('img')
  await expect(thumbnail).toHaveCount(1)
  await expect.poll(() => stale).not.toBeNull()
  await guest.clock.fastForward('06:00')
  jumped()
  await expectImageLoaded(thumbnail)
  expect(await thumbnail.getAttribute('src')).not.toBe(stale)

  // A thumbnail that was already shown and fails later also gets a fresh URL.
  await guest.clock.fastForward('06:00')
  const shownUrl = await thumbnail.getAttribute('src')
  await thumbnail.evaluate((img) => img.dispatchEvent(new Event('error')))
  await expect.poll(() => thumbnail.getAttribute('src')).not.toBe(shownUrl)
  await expectImageLoaded(thumbnail)

  // The enlarged photo takes focus, keeps it away from the page behind, and gives it back on close.
  const opener = guest.getByRole('button', { name: '拡大表示' })
  await opener.click()
  const overlay = guest.getByRole('dialog', { name: '写真' })
  const preview = overlay.locator('img')
  await expectImageLoaded(preview)
  expect(await preview.getAttribute('src')).not.toContain('original')
  const closeOverlay = overlay.getByRole('button', { name: '閉じる' })
  await expect(closeOverlay).toBeFocused()
  for (let i = 0; i < 3; i++) {
    await guest.keyboard.press('Tab')
    expect(await guest.evaluate(() => !document.activeElement?.closest('main'))).toBe(true)
  }
  await guest.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
  await expect(opener).toBeFocused()
  await opener.click()
  await expect(closeOverlay).toBeFocused()
  await closeOverlay.click()
  await expect(overlay).toBeHidden()
  await expect(opener).toBeFocused()

  // The secret travels only in the Authorization header, never in the page request or a cookie.
  expect(new URL(guest.url()).hash).not.toBe('')
  expect(shareRequests.length).toBeGreaterThan(0)
  for (const headers of shareRequests) {
    expect(headers.authorization).toBe(`Bearer ${url.split('#')[1]}`)
    expect(headers.cookie).toBeUndefined()
  }

  // Regenerating ends the current link, so it asks first; cancelling changes nothing.
  await sharing.getByRole('button', { name: '再発行' }).click()
  const confirmRegenerate = page.getByRole('dialog', { name: '共有リンクを再発行しますか？' })
  await expect(confirmRegenerate).toContainText('現在のリンクは使えなくなり')
  await confirmRegenerate.getByRole('button', { name: 'キャンセル' }).click()
  await expect(confirmRegenerate).toBeHidden()
  await expect(sharing).toBeVisible()
  await expect(sharing.getByLabel('共有リンク')).toHaveValue(url)
  await expect(sharing.getByText('無効化済み')).toHaveCount(0)

  await sharing.getByRole('button', { name: '再発行' }).click()
  await confirmRegenerate.getByRole('button', { name: '再発行する' }).click()
  await expect(confirmRegenerate).toBeHidden()
  await expect(sharing.getByLabel('共有リンク')).not.toHaveValue(url)
  const regenerated = await sharing.getByLabel('共有リンク').inputValue()
  await expect(sharing.getByText('無効化済み')).toHaveCount(1)
  // Focus stays inside the share dialog, not on a button that the refreshed list removed.
  expect(await sharing.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await guest.reload()
  await expect(guest.getByText('このリンクは無効か、期限切れです。')).toBeVisible()

  // Revoking asks too; Escape closes only the confirmation.
  await sharing.getByRole('button', { name: '無効化' }).click()
  const confirmRevoke = page.getByRole('dialog', { name: '共有リンクを無効化しますか？' })
  await expect(confirmRevoke).toContainText('元に戻せません')
  await expect.poll(() => confirmRevoke.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(confirmRevoke).toBeHidden()
  await expect(sharing).toBeVisible()
  await expect(sharing.getByText('無効化済み')).toHaveCount(1)
  // Opened again, it is still labelled by its own title (not the share dialog's text).
  await sharing.getByRole('button', { name: '無効化' }).click()
  await confirmRevoke.getByRole('button', { name: '無効化する' }).click()
  await expect(sharing.getByText('無効化済み')).toHaveCount(2)
  await expect(sharing.getByRole('button', { name: '無効化' })).toHaveCount(0)
  expect(await sharing.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await guest.goto(regenerated)
  await expect(guest.getByText('このリンクは無効か、期限切れです。')).toBeVisible()
  await guestContext.close()
})
