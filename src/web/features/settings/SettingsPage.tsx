import { useSignal, useSignalEffect } from '@preact/signals'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api/client'

type Diagnostics = Awaited<ReturnType<typeof api.diagnostics>>

export function SettingsPage() {
  const diag = useSignal<Diagnostics | null>(null)
  const error = useSignal<string | null>(null)

  const load = () =>
    api
      .diagnostics()
      .then((d) => {
        diag.value = d
      })
      .catch((err: Error) => {
        error.value = err.message
      })

  useSignalEffect(() => {
    void load()
  })

  async function downloadManifest() {
    const manifest = await api.exportManifest()
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `edgephotos-export-${manifest.exportedAt.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    await load()
  }

  return (
    <section class="max-w-2xl space-y-6">
      <h1 class="text-xl font-semibold">ライブラリ</h1>
      {error.value && <p class="text-sm text-destructive">{error.value}</p>}
      {diag.value && (
        <dl class="grid grid-cols-2 gap-2 rounded-lg border border-border bg-white p-4 text-sm">
          <dt class="text-muted-foreground">写真</dt>
          <dd>{diag.value.counts.assets}</dd>
          <dt class="text-muted-foreground">ゴミ箱</dt>
          <dd>{diag.value.counts.trashed}</dd>
          <dt class="text-muted-foreground">アルバム</dt>
          <dd>{diag.value.counts.albums}</dd>
          <dt class="text-muted-foreground">未完了のアップロード</dt>
          <dd>{diag.value.counts.pendingUploads}</dd>
          <dt class="text-muted-foreground">削除処理中</dt>
          <dd>{diag.value.counts.purging}</dd>
          <dt class="text-muted-foreground">最終 export</dt>
          <dd>{diag.value.lastExportAt ?? '未実施'}</dd>
          <dt class="text-muted-foreground">Migration</dt>
          <dd>{diag.value.latestMigration ?? '—'}</dd>
        </dl>
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
