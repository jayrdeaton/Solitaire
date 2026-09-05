import { useEffect, useRef, useState } from 'react';

export interface GameSession {
  elapsed: number;
  moves: number;
  started: boolean;
  registerMove: () => number;
  reset: () => void;
  stopClock: () => void;
  restore: (moves: number, elapsedSeconds: number) => void;
}

/** Tracks a single deal's elapsed time and move count, and gates the clock so it only starts on
 * the player's first real move rather than the instant a deal is dealt. `registerMove` is the one
 * chokepoint every game screen calls after a `tryMove`/`drawStock` succeeds - it doubles as "count
 * this move" and "start the clock if this is the first one", since those are the same event. */
export function useGameSession(): GameSession {
  const [elapsed, setElapsed] = useState(0);
  const [moves, setMoves] = useState(0);
  const [started, setStarted] = useState(false);
  const movesRef = useRef(0);
  const startedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopClock() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function reset() {
    stopClock();
    startedRef.current = false;
    movesRef.current = 0;
    setElapsed(0);
    setMoves(0);
    setStarted(false);
  }

  // Returns the synchronously up-to-date count: a caller that checks win state in the same tick
  // as the winning move would otherwise read a stale pre-increment `moves` state value (setMoves
  // is async) and undercount the winning move itself.
  function registerMove(): number {
    movesRef.current += 1;
    setMoves(movesRef.current);
    if (!startedRef.current) {
      startedRef.current = true;
      setStarted(true);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    }
    return movesRef.current;
  }

  // Seeds a resumed deal's move count/timer (see stores/gameInProgress.ts). `started` mirrors
  // whatever registerMove()'s own first-move gate would have produced: a saved, still-untouched
  // fresh deal (savedMoves === 0) restores with the clock not yet ticking, exactly like a brand
  // new deal - only a deal with real progress resumes with the clock already running.
  function restore(savedMoves: number, savedElapsedSeconds: number) {
    stopClock();
    movesRef.current = savedMoves;
    setMoves(savedMoves);
    setElapsed(savedElapsedSeconds);
    const alreadyStarted = savedMoves > 0;
    startedRef.current = alreadyStarted;
    setStarted(alreadyStarted);
    if (alreadyStarted) timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }

  useEffect(() => stopClock, []);

  return { elapsed, moves, started, registerMove, reset, stopClock, restore };
}
