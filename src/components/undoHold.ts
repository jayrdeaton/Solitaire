import { useEffect, useRef } from 'react'

export interface UndoRequestOptions {
  /** Asked while the request waits its turn - true drops it unrun. The hold-to-repeat loop below passes "the finger has lifted", so
   * releasing Undo never lets one more undo through after it. */
  cancelled?: () => boolean
}

/** What GameChrome's Undo button calls: one undo per call. A screen's handler resolves true once that undo has started (reverted and
 * committed - its flights may still be in the air) and false when it was refused (nothing left to undo, or cancelled); see
 * useFlightConcurrency's runUndo. */
export type UndoHandler = (opts?: UndoRequestOptions) => Promise<boolean> | void

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Press-and-hold Undo: undoes once at the long press, then once more `repeatMs` after each undo has started, until the finger lifts or
 * there is nothing left to undo.
 *
 * Not @rific/feedback-press's useHoldToRepeat: its fixed `setInterval` fires (and clicks) whether or not the screen could undo, and a
 * screen used to refuse an undo while the last one was still flying - so a tick that landed mid-flight did nothing, and holding Undo
 * undid one move every other click. This loop asks for the next undo only once the last one has started, and has no click of its own:
 * each undo's own card sound and haptic is the feedback, so there is exactly one per card that comes back.
 */
export function useUndoHold(onUndo: UndoHandler, repeatMs: number): { onLongPress: () => void; onPressOut: () => void } {
  const latest = useRef(onUndo)
  useEffect(() => {
    latest.current = onUndo
  }, [onUndo])
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
      while (!released()) {
        const undone = await latest.current({ cancelled: released })
        if (released() || undone === false) return
        await sleep(repeatMs)
      }
    })()
  }

  return { onLongPress, onPressOut }
}
