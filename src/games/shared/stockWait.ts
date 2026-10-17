/**
 * A stock tap that has to wait for a flight in its way (a turn-over still flying into the stock, a draw-3 fan still landing) waits
 * here instead of being dropped - every tap is one draw, however fast (Jay, 2026-10-16: his kids speed through the stock). The wait is
 * a poll, re-checked by the caller INLINE right before it commits:
 *
 *   const wait = startStockWait()
 *   while (!canGo() && wait.left() > 0 && !cancelled()) await stockWaitTick()
 *
 * so the last check and the commit it guards are one synchronous stretch. Several taps parked on the same flight wake one after
 * another, and the first to go (a fan, a turn-over) can put the next one back in the way - a helper that looped and resolved would
 * hand its answer back across a microtask in which a sibling has already changed it (Pyramid's whenLanded has the same rule).
 */

import { STOCK_HOLD_REPEAT_MS } from '@/components/stockHold'

/** How often a waiting stock tap asks again: a frame. The same poll the auto-play cascade and a waiting Undo use. */
export const STOCK_WAIT_POLL_MS = 16

/** How long a stock tap waits before it is dropped: a flight that never reports back must cost the player a tap, not the board. Long
 * enough for a few quick draw-3 taps queued behind each other (a fan is ~0.55s), like a waiting Undo's UNDO_MAX_WAIT_MS. */
export const STOCK_WAIT_MAX_MS = 3000

export function stockWaitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, STOCK_WAIT_POLL_MS))
}

/** The wait budget of ONE stock tap, started when it first has to wait. Module level because the clock read is impure, which the React
 * Compiler lint rejects inside a component. */
export function startStockWait(): { left: () => number } {
  const deadline = Date.now() + STOCK_WAIT_MAX_MS
  return { left: () => deadline - Date.now() }
}

/**
 * The taps that waited out one flight would all go in the frame it lands: three or four cards flying as one, the first ones never
 * seen. So a tap that had to wait goes no sooner than STOCK_HOLD_REPEAT_MS after the last one that did - they play out at a held
 * stock's pace once the way is clear. One per screen (a ref), shared by its taps: `ready()` is part of a waiting tap's loop condition,
 * `went()` is called by a tap that waited, in the stretch it commits.
 */
export function createStockQueue(): { ready: () => boolean; went: () => void } {
  let lastAt = -Infinity
  return {
    ready: () => Date.now() - lastAt >= STOCK_HOLD_REPEAT_MS,
    went: () => {
      lastAt = Date.now()
    }
  }
}
