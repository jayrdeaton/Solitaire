import { MutableRefObject, useCallback, useRef, useState } from 'react'

export type SetUndoStack<E> = (next: E[] | ((stack: E[]) => E[])) => void

/**
 * A screen's undo stack, plus a ref that always holds its latest value - updated in the same synchronous tick as every change, the
 * way useFlightConcurrency's commitState keeps stateRef. Undos can now run back to back, between two renders (see runUndo), so each
 * revert has to read the entry the previous one left on top, not the one the render closure saw.
 *
 * Every change must go through the returned setter (an updater is applied to the ref's value, which is always the latest).
 */
export function useUndoStack<E>(): [E[], SetUndoStack<E>, MutableRefObject<E[]>] {
  const [stack, setStack] = useState<E[]>([])
  const stackRef = useRef<E[]>(stack)
  // Stable, like a useState setter: it only touches the ref and React's own setter.
  const set = useCallback<SetUndoStack<E>>((next) => {
    stackRef.current = typeof next === 'function' ? next(stackRef.current) : next
    setStack(stackRef.current)
  }, [])
  return [stack, set, stackRef]
}
