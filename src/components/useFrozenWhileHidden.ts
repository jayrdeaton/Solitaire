import { useRef } from 'react'

/**
 * Returns `value`, except while `hidden` is true - then it keeps returning whatever `value` was
 * the instant before `hidden` became true, rather than whatever `value` has already become.
 *
 * For a single-card destination slot (foundation, freecell, waste), the slot's whole displayed
 * content flips to the just-arrived card in the same commit the move applies (game state and the
 * screen-level "flying" flag update together) - hiding that new value via opacity leaves the slot
 * showing nothing for the whole flight, instead of the previous card (or its empty-slot
 * placeholder) staying visible until the incoming ghost actually lands on it. A tableau pile
 * doesn't need this: earlier cards stay mounted and visible regardless of a new arrival (see
 * PileView's hiddenCount) - only the new card itself is ever hidden, so there's no "previous
 * single value" to lose track of.
 */
export function useFrozenWhileHidden<T>(value: T, hidden: boolean): T {
  const wasHiddenRef = useRef(false)
  const lastVisibleRef = useRef(value)
  const frozenRef = useRef(value)

  if (!hidden) {
    lastVisibleRef.current = value
  } else if (!wasHiddenRef.current) {
    frozenRef.current = lastVisibleRef.current
  }
  wasHiddenRef.current = hidden

  return hidden ? frozenRef.current : value
}
