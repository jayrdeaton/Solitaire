import { useAudioPool } from '@rific/feedback-press/audio'
import { useRef } from 'react'

const CARDS_PLAY_SOUND = require('../../assets/sounds/cards-play.wav')
const CARDS_INVALID_SOUND = require('../../assets/sounds/cards-invalid.wav')

// Tapping to skip a mid-deal animation forces every remaining card's onDealt in one synchronous
// tick (see DealLayer.tsx's handleSkipTap) - without a floor, that's 10-40+ overlapping plays at
// once. 40ms turns that into a fast, still-audible riffle instead of a garbled blast, and is loose
// enough to never affect the normal 35ms-staggered deal or ordinary play (a genuine human drag/tap
// is never that fast).
const PLAY_THROTTLE_MS = 40

/** Builds the pooled sound players (native - iOS/Android). See useCardSoundPlayers.web.ts for
 * why web needs a different implementation entirely, not just a different backend flag. Call
 * exactly once, at the root (_layout.tsx), and feed the result into FeedbackPressProvider's
 * `sound` prop - every other call site should use useCardSoundEffects (useCardSounds.ts)
 * instead, so the pools aren't recreated per-consumer. */
export function useCardSoundPlayers() {
  const rawPlayCard = useAudioPool(CARDS_PLAY_SOUND, { poolSize: 8 })
  const playInvalidSound = useAudioPool(CARDS_INVALID_SOUND)
  const lastPlayRef = useRef(0)

  function playCardSound() {
    const now = Date.now()
    if (now - lastPlayRef.current < PLAY_THROTTLE_MS) return
    lastPlayRef.current = now
    rawPlayCard()
  }

  return { playCardSound, playInvalidSound }
}
