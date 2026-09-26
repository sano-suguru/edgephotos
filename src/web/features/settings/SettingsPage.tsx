import { useSignal, useSignalEffect } from '@preact/signals'
import { Button } from '../../components/ui/button'
import { Trash } from '../../components/ui/icons'
import { PageHeader } from '../../components/ui/page'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { navigate } from '../../state/router'
import { repairAssets, repairMessage } from './repair'
import { repairDeps } from './repair-client'
import { resumePurges } from './resume-purges'
import { type AuditSummary, cleanupMessage, findings, REPAIRABLE_MAX, runAudit, runCleanup } from './storage-check'

const TONE_CLASS = { damage: 'text-destructive', action: 'text-foreground', info: 'text-muted-foreground' } as const

function StorageCheck(props: { onChanged: () => void }) {
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
      props.onChanged()
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
      props.onChanged()
    }
    await audit()
  }

  const list = summary.value ? findings(summary.value) : []
  const cleanable = (summary.value?.counts.expired_upload ?? 0) + (summary.value?.counts.duplicate_leftover ?? 0)
  const repairable = summary.value?.repairable.length ?? 0
  return (
    <div class="mt-10 space-y-3 text-sm">
      <h2 class="text-heading">ストレージの点検</h2>
      <p class="text-muted-foreground">
        写真の記録と、保存されている写真ファイルが食い違っていないか確かめます。点検は読み取りだけで、何も変更しません。
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
                <span class="font-medium tabular-nums">{f.count} 件</span> — {f.text}
                {f.kind === 'expired_upload' && summary.value && summary.value.completeUploads > 0
                  ? `うち ${summary.value.completeUploads} 件は転送が完了しており、整理するとライブラリに追加されます。`
                  : ''}
              </li>
            ))}
          </ul>
          {list.some((f) => f.tone === 'damage') && (
            <p class="text-destructive">赤字の項目は、EdgePhotos を管理している人に伝えてください。</p>
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

export function SettingsPage() {
  const diag = useSignal<Diagnostics | null>(null)
  const error = useSignal<string | null>(null)
  const resuming = useSignal(false)

  const load = () =>
    api
      .diagnostics()
      .then((d) => {
        diag.value = d
      })
      .catch((err) => {
        error.value = userMessage(err)
      })

  useSignalEffect(() => {
    void load()
  })

  async function downloadManifest() {
    error.value = null
    const manifest = await api.exportManifest().catch((err) => {
      error.value = userMessage(err)
      return null
    })
    if (!manifest) return
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `edgephotos-export-${manifest.exportedAt.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    await load()
  }

  async function resume(ids: string[]) {
    resuming.value = true
    error.value = null
    try {
      await resumePurges(ids, api.purge)
    } catch (err) {
      error.value = userMessage(err)
    } finally {
      resuming.value = false
      await load()
    }
  }

  return (
    <section class="max-w-2xl">
      <PageHeader>ライブラリ</PageHeader>
      {error.value && (
        <p role="alert" class="mb-4 text-sm text-destructive">
          {error.value}
        </p>
      )}
      <a
        href="/trash"
        onClick={(e) => {
          e.preventDefault()
          navigate('/trash')
        }}
        class="-mx-3 flex min-h-12 items-center gap-3 rounded-surface px-3 text-sm transition-colors hover:bg-muted active:bg-border"
      >
        <Trash class="size-5 text-muted-foreground" />
        <span class="flex-1 font-medium">ゴミ箱</span>
        <span class="text-muted-foreground">
          <span class="tabular-nums">{diag.value ? `${diag.value.counts.trashed} 枚` : ''}</span>{' '}
          <span aria-hidden="true">›</span>
        </span>
      </a>
      {diag.value && (
        <div class="mt-10">
          <h2 class="mb-2 text-heading">状態</h2>
          <dl class="divide-y divide-border text-sm">
            {(
              [
                ['写真', diag.value.counts.assets],
                ['ゴミ箱', diag.value.counts.trashed],
                ['アルバム', diag.value.counts.albums],
                [
                  '未完了のアップロード',
                  `${diag.value.counts.pendingUploads}${diag.value.counts.expiredUploads > 0 ? `（うち期限切れ ${diag.value.counts.expiredUploads}）` : ''}`,
                ],
                ['削除処理中', diag.value.counts.purging],
                // Recorded only when `pnpm backup export` writes manifest.json without a failure (docs/decisions.md
                // D-033). It does not show that the backup is still complete; `pnpm backup check` does. The
                // applied migration is for the operator and is reported by `pnpm diagnose`.
                [
                  'バックアップの完了日時',
                  diag.value.lastBackupAt ? new Date(diag.value.lastBackupAt).toLocaleString() : '記録なし',
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label} class="flex justify-between gap-4 py-2.5">
                <dt class="text-muted-foreground">{label}</dt>
                <dd class="text-right tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p class="mt-3 text-sm text-muted-foreground">
            「バックアップの完了日時」は、写真ファイルを含むバックアップが 1
            枚も取りこぼさずに終わった日時です。途中で失敗した回では更新されません。この日時より後に追加した写真は、まだバックアップされていません。
          </p>
          {diag.value.counts.expiredUploads > 0 && (
            <p class="mt-3 text-sm text-muted-foreground">
              期限切れのアップロードは中断したもので、写真としては登録されていません。自動では削除されません。下の「ストレージの点検」から整理できます。写真がタイムラインに無ければ、もう一度選んでアップロードしてもかまいません。
            </p>
          )}
        </div>
      )}
      {diag.value && diag.value.purgingAssetIds.length > 0 && (
        <div class="mt-10 space-y-3 text-sm">
          <h2 class="text-heading text-destructive">中断した完全削除</h2>
          <p class="text-muted-foreground">
            {`完全削除が途中で止まった写真が ${diag.value.counts.purging} 枚あります。どの画面にも表示されず、元に戻せません。削除を最後まで実行します。${diag.value.purgingAssetIds.length < diag.value.counts.purging ? `1 回に処理するのは古い順に ${diag.value.purgingAssetIds.length} 枚までです。残りは、終わったあとにもう一度押してください。` : ''}`}
          </p>
          <Button variant="destructive" busy={resuming.value} onClick={() => resume(diag.value?.purgingAssetIds ?? [])}>
            削除を再開
          </Button>
        </div>
      )}
      <StorageCheck onChanged={() => void load()} />
      <div class="mt-10 space-y-3 text-sm">
        <h2 class="text-heading">写真の情報を保存</h2>
        <p class="text-muted-foreground">
          写真ごとのファイル名・撮影日時・お気に入り・アップロードした人と、アルバムの構成を、1
          つのファイルに保存します。
        </p>
        <p class="font-medium">写真そのものは含まれません。これだけではバックアップになりません。</p>
        <Button variant="secondary" onClick={downloadManifest}>
          写真の情報をダウンロード
        </Button>
      </div>
    </section>
  )
}
