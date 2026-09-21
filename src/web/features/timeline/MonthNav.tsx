import { useSignal, useSignalEffect } from '@preact/signals'
import { Button, cn } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { Calendar } from '../../components/ui/icons'
import { formatMonthKey } from '../../lib/dates'
import { navigate, timelineMonth } from '../../state/router'
import { libraryVersion } from '../uploads/upload'
import { byYear } from './month-list'
import { loadMonths, months, monthsError, monthsVersion } from './months'

// Jump to a month. The list has one entry per month that has a photo, so months with none are simply absent
// instead of being listed as empty (docs/decisions.md D-031).
export function MonthNav() {
  const open = useSignal(false)

  useSignalEffect(() => {
    // Uploads, trash, restore and undo change which months exist and how many photos they hold.
    void libraryVersion.value
    void monthsVersion.value
    void loadMonths()
  })

  // The chosen month can disappear while it is open (its last photo was deleted, or someone else deleted it).
  // The timeline then starts at the newest photo, so the address should say that too.
  useSignalEffect(() => {
    const month = timelineMonth.value
    const list = months.value
    if (month && list && !list.some((m) => m.month === month)) navigate('/', { replace: true })
  })

  const list = months.value
  const selected = timelineMonth.value
  const total = list?.reduce((n, m) => n + m.count, 0) ?? 0

  function jump(to: string | null) {
    open.value = false
    navigate(to ? `/?m=${to}` : '/')
    window.scrollTo(0, 0)
  }

  return (
    <>
      {/* The label says where the timeline is; the name stays the same so it is still the same control. */}
      <Button
        variant="secondary"
        size="sm"
        pill
        aria-label="年月で移動"
        onClick={() => (open.value = true)}
        disabled={!list?.length}
      >
        <Calendar class="size-4" />
        {selected ? formatMonthKey(selected) : '年月で移動'}
      </Button>
      <Dialog
        open={open.value}
        onOpenChange={(v) => (open.value = v)}
        title="年月で移動"
        description={list?.length ? `${total.toLocaleString()}枚` : undefined}
      >
        {monthsError.value && <p class="text-sm text-destructive">{monthsError.value}</p>}
        <div class="flex flex-col gap-5">
          {byYear(list ?? []).map((year) => (
            <section key={year.year} aria-label={`${year.year}年`}>
              <h3 class="mb-2 text-sm font-semibold text-muted-foreground">{year.year}年</h3>
              <ul class="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {year.months.map((month) => {
                  const current = month.month === selected
                  return (
                    <li key={month.month}>
                      <button
                        type="button"
                        aria-current={current ? 'true' : undefined}
                        data-month={month.month}
                        onClick={() => jump(month.month)}
                        class={cn(
                          'flex min-h-11 w-full flex-col items-center justify-center rounded-lg px-2 py-1.5 text-sm transition',
                          current ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-border',
                        )}
                      >
                        <span>{Number(month.month.slice(5))}月</span>
                        <span class={cn('text-xs', current ? 'opacity-80' : 'text-muted-foreground')}>
                          {month.count.toLocaleString()}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
        {selected && (
          <div class="mt-5 flex justify-end">
            <Button variant="ghost" onClick={() => jump(null)}>
              最新の写真へ
            </Button>
          </div>
        )}
      </Dialog>
    </>
  )
}
