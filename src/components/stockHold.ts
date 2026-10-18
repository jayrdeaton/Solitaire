import { useEffect, useRef } from 'react'

export interface StockRequestOptions {
  /** A held stock's repeat draw: it never turns the waste over, so the hold stops where the stock runs out (the player lets go and
   * taps, or holds again, to turn it over). The press that starts a hold does whatever a tap would, a turn-over included. */
  repeat?: boolean
  /** Asked while the request waits its turn (a card still flying where it would go) - true drops it unrun. The hold below passes "the
   * finger has lifted", so letting go of the stock never lets one more draw through. */
  cancelled?: () => boolean
}

/** What StockWaste's stock calls: one draw (or turn-over) per call. A screen's handler resolves true once it has started (committed -
 * its flight may still be in the air) and false when nothing happened (nothing to draw, a repeat at an empty stock, cancelled). One
 * that answers nothing is a stock that is never held (see StockWaste's `canRecycle`): a hold stops after its first draw. */
export type StockHandler = (opts?: StockRequestOptions) => Promise<boolean | void> | void

/** How long the stock is held before it starts drawing on its own: the footer's Undo and Hint holds' long press. */
export const STOCK_LONG_PRESS_MS = 400

/** A held stock draws a card every quarter second (Jay, 2026-10-18): quick enough to go through a whole stock (24 cards in about six
 * seconds), slow enough to read each card as it leaves and let go on the one wanted. It used to be the auto-play's 96ms, with three or
 * four cards in the air at once and the waste's top changing faster than it could be read. Counted from each draw's start, so a draw
 * that had to wait (a draw-3 fan still landing) still gets its full beat on top. Taps keep their own, quicker pace (stockWait.ts). */
export const STOCK_HOLD_REPEAT_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Press-and-hold stock: draws (or turns the waste over) at the long press, as a tap would, then draws once more `repeatMs` after each
 * draw has started, until the finger lifts or the stock runs out (a repeat never turns the waste over - see StockRequestOptions).
 *
 * The same loop as useUndoHold (undoHold.ts): the next draw is asked for only once the last one has started, since a screen may make
 * a draw wait (a draw-3 fan waits for the last fan to land), and it has no click of its own - each draw's card sound and haptic is
 * the feedback.
 */
export function useStockHold(onDrawStock: StockHandler, repeatMs: number = STOCK_HOLD_REPEAT_MS): { onLongPress: () => void; onPressOut: () => void } {
  const latest = useRef(onDrawStock)
  useEffect(() => {
    latest.current = onDrawStock
  }, [onDrawStock])
  // Bumped by every press-out (and on unmount): a loop belongs to the hold that started it and stops the moment it is over.
  const holdRef = useRef(0)
  useEffect(
    () => () => {
      holdRef.current += 1
    },
    []
  )

  const onPressOut = () => {
    holdRef.current += 1
  }

  const onLongPress = () => {
    const hold = ++holdRef.current
    const released = () => holdRef.current !== hold
    void (async () => {
      // The long press itself is the press's action, like a tap: it may turn the waste over, and it goes even if the finger lifts
      // while it waits its turn.
      let drew = await latest.current()
      while (!released() && drew === true) {
        await sleep(repeatMs)
        if (released()) return
        drew = await latest.current({ repeat: true, cancelled: released })
      }
    })()
  }

  return { onLongPress, onPressOut }
}
