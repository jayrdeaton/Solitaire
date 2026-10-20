import { useLayoutEffect, useSyncExternalStore } from 'react'
import { AccessibilityInfo, LogBox } from 'react-native'
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated'

import { useSettings } from '@/hooks/useSettings'

import { setMotionReduced } from './reducedMotionFlag'

export { isMotionReduced } from './reducedMotionFlag'

/**
 * Reduce Motion: on when the player's own Settings row is on OR the device's Reduce Motion
 * accessibility setting is (iOS Settings > Accessibility > Motion, Android's Remove animations, a
 * browser's prefers-reduced-motion), live in both directions.
 *
 * What it does, everywhere:
 *  - Every Reanimated animation lands at once (ReducedMotionBridge's ReducedMotionConfig): a card
 *    flight, a drop, a snap-back, the fan glide, the footer slide, a shake, a toast. Reanimated reads
 *    the device setting only once, at launch, and ignores the in-app row, so the bridge sets it from
 *    the combined flag instead. Opacity-only fades that read as a cross-fade, not motion, opt out with
 *    `reduceMotion: ReduceMotion.Never` (GameLoading's reveal and pulse).
 *  - The JS timers that cover a flight follow it (isMotionReduced: springSettleMs, Spider's run
 *    stagger), so a card that has landed at once is handed to the real card at once instead of
 *    sitting there for the spring's full length.
 *  - Deals, draw-3 fans, stock deals and win sweeps land at once (DealLayer), the win cascade, the
 *    pip fireworks, the hint glide and Home's hero wave are left out. The win dialog, the hint ring
 *    and every sound and haptic stay.
 * Pacing that is not motion (the auto-play's and the finish's gaps, a held Undo's or Hint's repeat)
 * is unchanged: cards still go one after another, each appearing in its spot.
 */

// ReducedMotionConfig warns once in a dev build that it overrides the device setting, which is the point here.
LogBox.ignoreLogs(['Reduced motion setting is overwritten'])

// The device setting, shared by every reader through one AccessibilityInfo subscription.
let systemReduced = false
const listeners = new Set<() => void>()
let subscribed = false

function setSystemReduced(value: boolean) {
  if (value === systemReduced) return
  systemReduced = value
  listeners.forEach((listener) => listener())
}

function subscribeSystem(listener: () => void) {
  listeners.add(listener)
  if (!subscribed) {
    subscribed = true
    AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReduced)
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setSystemReduced)
      .catch(() => {})
  }
  return () => {
    listeners.delete(listener)
  }
}

function getSystemReduced() {
  return systemReduced
}

/** The device's own Reduce Motion setting, live. */
export function useSystemReduceMotion(): boolean {
  return useSyncExternalStore(subscribeSystem, getSystemReduced, getSystemReduced)
}

/** Reduce Motion as the app applies it: the Settings row or the device setting. */
export function useMotionReduced(): boolean {
  const { settings } = useSettings()
  const system = useSystemReduceMotion()
  return settings.reduceMotion || system
}

/** Mounted once at the root, inside PersistGate (it reads the settings): applies the combined flag to
 * Reanimated and to isMotionReduced(). */
export function ReducedMotionBridge() {
  const reduced = useMotionReduced()
  useLayoutEffect(() => {
    setMotionReduced(reduced)
  }, [reduced])
  return <ReducedMotionConfig mode={reduced ? ReduceMotion.Always : ReduceMotion.Never} />
}
