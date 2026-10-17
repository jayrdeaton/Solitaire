import { MutableRefObject, useEffect, useRef, useState } from 'react'

import type { UndoRequestOptions } from '@/components/undoHold'
import { PileRef } from '@/engine/gameTypes'

/** What the top undo entry needs before its revert may start - see runUndo. */
export type UndoGate =
  /** Nothing to undo: this request, and every one queued behind it, is refused. */
  | null
  /** Not yet, for a reason of the screen's own (Spider's run waiting for its sweep) - asked again shortly. */
  | 'blocked'
  /** Starts only once nothing at all is in the air, and no other undo starts until its flights have all landed: a revert that flies
   * through the deal layer (one batch at a time - a second start cancels the first), moves a whole pile at once (a recycle), touches
   * several piles (a stock deal, a legacy entry's cascaded auto-plays, Spider's completed run) or leans on a single-slot ref (Pyramid's
   * frozen stock). Undo used to work this way for every entry. */
  | 'exclusive'
  /** An ordinary one-move revert through the ghost layer: overlaps the flights of the undos before it, once nothing is still landing
   * on any of these piles. Always the pile it takes its cards from (picking up a card whose own ghost is still airborne shows it
   * twice - the auto-play cascade waits for the same thing); a screen adds whatever else it cannot share mid-flight (the waste, whose
   * frozen-top bookkeeping assumes one arrival at a time). */
  | { takesFrom: readonly PileRef[] }

// How often a waiting undo asks its gate again, and how long the request at the head of the queue waits before it is refused - the
// same numbers the auto-play cascade waits for a landing with (useAutoFoundationCascade).
const UNDO_POLL_MS = 16
const UNDO_MAX_WAIT_MS = 3000

interface UndoRequest {
  resolve(started: boolean): void
  reject(error: unknown): void
  cancelled?: () => boolean
  /** Set when the request first reaches the head of the queue and has to wait - a tap queued behind others isn't timed out by their waits. */
  deadline: number | null
}

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
  /** Takes `count` cards back out of the flights still landing on `pile`, newest first (they carry its top cards): cards a later
   * move sends somewhere else before they have landed - an undo that turns them back in mid-air (DragGhostController.peel). The
   * flight lands as before, revealing only what it still carries. */
  shrinkLanding(pile: PileRef, count: number): void
  /** Whether a card is still flying in to `pile` right now - read live (kept in step with every
   * beginFlying/endFlying/shrinkFlying as it happens, not on React's next render), for a loop that
   * outlives the render that started it (the auto-play cascade: a card whose own flight hasn't
   * landed must not be picked up again, or it shows twice). */
  isLanding(pile: PileRef): boolean
  /** How many of `pile`'s top cards are still flying in to it right now - read live, like isLanding. A tap on a card under them sends
   * them on from mid-air (inAirRun.ts). */
  landingCount(pile: PileRef): number
  /** How many independent flight-completions are outstanding right now, summed across every
   * concurrently-active action (tap-to-move, drag, auto-play, stock-draw all run concurrently with
   * each other - see PATTERN_OVERLAP_GATE; the first undo of a run waits for this to hit 0, and
   * undo blocks everything that is not an undo while it runs - see runUndo). The ref is
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
   * action claimed up front has reported in and no undo is waiting or running. */
  settleFlight(): void
  /** True from the moment an undo is requested (runUndo) until every undo is done and every flight
   * the undos kicked off has settled (visually, not just in state) - cleared by settleFlight once
   * activeFlightCountRef returns to 0 with no undo waiting or running. Undo holds mutual exclusion
   * with everything that is not an undo (see PATTERN_OVERLAP_GATE): every other flight-starting
   * entry point should refuse to start while this is true, and bail if it turned true across its
   * own awaits - reverting to an earlier board and applying a fresh move on top of it are not safe
   * to interleave (undo's own commitState would silently clobber whatever a concurrent action just
   * committed, or vice versa), unlike two ordinary moves, which are. Undos may overlap EACH OTHER's
   * flights (see runUndo). Checking it in every other action is each screen's own job. */
  undoBusyRef: MutableRefObject<boolean>
  /** Requests one undo and resolves once it has run (true: reverted and committed - its flights may
   * still be in the air) or been refused (false: nothing to undo, `cancelled`, or its gate did not
   * open within UNDO_MAX_WAIT_MS). Never drops a request because something is still flying: it
   * waits for the entry's own `gate` instead, so each tap of Undo is one undo, however fast.
   * Requests run one at a time, in order, and `run` is only ever called once the previous undo has
   * committed - so `run` (the screen's own revert of the TOP entry, read live - the undo stack and
   * board through refs, never the render closure, since several undos can run between two renders)
   * never races another revert's measurement.
   *
   * The first undo waits for every flight in the air to land, as undo always has. From then on
   * nothing but an undo can start a flight (undoBusyRef), so an undo whose gate is
   * `{ takesFrom }` starts while the undos before it are still flying, once nothing is landing on
   * any of its piles - a hold on Undo streams the cards back like the auto-play streams them up.
   * `gate`/`run` are the latest ones passed (each call replaces them). */
  runUndo(gate: () => UndoGate, run: () => unknown, opts?: UndoRequestOptions): Promise<boolean>
  /** Resets every piece of concurrency bookkeeping this hook owns (but NOT `state` itself - call
   * commitState/set state separately) - call from a fresh deal/restore, alongside resetting
   * whatever other per-game refs (pendingFlightRef, dealTokenRef, ...) that screen owns on its own. */
  reset(): void
}

/**
 * Owns the concurrency bookkeeping every game screen needs once its card flights can run
 * independently instead of being serialized behind a single busy-gate - see Klondike's own history
 * for the shape this was extracted from (git log), and PATTERN_OVERLAP_GATE for the invariant this
 * exists to protect: undo needs mutual exclusion with everything that is not an undo (see runUndo:
 * undos overlap each other's flights, never a forward move's), but everything else (tap, drag,
 * auto-play, stock-draw) can safely run concurrently with each other, since each one's flight is
 * purely a cosmetic overlay on top of a board that already updated synchronously.
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
  // `flying` as of the last update, not the last render - what isLanding reads.
  const flyingRef = useRef<FlyingEntry[]>([])

  function updateFlying(update: (f: FlyingEntry[]) => FlyingEntry[]) {
    flyingRef.current = update(flyingRef.current)
    setFlying(flyingRef.current)
  }

  function beginFlying(to: PileRef, count: number): number {
    const id = ++flyingIdRef.current
    updateFlying((f) => [...f, { id, to, count }])
    return id
  }

  function endFlying(flyingId: number) {
    updateFlying((f) => f.filter((e) => e.id !== flyingId))
  }

  function shrinkFlying(flyingId: number) {
    updateFlying((f) => f.map((e) => (e.id === flyingId ? { ...e, count: Math.max(0, e.count - 1) } : e)))
  }

  function shrinkLanding(pile: PileRef, count: number) {
    updateFlying((f) => {
      let left = count
      const next = [...f]
      for (let i = next.length - 1; i >= 0 && left > 0; i--) {
        const e = next[i]
        if (e.count === 0 || e.to.zone !== pile.zone || e.to.index !== pile.index) continue
        const taken = Math.min(e.count, left)
        next[i] = { ...e, count: e.count - taken }
        left -= taken
      }
      return next
    })
  }

  function isLanding(pile: PileRef): boolean {
    return landingCount(pile) > 0
  }

  function landingCount(pile: PileRef): number {
    return flyingRef.current.reduce((sum, e) => (e.to.zone === pile.zone && e.to.index === pile.index ? sum + e.count : sum), 0)
  }

  const activeFlightCountRef = useRef(0)
  const [activeFlightCount, setActiveFlightCount] = useState(0)
  const undoBusyRef = useRef(false)

  // runUndo's bookkeeping. `undoStreakRef`: every flight in the air is an undo's - true once the count has been seen at 0 while an undo
  // held undoBusyRef (nothing else can start a flight from then on). `exclusiveUndoRef`: an 'exclusive' undo has started and its flights
  // have not all landed. `undoEpochRef` is bumped by reset() and on unmount, so a revert still awaiting its measurements when the game
  // was replaced can't touch the new game's queue.
  const undoQueueRef = useRef<UndoRequest[]>([])
  const undoRunningRef = useRef(false)
  const undoStreakRef = useRef(false)
  const exclusiveUndoRef = useRef(false)
  const latestUndoRef = useRef<{ gate: () => UndoGate; run: () => unknown } | null>(null)
  const undoPollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoEpochRef = useRef(0)

  function startFlights(n = 1) {
    activeFlightCountRef.current += n
    setActiveFlightCount(activeFlightCountRef.current)
  }

  function settleFlight() {
    activeFlightCountRef.current = Math.max(0, activeFlightCountRef.current - 1)
    setActiveFlightCount(activeFlightCountRef.current)
    if (activeFlightCountRef.current === 0) {
      if (!undoRunningRef.current) exclusiveUndoRef.current = false
      releaseUndoIfIdle()
    }
  }

  // Lets go of undoBusyRef once no undo is waiting or running and none of the undos' flights is still in the air. A request that gave up
  // while other flights were landing (no undo ever ran: not a streak) lets go at once - those flights were never the undo's.
  function releaseUndoIfIdle() {
    if (undoQueueRef.current.length > 0 || undoRunningRef.current) return
    if (activeFlightCountRef.current > 0 && undoStreakRef.current) return
    undoBusyRef.current = false
    undoStreakRef.current = false
    exclusiveUndoRef.current = false
  }

  function undoGateOpen(gate: Exclude<UndoGate, null>): boolean {
    if (gate === 'blocked') return false
    const settled = activeFlightCountRef.current === 0
    if (settled) undoStreakRef.current = true
    // The first undo waits for every other flight to land, as undo always has.
    if (!undoStreakRef.current) return false
    if (gate === 'exclusive' || exclusiveUndoRef.current) return settled
    return gate.takesFrom.every((pile) => !isLanding(pile))
  }

  function clearUndoPoll() {
    if (undoPollRef.current === null) return
    clearTimeout(undoPollRef.current)
    undoPollRef.current = null
  }

  function pumpUndo() {
    clearUndoPoll()
    const queue = undoQueueRef.current
    while (!undoRunningRef.current && queue.length > 0) {
      const request = queue[0]
      const latest = latestUndoRef.current
      const gate = latest ? latest.gate() : null
      if (!latest || gate === null) {
        queue.splice(0).forEach((r) => r.resolve(false))
        break
      }
      if (request.cancelled?.()) {
        queue.shift()
        request.resolve(false)
        continue
      }
      if (!undoGateOpen(gate)) {
        request.deadline ??= Date.now() + UNDO_MAX_WAIT_MS
        if (Date.now() < request.deadline) {
          undoPollRef.current = setTimeout(pumpUndo, UNDO_POLL_MS)
          return
        }
        queue.shift()
        request.resolve(false)
        continue
      }
      queue.shift()
      if (gate === 'exclusive') exclusiveUndoRef.current = true
      undoRunningRef.current = true
      const epoch = undoEpochRef.current
      // Called synchronously, as the undo handler always was - a revert that needs no measurement commits inside this very call.
      let done: Promise<unknown>
      try {
        done = Promise.resolve(latest.run())
      } catch (error) {
        done = Promise.reject(error)
      }
      done.then(
        () => finishUndo(epoch, () => request.resolve(true)),
        (error) => finishUndo(epoch, () => request.reject(error))
      )
    }
    releaseUndoIfIdle()
  }

  function finishUndo(epoch: number, report: () => void) {
    if (undoEpochRef.current === epoch) {
      undoRunningRef.current = false
      if (activeFlightCountRef.current === 0) exclusiveUndoRef.current = false
    }
    report()
    if (undoEpochRef.current === epoch) pumpUndo()
  }

  function runUndo(gate: () => UndoGate, run: () => unknown, opts?: UndoRequestOptions): Promise<boolean> {
    latestUndoRef.current = { gate, run }
    if (!undoRunningRef.current && undoQueueRef.current.length === 0 && gate() === null) return Promise.resolve(false)
    // A press handler may hand its event in as `opts` - only a real `cancelled` function counts.
    const cancelled = typeof opts?.cancelled === 'function' ? opts.cancelled : undefined
    return new Promise<boolean>((resolve, reject) => {
      undoQueueRef.current.push({ resolve, reject, cancelled, deadline: null })
      // Held from the request on, not just once the revert starts: nothing new may start flying while the undo waits for the board to
      // settle, or a steady stream (an auto-play running) could keep it waiting until it gives up.
      undoBusyRef.current = true
      pumpUndo()
    })
  }

  // Drops every waiting request (refused) and forgets a running one, without touching undoBusyRef - reset() and unmount do the rest.
  function abandonUndos() {
    undoEpochRef.current += 1
    clearUndoPoll()
    undoQueueRef.current.splice(0).forEach((r) => r.resolve(false))
    undoRunningRef.current = false
    undoStreakRef.current = false
    exclusiveUndoRef.current = false
  }

  // Unmount: a request still waiting must not poll a screen that is gone.
  useEffect(
    () => () => {
      undoEpochRef.current += 1
      if (undoPollRef.current !== null) clearTimeout(undoPollRef.current)
      undoQueueRef.current.splice(0).forEach((r) => r.resolve(false))
    },
    []
  )

  function reset() {
    abandonUndos()
    undoBusyRef.current = false
    activeFlightCountRef.current = 0
    setActiveFlightCount(0)
    updateFlying(() => [])
  }

  return {
    state,
    stateRef,
    commitState,
    flying,
    beginFlying,
    endFlying,
    shrinkFlying,
    shrinkLanding,
    isLanding,
    landingCount,
    activeFlightCount,
    activeFlightCountRef,
    startFlights,
    settleFlight,
    undoBusyRef,
    runUndo,
    reset
  }
}
