import { useSignal, useSignalEffect } from '@preact/signals'
import { useRef } from 'preact/hooks'
import type { Share } from '../../../contracts/schemas'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/dialog'
import { api } from '../../lib/api/client'
import { userMessage } from '../../lib/errors'

const STATUS: Record<Share['status'], string> = { active: '有効', expired: '期限切れ', revoked: '無効化済み' }

// Both actions end the current link for good (regenerate revokes it server-side), so each asks first.
const CONFIRM = {
  regenerate: {
    title: '共有リンクを再発行しますか？',
    description:
      '新しいリンクを発行すると、現在のリンクは使えなくなり、元に戻せません。共有した相手には新しいリンクを送り直してください。',
    confirmLabel: '再発行する',
  },
  revoke: {
    title: '共有リンクを無効化しますか？',
    description: 'このリンクでは閲覧できなくなり、元に戻せません。',
    confirmLabel: '無効化する',
  },
} as const

export function SharePanel({ albumId }: { albumId: string }) {
  const shares = useSignal<Share[]>([])
  const days = useSignal(7)
  const fresh = useSignal<{ id: string; url: string } | null>(null)
  const error = useSignal<string | null>(null)
  const copied = useSignal(false)
  // The target stays set while the dialog closes, so its text does not change during the close.
  const confirming = useSignal<{ kind: keyof typeof CONFIRM; shareId: string }>({ kind: 'revoke', shareId: '' })
  const confirmOpen = useSignal(false)
  // The button that asked. After a confirmed action the list no longer has it, so focus goes to the form.
  const opener = useRef<HTMLElement | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = useSignal(false)

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
    <div class="flex flex-col gap-5 text-sm">
      <form
        ref={form}
        class="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            const created = await api.createShare(albumId, days.value)
            fresh.value = { id: created.share.id, url: created.url }
          })
        }}
      >
        <label class="flex flex-col gap-1.5 text-muted-foreground">
          有効期限（日）
          <input
            type="number"
            min={1}
            max={365}
            value={days.value}
            onInput={(e) => (days.value = Number((e.currentTarget as HTMLInputElement).value))}
            class="h-11 w-24 rounded-control bg-muted px-3 text-base text-foreground tabular-nums md:h-9 md:text-sm"
          />
        </label>
        <Button type="submit">リンクを発行</Button>
      </form>

      {fresh.value && (
        <div>
          <p class="mb-1.5 font-medium">新しいリンク（この画面を閉じると再表示できません）</p>
          <div class="flex gap-2">
            <input
              readOnly
              value={fresh.value.url}
              aria-label="共有リンク"
              class="h-11 min-w-0 flex-1 rounded-control bg-muted px-3 text-base md:h-9 md:text-sm"
            />
            <Button
              variant="secondary"
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

      <ul class="divide-y divide-border empty:hidden">
        {shares.value.map((share) => (
          <li key={share.id} class="flex items-center justify-between gap-2 py-2.5">
            <div>
              <div>{STATUS[share.status]}</div>
              <div class="text-muted-foreground tabular-nums">期限 {new Date(share.expiresAt).toLocaleString()}</div>
            </div>
            {share.status === 'active' && (
              <div class="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    opener.current = e.currentTarget
                    confirming.value = { kind: 'regenerate', shareId: share.id }
                    confirmOpen.value = true
                  }}
                >
                  再発行
                </Button>
                <Button
                  size="sm"
                  variant="destructive-ghost"
                  onClick={(e) => {
                    opener.current = e.currentTarget
                    confirming.value = { kind: 'revoke', shareId: share.id }
                    confirmOpen.value = true
                  }}
                >
                  無効化
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirmOpen.value}
        onOpenChange={(open) => {
          confirmOpen.value = open
        }}
        {...CONFIRM[confirming.value.kind]}
        busy={busy.value}
        finalFocus={() =>
          opener.current?.isConnected
            ? opener.current
            : (form.current?.querySelector<HTMLElement>('button[type=submit]') ?? null)
        }
        onConfirm={async () => {
          const target = confirming.value
          busy.value = true
          await act(async () => {
            if (target.kind === 'regenerate') {
              const created = await api.regenerateShare(target.shareId)
              fresh.value = { id: created.share.id, url: created.url }
            } else {
              await api.revokeShare(target.shareId)
              if (fresh.value?.id === target.shareId) fresh.value = null
            }
          })
          busy.value = false
          confirmOpen.value = false
        }}
      />
      <p class="text-xs text-muted-foreground">
        無効化すると以後のアクセスは拒否されます。ただし、開いているページに発行済みの画像 URL は最長 5
        分間有効なままで、すでに閲覧・保存された画像を取り消すこともできません。
      </p>
    </div>
  )
}
