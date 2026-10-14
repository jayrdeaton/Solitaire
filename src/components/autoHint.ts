import { useIsFocused } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'

/** What a screen's Hint handler is told about who asked for it. */
export interface HintRequest {
  /** The Auto Hint setting fired it, not the player: it only rings the cards (no glide), and says nothing if there's no move (no toast). */
  auto?: boolean
}

export type HintHandler = (request?: HintRequest) => void

interface AutoHintOptions {
  /** The Auto Hint setting: seconds of no move before a hint shows by itself, 0 for never. */
  seconds: number
  /** The board: any change (a move, an auto-played card, an undo, a new deal) starts the wait over. */
  boardKey: unknown
  /** Nothing to hint (won, or a dead board) or a dialog is open over the board. */
  paused: boolean
  /** A hint is already on the board: nothing to add until the board changes. */
  hintShowing: boolean
  onHint: HintHandler
}

/** Anything but the background (or iOS's brief 'inactive', e.g. Control Center pulled down): an unknown state at launch counts as foreground. */
function isForeground(state: string | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive'
}

/**
 * The Auto Hint setting: once the board has sat unchanged for `seconds`, asks for a hint exactly as the Hint button does
 * (it counts as one). At most once per board: if there was nothing to suggest, it waits for the next change rather than
 * asking again every `seconds`. The wait starts over whenever it is held back (paused, the screen covered, the app in
 * the background), so a hint never appears the instant the player comes back.
 */
export function useAutoHint({ seconds, boardKey, paused, hintShowing, onHint }: AutoHintOptions) {
  const focused = useIsFocused()
  const [active, setActive] = useState(isForeground(AppState.currentState))
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setActive(isForeground(next)))
    return () => subscription.remove()
  }, [])

  const onHintRef = useRef(onHint)
  useEffect(() => {
    onHintRef.current = onHint
  })
  const firedForRef = useRef<{ key: unknown } | null>(null)

  useEffect(() => {
    if (seconds <= 0 || paused || hintShowing || !focused || !active) return
    if (firedForRef.current && firedForRef.current.key === boardKey) return
    const timer = setTimeout(() => {
      firedForRef.current = { key: boardKey }
      onHintRef.current({ auto: true })
    }, seconds * 1000)
    return () => clearTimeout(timer)
  }, [seconds, boardKey, paused, hintShowing, focused, active])
}
