import { faceUpFanOffset, type TableColors, useCardSize } from '@tastic/cards'
import React, { RefObject } from 'react'
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native'

import { Card } from '@/engine/types'

import { DraggableCard } from './dragdrop/DraggableCard'
import { DropZone } from './dragdrop/DropZone'
import { DropZoneRegistry } from './dragdrop/DropZoneRegistry'
import { EmptySlot, PlayingCard } from './PlayingCard'
import { useTableColors } from './theme'
import { useFrozenWhileHidden } from './useFrozenWhileHidden'

// Stable empty-array default for wasteBehind, so callers that never pass it (Pyramid, draw-1) get
// a consistent, referentially-stable [] rather than a fresh literal on every render.
const EMPTY_WASTE_BEHIND: Card[] = []

// Plain (theme-independent) style, same idiom as FoundationCell's HIDDEN_CARD_STYLE - StockWaste is
// a module-level component too, so it can't reach a caller's own theme-derived `styles`.
const HIDDEN_STOCK_STYLE = { opacity: 0 }

interface StockWasteProps {
  dropZones: DropZoneRegistry
  /** Real top-of-stock card, or undefined when the stock is empty. Rendered face-down regardless of its own faceUp flag. */
  stockTopCard: Card | undefined
  /** Real top-of-waste card, or undefined when the waste is empty. */
  wasteTop: Card | undefined
  /** Additional waste cards fanned out behind wasteTop, purely decorative - never draggable or
   * tappable, never registered in CardRegistry. Ordered nearest-to-top first (index 0 is the card
   * directly under wasteTop). Klondike's draw-3 mode passes the previous 2 drawn cards here so all
   * 3 stay visible, overlapping, matching how a real draw-3 waste fans out; every other draw
   * mode/game omits it, which keeps the single fully-covered slot this component has always
   * rendered. */
  wasteBehind?: Card[]
  onDrawStock: () => void
  /** Lazy measure function - see DraggableCard.tsx's onPress doc comment for why (this is a
   * straight pass-through to that same prop). */
  onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void
  onWasteDrop: (absoluteX: number, absoluteY: number) => Promise<boolean> | boolean
  wasteSelected?: boolean
  /** Highlight the waste top / stock pile as the Hint feature's suggested source/destination - see
   * PlayingCard's own `hinted` prop. `stockHinted` covers both the stock pile card itself and its
   * empty/recycle slot. */
  wasteHinted?: boolean
  stockHinted?: boolean
  /** How many of the frontmost fan slots - 0 = wasteTop, 1 = wasteBehind[0], 2 = wasteBehind[1] -
   * are currently mid-flight in a screen-level ghost/deal layer: that slot's real card stays
   * registered (so the flight can measure exactly where it landed) but invisible, showing
   * whatever was in that same SLOT before instead (see the frozen overlays below), so the pile
   * doesn't go blank - or jump straight to the new card early - for the whole flight. A single
   * tap-to-move/undo/draw-1 flight is wasteHiddenCount=1 (just wasteTop); a draw-3 deal-style
   * flight starts at 3 and counts down to 0 as each of its 3 ghosts lands, farthest-from-top
   * first - see KlondikeScreen's handleDrawStock. */
  wasteHiddenCount?: number
  /** Bumped (to any new value) to play the waste card's "nowhere to go" shake - see
   * shakeAnimation.ts and each screen's handleCardTap. */
  wasteShakeToken?: number
  cardWidth?: number
  style?: StyleProp<ViewStyle>
  /** Ref to the stock pile's wrapping View, for measuring its screen position as the deal
   * animation's flight origin (see components/dealing/DealLayer.tsx) - the stock card itself isn't
   * registered in CardRegistry the way draggable cards are. */
  stockRef?: RefObject<View | null>
  /** Ref to the waste slot's wrapping View, for measuring its screen position as a deal-style
   * flight's shared origin/destination (e.g. a stock recycle, which moves the whole waste pile back
   * to stock at once) - the waste area itself isn't a single registrable card the way wasteTop is,
   * since a recycle can move more cards than are ever individually rendered (see wasteBehind's
   * "only 2 decorative slots" cap above). */
  wasteRef?: RefObject<View | null>
  /** True while the stock slot's own real content (card or empty/recycle placeholder) is mid-flight
   * elsewhere and should stay invisible, showing whatever it displayed a moment before instead - the
   * same "freeze the outgoing look, don't reveal the incoming one early" treatment wasteTop already
   * gets via topHidden/frozenWasteTop above. Needed for e.g. undoing a stock draw that had just
   * emptied the stock (recycle-hint placeholder) back to a real card: without this, the placeholder
   * would flip to a solid card the instant state reverts, a beat before the undo ghost actually
   * lands there. */
  stockHidden?: boolean
}

/** Stock (face-down, draw) + waste (face-up, top card) pair, shared by every game that deals from
 * a stock pile. Waste sits first so the card players are about to act on lands next to the tableau,
 * with the draw pile as the secondary action beside it. When the stock runs out but the waste still
 * has cards, an empty stock slot shows a recycle hint - every game here allows unlimited recycling. */
export function StockWaste({ dropZones, stockTopCard, wasteTop, wasteBehind = EMPTY_WASTE_BEHIND, onDrawStock, onWastePress, onWasteDrop, wasteSelected, wasteHinted, stockHinted, wasteHiddenCount = 0, wasteShakeToken, cardWidth, style, stockRef, wasteRef, stockHidden = false }: StockWasteProps) {
  const colors = useTableColors()
  const styles = React.useMemo(() => makeStyles(colors), [colors])
  const wasteHasCards = !!wasteTop
  // Only 2 behind slots are ever supported (draw-3's max) - fixed, unconditional hook calls per
  // slot rather than a `.map()` over wasteBehind, since each slot needs its own independent
  // freeze (see below) and the rules of hooks forbid calling a variable number of hooks.
  const behind1 = wasteBehind[0]
  const behind2 = wasteBehind[1]
  const topHidden = wasteHiddenCount > 0
  const behind1Hidden = wasteHiddenCount > 1
  const behind2Hidden = wasteHiddenCount > 2
  // Each slot freezes independently, to whatever card last occupied THAT slot - a draw-3 deal-style
  // flight reveals its 3 ghosts one at a time, farthest-from-top first (see KlondikeScreen's
  // handleDrawStock), so by the time e.g. wasteTop itself finally reveals, the two behind slots may
  // already be showing their own new cards - a single freeze covering the whole fan as one unit
  // would either hold ALL 3 back until the last ghost lands (killing the staggered reveal) or, if
  // it only covered wasteTop, show the NEW state's behind cards a beat before their own ghosts
  // actually arrive.
  const frozenWasteTop = useFrozenWhileHidden(wasteTop, topHidden)
  const frozenBehind1 = useFrozenWhileHidden(behind1, behind1Hidden)
  const frozenBehind2 = useFrozenWhileHidden(behind2, behind2Hidden)
  const frozenStockTopCard = useFrozenWhileHidden(stockTopCard, stockHidden)
  // Reuses faceUpFanOffset's fraction, tuned to clear PileView's vertical corner-row content -
  // this deck's corner row (rank left, suit pip right - see CardFace's cornerRow) spans nearly the
  // full card width, so the same fraction leaves enough horizontal peek to read a covered card's
  // rank too.
  const { width: contextCardWidth } = useCardSize()
  const fanOffset = faceUpFanOffset(cardWidth ?? contextCardWidth)

  return (
    <View style={[styles.group, style]}>
      <View ref={wasteRef} collapsable={false} style={styles.wasteArea}>
        {frozenBehind2 && (
          <View style={[styles.wasteBehindCard, styles.wasteBehindFar, { left: -fanOffset * 2 }]} pointerEvents='none'>
            <PlayingCard card={frozenBehind2} />
          </View>
        )}
        {frozenBehind1 && (
          <View style={[styles.wasteBehindCard, styles.wasteBehindNear, { left: -fanOffset }]} pointerEvents='none'>
            <PlayingCard card={frozenBehind1} />
          </View>
        )}
        <DropZone registry={dropZones} pileRef={{ zone: 'waste', index: 0 }} style={[cardWidth ? { width: cardWidth } : undefined, styles.wasteTopZone]}>
          {wasteTop ? <DraggableCard card={wasteTop} selected={wasteSelected} hinted={wasteHinted} hidden={topHidden} shakeToken={wasteShakeToken} emptyFallback={<EmptySlot />} onPress={onWastePress} onDrop={onWasteDrop} testID='waste-top' /> : <EmptySlot hinted={wasteHinted} />}
          {topHidden && (
            <View style={StyleSheet.absoluteFill} pointerEvents='none'>
              {frozenWasteTop ? <PlayingCard card={frozenWasteTop} /> : <EmptySlot />}
            </View>
          )}
        </DropZone>
      </View>
      <View ref={stockRef} collapsable={false}>
        <View style={stockHidden ? HIDDEN_STOCK_STYLE : undefined}>
          {stockTopCard ? (
            <PlayingCard card={{ ...stockTopCard, faceUp: false }} hinted={stockHinted} onPress={onDrawStock} testID='stock-pile' />
          ) : (
            <EmptySlot onPress={onDrawStock} hinted={stockHinted} testID='stock-pile'>
              {wasteHasCards ? <Text style={styles.recycleIcon}>↺</Text> : null}
            </EmptySlot>
          )}
        </View>
        {stockHidden && (
          <View style={StyleSheet.absoluteFill} pointerEvents='none'>
            {frozenStockTopCard ? <PlayingCard card={{ ...frozenStockTopCard, faceUp: false }} /> : <EmptySlot>{wasteHasCards ? <Text style={styles.recycleIcon}>↺</Text> : null}</EmptySlot>}
          </View>
        )}
      </View>
    </View>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    group: {
      flexDirection: 'row',
      gap: 10
    },
    recycleIcon: {
      color: colors.emptySlot,
      fontSize: 24
    },
    // position: 'relative' alone doesn't establish a stacking context in React Native (see
    // PileView's own container style for the same note) - the explicit zIndex here scopes
    // wasteBehindCard's/the DropZone's zIndex values to just this group, instead of leaking out
    // to compete with unrelated siblings elsewhere on screen (e.g. the drag/deal ghost layers).
    wasteArea: {
      position: 'relative',
      zIndex: 0
    },
    // Absolutely positioned so it doesn't add to wasteArea's own layout width - a draw-3 fan
    // spills left of the waste slot into the gap toward the foundations rather than pushing the
    // stock pile over.
    wasteBehindCard: {
      position: 'absolute',
      top: 0
    },
    // The farther-back of the two draw-3 behind slots (wasteBehind[1]) - beneath wasteBehindNear,
    // which itself sits beneath wasteTopZone (3).
    wasteBehindFar: {
      zIndex: 1
    },
    // The nearer of the two draw-3 behind slots (wasteBehind[0]) - above wasteBehindFar, still
    // beneath wasteTopZone (3).
    wasteBehindNear: {
      zIndex: 2
    },
    // Always above both wasteBehindCard slots (zIndex 1 and 2 above) - wasteTop is always the
    // frontmost, fully-visible card regardless of wasteHiddenCount.
    wasteTopZone: {
      zIndex: 3
    }
  })
}
