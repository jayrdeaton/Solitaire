import { Asset } from 'expo-asset'
import { useCallback, useEffect, useRef } from 'react'

const CARDS_PLAY_SOUND = require('../../assets/sounds/cards-play.wav')
const CARDS_INVALID_SOUND = require('../../assets/sounds/cards-invalid.wav')

// Same reasoning as useCardSoundPlayers.ts's own PLAY_THROTTLE_MS (kept in sync manually - a
// third shared-constants file for one small number isn't worth it): a skipped mid-deal animation
// forces 10-40+ cards' onDealt in one tick, and this keeps that a fast riffle instead of a garbled
// overlapping blast. Loose enough to never affect ordinary play or the 35ms-staggered deal.
const PLAY_THROTTLE_MS = 40

function getAudioContextCtor(): typeof AudioContext | undefined {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  return w.AudioContext ?? w.webkitAudioContext
}

// Web's <audio>-element playback (what @rific/feedback-press's useAudioPool uses via
// expo-audio's AudioPlayer.web.js - a plain `new Audio()`, not the Web Audio API) measured live
// in this app at 42-89ms between calling play() and the browser's own 'playing' event actually
// firing - a real, repeatable HTMLMediaElement scheduling cost, not anything this app's own code
// does. The same clip played through an AudioBufferSourceNode instead measured under 3ms of
// scheduling latency on the same machine/browser, because the buffer is already decoded in
// memory and start() hands it straight to the browser's audio rendering thread - no per-play
// seekTo/play promise chain, and therefore no setTimeout(0) deferral needed either (that
// deferral in useAudioPool's triggerPlayback exists specifically to keep the <audio>-element
// seekTo+play round trip off the caller's stack - start() is cheap enough not to need it).
//
// A fresh AudioBufferSourceNode per play also sidesteps the exact bug useAudioPool's own pooling
// works around (a single retriggered <audio>/player's seekTo(0) racing its own still-in-flight
// play()): a buffer source node is one-shot and can't be raced, so overlapping plays just mix
// naturally with no pool needed.
function useWebBufferSound(source: number): () => void {
  const ctxRef = useRef<AudioContext | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)

  useEffect(() => {
    const Ctor = getAudioContextCtor()
    if (!Ctor) return
    const ctx = new Ctor()
    ctxRef.current = ctx
    let cancelled = false
    ;(async () => {
      try {
        const uri = Asset.fromModule(source).uri
        const response = await fetch(uri)
        const data = await response.arrayBuffer()
        const buffer = await ctx.decodeAudioData(data)
        if (!cancelled) bufferRef.current = buffer
      } catch {
        // Leave bufferRef null - the returned play function below silently no-ops, same as
        // useAudioPool's own guard for a not-yet-built native pool.
      }
    })()
    return () => {
      cancelled = true
      ctxRef.current = null
      void ctx.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useCallback(() => {
    const ctx = ctxRef.current
    const buffer = bufferRef.current
    if (!ctx || !buffer) return
    // The context is created at app mount, before any user gesture has necessarily happened, so
    // it starts 'suspended' on most browsers - resumed here instead, since every real call to
    // this function is already itself the result of a tap/drag.
    if (ctx.state === 'suspended') void ctx.resume()
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(ctx.destination)
    node.start()
  }, [])
}

/** Builds the sound players - web variant (see useCardSoundPlayers.ts's doc comment for the
 * shared calling contract; this file replaces it only on web, via the .web.ts platform
 * extension). Call exactly once, at the root (_layout.tsx). */
export function useCardSoundPlayers() {
  const rawPlayCard = useWebBufferSound(CARDS_PLAY_SOUND)
  const playInvalidSound = useWebBufferSound(CARDS_INVALID_SOUND)
  const lastPlayRef = useRef(0)

  function playCardSound() {
    const now = Date.now()
    if (now - lastPlayRef.current < PLAY_THROTTLE_MS) return
    lastPlayRef.current = now
    rawPlayCard()
  }

  return { playCardSound, playInvalidSound }
}
