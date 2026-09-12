import { CARD_ASPECT } from '@tastic/cards'
import { useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { GAME_CONTENT_BOTTOM_PADDING, GAME_CONTENT_TOP_PADDING } from '@/components/GameChrome'

// topRow's own marginBottom and tableauRow's own paddingBottom - identical across every game
// screen this hook is used from (Klondike/Yukon/FreeCell/Canfield/Golf), so budgeted here rather
// than threaded in as params. Update both places together if a screen's own styles ever diverge.
const TOP_ROW_MARGIN_BOTTOM = 16
const TABLEAU_ROW_PADDING_BOTTOM = 20

/**
 * Computes how tall a tableau column's card fan is allowed to grow before PileView starts
 * compressing it (see PileView's own `maxHeight` prop), from the real window height - the same
 * "derive from useWindowDimensions() instead of a fixed pixel constant" idiom card WIDTH already
 * uses (see cardWidthForRow()/computeContentBounds()), rather than a fixed per-game constant that
 * compresses a fan on a tall screen with plenty of room to spare.
 *
 * `floor` is each game's own previous fixed TABLEAU_MAX_HEIGHT value, kept as a lower bound so a
 * short/cramped screen never gets less generous than it did before - only a screen with real
 * headroom to spare gets more of it.
 *
 * topRow is exactly one card tall on every screen that calls this (confirmed across Klondike,
 * Yukon, FreeCell, Canfield, Golf), so its height is derived from `cardWidth` via CARD_ASPECT
 * (same pattern PyramidScreen already uses for its own analytic layout) rather than measured live
 * - avoiding the onLayout-vs-mount-commit race the deal animation elsewhere in this app had to
 * work around for a very different reason (see this app's CLAUDE.md).
 */
export function useTableauMaxHeight(cardWidth: number, floor: number): number {
  const { height: winHeight } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const topRowHeight = cardWidth / CARD_ASPECT
  const available = winHeight - insets.top - insets.bottom - GAME_CONTENT_TOP_PADDING - GAME_CONTENT_BOTTOM_PADDING - topRowHeight - TOP_ROW_MARGIN_BOTTOM - TABLEAU_ROW_PADDING_BOTTOM
  return Math.max(floor, available)
}
