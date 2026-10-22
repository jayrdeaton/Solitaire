import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Platform } from 'react-native'

export interface GameSession {
  moves: number
  started: boolean
  registerMove: () => number
  reset: () => void
  stopClock: () => void
  restore: (moves: number, elapsedSeconds: number) => void
  /** Live elapsed seconds, computed on demand from wall-clock time rather than a per-second-ticked
   * state value - safe to call from a save/win effect, or from GameChrome's own once-a-second
   * timer-text tick, without ever forcing this hook's own screen to re-render. Stable identity
   * across renders (no deps), so passing it straight through as a prop never invalidates a
   * memoized/effect-deps consumer. */
  getElapsed: () => number
  /** The synchronously up-to-date move count (what `registerMove` returns), for code that runs after an await and so
   * can't trust the `moves` its render closed over. Stable identity, like getElapsed. */
  getMoves: () => number
  /** Holds the clock (or releases it) for one reason; it runs only while no reason holds it. GameChrome passes
   * 'dialog' while Rules or Settings is open. Stable identity. */
  setPaused: (reason: string, paused: boolean) => void
}

/** Tracks a single deal's elapsed time and move count, and gates the clock so it only starts on
 * the player's first real move rather than the instant a deal is dealt. `registerMove` is the one
 * chokepoint every game screen calls after a `tryMove`/`drawStock` succeeds - it doubles as "count
 * this move" and "start the clock if this is the first one", since those are the same event.
 *
 * Elapsed time is deliberately NOT React state that ticks once a second - an earlier version of
 * this hook did exactly that (`setInterval(() => setElapsed(e => e + 1), 1000)`), which meant every
 * game screen mounting this hook re-rendered its ENTIRE tree - every pile, every card - once a
 * second for as long as a deal was in progress, and (worse) re-ran each screen's save-in-progress
 * effect once a second too, JSON-serializing the full board state + undo stack and writing it to
 * AsyncStorage the entire time the player was playing - confirmed as a real cause of the app
 * feeling laggy/glitchy on-device, landing exactly while dragging cards around, since that's
 * exactly when a deal is "in progress." Wall-clock-based elapsed needs no ticking to stay accurate:
 * `getElapsed()` computes the true current value on demand from `Date.now()`, so nothing has to
 * re-render just to keep it fresh. A save stores the elapsed time AT THAT SAVE, so the screen also
 * saves afresh the moment it is left or the app is backgrounded (see useSaveInProgressBackstop). The only remaining once-a-second tick lives
 * inside GameChrome's own small timer-text display (see GameChrome.tsx), which calls `getElapsed()`
 * on its own local interval instead of receiving an ever-changing prop.
 */
export function useGameSession(): GameSession {
  const [moves, setMoves] = useState(0)
  const [started, setStarted] = useState(false)
  const movesRef = useRef(0)
  const startedRef = useRef(false)
  // Wall-clock timestamp the clock last (re)started at, or null while stopped, paused or not yet started.
  const startedAtRef = useRef<number | null>(null)
  // Milliseconds banked from before the clock's current run: restore() seeds it, and stopClock() and
  // every background pause add the run that just ended. Kept in ms, not whole seconds, so a pause
  // never drops the part-second it lands in.
  const baseMsRef = useRef(0)
  // True while the clock would be running but something holds it (`holdsRef`).
  const pausedRef = useRef(false)
  // Why the clock is held: 'app' while the app isn't in the foreground, 'idle' from the app's return (or a resumed save)
  // until the next move, and whatever setPaused is given.
  const holdsRef = useRef(new Set<string>())

  const getElapsed = useCallback(() => {
    const runMs = startedAtRef.current === null ? 0 : Date.now() - startedAtRef.current
    return Math.floor((baseMsRef.current + runMs) / 1000)
  }, [])

  const getMoves = useCallback(() => movesRef.current, [])

  function bankRun() {
    if (startedAtRef.current !== null) baseMsRef.current += Date.now() - startedAtRef.current
    startedAtRef.current = null
  }

  // Starts (or restarts) a run, or parks it as paused if something holds the clock right now.
  function startRun() {
    if (holdsRef.current.size > 0) pausedRef.current = true
    else startedAtRef.current = Date.now()
  }

  const setPaused = useCallback((reason: string, paused: boolean) => {
    const holds = holdsRef.current
    if (paused) {
      holds.add(reason)
      if (startedAtRef.current === null) return
      baseMsRef.current += Date.now() - startedAtRef.current
      startedAtRef.current = null
      pausedRef.current = true
    } else {
      holds.delete(reason)
      if (holds.size > 0 || !pausedRef.current) return
      pausedRef.current = false
      startedAtRef.current = Date.now()
    }
  }, [])

  // The score counts seconds of PLAY: the clock pauses whenever the app leaves the foreground (a call, the app switcher,
  // the home screen, a locked phone) and on the web whenever the tab is hidden or the window loses focus. It picks up
  // again with the player's next move, not the moment they come back (a coworker of Jay's, 2026-10-22: it kept counting
  // while he got his bearings), the same as a new deal's clock waits for its first move. A killed app resumes from its
  // last save, which holds the time from when the app left the foreground.
  useEffect(() => {
    const leave = () => setPaused('app', true)
    const comeBack = () => {
      if (!holdsRef.current.has('app')) return
      holdsRef.current.add('idle')
      setPaused('app', false)
    }
    if (AppState.currentState === 'background' || AppState.currentState === 'inactive') leave()
    const sub = AppState.addEventListener('change', (next) => (next === 'active' ? comeBack() : leave()))
    if (Platform.OS !== 'web' || typeof window?.addEventListener !== 'function') return () => sub.remove()
    window.addEventListener('blur', leave)
    window.addEventListener('focus', comeBack)
    return () => {
      sub.remove()
      window.removeEventListener('blur', leave)
      window.removeEventListener('focus', comeBack)
    }
  }, [setPaused])

  function stopClock() {
    bankRun()
    pausedRef.current = false
  }

  function reset() {
    stopClock()
    startedRef.current = false
    movesRef.current = 0
    baseMsRef.current = 0
    setMoves(0)
    setStarted(false)
  }

  // Returns the synchronously up-to-date count: a caller that checks win state in the same tick
  // as the winning move would otherwise read a stale pre-increment `moves` state value (setMoves
  // is async) and undercount the winning move itself.
  function registerMove(): number {
    movesRef.current += 1
    setMoves(movesRef.current)
    if (holdsRef.current.has('idle')) setPaused('idle', false)
    if (!startedRef.current) {
      startedRef.current = true
      setStarted(true)
      startRun()
    }
    return movesRef.current
  }

  // Seeds a resumed deal's move count/timer (see stores/gameInProgress.ts). `started` mirrors
  // whatever registerMove()'s own first-move gate would have produced: a saved, still-untouched
  // fresh deal (savedMoves === 0) restores with the clock not yet ticking, exactly like a brand
  // new deal. A deal with real progress resumes started but held ('idle') until the next move, so the time it takes to
  // find your place again (after a relaunch, or coming back from Home) isn't counted either.
  function restore(savedMoves: number, savedElapsedSeconds: number) {
    movesRef.current = savedMoves
    setMoves(savedMoves)
    baseMsRef.current = savedElapsedSeconds * 1000
    pausedRef.current = false
    startedAtRef.current = null
    const alreadyStarted = savedMoves > 0
    startedRef.current = alreadyStarted
    setStarted(alreadyStarted)
    if (!alreadyStarted) return
    holdsRef.current.add('idle')
    startRun()
  }

  return { moves, started, registerMove, reset, stopClock, restore, getElapsed, getMoves, setPaused }
}
