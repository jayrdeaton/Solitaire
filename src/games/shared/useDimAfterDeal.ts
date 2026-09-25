import { useCallback, useEffect, useRef, useState } from 'react'

/** The beat between a deal's last card landing and the board dimming: long enough that the dim is its own moment (and
 * not piled onto the commit that reveals the last card and unmounts the deal's ghost pool), short enough to read as the
 * deal settling rather than as a separate event. */
export const DEAL_DIM_SETTLE_MS = 150
/** Backstop: if a deal never reports that it has landed, the board still dims this long after it started. Well past the
 * longest deal (~2s for a face-up one - see dealSpring.ts's FACE_UP_TARGET_TOTAL_MS) plus its pool's mount. */
export const DEAL_DIM_MAX_HOLD_MS = 6000

export interface DimAfterDeal {
  /** True while an initial deal is in the air (and for DEAL_DIM_SETTLE_MS after its last card lands): draw nothing dimmed
   * yet. Feed it to whatever turns the dimming on - PileView's `dimUnplayable`, Pyramid's `dimHold`. */
  held: boolean
  /** A new deal is starting: hold every dim until it has landed. Call in the same tick as the commit that starts it. */
  hold(): void
  /** The deal has landed (or was skipped, or never got to fly): dim the whole board at once, after DEAL_DIM_SETTLE_MS. */
  release(): void
  /** No deal to wait for (a resumed board): dimming is on right away. */
  releaseNow(): void
}

/**
 * Holds a game's "this card can't be played" dimming off for the whole of its initial deal, then turns it on for every
 * card at once. Dimming each card as it landed meant ~35 scrims mounting and fading one by one underneath cards that
 * were still flying - in the busiest stretch of the deal, where (on iOS) a fade's final opacity was measurably lost
 * for a whole row at a time (see PlayingCard's FadingDimScrim). Now every card lands looking exactly like the ghost
 * that carried it, and the board settles into its dimmed look in one fade, after the last card is down.
 */
export function useDimAfterDeal(): DimAfterDeal {
  const [held, setHeld] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  const releaseAfter = useCallback(
    (ms: number) => {
      clearTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setHeld(false)
      }, ms)
    },
    [clearTimer]
  )

  useEffect(() => clearTimer, [clearTimer])

  const hold = useCallback(() => {
    setHeld(true)
    releaseAfter(DEAL_DIM_MAX_HOLD_MS)
  }, [releaseAfter])
  const release = useCallback(() => releaseAfter(DEAL_DIM_SETTLE_MS), [releaseAfter])
  const releaseNow = useCallback(() => {
    clearTimer()
    setHeld(false)
  }, [clearTimer])

  return { held, hold, release, releaseNow }
}
