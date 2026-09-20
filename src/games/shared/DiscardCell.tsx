import { RefObject } from 'react'
import { StyleSheet, View } from 'react-native'

import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { Card } from '@/engine/types'

import { HIDDEN_CARD_STYLE } from './FoundationCell'

/** A single discard pile's display - extracted from Pyramid once Aces Up needed the identical
 * shape (see games/shared's own doc comment on when a component graduates here). Cards removed
 * from play land here permanently and are always face-up and non-interactive (`disabled`, no
 * DropZone/onPress - each game's own tryMove already rejects any `to.zone` other than what it
 * actually supports, so this could never be a legal drop target anyway). While `isFlyingHere`,
 * the real (already-updated) top card is hidden and a frozen copy of whatever was on top before
 * is shown instead - same reasoning as FoundationCell - so the pile doesn't flash to its new top
 * card before the ghost visually lands. Unlike FoundationCell, this measures its position via a
 * plain view ref (viewRef, passed a stable ref from the caller), not per-card CardRegistry
 * registration - there's only ever one discard pile, not a slot whose occupant identity keeps
 * changing. */
interface DiscardCellProps {
  card: Card | undefined
  isFlyingHere: boolean
  viewRef: RefObject<View | null>
  /** What to show under the incoming ghost(s) while `isFlyingHere`: the top card that has already
   * LANDED (`null` = the empty slot) - the same optional prop FoundationCell has, for the same
   * reason. Omit it (Aces Up, which only ever has one card in the air) to use the frozen copy of
   * whatever was on top before the flight began; that copy goes stale once flights to the pile
   * OVERLAP (`isFlyingHere` never drops in between, so it is never refreshed) and every ghost that
   * lands vanishes onto a pile still showing the card from before the whole stream. The caller
   * works out what has landed (Pyramid: the topmost discard card that is not still in the air). */
  settledCard?: Card | null
}

export function DiscardCell({ card, isFlyingHere, viewRef, settledCard }: DiscardCellProps) {
  const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
  const frozen = settledCard === undefined ? frozenCopy : settledCard
  return (
    <View ref={viewRef} collapsable={false}>
      {card ? <PlayingCard card={card} disabled style={isFlyingHere && HIDDEN_CARD_STYLE} testID='discard-top' /> : <EmptySlot testID='discard-empty' />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {frozen ? <PlayingCard card={frozen} disabled /> : <EmptySlot />}
        </View>
      )}
    </View>
  )
}
