import { useEffect, useId } from 'react'

/**
 * A way for a gesture worklet to call back into a component without pinning that component in memory forever.
 *
 * `runOnJS(fn)` inside a worklet makes react-native-worklets hold `fn` from native code for as long as the worklet's
 * serialized copy lives, and Hermes treats that hold as a GC root. A drag gesture's worklets are serialized once and
 * cached for as long as the component holds its gesture, so when `fn` is one of the component's own callbacks, the
 * root keeps the callback, the callback's closure keeps the component (its gesture, its worklets, its fiber, and
 * through its animated ref, its native views), and that keeps the cached copy that holds the root. Nothing in the
 * loop is ever collected: every card a deal unmounted stayed in memory with its whole subtree (2026-10-18, measured in
 * a Debug build's heap snapshots: about 60 cards and 3.6MB of native views per New Game, with garbage-collection
 * pauses growing until a long session stuttered).
 *
 * So a worklet calls only `callWorkletCallback`, a module-level function with nothing of a component in its closure,
 * with the string key `useWorkletCallback` returns. The component registers its live callback under that key in an
 * effect and removes it on unmount, so all native code ever holds is this module's function.
 */
type Callback = (...args: number[]) => void

const callbacks = new Map<string, Callback>()

/** Call from a worklet as `runOnJS(callWorkletCallback)(key, ...args)`. A key whose component has unmounted is ignored. */
export function callWorkletCallback(key: string, ...args: number[]): void {
  callbacks.get(key)?.(...args)
}

/** Registers `callback` (keep it stable, e.g. a useCallback) for as long as the component is mounted and returns the key
 * a worklet passes to callWorkletCallback. Arguments are numbers only: worklet event values. */
export function useWorkletCallback(callback: Callback): string {
  const key = useId()
  useEffect(() => {
    callbacks.set(key, callback)
    return () => {
      if (callbacks.get(key) === callback) callbacks.delete(key)
    }
  }, [key, callback])
  return key
}
