import { useSignal, useSignalEffect } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { Button } from '../../components/ui/button'
import { Trash, Wrench } from '../../components/ui/icons'
import { PageHeader } from '../../components/ui/page'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'
import { navigate } from '../../state/router'
import { resumePurges } from './resume-purges'

function RowLink(props: { to: string; icon: ComponentChildren; label: string; hint?: string; value?: string }) {
  return (
    <a
      href={props.to}
      onClick={(e) => {
        e.preventDefault()
        navigate(props.to)
        window.scrollTo(0, 0)
      }}
      class="-mx-3 flex min-h-12 items-center gap-3 rounded-surface px-3 py-2 text-sm transition-colors hover:bg-muted active:bg-border"
    >
      {props.icon}
      <span class="min-w-0 flex-1">
        <span class="block font-medium">{props.label}</span>
        {props.hint && <span class="block text-muted-foreground">{props.hint}</span>}
      </span>
      <span class="text-muted-foreground">
        {props.value && <span class="tabular-nums">{props.value}</span>} <span aria-hidden="true">›</span>
      </span>
    </a>
  )
}

type Diagnostics = Awaited<ReturnType<typeof api.diagnostics>>

// What a household member looks at from day to day. The upkeep that is rarely needed (the backup record,
// the storage check, the metadata download) is one level down, on the Maintenance page (docs/decisions.md
// D-039). Both pages are open to every member alike.
export function ManagePage() {
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
      <PageHeader>管理</PageHeader>
      {error.value && (
        <p role="alert" class="mb-4 text-sm text-destructive">
          {error.value}
        </p>
      )}
      <RowLink
        to="/trash"
        icon={<Trash class="size-5 shrink-0 text-muted-foreground" />}
        label="ゴミ箱"
        value={diag.value ? `${diag.value.counts.trashed} 枚` : ''}
      />
      {diag.value && (
        <div class="mt-10">
          <h2 class="mb-2 text-heading">状態</h2>
          <dl class="divide-y divide-border text-sm">
            {(
              [
                ['写真', diag.value.counts.assets],
                ['アルバム', diag.value.counts.albums],
                ['ゴミ箱', diag.value.counts.trashed],
                [
                  '未完了のアップロード',
                  `${diag.value.counts.pendingUploads}${diag.value.counts.expiredUploads > 0 ? `（うち期限切れ ${diag.value.counts.expiredUploads}）` : ''}`,
                ],
                ['削除処理中', diag.value.counts.purging],
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
              期限切れのアップロードは中断したもので、写真としては登録されていません。自動では削除されません。「メンテナンス」の「保存状態の点検」から整理できます。写真がタイムラインに無ければ、もう一度選んでアップロードしてもかまいません。
            </p>
          )}
        </div>
      )}
      {/* A permanent delete a member started from the trash and that stopped halfway. It is finishing their own
          action, so it stays here rather than under Maintenance. */}
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
      <div class="mt-10">
        <RowLink
          to="/settings/maintenance"
          icon={<Wrench class="size-5 shrink-0 text-muted-foreground" />}
          label="メンテナンス"
          hint="バックアップの記録、保存状態の点検、写真とアルバムの情報の書き出し。普段は開く必要はありません。"
        />
      </div>
    </section>
  )
}
