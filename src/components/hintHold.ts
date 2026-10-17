import { useEffect, useRef } from 'react'

import { HintHandler } from './autoHint'

/**
 * Press-and-hold Hint: a hint at the long press, then the next one every `repeatMs` until the finger lifts, the same cycle
 * pressing Hint again steps through (each screen moves on to the next move while the board is unchanged, see
 * engine/hint.ts's findHint). It stops by itself as soon as there is nothing new to show - a stock draw, a lone move, no
 * move at all (the screen's handler doesn't return true) - so a hold never replays one hint or repeats the "no helpful
 * moves" toast.
 *
 * Same shape as useUndoHold (undoHold.ts), without the waiting: a hint is shown at once, so a plain timer is enough.
 */
export function useHintHold(onHint: HintHandler, repeatMs: number): { onLongPress: () => void; onPressOut: () => void } {
  const latest = useRef(onHint)
  useEffect(() => {
    latest.current = onHint
  }, [onHint])
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
    const step = () => {
      if (holdRef.current !== hold) return
      if (latest.current() === true) setTimeout(step, repeatMs)
    }
    step()
  }

  return { onLongPress, onPressOut }
}
