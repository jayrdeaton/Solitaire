import { useRef } from 'react'

// A fast multi-card auto-play cascade (see useAutoFoundationCascade) risks piling up per-card
// feedback calls faster than either channel can distinctly render - most acutely once a win-
// completing sweep pushes cards through at its own much quicker pace. Haptics
// (@rific/feedback-press's useVibration) have no throttling of their own at all, so an
// un-gated cascade produces an uninterrupted buzz of individual pulses rather than a readable
// patter. Must not go below the sound pool's own PLAY_THROTTLE_MS floor (see
// useCardSoundPlayers.ts, added for an unrelated purpose - deal-skip bursts) - going lower would
// make haptics fire denser than sound can even audibly keep up with, the exact mismatch this
// exists to close.
const CASCADE_FEEDBACK_MIN_INTERVAL_MS = 45

/**
 * Gates a screen's own playCardSound+hapticCard pair behind one shared minimum-interval timer, for
 * use inside an auto-play cascade's own per-card feedback (firePlay/fireDraw/fireDrawAndPlay) -
 * every other call site (a manual tap, a drag's drop, undo, a non-sweep manual draw) keeps calling
 * playCardSound/hapticCard directly, fully unthrottled. Harmless to apply even to an ordinary
 * (non-sweep) cascade step: those are already gated by the slower autoPlaySpringFor settle time
 * (75-170ms, see dragSpring.ts) before the next step ever fires, well above this floor, so the
 * throttle only actually suppresses anything once sweep speed (40-90ms) makes consecutive steps
 * fast enough to collide.
 */
export function useCascadeFeedback(playCardSound: () => void, hapticCard: () => void): () => void {
  const lastFiredAtRef = useRef(0)
  return () => {
    const now = Date.now()
    if (now - lastFiredAtRef.current < CASCADE_FEEDBACK_MIN_INTERVAL_MS) return
    lastFiredAtRef.current = now
    playCardSound()
    hapticCard()
  }
}
