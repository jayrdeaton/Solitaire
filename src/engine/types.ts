// Core card primitives, re-exported from @tastic/cards (extracted so a second app - Egyptian
// Ratscrew - can reuse the same card vocabulary/rendering layer). Kept as a re-export here rather
// than rewriting every one of this file's many importers across engine/, games/*, components/ to
// import from @tastic/cards directly.
export type { Card, Color, Rank, Suit } from '@tastic/cards'
export { cardColor, cloneCard, rankLabel, SUIT_SYMBOLS, SUITS } from '@tastic/cards'
