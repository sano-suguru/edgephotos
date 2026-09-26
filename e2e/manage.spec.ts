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

async function stubDiagnostics(page: Page, counts: Record<string, number>, purgingAssetIds: string[] = []) {
  await page.route('**/api/v1/diagnostics', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.lastBackupAt = backupAt
    body.purgingAssetIds = purgingAssetIds
    Object.assign(body.counts, counts)
    await route.fulfill({ response: res, json: body })
  })
}

// Findings of each tone, so every conditional part of the check shows.
async function stubAudit(page: Page) {
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

const row = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('dl > div')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })

test('管理 is quiet when nothing needs attention', async ({ page }) => {
  // An upload in progress (pending, not yet expired) is normal and says nothing.
  await stubDiagnostics(page, { pendingUploads: 2, expiredUploads: 0, purging: 0 })
  await openApp(page)
  const nav = page.getByRole('navigation', { name: 'メイン' })
  // The tab is 管理. ライブラリ is no longer the name of a tab (it still means the photo library in text).
  await expect(nav.getByRole('link', { name: 'ライブラリ' })).toHaveCount(0)
  await nav.getByRole('link', { name: '管理' }).click()
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '管理' })).toBeVisible()

  await expect(row(page, '写真')).toHaveCount(1)
  await expect(row(page, 'アルバム')).toHaveCount(1)
  // The trash count is on its link, not repeated as a row; nothing about uploads or deletes shows.
  await expect(main.getByRole('link', { name: /ゴミ箱/ })).toContainText(/\d+ 枚/)
  for (const label of ['ゴミ箱', '未完了のアップロード', '中断したアップロード', '削除処理中']) {
    await expect(row(page, label)).toHaveCount(0)
  }
  await expect(main.getByRole('heading', { name: '中断した完全削除' })).toHaveCount(0)
  await expect(main.getByRole('link', { name: 'メンテナンスを開く' })).toHaveCount(0)
})

test('管理 shows the everyday state, and the upkeep is one level down on メンテナンス', async ({ page }) => {
  await stubDiagnostics(page, { pendingUploads: 3, expiredUploads: 1, purging: 1 }, [id(9)])
  await stubAudit(page)
  await openApp(page, '/settings')
  const nav = page.getByRole('navigation', { name: 'メイン' })
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: '管理' })).toBeVisible()

  // Only what needs attention shows: the uploads that stopped (not the ones in progress), and a stopped delete
  // once, in its own section rather than also as a row.
  await expect(row(page, '中断したアップロード').locator('dd')).toHaveText('1')
  await expect(row(page, '未完了のアップロード')).toHaveCount(0)
  await expect(row(page, '削除処理中')).toHaveCount(0)
  await expect(main.getByRole('heading', { name: '中断した完全削除' })).toBeVisible()

  // None of the upkeep is here.
  await expect(main).not.toContainText('バックアップ処理の完了日時')
  await expect(main.getByRole('button', { name: '点検する' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: /作り直す/ })).toHaveCount(0)
  let text = await main.innerText()
  expect(text).not.toMatch(JARGON)
  expect(text).not.toMatch(ROLE)

  // Expired uploads lead straight to where they are tidied up.
  await main.getByRole('link', { name: 'メンテナンスを開く' }).click()
  await expect(page).toHaveURL(/\/settings\/maintenance$/)
  await expect(main.getByRole('heading', { level: 1, name: 'メンテナンス' })).toBeVisible()
  // One level below 管理, not a tab of its own.
  await expect(nav.getByRole('link', { name: 'メンテナンス' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: '管理' })).toHaveAttribute('aria-current', 'page')

  // The backup time is a local date, not an ISO string. The server only knows the CLI reported a finished run,
  // not what the backup directory holds now (docs/operations.md §12), so the page must not promise that every
  // photo is in it, or that later ones are not.
  await expect(row(page, 'バックアップ処理の完了日時').locator('dd')).toHaveText(
    await page.evaluate((at) => new Date(at).toLocaleString(), backupAt),
  )
  for (const promise of ['取りこぼさ', '揃って', 'バックアップされていません']) {
    await expect(main).not.toContainText(promise)
  }
  // The counts stay on 管理, and the metadata download is gone (D-039).
  await expect(row(page, '中断したアップロード')).toHaveCount(0)
  await expect(main.getByRole('button', { name: /ダウンロード/ })).toHaveCount(0)

  await main.getByRole('button', { name: '点検する' }).click()
  // Damage is named in text, not only in red.
  await expect(main.getByRole('listitem').filter({ hasText: '写真の元ファイルが保存先にありません' })).toContainText(
    '要対応',
  )
  await expect(main.getByRole('listitem').filter({ hasText: 'サムネイル' })).not.toContainText('要対応')
  await expect(main.getByRole('button', { name: '1 枚のサムネイルを作り直す' })).toBeEnabled()
  await expect(main.getByRole('button', { name: '中断したアップロードを整理する' })).toBeEnabled()

  text = await main.innerText()
  expect(text).not.toMatch(JARGON)
  expect(text).not.toMatch(ROLE)

  // The way back is on desktop too, where メンテナンス has no entry in the header.
  await main.getByRole('link', { name: '← 管理' }).click()
  await expect(main.getByRole('heading', { level: 1, name: '管理' })).toBeVisible()
  // The plain link to メンテナンス is always there.
  await main.getByRole('link', { name: /普段は開く必要はありません/ }).click()
  await expect(page).toHaveURL(/\/settings\/maintenance$/)
  // The page's diagnostics request finishes before the test does, so its route handler is not cut off.
  await expect(row(page, 'バックアップ処理の完了日時')).toBeVisible()
})

test('メンテナンス opens from its address, with nothing asked beyond being a member', async ({ page }) => {
  await openApp(page, '/settings/maintenance')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: 'メンテナンス' })).toBeVisible()
  await expect(main.getByRole('alert')).toHaveCount(0)
  await expect(row(page, 'バックアップ処理の完了日時').locator('dd')).toHaveText('記録なし')
  await main.getByRole('button', { name: '点検する' }).click()
  await expect(main.getByText(/枚を確認しました。/)).toBeVisible()
  await expect(main.getByRole('alert')).toHaveCount(0)
})
