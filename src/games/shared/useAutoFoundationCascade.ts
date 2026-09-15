import { useEffect, useRef } from 'react'

import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'

export interface AutoFoundationCascade {
  /** Call right after a manual (non-silent) player move whose `to.zone === 'foundation'` commits -
   * the only ordinary trigger for this whole feature. Arms the cascade; the effect below fires the
   * first step once `state`/`settled` next reflect that move having landed. */
  armFromForwardMove(): void
  /** Call right after a stock-draw-to-waste or tableau/reserve-reveal produces this game's own
   * foundation-starter card (rank 1 for every game except Canfield - see its own
   * isFoundationStarterCard). Plays `entry` first, ahead of whatever computeNextStep's own scan
   * order would otherwise pick, then continues the cascade exactly like armFromForwardMove - the
   * ace landing on its foundation is itself now "a card moved to the foundation." */
  armFromAceEvent(entry: AccessibleCard, to: PileRef): void
}

/**
 * Replaces the old "re-check after every settled state change" watcher every foundation game used
 * to duplicate (see git history) with an explicit armed state machine: nothing fires until one of
 * the two methods above is called, and it disarms the moment computeNextStep runs dry - a plain
 * tableau/freecell move, an undo, a non-ace draw/reveal, or the initial deal trigger nothing here
 * at all, by construction, since none of them ever call either arm method.
 *
 * `sweepingRef` latches once computeNextStep first returns a 'draw'/'drawAndPlay' step and stays
 * latched for the rest of that cascade - once the game is provably finishing itself, every
 * remaining flight in the same cascade uses sweep speed, including any ordinary 'play' steps
 * interleaved with the draws.
 */
export function useAutoFoundationCascade<TState>(config: {
  state: TState | null
  /** True once nothing is animating and the initial deal has finished - each screen's own existing
   * activeFlightCount===0 (or flying===null) && dealHiddenIds.size===0 signal, unchanged. */
  settled: boolean
  enabled: () => boolean
  isBusy: () => boolean
  /** Composes whichever of Mechanism A / Mechanism B / the draws-aware Mechanism B applies to this
   * game (see engine/autoFoundation.ts) into the single step shape below - same composition each
   * screen's own maybeAutoPlay already did, just returning a step instead of firing it directly. */
  computeNextStep: (state: TState) => AutoCompleteStep | null
  firePlay: (entry: AccessibleCard, to: PileRef, opts: { sweep: boolean }) => void
  /** Only supplied by the games with a stock (Klondike/Canfield/FortyThieves). */
  fireDraw?: (opts: { sweep: boolean }) => void
  fireDrawAndPlay?: (entry: AccessibleCard, to: PileRef, opts: { sweep: boolean }) => void
}): AutoFoundationCascade {
  const armedRef = useRef(false)
  const pinnedRef = useRef<{ entry: AccessibleCard; to: PileRef } | null>(null)
  const sweepingRef = useRef(false)

  // Deliberately depends on only [state, settled], not on enabled/isBusy/computeNextStep/the fire
  // callbacks - every screen passes fresh inline closures for those on every render, so depending
  // on them would re-run this effect (and re-read armedRef) on every render instead of only when
  // the board actually settles into a new position. Whichever render's closures are current by the
  // time state/settled next change are the ones this effect runs with - never a stale set from many
  // renders ago - so the only real edge is a settings/undo-busy flip landing in the brief window
  // between one step settling and the next settle-check, same negligible race every one of the old
  // per-screen watcher effects already accepted (see e.g. KlondikeScreen.tsx's own history).
  useEffect(() => {
    if (!armedRef.current) return
    if (!config.enabled() || !config.state || !config.settled || config.isBusy()) return
    const pinned = pinnedRef.current
    pinnedRef.current = null
    if (pinned) {
      config.firePlay(pinned.entry, pinned.to, { sweep: sweepingRef.current })
      return
    }
    const step = config.computeNextStep(config.state)
    if (!step) {
      armedRef.current = false
      sweepingRef.current = false
      return
    }
    if (step.kind !== 'play') sweepingRef.current = true
    if (step.kind === 'play') config.firePlay(step.entry, step.to, { sweep: sweepingRef.current })
    else if (step.kind === 'drawAndPlay') config.fireDrawAndPlay?.(step.entry, step.to, { sweep: true })
    else config.fireDraw?.({ sweep: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.state, config.settled])

  return {
    armFromForwardMove() {
      armedRef.current = true
    },
    armFromAceEvent(entry, to) {
      armedRef.current = true
      pinnedRef.current = { entry, to }
    }
  }
}
