import { CardBack, DecoratedCardBack, type TableColors } from '@tastic/cards'

import type { Settings } from '@/types'

import { MonogramCardBack } from './MonogramCardBack'

/** What the Monogram back shows until the player has a tag of their own: S for Solitaire. */
export const DEFAULT_MONOGRAM = 'S'

/** The Monogram back's letters: the player's tag (letters or one emoji), or S without one (a guest, or a profile with no tag yet). */
export function monogramFor(tag: string | undefined): string {
  const trimmed = tag?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : DEFAULT_MONOGRAM
}

interface CardBackArtProps {
  backStyle: Settings['cardBackStyle']
  colors: TableColors
  width: number
  height: number
  /** The selected player's tag. Only the Monogram back draws it (S without one). */
  tag?: string
  invertDarkModeColors?: boolean
}

/** One card back in the chosen style: the one place a style picks its art, for the board, Home's fan and the Settings previews. */
export function CardBackArt({ backStyle, colors, width, height, tag, invertDarkModeColors }: CardBackArtProps) {
  if (backStyle === 'monogram') return <MonogramCardBack colors={colors} width={width} height={height} monogram={monogramFor(tag)} invertDarkModeColors={invertDarkModeColors} />
  // The geometric back never carries the tag any more: that is the Monogram back's job.
  if (backStyle === 'geometric') return <CardBack colors={colors} width={width} height={height} invertDarkModeColors={invertDarkModeColors} />
  return <DecoratedCardBack style={backStyle} colors={colors} width={width} height={height} invertDarkModeColors={invertDarkModeColors} />
}
