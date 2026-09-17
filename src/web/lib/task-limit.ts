// Pure helper (no DOM) so it can be unit-tested outside the browser.
// One limiter is shared by every call, so selecting more photos while a batch is still running queues them
// behind it instead of adding more tasks in flight. Waiters run in the order they arrived.
export function createTaskLimiter(limit: number) {
  const waiting: (() => void)[] = []
  let running = 0
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running < limit) running++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      // Hand the slot straight to the next waiter; only free it when nobody is waiting.
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}
