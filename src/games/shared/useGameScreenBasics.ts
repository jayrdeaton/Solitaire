import { type TableColors } from '@tastic/cards'
import { useMemo } from 'react'

import { useDropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { useTableColors } from '@/components/theme'
import { useGameStats } from '@/stores/gameStats'
import { useLastActiveGame } from '@/stores/lastActiveGame'

/**
 * Bundles the hook prologue every game screen opens with - byte-identical across all four before
 * this extraction. `makeStyles` is each game's own module-level style-builder function (a stable
 * identity across renders), so including it in the useMemo deps below is safe and doesn't change
 * how often styles actually recompute.
 */
export function useGameScreenBasics<S>(makeStyles: (colors: TableColors) => S) {
  const colors = useTableColors()
  const { recordDealWon, recordDealAbandoned, recordHintUsed, recordUndoUsed } = useGameStats()
  const { setLastActiveGame, clearLastActiveGame } = useLastActiveGame()
  const styles = useMemo(() => makeStyles(colors), [colors, makeStyles])
  const dropZones = useDropZoneRegistry()
  return { styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, recordUndoUsed, setLastActiveGame, clearLastActiveGame }
}
