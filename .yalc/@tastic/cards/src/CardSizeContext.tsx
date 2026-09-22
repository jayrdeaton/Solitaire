import React, { createContext, useContext, useMemo } from 'react'

/** Width/height ratio a card is drawn at when a CardSizeProvider doesn't override it via its own
 * `aspectRatio` prop - Solitaire's own standard-deck proportions (64/93), baked in as a plain
 * literal here since this package owns no theme.ts of its own to derive CARD_WIDTH/CARD_HEIGHT
 * from. A consuming app with different card proportions (e.g. a taller tarot-style deck) passes its
 * own `aspectRatio` to CardSizeProvider instead of relying on this default. */
export const CARD_ASPECT = 64 / 93

export interface CardSize {
  width: number
  height: number
}

const DEFAULT_SIZE: CardSize = { width: 64, height: 93 }

const CardSizeContext = createContext<CardSize>(DEFAULT_SIZE)

/** Current card pixel size - card components read this instead of a fixed baseline so a screen can
 * size cards to fill its available width. Falls back to DEFAULT_SIZE outside any CardSizeProvider
 * (e.g. in tests). */
export function useCardSize(): CardSize {
  return useContext(CardSizeContext)
}

interface CardSizeProviderProps {
  width: number
  /** Keeps this ratio between width/height when deriving height from `width` - defaults to
   * CARD_ASPECT (Solitaire's own standard-deck proportions). Pass a different ratio for a
   * differently-proportioned card set. */
  aspectRatio?: number
  children: React.ReactNode
}

/** Wrap a screen (or the part of it with a fixed column count) to size every card within it off a
 * single `width`, keeping `aspectRatio` - height is always derived, never set independently. */
export function CardSizeProvider({ width, aspectRatio = CARD_ASPECT, children }: CardSizeProviderProps) {
  const size = useMemo<CardSize>(() => ({ width, height: width / aspectRatio }), [width, aspectRatio])
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
