import { useSignal, useSignalEffect } from '@preact/signals'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/ui/page'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { repairAssets, repairMessage } from './repair'
import { repairDeps } from './repair-client'
import { type AuditSummary, cleanupMessage, findings, REPAIRABLE_MAX, runAudit, runCleanup } from './storage-check'

const TONE_CLASS = { damage: 'text-destructive', action: 'text-foreground', info: 'text-muted-foreground' } as const

function StorageCheck() {
  const running = useSignal<'audit' | 'cleanup' | 'repair' | null>(null)
  const progress = useSignal(0)
  const summary = useSignal<AuditSummary | null>(null)
  const message = useSignal<string | null>(null)
  const error = useSignal<string | null>(null)

  async function audit() {
    running.value = 'audit'
    error.value = null
    progress.value = 0
    try {
      summary.value = await runAudit(api.storageAudit, (n) => (progress.value = n))
    } catch (err) {
      error.value = `点検を完了できませんでした。${userMessage(err)} 何も変更していません。`
    } finally {
      running.value = null
    }
  }

  async function cleanup() {
    running.value = 'cleanup'
    error.value = null
    message.value = null
    try {
      message.value = cleanupMessage(await runCleanup(api.storageCleanup))
    } catch (err) {
      error.value = `整理を完了できませんでした。${userMessage(err)} 途中までの処理は安全で、もう一度実行できます。`
    } finally {
      running.value = null
    }
    await audit()
  }

  // Rebuilds the thumbnails / previews the audit just listed, from the originals that are still there.
  // The originals are read and never written, so a failure leaves the photo exactly as it was.
  async function repair() {
    const ids = summary.value?.repairable ?? []
    running.value = 'repair'
    error.value = null
    message.value = null
    progress.value = 0
    try {
      message.value = repairMessage(await repairAssets(repairDeps, ids, (n) => (progress.value = n)))
    } catch (err) {
      error.value = `作り直しを完了できませんでした。${userMessage(err)} 元ファイルには触れていません。`
    } finally {
      running.value = null
    }
    await audit()
  }

  const list = summary.value ? findings(summary.value) : []
  const cleanable = (summary.value?.counts.expired_upload ?? 0) + (summary.value?.counts.duplicate_leftover ?? 0)
  const repairable = summary.value?.repairable.length ?? 0
  return (
    <div class="mt-10 space-y-3 text-sm">
      <h2 class="text-heading">保存状態の点検</h2>
      <p class="text-muted-foreground">
        写真の記録と、保存されている写真ファイルが食い違っていないか確かめます。点検は読み取りだけで、何も変更しません。中断したアップロードは、点検のあとに整理できます。
      </p>
      <Button variant="secondary" disabled={running.value !== null} onClick={() => void audit()}>
        {running.value === 'audit' ? `点検中…（${progress.value} 枚）` : '点検する'}
      </Button>
      {error.value && (
        <p role="alert" class="text-destructive">
          {error.value}
        </p>
      )}
      {message.value && <p role="status">{message.value}</p>}
      {summary.value && (
        <div role="status" class="space-y-2">
          <p>
            {summary.value.photos} 枚を確認しました。
            {list.length === 0 ? '問題は見つかりませんでした。' : ''}
          </p>
          <ul class="space-y-2">
            {list.map((f) => (
              <li key={f.kind} class={TONE_CLASS[f.tone]}>
                {/* Colour alone does not reach a screen reader or every eye, so damage is also named in text. */}
                {f.tone === 'damage' && <span class="font-medium">要対応 </span>}
                <span class="font-medium tabular-nums">{f.count} 件</span> — {f.text}
                {f.kind === 'expired_upload' && summary.value && summary.value.completeUploads > 0
                  ? `うち ${summary.value.completeUploads} 件は転送が完了しており、整理するとライブラリに追加されます。`
                  : ''}
              </li>
            ))}
          </ul>
          {list.some((f) => f.tone === 'damage') && (
            <p class="text-destructive">「要対応」の項目は、EdgePhotos の設定をした人に伝えてください。</p>
          )}
          {repairable > 0 && (
            <div class="space-y-2">
              <p class="text-muted-foreground">
                「サムネイルを作り直す」は、元ファイルを読み込んで、欠けているサムネイルとプレビューだけを作り直します。元ファイル・撮影日時・アルバム・お気に入り・ゴミ箱の状態は変わりません。一度に作り直すのは最大{' '}
                {REPAIRABLE_MAX} 枚です。残りは、作り直したあとにもう一度点検すると続けて直せます。
              </p>
              <Button variant="secondary" disabled={running.value !== null} onClick={() => void repair()}>
                {running.value === 'repair'
                  ? `作り直し中…（${progress.value} / ${repairable} 枚）`
                  : `${repairable} 枚のサムネイルを作り直す`}
              </Button>
            </div>
          )}
          {cleanable > 0 && (
            <div class="space-y-2">
              <p class="text-muted-foreground">
                「整理する」は、中断から 1
                日以上たったアップロードを片付けます。転送が完了していた写真はライブラリに追加し、完了できないものとその残りファイルだけを削除します。ライブラリの写真と、どの写真にも結び付かないファイルには触れません。
              </p>
              <Button variant="secondary" disabled={running.value !== null} onClick={() => void cleanup()}>
                {running.value === 'cleanup' ? '整理中…' : '中断したアップロードを整理する'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type Diagnostics = Awaited<ReturnType<typeof api.diagnostics>>

// Upkeep a household member rarely needs, one level below 管理 (docs/decisions.md D-039). It is a grouping,
// not a permission: every member can open it and use every button.
export function MaintenancePage() {
  const diag = useSignal<Diagnostics | null>(null)
  const error = useSignal<string | null>(null)

  useSignalEffect(() => {
    api
      .diagnostics()
      .then((d) => {
        diag.value = d
      })
      .catch((err) => {
        error.value = userMessage(err)
      })
  })

  return (
    <section class="max-w-2xl">
      <PageHeader
        back={{ to: '/settings', label: '管理', always: true }}
        hint="普段は開く必要のない、バックアップの記録と保存状態の点検です。"
      >
        メンテナンス
      </PageHeader>
      {error.value && (
        <p role="alert" class="mb-4 text-sm text-destructive">
          {error.value}
        </p>
      )}
      {diag.value && (
        <div class="space-y-3 text-sm">
          <h2 class="text-heading">バックアップ</h2>
          <dl class="divide-y divide-border">
            {/* Recorded only when `pnpm backup export` writes manifest.json without a failure (docs/decisions.md
                D-033). It does not show that the backup is still complete; `pnpm backup check` does. The applied
                migration is for the operator and is reported by `pnpm diagnose`. */}
            <div class="flex flex-wrap justify-between gap-x-4 py-2.5">
              <dt class="text-muted-foreground">バックアップ処理の完了日時</dt>
              <dd class="text-right tabular-nums">
                {diag.value.lastBackupAt ? new Date(diag.value.lastBackupAt).toLocaleString() : '記録なし'}
              </dd>
            </div>
          </dl>
          <p class="text-muted-foreground">
            「バックアップ処理の完了日時」は、写真ファイルを含むバックアップ処理が最後まで完了した日時です。途中で失敗した回では更新されません。
          </p>
        </div>
      )}
      <StorageCheck />
    </section>
  )
}
