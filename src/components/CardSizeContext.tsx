import React, { createContext, useContext, useMemo } from 'react'

import { CARD_HEIGHT, CARD_WIDTH } from './theme'

/** Width/height ratio every card is drawn at, regardless of the pixel size it's rendered at. */
export const CARD_ASPECT = CARD_WIDTH / CARD_HEIGHT

/** Vertical fan offsets as a fraction of card height - shared by PileView's own fan layout and by
 * screens computing a ghost's offsetStep for an animated multi-card tap-to-move, so a flying run's
 * internal card spacing matches what it'll look like once it lands and PileView takes over. */
export const FACE_UP_OFFSET_RATIO = 0.26
export const FACE_DOWN_OFFSET_RATIO = 0.13

export interface CardSize {
  width: number
  height: number
}

const DEFAULT_SIZE: CardSize = { width: CARD_WIDTH, height: CARD_HEIGHT }

const CardSizeContext = createContext<CardSize>(DEFAULT_SIZE)

/** Current card pixel size - PlayingCard/PileView read this instead of the static theme constants
 * so a screen can size cards to fill its available width. Falls back to the theme's baseline size
 * outside any CardSizeProvider (e.g. in tests). */
export function useCardSize(): CardSize {
  return useContext(CardSizeContext)
}

/** Wrap a screen (or the part of it with a fixed column count) to size every card within it off a
 * single `width`, keeping the aspect ratio - height is always derived, never set independently. */
export function CardSizeProvider({ width, children }: { width: number; children: React.ReactNode }) {
  const size = useMemo<CardSize>(() => ({ width, height: width / CARD_ASPECT }), [width])
  return <CardSizeContext.Provider value={size}>{children}</CardSizeContext.Provider>
}

/**
 * Card width that fills a row of `columns` piles spaced `gap` apart within `availableWidth`,
 * clamped to a sane range - this is what makes pile rows fill the full width and scale together
 * instead of overflowing into horizontal scroll or wrapping to a second row.
 */
export function cardWidthForRow(availableWidth: number, columns: number, gap: number, opts?: { min?: number; max?: number }): number {
  const min = opts?.min ?? 28
  const max = opts?.max ?? 96
  const raw = (availableWidth - gap * Math.max(0, columns - 1)) / Math.max(1, columns)
  if (!Number.isFinite(raw)) return min
  return Math.max(min, Math.min(max, raw))
}
