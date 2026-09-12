import { useCallback, useRef, useState } from 'react'

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
 * re-render just to keep it fresh, and a save made at the last real move is never stale even if the
 * player just sits looking at the board afterward. The only remaining once-a-second tick lives
 * inside GameChrome's own small timer-text display (see GameChrome.tsx), which calls `getElapsed()`
 * on its own local interval instead of receiving an ever-changing prop.
 */
export function useGameSession(): GameSession {
  const [moves, setMoves] = useState(0)
  const [started, setStarted] = useState(false)
  const movesRef = useRef(0)
  const startedRef = useRef(false)
  // Wall-clock timestamp the clock last (re)started at, or null while stopped/not yet started.
  const startedAtRef = useRef<number | null>(null)
  // Elapsed seconds banked from before the clock's current run - only changes via restore()
  // (seeding a resumed deal) or stopClock() (freezing the final value once a deal is won).
  const baseElapsedRef = useRef(0)

  const getElapsed = useCallback(() => {
    if (startedAtRef.current === null) return baseElapsedRef.current
    return baseElapsedRef.current + Math.floor((Date.now() - startedAtRef.current) / 1000)
  }, [])

  function stopClock() {
    baseElapsedRef.current = getElapsed()
    startedAtRef.current = null
  }

  function reset() {
    stopClock()
    startedRef.current = false
    movesRef.current = 0
    baseElapsedRef.current = 0
    setMoves(0)
    setStarted(false)
  }

  // Returns the synchronously up-to-date count: a caller that checks win state in the same tick
  // as the winning move would otherwise read a stale pre-increment `moves` state value (setMoves
  // is async) and undercount the winning move itself.
  function registerMove(): number {
    movesRef.current += 1
    setMoves(movesRef.current)
    if (!startedRef.current) {
      startedRef.current = true
      setStarted(true)
      startedAtRef.current = Date.now()
    }
    return movesRef.current
  }

  // Seeds a resumed deal's move count/timer (see stores/gameInProgress.ts). `started` mirrors
  // whatever registerMove()'s own first-move gate would have produced: a saved, still-untouched
  // fresh deal (savedMoves === 0) restores with the clock not yet ticking, exactly like a brand
  // new deal - only a deal with real progress resumes with the clock already running.
  function restore(savedMoves: number, savedElapsedSeconds: number) {
    movesRef.current = savedMoves
    setMoves(savedMoves)
    baseElapsedRef.current = savedElapsedSeconds
    const alreadyStarted = savedMoves > 0
    startedRef.current = alreadyStarted
    setStarted(alreadyStarted)
    startedAtRef.current = alreadyStarted ? Date.now() : null
  }

  return { moves, started, registerMove, reset, stopClock, restore, getElapsed }
}
