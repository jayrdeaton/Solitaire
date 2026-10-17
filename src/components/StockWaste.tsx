import { Pressable } from '@rific/feedback-press'
import { type TableColors, useCardSize } from '@tastic/cards'
import React, { RefObject } from 'react'
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native'

import { Card } from '@/engine/types'

import { CARD_GAP_MIN } from './cardLayout'
import { DraggableCard } from './dragdrop/DraggableCard'
import { DragFlightHandle } from './dragdrop/DragGhostLayer'
import { DropZone } from './dragdrop/DropZone'
import { DropZoneRegistry } from './dragdrop/DropZoneRegistry'
import { PileOverlay } from './PileOverlay'
import { EmptySlot, PlayingCard } from './PlayingCard'
import { STOCK_LONG_PRESS_MS, StockHandler, useStockHold } from './stockHold'
import { useTableColors } from './theme'
import { useFrozenWhileHidden } from './useFrozenWhileHidden'
import { useTakeOffHold } from './useTakeOffHold'
import { wasteFanStepFor } from './wasteFan'

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
  /** The waste card directly under wasteTop (undefined when there is none). Shown in the slot while wasteTop is lifted for
   * a drag, so the card that will be on top once it goes is in view meanwhile - unless the draw-3 fan already shows it
   * beside the slot (wasteBehind[0]). Omitted: the slot shows its empty outline under a lifted card. */
  wasteUnder?: Card
  /** One draw (or turn-over) per call - see StockHandler. Holding the stock calls it again and again (useStockHold) when the game's
   * stock turns over (`canRecycle`); a stock that runs out for good is never held - one hold would deal the whole of it. */
  onDrawStock: StockHandler
  /** Lazy measure function - see DraggableCard.tsx's onPress doc comment for why (this is a
   * straight pass-through to that same prop). */
  onWastePress: (measure: () => Promise<{ x: number; y: number }>) => void
  /** A straight pass-through to DraggableCard's onDrop: anchor the move on `dragged`, not on the waste's top at drop time
   * (an auto-play may have taken the dragged card meanwhile, and the card now on top would be moved instead). */
  onWasteDrop: (absoluteX: number, absoluteY: number, flight: DragFlightHandle, dragged: Card) => Promise<boolean> | boolean
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
  /** What the waste slot shows UNDER the flying card(s) while `wasteHiddenCount` > 0, when the caller knows better than the
   * frozen copy of "whatever was on top before the flights began": the top card that has already LANDED (`null` = the empty
   * slot) - the same optional prop DiscardCell/FoundationCell have, for the same reason. The frozen copy goes stale once draw
   * flights OVERLAP (a fast player taps the stock again before the last card landed: the hidden count never drops in between,
   * so it is never refreshed), and every ghost that lands vanishes onto the card from before the whole stream. Omit it (every
   * other caller, and any flight that is not a stream of draws) to keep the frozen copy. */
  settledWasteTop?: Card | null
  /** Bumped (to any new value) to play the waste card's "nowhere to go" shake - see
   * shakeAnimation.ts and each screen's handleCardTap. */
  wasteShakeToken?: number
  cardWidth?: number
  /** Overrides the stock/waste pair's own internal gap (defaults to CARD_GAP_MIN when omitted) -
   * pass a caller's own render-scoped `gap` (from cardLayoutForRow) so this pair's spacing keeps
   * breathing with the rest of that screen's rows even once cards hit CARD_WIDTH_MAX and the gap
   * grows past its floor. Canfield relies on this to keep its top-row width reservation pixel-exact
   * (see CanfieldScreen.tsx's own doc comment on TOP_ROW_UNITS) - every other caller may pass it too
   * for the same "whole screen breathes together" consistency, or omit it to keep the old fixed
   * CARD_GAP_MIN behavior. */
  gap?: number
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
  /** Whether a draw-3 fan may spread past the plain face-up strip so a covered card shows its whole rank (a '10' reaches ~0.51W,
   * the strip is 0.45W) - default true, which needs the fan to have clear room to its left. False keeps the strip, for a screen
   * whose fan has none: Canfield's runs over its reserve slot, so widening it would only bury the reserve card further. A caller
   * passing false must offset its own draw/undo flight ghosts by wasteFanStepFor(cardWidth, false), or they land off the fan. */
  widenFan?: boolean
  /** Whether an exhausted stock can be turned over again. False (Golf, TriPeaks, Forty Thieves: the stock runs out for good)
   * shows the empty stock as a plain slot, with no recycle arrow inviting a tap that can never do anything. */
  canRecycle?: boolean
}

/** Stock (face-down, draw) + waste (face-up, top card) pair, shared by every game that deals from
 * a stock pile. Waste sits first so the card players are about to act on lands next to the tableau,
 * with the draw pile as the secondary action beside it. When the stock runs out but the waste still
 * has cards, an empty stock slot shows a recycle hint - unless the game never recycles (`canRecycle`). */
export function StockWaste({ dropZones, stockTopCard, wasteTop, wasteBehind = EMPTY_WASTE_BEHIND, wasteUnder, onDrawStock, onWastePress, onWasteDrop, wasteSelected, wasteHinted, stockHinted, wasteHiddenCount = 0, settledWasteTop, wasteShakeToken, cardWidth, gap, style, stockRef, wasteRef, stockHidden = false, widenFan = true, canRecycle = true }: StockWasteProps) {
  const colors = useTableColors()
  const styles = React.useMemo(() => makeStyles(colors), [colors])
  const wasteHasCards = !!wasteTop
  const showRecycle = canRecycle && wasteHasCards
  // Only 2 behind slots are ever supported (draw-3's max) - fixed, unconditional hook calls per
  // slot rather than a `.map()` over wasteBehind, since each slot needs its own independent
  // freeze (see below) and the rules of hooks forbid calling a variable number of hooks.
  const behind1 = wasteBehind[0]
  const behind2 = wasteBehind[1]
  const topHidden = wasteHiddenCount > 0
  // The most cards hidden at once since the waste was last fully shown. A landing that has only ever hidden ONE card (a
  // draw-1 card onto a draw-3 fan - Klondike's last stock card, any Canfield draw that finds one card - or an undo sending a
  // card back to the waste) shifts the whole fan left by one under the incoming ghost: frozen top alone, the near slot would
  // already show that same outgoing top card - the card twice, for the whole flight. So such a landing freezes the whole fan,
  // which moves over when the card lands. A staggered draw-3 reveal (3 -> 2 -> 1) keeps its per-slot freezes below.
  const [hiddenPeak, setHiddenPeak] = React.useState(wasteHiddenCount)
  if (wasteHiddenCount === 0 ? hiddenPeak !== 0 : wasteHiddenCount > hiddenPeak) setHiddenPeak(wasteHiddenCount)
  const singleArrival = topHidden && Math.max(hiddenPeak, wasteHiddenCount) === 1
  const behind1Hidden = wasteHiddenCount > 1 || singleArrival
  const behind2Hidden = wasteHiddenCount > 2 || singleArrival
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
  const underTop = settledWasteTop === undefined ? frozenWasteTop : settledWasteTop
  // What the waste's overlay shows: the card under the incoming ghost(s) while one is landing, else the waste's own top
  // card (invisibly, so the overlay is already painted when a flight starts - see PileOverlay).
  const wasteUnderlay = topHidden ? underTop : wasteTop
  // Take-off hold: keeps drawing a card that has just left while its ghost is not on screen yet (useTakeOffHold).
  const { shown: wasteShown, holding: wasteHolding, revealing: wasteRevealing } = useTakeOffHold(wasteTop)
  // The overlay stands in for the real top card while a flight is landing here (not over a held card, which is still the
  // painted copy of the card that just left - an arriving flight must not hide it before its ghost shows), and while the
  // card a take-off uncovered is revealed (useTakeOffHold): the real card's Image has just been re-sourced from the
  // departed card, the overlay's has shown wasteTop all along.
  const wasteOverlayVisible = (topHidden && !wasteHolding) || wasteRevealing
  // What a drag uncovers when it lifts the top card: the card under it, drawn in the slot - or, when the draw-3 fan already
  // shows that card beside the slot, nothing more (a second copy would show it twice, and the empty outline would cross
  // its face).
  const fanShowsUnder = !!behind1
  // The stock too: a draw that empties it would otherwise show the empty slot while the drawn card's ghost is not on
  // screen yet - the card visible nowhere for a frame or two.
  const { shown: stockShown, holding: stockHolding } = useTakeOffHold(stockTopCard)
  // The stock's one touch target (see the stock below). A held stock deals card after card (useStockHold) - only where it turns over:
  // in Golf, TriPeaks and Forty Thieves one hold would deal the whole stock, which never comes back.
  const stockHold = useStockHold(onDrawStock)
  const stockPressable = !!stockShown || canRecycle
  const stockLabel = stockShown ? 'Draw' : 'Turn over'
  // Starts from faceUpFanOffset's fraction, tuned to clear PileView's VERTICAL corner-row strip, and
  // widens it where a HORIZONTAL fan needs more: a covered card shows only its left `fanOffset`
  // points, and the corner rank's ink (a '10' in particular) can reach past that strip - see
  // wasteFanStep. The draw-3 flights in Klondike/Canfield offset their ghosts by the same
  // wasteFanStepFor (with the same widenFan), so the two can't drift apart.
  const { width: contextCardWidth } = useCardSize()
  const fanOffset = wasteFanStepFor(cardWidth ?? contextCardWidth, widenFan)

  return (
    <View style={[styles.group, gap != null && { gap }, style]}>
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
          {/* A held card is inert: no drag (it has already left) and no tap either, even with a card under it. Passing the tap
          on to the real top (every caller's onWastePress acts on its own wasteTop) was tried: the held card still looks like
          the card that left, sitting where it was, so a second tap there is a repeat tap on THAT card - and in draw-1 the card
          it would send has never been seen - and the card it sent was drawn nowhere: not here (this slot draws the held
          card, then the card under both once that one's ghost shows), and not as its own ghost until that ghost painted. The
          tap is lost instead, for the frame or two until the held card's ghost shows. The stock below does pass a tap on:
          its cards are backs, all alike. */}
          {wasteShown ? <DraggableCard card={wasteShown} selected={wasteSelected && !wasteHolding} hinted={wasteHinted && !wasteHolding} hidden={wasteOverlayVisible} disabled={wasteHolding} registryId={wasteHolding ? (wasteTop?.id ?? null) : undefined} shakeToken={wasteHolding ? undefined : wasteShakeToken} underCard={fanShowsUnder ? null : wasteHolding ? wasteTop : wasteUnder} emptyFallback={fanShowsUnder ? null : <EmptySlot />} onPress={wasteHolding ? undefined : onWastePress} onDrop={wasteHolding ? undefined : onWasteDrop} testID='waste-top' /> : <EmptySlot hinted={wasteHinted} />}
          {/* Mounted (invisible) whenever there is a waste card, not just during a flight here - see PileOverlay. */}
          {(topHidden || wasteTop) && <PileOverlay visible={wasteOverlayVisible}>{wasteUnderlay ? <PlayingCard card={wasteUnderlay} disabled /> : <EmptySlot />}</PileOverlay>}
        </DropZone>
      </View>
      <View ref={stockRef} collapsable={false}>
        {/* ONE press target for the stock, whatever it draws: a back, the empty slot, the frozen look while cards fly into it, the
        card a draw has just taken off. It used to be the card's own press, then the empty slot's, and fast taps were lost (Jay's
        kids, speeding through the stock, 2026-10-16): a press that began on one and ended after the swap to the other went with
        the unmounted one; while the last card took off the tap was ignored; and while a turn-over flew in, iOS gave the stock NO
        taps at all, because the hidden stock is drawn at opacity 0 and React Native on iOS hit-tests no view under 1% opacity
        (RCTViewComponentView's betterHitTest - the web doesn't, which is why it never showed there). So the art inside is never
        pressable and only ever hidden, and this stays mounted, fully opaque, and decides nothing: a tap goes to the screen, which
        draws, turns the waste over, or waits for a flight in its way (KlondikeScreen's handleDrawStock). */}
        <Pressable testID='stock-pile' accessibilityRole='button' accessibilityLabel={stockLabel} disabled={!stockPressable} soundDisabled onPress={() => void onDrawStock()} onLongPress={canRecycle ? stockHold.onLongPress : undefined} onPressOut={canRecycle ? stockHold.onPressOut : undefined} delayLongPress={STOCK_LONG_PRESS_MS}>
          <View style={stockHidden ? HIDDEN_STOCK_STYLE : undefined}>{stockShown ? <PlayingCard card={{ ...stockShown, faceUp: false }} hinted={stockHinted && !stockHolding} /> : <EmptySlot hinted={stockHinted}>{showRecycle ? <Text style={styles.recycleIcon}>↺</Text> : null}</EmptySlot>}</View>
          {stockHidden && (
            <View style={StyleSheet.absoluteFill} pointerEvents='none'>
              {frozenStockTopCard ? <PlayingCard card={{ ...frozenStockTopCard, faceUp: false }} /> : <EmptySlot>{showRecycle ? <Text style={styles.recycleIcon}>↺</Text> : null}</EmptySlot>}
            </View>
          )}
        </Pressable>
      </View>
    </View>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    group: {
      flexDirection: 'row',
      gap: CARD_GAP_MIN
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
