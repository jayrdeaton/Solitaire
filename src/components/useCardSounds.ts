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

  // When a card clicks and buzzes (Jay, 2026-10-17: a card's buzz is when it is PLAYED, never when it lands):
  // - A press: every card (and the stock) is a feedback-press Pressable, which buzzes at touch-down. That is a tap's whole buzz;
  //   the move it makes only clicks (playCardSound) as the card takes off. A drag's pickup clicks too.
  // - A drag's release (PileView/DraggableCard): hapticCard once the drop stands, or hapticInvalid with the invalid sound as a
  //   refused card starts back (DragGhostLayer's snapBack).
  // - A deal: click and buzz together on the deal's steady beat (DealLayer.tsx's dealBeatTicks), not once per card.
  // - Auto-play: click and buzz together as each card leaves on the cascade's or finish's own clock (their `beat`), throttled by
  //   games/shared/cascadeFeedback.ts.
  // - A held Undo or stock: each undo, and each repeat draw, clicks and buzzes - nothing pressed it.
  // Nothing plays on arrival (DragGhostLayer's flyTo). Landing-synced feedback read as sluggish, trailing the input that caused it.
  const playCardSound = useCallback(() => {
    if (latest.current.enabled) latest.current.selection?.()
  }, [])
  const playInvalidSound = useCallback(() => {
    if (latest.current.enabled) latest.current.notification?.()
  }, [])
  const hapticCard = useCallback(() => {
    latest.current.vibration.selection()
  }, [])
  const hapticInvalid = useCallback(() => {
    latest.current.vibration.short()
  }, [])

  return { playCardSound, playInvalidSound, hapticCard, hapticInvalid }
}
