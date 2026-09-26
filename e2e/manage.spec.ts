import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

// Words a household member cannot be expected to know. The operator's steps behind them are in
// docs/operations.md; 管理 and メンテナンス only say what each value and button means.
const JARGON = /pnpm|manifest|SHA-256|\bD1\b|\bR2\b|migration|backup|docs\/|CLI|Cloudflare/i
// Every member can open both pages and press every button (docs/decisions.md D-028, D-039). Nothing on them
// may suggest a role that the app does not have.
const ROLE = /管理者|権限|admin/i

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const backupAt = '2026-09-20T03:04:05.000Z'

// Every conditional block shows: a recorded backup, an expired upload, and findings of each tone.
async function stubDiagnosticsAndAudit(page: Page) {
  await page.route('**/api/v1/diagnostics', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.lastBackupAt = backupAt
    body.counts.expiredUploads = 1
    await route.fulfill({ response: res, json: body })
  })
  await page.route('**/api/v1/storage/audit*', (route) =>
    route.fulfill({
      json: {
        checked: { assets: 3, uploadsInProgress: 1, objects: 9, checksumsUnrecorded: 1 },
        issues: [
          { kind: 'missing_original', assetId: id(1) },
          { kind: 'missing_derivative', assetId: id(2), objects: ['thumbnail'] },
          { kind: 'expired_upload', assetId: id(3), objects: [] },
          { kind: 'unreferenced_objects', assetId: id(4), objects: ['original'] },
          { kind: 'original_checksum_unrecorded', assetId: id(5) },
        ],
        nextAfter: null,
      },
    }),
  )
}

test('管理 shows the everyday state, and the upkeep is one level down on メンテナンス', async ({ page }) => {
  await stubDiagnosticsAndAudit(page)
  await openApp(page)
  const nav = page.getByRole('navigation', { name: 'メイン' })
  // The tab is 管理. ライブラリ is no longer the name of a tab (it still means the photo library in text).
  await expect(nav.getByRole('link', { name: 'ライブラリ' })).toHaveCount(0)
  await nav.getByRole('link', { name: '管理' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '管理' })).toBeVisible()

  // The everyday state: the counts, the trash, and uploads that did not finish.
  const rows = main.locator('dl > div')
  for (const label of ['写真', 'アルバム', 'ゴミ箱', '未完了のアップロード', '削除処理中']) {
    await expect(rows.filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })).toHaveCount(1)
  }
  await expect(rows.filter({ hasText: '未完了のアップロード' }).locator('dd')).toContainText('（うち期限切れ 1）')
  await expect(main.getByRole('link', { name: /ゴミ箱/ })).toBeVisible()
  // The expired-upload note points at where the tidy-up now is.
  await expect(main).toContainText('「メンテナンス」の「保存状態の点検」から整理できます。')

  // None of the upkeep is here.
  await expect(main).not.toContainText('バックアップ処理の完了日時')
  await expect(main.getByRole('button', { name: '点検する' })).toHaveCount(0)
  await expect(main.getByRole('heading', { name: '保存状態の点検' })).toHaveCount(0)
  await expect(main.getByRole('heading', { name: '写真とアルバムの情報を書き出す' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: '写真とアルバムの情報をダウンロード' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: /サムネイルを作り直す/ })).toHaveCount(0)
  let text = await main.innerText()
  expect(text).not.toMatch(JARGON)
  expect(text).not.toMatch(ROLE)

  await main.getByRole('link', { name: /メンテナンス/ }).click()
  await expect(page).toHaveURL(/\/settings\/maintenance$/)
  await expect(main.getByRole('heading', { level: 1, name: 'メンテナンス' })).toBeVisible()
  // One level below 管理, not a tab of its own.
  await expect(nav.getByRole('link', { name: 'メンテナンス' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: '管理' })).toHaveAttribute('aria-current', 'page')

  // The backup time is a local date, not an ISO string, and says it is only set by a finished backup.
  const backupRow = main.locator('dl > div', { hasText: 'バックアップ処理の完了日時' })
  await expect(backupRow.locator('dd')).toHaveText(await page.evaluate((at) => new Date(at).toLocaleString(), backupAt))
  await expect(main).toContainText(
    '「バックアップ処理の完了日時」は、写真ファイルを含むバックアップ処理が最後まで完了した日時です。',
  )
  await expect(main).toContainText('途中で失敗した回では更新されません。')
  // The server only knows the CLI reported a finished run, not what the backup directory holds now
  // (docs/operations.md §12), so the page must not promise that every photo is in it, or that later ones are not.
  await expect(main).not.toContainText('取りこぼさ')
  await expect(main).not.toContainText('揃って')
  await expect(main).not.toContainText('バックアップされていません')
  // The counts stay on 管理.
  await expect(main).not.toContainText('未完了のアップロード')

  // The download says what it saves, and that the photos are not in it, before it is pressed; and it still works.
  await expect(main.getByRole('heading', { name: '写真とアルバムの情報を書き出す' })).toBeVisible()
  await expect(main).toContainText('写真ごとのファイル名・撮影日時・お気に入り・アップロードした人と、アルバムの構成')
  await expect(main.getByText('写真そのものは含まれません。これだけではバックアップになりません。')).toBeVisible()
  const downloaded = page.waitForEvent('download')
  await main.getByRole('button', { name: '写真とアルバムの情報をダウンロード' }).click()
  expect((await downloaded).suggestedFilename()).toMatch(/^edgephotos-export-\d{4}-\d{2}-\d{2}\.json$/)
  await expect(main.getByRole('alert')).toHaveCount(0)

  await expect(main.getByRole('heading', { name: '保存状態の点検' })).toBeVisible()
  await main.getByRole('button', { name: '点検する' }).click()
  await expect(main).toContainText('「要対応」の項目は、EdgePhotos を設置した人に伝えてください。')
  // Damage is named in text, not only in red.
  await expect(main.getByRole('listitem').filter({ hasText: '写真の元ファイルが保存先にありません' })).toContainText(
    '要対応 1 件',
  )
  await expect(main.getByRole('listitem').filter({ hasText: 'サムネイル' })).not.toContainText('要対応')
  await expect(main).not.toContainText('赤字')
  await expect(main.getByRole('button', { name: '1 枚のサムネイルを作り直す' })).toBeEnabled()
  await expect(main.getByRole('button', { name: '中断したアップロードを整理する' })).toBeEnabled()

  text = await main.innerText()
  expect(text).not.toMatch(JARGON)
  expect(text).not.toMatch(ROLE)
  expect(text).not.toContain('Export')

  // The way back is on desktop too, where メンテナンス has no entry in the header.
  await main.getByRole('link', { name: '← 管理' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '管理' })).toBeVisible()
})

test('メンテナンス opens from its address, with nothing asked beyond being a member', async ({ page }) => {
  await openApp(page, '/settings/maintenance')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: 'メンテナンス' })).toBeVisible()
  await expect(main.getByRole('alert')).toHaveCount(0)
  await expect(main.locator('dl > div', { hasText: 'バックアップ処理の完了日時' }).locator('dd')).toHaveText('記録なし')
  await main.getByRole('button', { name: '点検する' }).click()
  await expect(main.getByText(/枚を確認しました。/)).toBeVisible()
  await expect(main.getByRole('alert')).toHaveCount(0)
  await expect(main.getByRole('button', { name: '写真とアルバムの情報をダウンロード' })).toBeEnabled()
})
