import { useState } from 'react'

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
  // React's own sanctioned "adjust state during render" shape (see react.dev's guide of the same
  // name) rather than mutating a ref during render - each setter below is only ever called when
  // the value it tracks has actually changed, so this settles within the same render pass instead
  // of triggering a visible extra frame.
  const [prevHidden, setPrevHidden] = useState(hidden)
  const [prevValue, setPrevValue] = useState(value)
  const [frozen, setFrozen] = useState(value)

  if (hidden !== prevHidden) {
    setPrevHidden(hidden)
    // Freezes `prevValue` (last render's value, still whatever was visible a moment ago), not
    // this render's `value` - hidden can flip true the same commit `value` already changed to
    // the incoming card, and it's the outgoing one that should stay on screen during the flight.
    if (hidden) setFrozen(prevValue)
  }
  if (value !== prevValue) {
    setPrevValue(value)
  }

  return hidden ? frozen : value
}
