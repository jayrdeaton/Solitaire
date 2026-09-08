import { MutableRefObject, useEffect, useRef } from 'react'

/**
 * Generalizes the deal-commit race-condition guard documented in this repo's own CLAUDE.md:
 * CardRegistry.measure()/measureView() must never be called synchronously right after the
 * setState that mounts what they're measuring, because that races the still-mounted PREVIOUS
 * deal's cards against the NEW deal's not-yet-run registration effects (confirmed live: 25/28
 * destinations came back null). Deferring to a useEffect keyed on [state] fixes it - React fires
 * effects bottom-up per commit (children's before parents'), so by the time THIS hook's own
 * [state]-effect runs, every child for that same commit has already registered.
 *
 * `schedule(token)` must be called SYNCHRONOUSLY, in the same tick as the setState that starts the
 * deal, passing the freshly-bumped value of the SAME generation ref (`genRef`) the caller already
 * maintains for its own other purposes (e.g. Klondike's `dealTokenRef`). Once `state` actually
 * commits, `runDeal(state, token)` fires - but ONLY if `genRef.current` still equals `token`, i.e.
 * nothing else (a later New Game, or a restoreGame) bumped `genRef` again in the meantime.
 * `runDeal` itself is still independently responsible for its OWN post-await re-check against
 * `genRef` (see e.g. runDeal's own `dealTokenRef.current !== token` check after its own `await`) -
 * this hook only ever guards the "should this even start" decision made at commit time, never the
 * "is this still valid once my own async measurement resolves" one made later, since only
 * `runDeal`'s own body knows when that later moment is.
 */
export function useDeferredDeal<TState>(state: TState | null, genRef: MutableRefObject<number>, runDeal: (state: TState, token: number) => void): (token: number) => void {
  const pendingRef = useRef<number | null>(null)

  useEffect(() => {
    if (pendingRef.current === null || pendingRef.current !== genRef.current || !state) return
    const token = pendingRef.current
    pendingRef.current = null
    runDeal(state, token)
    // deliberately depends on `runDeal`'s identity too (not just [state]) - if the enclosing
    // component re-renders with a new `runDeal` closure before this fires, we want THAT render's
    // closure, matching what a hand-inlined effect (closing over `runDeal` directly) would already
    // do. Harmless when `runDeal` changes identity on an unrelated re-render after this has
    // already fired once for this state, since `pendingRef.current` is already null by then.
  }, [state, genRef, runDeal])

  return (token: number) => {
    pendingRef.current = token
  }
}
