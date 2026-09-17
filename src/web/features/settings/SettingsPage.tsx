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
    <section class="max-w-2xl space-y-6">
      <h1 class="text-xl font-semibold">ライブラリ</h1>
      {error.value && (
        <p role="alert" class="text-sm text-destructive">
          {error.value}
        </p>
      )}
      <a
        href="/trash"
        onClick={(e) => {
          e.preventDefault()
          navigate('/trash')
        }}
        class="flex items-center gap-3 rounded-lg border border-border bg-white p-4 text-sm hover:bg-muted"
      >
        <Trash class="size-5 text-muted-foreground" />
        <span class="flex-1 font-medium">ゴミ箱</span>
        <span class="text-muted-foreground">
          {diag.value ? `${diag.value.counts.trashed} 枚` : ''} <span aria-hidden="true">›</span>
        </span>
      </a>
      {diag.value && (
        <dl class="grid grid-cols-2 gap-2 rounded-lg border border-border bg-white p-4 text-sm">
          <dt class="text-muted-foreground">写真</dt>
          <dd>{diag.value.counts.assets}</dd>
          <dt class="text-muted-foreground">ゴミ箱</dt>
          <dd>{diag.value.counts.trashed}</dd>
          <dt class="text-muted-foreground">アルバム</dt>
          <dd>{diag.value.counts.albums}</dd>
          <dt class="text-muted-foreground">未完了のアップロード</dt>
          <dd>
            {diag.value.counts.pendingUploads}
            {diag.value.counts.expiredUploads > 0 && `（うち期限切れ ${diag.value.counts.expiredUploads}）`}
          </dd>
          <dt class="text-muted-foreground">削除処理中</dt>
          <dd>{diag.value.counts.purging}</dd>
          <dt class="text-muted-foreground">最終 export</dt>
          <dd>{diag.value.lastExportAt ?? '未実施'}</dd>
          <dt class="text-muted-foreground">Migration</dt>
          <dd>{diag.value.latestMigration ?? '—'}</dd>
        </dl>
      )}
      {diag.value && diag.value.counts.expiredUploads > 0 && (
        <p class="text-sm text-muted-foreground">
          期限切れのアップロードは中断したもので、写真としては登録されていません。自動では削除されません。写真がタイムラインに無ければ、もう一度選んでアップロードしてください。
        </p>
      )}
      {diag.value && diag.value.purgingAssetIds.length > 0 && (
        <div class="space-y-2 rounded-lg border border-border bg-white p-4 text-sm">
          <h2 class="font-medium">中断した完全削除</h2>
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
      <div class="space-y-2 rounded-lg border border-border bg-white p-4 text-sm">
        <h2 class="font-medium">Export</h2>
        <p class="text-muted-foreground">
          metadata・アルバム構成・オリジナルの SHA-256 を含む manifest を保存します。オリジナル本体を含む完全な backup
          と restore は <code>pnpm backup</code> CLI を使用してください（docs/operations.md）。
        </p>
        <Button variant="outline" onClick={downloadManifest}>
          manifest をダウンロード
        </Button>
      </div>
    </section>
  )
}
