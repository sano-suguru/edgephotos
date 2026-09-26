import { expect, openApp, test } from './fixtures'

// Words a household member cannot be expected to know. The operator's steps behind them are in
// docs/operations.md; the Library page only says what each value and button means.
const JARGON = /pnpm|manifest|SHA-256|\bD1\b|\bR2\b|migration|backup|docs\//i

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('the Library page explains itself without operator jargon', async ({ page }) => {
  // Every conditional block shows: a recorded backup, an expired upload, and findings of each tone.
  const backupAt = '2026-09-20T03:04:05.000Z'
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

  await openApp(page)
  await page.getByRole('navigation', { name: 'メイン' }).getByRole('link', { name: 'ライブラリ' }).click()
  const main = page.getByRole('main')

  // The backup time is a local date, not an ISO string, and says it is only set by a finished backup.
  const backupRow = main.locator('dl > div', { hasText: 'バックアップの完了日時' })
  await expect(backupRow.locator('dd')).toHaveText(await page.evaluate((at) => new Date(at).toLocaleString(), backupAt))
  await expect(main).toContainText(
    '「バックアップの完了日時」は、写真ファイルを含むバックアップが 1 枚も取りこぼさずに終わった日時です。',
  )
  await expect(main).toContainText('途中で失敗した回では更新されません。')
  await expect(main).toContainText('この日時より後に追加した写真は、まだバックアップされていません。')

  // The download says what it saves, and that the photos are not in it, before it is pressed.
  await expect(main.getByRole('heading', { name: '写真の情報を保存' })).toBeVisible()
  await expect(main.getByText('写真そのものは含まれません。', { exact: false })).toBeVisible()
  await expect(main.getByRole('button', { name: '写真の情報をダウンロード' })).toBeVisible()

  await main.getByRole('button', { name: '点検する' }).click()
  await expect(main).toContainText('赤字の項目は、EdgePhotos を管理している人に伝えてください。')
  await expect(main.getByRole('button', { name: '1 枚のサムネイルを作り直す' })).toBeVisible()

  const text = await main.innerText()
  expect(text).not.toMatch(JARGON)
  expect(text).not.toContain('Export')
})
