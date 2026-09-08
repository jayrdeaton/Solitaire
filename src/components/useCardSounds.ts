import { SoundContext, useSoundSettings, useVibration } from '@rific/feedback-press'
import { useCallback, useContext, useEffect, useRef } from 'react'

// Platform-split (useCardSoundPlayers.ts / .web.ts) - web needs a genuinely different
// implementation, not just a different backend flag, to avoid the <audio>-element playback
// latency measured in useCardSoundPlayers.web.ts's doc comment. Metro picks the right file per
// platform automatically; every caller (just _layout.tsx) imports this same re-export.
export { useCardSoundPlayers } from './useCardSoundPlayers'

/** Reads the already-wired sound functions back out via the same SoundContext
 * FeedbackPressProvider populates, for any call site that isn't a Pressable press - a card's
 * pickup or a tap that resolves to a move, a deal's per-card dealt-out moment, a rejected
 * drag/tap. Still gated on the user's Sound FX setting, which useFeedbackHandlers only applies to
 * press-driven calls. Also exposes matching haptics (see hapticCard/hapticInvalid below) -
 * useVibration()'s own selection()/short() already self-gate on the app's Haptics setting, same
 * as every other haptic call site in this codebase.
 *
 * Returns stable function identities (reading through a ref updated every render, same pattern
 * as DraggableCard.tsx's `latest`) so a consumer can safely list them in a useCallback/useEffect
 * dependency array - or omit them, since they never change - without going stale: a naive
 * `() => { if (enabled) selection?.() }` closure would freeze whatever `enabled` was true at
 * creation time inside any caller wrapped in its own useCallback([]), silently ignoring later
 * Sound FX toggle changes. */
export function useCardSoundEffects() {
  const { selection, notification } = useContext(SoundContext)
  const {
    settings: { enabled }
  } = useSoundSettings()
  const vibration = useVibration()
  const latest = useRef({ selection, notification, enabled, vibration })
  // Updated in an effect rather than directly during render (mutating a ref during render isn't
  // allowed) - still fresh well before any of the callbacks below can actually fire, since those
  // only ever run from a later event/gesture callback, never synchronously during this render.
  useEffect(() => {
    latest.current = { selection, notification, enabled, vibration }
  })

  // playCardSound/hapticCard are always fired together, the instant a move is confirmed - a
  // drag's pickup, a tap that resolves to a valid auto-move, an Undo, a stock draw, or (in
  // DealLayer.tsx) the moment each dealt card leaves the stock - rather than waiting for that
  // card's flight to land (see DragGhostLayer.tsx's flyTo, which no longer plays either on
  // arrival). Landing-synced timing read as sluggish and left the two senses out of sync with
  // each other: the click/buzz trailed the animation by however long the flight took, instead of
  // responding together to the input that caused it.
  const playCardSound = useCallback(() => {
    if (latest.current.enabled) latest.current.selection?.()
  }, [])
  const playInvalidSound = useCallback(() => {
    if (latest.current.enabled) latest.current.notification?.()
  }, [])
  // hapticCard is deliberately NOT called from a drag's own pick-up handler (DraggableCard.tsx/
  // PileView.tsx) even though playCardSound is - every card is already a Pressable (see
  // PlayingCard.tsx), so picking one up already fires a touch haptic for free via onPressIn,
  // before the pan gesture even claims the gesture as a drag; an explicit hapticCard call there
  // too would double up on that same instant. Sound doesn't have this constraint (soundDisabled
  // already silences the generic press sound on every card), which is why playCardSound can fire
  // from pick-up without doubling anything - hapticCard instead fires alongside it from every
  // OTHER move site (tap-to-move, undo, stock draw, auto-play, deal), none of which already have
  // a free haptic of their own to double up against.
  const hapticCard = useCallback(() => {
    latest.current.vibration.selection()
  }, [])
  const hapticInvalid = useCallback(() => {
    latest.current.vibration.short()
  }, [])

  return { playCardSound, playInvalidSound, hapticCard, hapticInvalid }
}
