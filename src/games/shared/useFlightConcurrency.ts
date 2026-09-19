import { MutableRefObject, useEffect, useRef, useState } from 'react'

import { PileRef } from '@/engine/gameTypes'

/** One currently-in-flight move's own "what's still hidden at the destination" descriptor - see
 * `flying` below. `id` is this entry's own beginFlying-issued id, used to remove (endFlying) or
 * shrink (shrinkFlying, for a multi-card fan landing one card at a time) exactly this entry and no
 * other, since several can now be headed to different piles at once. */
export interface FlyingEntry {
  id: number
  to: PileRef
  count: number
}

export interface FlightConcurrency<TState> {
  state: TState | null
  /** Mirrors `state`, updated synchronously inside commitState (not just on React's next render) -
   * see commitState's own doc comment for why every mutator should read the board through this,
   * not the closure `state` value. */
  stateRef: MutableRefObject<TState | null>
  /** The only way the board should ever be replaced (never call the raw setState this hook wraps
   * internally) - updates stateRef.current in the SAME synchronous tick as the state update, not
   * just on React's next render pass. This matters once multiple actions can be triggered
   * back-to-back before React has had a chance to re-render (see PATTERN_OVERLAP_GATE): reading
   * the closure `state` in that window would have every one of them building their own move on
   * top of the SAME stale board and clobbering each other's commit (whichever lands last silently
   * discards every earlier one's move) - confirmed live by rapid-clicking Klondike's stock pile 3
   * times, which drew the SAME card 3 times instead of 3 different ones before this fix. `state`
   * itself stays the right thing to read from the render body (JSX) and from [state]-effects (both
   * only ever see an already-committed value, no race there). */
  commitState(next: TState): void
  /** Every currently-in-flight move's own destination descriptor - a list, not a single value,
   * since concurrent flights (see PATTERN_OVERLAP_GATE) can each be headed to a different pile at
   * once. Aggregate with `.some()`/`.filter().reduce()` in JSX (e.g. `flying.some(f => f.to.zone
   * === 'foundation' && f.to.index === i)` for an isFlyingHere flag, or `flying.filter(f =>
   * f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0)` for a hidden-count prop). */
  flying: FlyingEntry[]
  /** Adds a new `flying` entry for a move headed to `to` (an N-card group), returning its id -
   * pass that id to endFlying/shrinkFlying once it lands (in full, or one card at a time). */
  beginFlying(to: PileRef, count: number): number
  /** Removes one `flying` entry outright - call once its flight has fully landed (or been
   * abandoned, e.g. a failed measurement). */
  endFlying(flyingId: number): void
  /** Shrinks one `flying` entry's own count by 1, for a multi-card fan (draw-3, a stock-cycling
   * sweep, ...) whose cards land one at a time rather than all together - see DealLayer's
   * per-card onCardLanded callback. Never goes below 0. */
  shrinkFlying(flyingId: number): void
  /** How many independent flight-completions are outstanding right now, summed across every
   * concurrently-active action (tap-to-move, drag, auto-play, stock-draw all run concurrently with
   * each other - see PATTERN_OVERLAP_GATE; undo alone still waits for this to hit 0 before it can
   * start, and blocks everything else while it runs, to protect the undo stack). The ref is
   * authoritative and updated synchronously (closing the gap where a rapid second action could
   * start during an async measurement window before a commit has even happened); the state mirror
   * exists only so a watcher effect (e.g. the auto-play cascade's `settled` flag) can re-run once
   * the count changes. */
  activeFlightCount: number
  activeFlightCountRef: MutableRefObject<number>
  /** Claims N outstanding completions up front (see activeFlightCountRef above) - call once per
   * flight-starting action, before its own async measurement/flight actually begins. Normally 1;
   * pass 2 for e.g. an undo whose entry also carries a cascaded move, where the primary flight and
   * the cascade's own independent flight are two genuinely concurrent completions. */
  startFlights(n?: number): void
  /** Shared completion tail for every flight-starting action (see activeFlightCountRef above) -
   * call once per independent completion (a landed ghost flight, a landed deal, or a "nothing to
   * animate" bail); only actually clears undoBusyRef once every completion every currently-active
   * action claimed up front has reported in. */
  settleFlight(): void
  /** True for the whole span of one undo call, from its own guard through every flight it kicked
   * off fully settling (visually, not just in state) - cleared by settleFlight once
   * activeFlightCountRef returns to 0. Undo alone holds FULL mutual exclusion (see
   * PATTERN_OVERLAP_GATE): it should refuse to start while anything else is active
   * (activeFlightCountRef.current > 0), AND every other flight-starting entry point should refuse
   * to start while this is true - reverting to an earlier board and applying a fresh move on top
   * of it are not safe to interleave (undo's own commitState would silently clobber whatever a
   * concurrent action just committed, or vice versa), unlike two ordinary moves, which are. This
   * hook only allocates the ref; setting/clearing it around the undo handler's own body, and
   * checking it in every other action, is each screen's own job (undo's exact shape - cascades,
   * multi-branch reverse flights - varies too much per game to generalize here). */
  undoBusyRef: MutableRefObject<boolean>
  /** Resets every piece of concurrency bookkeeping this hook owns (but NOT `state` itself - call
   * commitState/set state separately) - call from a fresh deal/restore, alongside resetting
   * whatever other per-game refs (pendingFlightRef, dealTokenRef, ...) that screen owns on its own. */
  reset(): void
}

/**
 * Owns the concurrency bookkeeping every game screen needs once its card flights can run
 * independently instead of being serialized behind a single busy-gate - see Klondike's own history
 * for the shape this was extracted from (git log), and PATTERN_OVERLAP_GATE for the invariant this
 * exists to protect: undo needs full mutual exclusion with everything else, but everything else
 * (tap, drag, auto-play, stock-draw) can safely run concurrently with each other, since each one's
 * flight is purely a cosmetic overlay on top of a board that already updated synchronously.
 *
 * Deliberately does NOT own `pendingFlightRef`/`dealTokenRef`/`ghost`-style per-game plumbing - the
 * exact shape of "what to measure and fly once a move commits" (does it need a stock-pile
 * container ref, a per-card CardRegistry lookup, a multi-card DealLayer fan, ...) varies enough
 * per game that generalizing it here would cost more clarity than it saves. Each screen still owns
 * its own `useRef<PendingEntry[]>([])` queue(s) and `[state]`-keyed effect(s) to drain them,
 * exactly as before - this hook only replaces the state/commitState/flying/activeFlightCount/
 * undoBusyRef bookkeeping around them.
 */
export function useFlightConcurrency<TState>(): FlightConcurrency<TState> {
  const [state, setState] = useState<TState | null>(null)
  const stateRef = useRef<TState | null>(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  function commitState(next: TState) {
    stateRef.current = next
    setState(next)
  }

  const [flying, setFlying] = useState<FlyingEntry[]>([])
  const flyingIdRef = useRef(0)

  function beginFlying(to: PileRef, count: number): number {
    const id = ++flyingIdRef.current
    setFlying((f) => [...f, { id, to, count }])
    return id
  }

  function endFlying(flyingId: number) {
    setFlying((f) => f.filter((e) => e.id !== flyingId))
  }

  function shrinkFlying(flyingId: number) {
    setFlying((f) => f.map((e) => (e.id === flyingId ? { ...e, count: Math.max(0, e.count - 1) } : e)))
  }

  const activeFlightCountRef = useRef(0)
  const [activeFlightCount, setActiveFlightCount] = useState(0)
  const undoBusyRef = useRef(false)

  function startFlights(n = 1) {
    activeFlightCountRef.current += n
    setActiveFlightCount(activeFlightCountRef.current)
  }

  function settleFlight() {
    activeFlightCountRef.current = Math.max(0, activeFlightCountRef.current - 1)
    setActiveFlightCount(activeFlightCountRef.current)
    if (activeFlightCountRef.current === 0) {
      undoBusyRef.current = false
    }
  }

  function reset() {
    undoBusyRef.current = false
    activeFlightCountRef.current = 0
    setActiveFlightCount(0)
    setFlying([])
  }

  return {
    state,
    stateRef,
    commitState,
    flying,
    beginFlying,
    endFlying,
    shrinkFlying,
    activeFlightCount,
    activeFlightCountRef,
    startFlights,
    settleFlight,
    undoBusyRef,
    reset
  }
}
