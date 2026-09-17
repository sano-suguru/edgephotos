import { useSignal, useSignalEffect } from '@preact/signals'
import type { Share } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'

const STATUS: Record<Share['status'], string> = { active: '有効', expired: '期限切れ', revoked: '無効化済み' }

export function SharePanel({ albumId }: { albumId: string }) {
  const shares = useSignal<Share[]>([])
  const days = useSignal(7)
  const fresh = useSignal<{ id: string; url: string } | null>(null)
  const error = useSignal<string | null>(null)
  const copied = useSignal(false)

  const load = () =>
    api
      .listShares(albumId)
      .then((r) => {
        shares.value = r.items
      })
      .catch((err) => {
        error.value = userMessage(err)
      })

  useSignalEffect(() => {
    void load()
  })

  async function act(fn: () => Promise<void>) {
    error.value = null
    copied.value = false
    try {
      await fn()
      await load()
    } catch (err) {
      error.value = userMessage(err)
    }
  }

  return (
    <div class="flex flex-col gap-4 text-sm">
      <form
        class="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            const created = await api.createShare(albumId, days.value)
            fresh.value = { id: created.share.id, url: created.url }
          })
        }}
      >
        <label class="flex flex-col gap-1">
          有効期限（日）
          <input
            type="number"
            min={1}
            max={365}
            value={days.value}
            onInput={(e) => (days.value = Number((e.currentTarget as HTMLInputElement).value))}
            class="h-9 w-24 rounded-md border border-border px-2"
          />
        </label>
        <Button type="submit">リンクを発行</Button>
      </form>

      {fresh.value && (
        <div class="rounded-md border border-border bg-muted p-3">
          <p class="mb-2 font-medium">新しいリンク（この画面を閉じると再表示できません）</p>
          <div class="flex gap-2">
            <input
              readOnly
              value={fresh.value.url}
              aria-label="共有リンク"
              class="h-9 flex-1 rounded-md border border-border px-2"
            />
            <Button
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh.value?.url ?? '')
                copied.value = true
              }}
            >
              {copied.value ? 'コピー済み' : 'コピー'}
            </Button>
          </div>
        </div>
      )}

      {error.value && (
        <p role="alert" class="text-destructive">
          {error.value}
        </p>
      )}

      <ul class="divide-y divide-border">
        {shares.value.map((share) => (
          <li key={share.id} class="flex items-center justify-between gap-2 py-2">
            <div>
              <div>{STATUS[share.status]}</div>
              <div class="text-muted-foreground">期限 {new Date(share.expiresAt).toLocaleString()}</div>
            </div>
            {share.status === 'active' && (
              <div class="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    act(async () => {
                      const created = await api.regenerateShare(share.id)
                      fresh.value = { id: created.share.id, url: created.url }
                    })
                  }
                >
                  再発行
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    act(async () => {
                      await api.revokeShare(share.id)
                      if (fresh.value?.id === share.id) fresh.value = null
                    })
                  }
                >
                  無効化
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p class="text-xs text-muted-foreground">
        無効化すると以後のアクセスは拒否されます。ただし、開いているページに発行済みの画像 URL は最長 5
        分間有効なままで、すでに閲覧・保存された画像を取り消すこともできません。
      </p>
    </div>
  )
}
