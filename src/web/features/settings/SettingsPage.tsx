import { useSignal, useSignalEffect } from '@preact/signals'
import { Button } from '../../components/ui/button'
import { Trash } from '../../components/ui/icons'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { navigate } from '../../state/router'
import { resumePurges } from './resume-purges'

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
      <h1 class="mb-6 text-2xl font-semibold tracking-tight">ライブラリ</h1>
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
        class="-mx-3 flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm hover:bg-muted"
      >
        <Trash class="size-5 text-muted-foreground" />
        <span class="flex-1 font-medium">ゴミ箱</span>
        <span class="text-muted-foreground">
          {diag.value ? `${diag.value.counts.trashed} 枚` : ''} <span aria-hidden="true">›</span>
        </span>
      </a>
      {diag.value && (
        <div class="mt-10">
          <h2 class="mb-2 text-sm font-semibold">状態</h2>
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
                ['最終 export', diag.value.lastExportAt ?? '未実施'],
                ['Migration', diag.value.latestMigration ?? '—'],
              ] as const
            ).map(([label, value]) => (
              <div key={label} class="flex justify-between gap-4 py-2.5">
                <dt class="text-muted-foreground">{label}</dt>
                <dd class="text-right tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {diag.value.counts.expiredUploads > 0 && (
            <p class="mt-3 text-sm text-muted-foreground">
              期限切れのアップロードは中断したもので、写真としては登録されていません。自動では削除されません。写真がタイムラインに無ければ、もう一度選んでアップロードしてください。
            </p>
          )}
        </div>
      )}
      {diag.value && diag.value.purgingAssetIds.length > 0 && (
        <div class="mt-10 space-y-3 text-sm">
          <h2 class="font-semibold text-destructive">中断した完全削除</h2>
          <p class="text-muted-foreground">
            {`完全削除が途中で止まった写真が ${diag.value.counts.purging} 枚あります。どの画面にも表示されず、元に戻せません。削除を最後まで実行します。${diag.value.purgingAssetIds.length < diag.value.counts.purging ? `1 回に処理するのは古い順に ${diag.value.purgingAssetIds.length} 枚までです。残りは、終わったあとにもう一度押してください。` : ''}`}
          </p>
          <Button
            variant="destructive"
            disabled={resuming.value}
            onClick={() => resume(diag.value?.purgingAssetIds ?? [])}
          >
            削除を再開
          </Button>
        </div>
      )}
      <div class="mt-10 space-y-3 text-sm">
        <h2 class="font-semibold">Export</h2>
        <p class="text-muted-foreground">
          metadata・アルバム構成・オリジナルの SHA-256 を含む manifest を保存します。オリジナル本体を含む完全な backup
          と restore は <code>pnpm backup</code> CLI を使用してください（docs/operations.md）。
        </p>
        <Button variant="secondary" onClick={downloadManifest}>
          manifest をダウンロード
        </Button>
      </div>
    </section>
  )
}
