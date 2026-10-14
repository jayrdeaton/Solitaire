// Pyramid solitaire screen: triangle tap-to-select board + stock/waste row.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import { Fireworks } from '@tastic/sprites/fireworks'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'

import { HintRequest } from '@/components/autoHint'
import { FaceLoadTrackingContext, LANDED_GHOST_MAX_MS, markGhostPending, useGhostPaintGate, whenCardsSettled } from '@/components/cardFacePaint'
import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { dealStaggerMs } from '@/components/dealing/dealSpring'
import { measureView, ScreenPoint } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { DropZone } from '@/components/dragdrop/DropZone'
import { DropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { OverlayFrame, toLocal, useOverlayFrame } from '@/components/overlayFrame'
import { PlayingCard } from '@/components/PlayingCard'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { useTakeOffHold } from '@/components/useTakeOffHold'
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { chainSegmentDelayMs } from '@/components/winning/winCascadeMotion'
import { PYRAMID_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { parFor } from '@/engine/par'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { DiscardCell } from '@/games/shared/DiscardCell'
import { MoveInfo } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useDimAfterDeal } from '@/games/shared/useDimAfterDeal'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useHintGlide } from '@/games/shared/useHintGlide'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useUndoStack } from '@/games/shared/useUndoStack'
import { useWinReveal, WIN_REVEAL_HOLD_MS } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { buildPyramidDealSequence } from './dealSequence'
import { cardPosition, pyramidCardWidth, pyramidCellScreenPoint, ROWS, triangleHeight, triangleWidth } from './geometry'
import { cardAt, isExposed, PyramidController, PyramidState, rowColOf } from './rules'

/** One card's original spot, recorded so undoing a pairing/King removal can fly it back there
 * (see handleUndo's undoRemoval branch) instead of just reappearing there instantly. ref.zone is
 * always 'pyramid' or 'waste' - the only two zones tryMove ever accepts a removal from. */
interface RemovedCardRef {
  cardId: string
  ref: PileRef
}

/** How long the slowest single flight keeps its ghost up: every flight here is dragSpring.ts's FLIGHT_SPRING (a drag never flies on its own -
 * its drop hands over to the pair flight, or snaps back), so springSettleMs of that, ~483ms at the default FLIGHT_TIME_SCALE. Derived, so
 * re-pacing the flights re-paces everything below that has to outlast one. */
const SLOWEST_FLIGHT_MS = springSettleMs(FLIGHT_SPRING)

/** A deferred action (a tap on a card still flying onto the waste, a draw waiting out a recycle flight) never waits longer than this
 * for the flight it is waiting on: a flight that never reports back must cost the player a moment, not the tap. Three times the
 * slowest flight (SLOWEST_FLIGHT_MS, which already includes the spring's real end) covers its measurements with room to spare, and the
 * wait can never expire before a healthy draw ghost has landed - it used to be a flat 1000ms against a flight of at most ~320ms. */
export const DEFER_MAX_WAIT_MS = 3 * SLOWEST_FLIGHT_MS

/** A pile blanks this long AFTER its last card takes off in the win sweep (the deal layer's onCardDealt): the departing ghost is
 * drawn exactly over the pile's top card at take-off, so a blank a frame late is hidden under it, while one a frame EARLY would
 * flash an empty slot. */
const SWEEP_PILE_BLANK_LAG_MS = 20

/** The wait budget of ONE deferred action: a clock started when it first has to wait, read by every re-check of its gate (see
 * PyramidScreenInner's whenLanded). One budget for the whole wait - not a fresh DEFER_MAX_WAIT_MS per resume, which a flight that keeps
 * being re-checked without ever clearing the gate would stretch without end. Module level (not inline at the call sites) because the
 * clock read is impure, which the React Compiler lint rejects inside the component. */
function startDeferBudget(): { left: () => number } {
  const deadline = Date.now() + DEFER_MAX_WAIT_MS
  return { left: () => deadline - Date.now() }
}

/** How long a won game may wait for its flights before the celebration starts anyway. Longer than useWinReveal's default because the
 * winning move here starts a whole sequence the reveal must wait for: the last removal's flight (SLOWEST_FLIGHT_MS plus ~30ms of
 * measurement), then the sweep of up to ~24 leftover stock/waste cards onto the discard (dealStaggerMs(24) = 35ms apart + the 280ms
 * deal spring = ~1.1s - the deal is not re-paced by FLIGHT_TIME_SCALE), then the hold (WIN_REVEAL_HOLD_MS) - ~2.2s nominal at the
 * default pace, against the default 2.5s: too little margin for a slow phone's JS stalls (a 24-card deal was measured at ~+0.8s of
 * lag there), and cutting the sweep short with the fallback timer is exactly what this is meant to avoid. Twice the nominal timeline
 * (it was 4000ms against ~1.9s before the flights were slowed). Only a flight that never lands waits this long. */
export const SWEEP_WIN_REVEAL_MAX_WAIT_MS = 2 * (SLOWEST_FLIGHT_MS + 30 + 1100 + WIN_REVEAL_HOLD_MS)

interface UndoEntry {
  state: PyramidState
  /** Non-null for a stock draw (the only MoveInfo-shaped move this game has - see handleUndo's
   * draw branch). Mutually exclusive with `removedCards` below - a stock draw and a
   * pairing/King removal are never the same move. */
  move: MoveInfo | null
  /** Non-null for a pairing/King removal - always 1 (a solo King) or 2 (a pair) entries, since
   * Pyramid removals are never more than a pair. Mutually exclusive with `move` above. */
  removedCards: RemovedCardRef[] | null
}

/** Each card's own leg gets its own origin AND destination - unlike the forward (removal) flight,
 * where every card shares one destination (the discard pile), an undo-of-removal flight has every
 * card share one ORIGIN (the discard pile) but fly to its own distinct destination instead. Both
 * shapes fit the same per-card {from, to} spec - see attemptMove vs. undoRemoval below. */
interface PairFlightCardSpec {
  card: Card
  from: ScreenPoint
  to: ScreenPoint
}

/** One airborne pair flight. A card is marked `landed` the moment it lands (everything the landing owes - the discard
 * count, the un-hide, the flight's claim - is settled then, see handlePairFlightLanded), and its ghost stays over the spot,
 * shadowless, only until the card revealed under it has painted (FlyingPairCard's landed hold): then it leaves `cards` -
 * on its own, not when its partner does - and the flight goes when `cards` is empty. Several of these are in the air at
 * once when the player removes pairs faster than a flight lasts - see PyramidScreenInner's pairFlights. */
interface PairFlightState {
  gen: number
  cardWidth: number
  cards: PairFlightCardSpec[]
  /** Ids of the cards that have landed and only wait to be retired (see FlyingPairCard). */
  landed: ReadonlySet<string>
  /** Ends the take-off hold on the cards' sources (cardFacePaint.ts) - see PairFlightGroup. */
  releasePending: () => void
  /** Run once the pair's ghosts are on screen (or the flight goes first): a drag-completed pair hides the dragged card's
   * drag ghost here rather than in the commit the pair starts, so the card is never missing mid-air. */
  onShown?: () => void
}

/** What one airborne pair flight still owes: the cards that have not landed yet, the `flying` entry
 * (a waste-bound undo-of-removal only) to end, and the claim on activeFlightCount to settle. The claim
 * is settled exactly once, when the flight's own last card lands, whatever any other flight is doing;
 * the `flying` entry ends with ITS card (`flying.cardId` - the one restored to the waste), not with
 * the flight: the other card of the pair can take longer, and the waste's real card must not stay
 * hidden - the landed card visible nowhere - until it arrives. */
interface PairFlightLedger {
  pending: Set<string>
  flying: { id: number; cardId: string } | null
  settle: () => void
}

/** What the board shows while a won game's leftover stock/waste cards are dealt onto the discard (see PyramidScreenInner's sweep) -
 * everything render needs, keyed to the exact won board (`state`, compared by identity like cascadeHandoff, so an undo or a New Game
 * makes it inert with nothing to reset). `view` is the pre-sweep piles: rules.ts folds the leftovers into the discard on the winning
 * move itself, so without this the stock and waste would be empty from that instant with nothing having left them. `wasteGone` /
 * `stockGone` flip when that pile's last card has departed. `flies` is false when the discard could not be measured at the winning
 * move (so no flight exists, before or after): the board then simply stays as the finished board showed it. */
interface SweepUi {
  state: PyramidState
  view: WinHoldView
  flies: boolean
  wasteGone: boolean
  stockGone: boolean
}

/** The imperative half of a sweep (what does not belong in render): its claim on activeFlightCount, whether it has started, and its
 * pending pile-blanking timers (armed as each pile's last card takes off). `cards` is in landing order - the order rules.ts appended
 * them to the discard (waste bottom-to-top, then stock bottom-to-top) - the first `wasteCount` of them from the waste, the rest from
 * the stock. */
interface SweepRun {
  state: PyramidState
  gen: number
  cards: Card[]
  wasteCount: number
  settle: () => void
  started: boolean
  dealing: boolean
  timers: ReturnType<typeof setTimeout>[]
}

/** Something waiting for a flight to land (see PyramidScreenInner's whenLanded). */
interface LandWaiter {
  done: () => boolean
  resolve: () => void
}

/** The topmost card of `cards` that is not one of the `inAir` ids - what the discard pile actually
 * shows once every card still flying to it is discounted (null: nothing has landed on it, so the
 * empty slot). It stays right however the flights land: a pair's two cards can arrive in either
 * order, and a later removal's cards can be in the air while an earlier one's have landed. */
export function topLandedCard(cards: Card[], inAir: ReadonlySet<string>): Card | null {
  for (let i = cards.length - 1; i >= 0; i--) if (!inAir.has(cards[i].id)) return cards[i]
  return null
}

/** What a WON board looked like just before rules.ts's sweepRemainderOnWin folded whatever was still
 * in the stock/waste into the discard - the winning move's own removal record carries the pre-move
 * state, and the sweep only ever appends (waste bottom-to-top, then stock bottom-to-top), so
 * `discard` splits back into the three piles cleanly. The screen keeps showing THESE piles (see
 * SweepUi) while their cards are dealt onto the discard one by one, instead of the swept board:
 * the stock and waste must not simply vanish the instant the last pair is removed, they must
 * visibly empty as their cards fly to the discard. Null when the record can't account for every
 * discarded card (no removal record, an unexpected count): the caller then falls back to the
 * swept board as-is. */
export interface WinHoldView {
  /** The discard as the last removal flight leaves it - everything but the swept remainder. */
  discardCards: Card[]
  /** Swept from the waste, bottom-to-top; the last one is the waste top the board was showing. */
  wasteCards: Card[]
  /** Swept from the stock, bottom-to-top; the last one is the stock top the board was showing. */
  stockCards: Card[]
}

export function winHoldView(won: PyramidState, entry: { state: PyramidState; removedCards: RemovedCardRef[] | null } | undefined): WinHoldView | null {
  if (!entry || !entry.removedCards) return null
  const before = entry.state
  // A pair (or King) taken from the waste consumed its top before the sweep, so that card is not part of what got swept.
  const wasteSwept = entry.removedCards.some((r) => r.ref.zone === 'waste') ? before.waste.length - 1 : before.waste.length
  const kept = before.discard.length + entry.removedCards.length
  if (won.discard.length !== kept + wasteSwept + before.stock.length) return null
  return { discardCards: won.discard.slice(0, kept), wasteCards: won.discard.slice(kept, kept + wasteSwept), stockCards: won.discard.slice(kept + wasteSwept) }
}

/** No shadow on a landed ghost: the card revealed under it draws its own, and two would darken it for as long as both
 * show (the same style DragGhostLayer gives its landed ghosts). */
const LANDED_CARD_STYLE = { shadowOpacity: 0, elevation: 0 }

/** One card's independent leg of a pair's removal flight (see PairFlightGhosts) - its own spring
 * from its own spot, taking the same time as every other flight in this app (dragSpring.ts's
 * FLIGHT_SPRING), so the two cards of a pair leave together and land together. Settlement is a
 * plain timer matching the spring's own real end (springSettleMs) rather than the spring's
 * completion callback - confirmed elsewhere in this codebase (DragGhostLayer.tsx/DealLayer.tsx)
 * not to reliably fire on this app's web target.
 *
 * Landed (`landed`), the ghost stays where it came to rest until the card revealed under it can really be seen, then
 * calls `onRetired`: the landing reveals a card whose face is ONE Image - the discard pile's overlay re-sourced to this
 * card while other cards are still flying to it (a quick next pair, a King, the win sweep's leftovers), the real discard
 * top, the waste or a pyramid cell an undo restored - and on iOS a re-sourced Image keeps its PREVIOUS bitmap until the
 * new one arrives, a frame or two later (cardFacePaint.ts). Removing the ghost in the landing commit therefore showed the
 * card that was there before for a frame or two: the card that had just landed vanished and the old top came back. The
 * wait is whenCardsSettled - the board face has painted, and no new ghost of this card is still waiting to show (an undo
 * flying it straight back) - bounded by LANDED_GHOST_MAX_MS, the same hold DragGhostLayer gives a landed King. Started from
 * a LAYOUT effect of the landing commit: PairFlightGhosts is rendered after GameChrome, so by then the board's own layout
 * effects in that commit (the re-sourced face reporting itself as loading) have run; checked synchronously in the landing
 * callback instead, it would find nothing loading yet and retire at once. */
function FlyingPairCard({ gen, card, from, to, frame, cardWidth, go, landed, onFacePainted, onLanded, onRetired }: { gen: number; card: Card; from: ScreenPoint; to: ScreenPoint; frame: OverlayFrame; cardWidth: number; go: boolean; landed: boolean; onFacePainted: () => void; onLanded: () => void; onRetired: (gen: number, cardId: string) => void }) {
  const cardHeight = cardWidth / CARD_ASPECT
  const tx = useSharedValue(from.x)
  const ty = useSharedValue(from.y)
  const notified = useRef(false)
  const cardId = card.id

  // Flies (and its landing clock runs) only once the pair is on screen - see PairFlightGroup.
  useEffect(() => {
    if (!go) return
    tx.value = withSpring(to.x, FLIGHT_SPRING)
    ty.value = withSpring(to.y, FLIGHT_SPRING)
    // The spring's real end, not its bare `duration` (which is only its perceptual length and starts a
    // frame or two before the UI thread does) - see dragSpring.ts's springSettleMs.
    const timer = setTimeout(() => {
      if (notified.current) return
      notified.current = true
      onLanded()
    }, springSettleMs(FLIGHT_SPRING))
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go])

  // The landed hold (see above). The cleanup cancels a wait still pending when the ghost goes another way - a New Game
  // drops every pair flight at once.
  useLayoutEffect(() => {
    if (!landed) return
    return whenCardsSettled([cardId], LANDED_GHOST_MAX_MS, () => onRetired(gen, cardId))
  }, [landed, gen, cardId, onRetired])

  const style = useAnimatedStyle(() => {
    const p = toLocal(tx.value, ty.value, cardWidth, cardHeight, frame)
    return { transform: [{ translateX: p.x }, { translateY: p.y }] }
  })

  return (
    <Animated.View style={[pairFlightStyles.ghostCard, !go && pairFlightStyles.unpainted, style]}>
      {/* A ghost: its face is not the board's (see cardFacePaint.ts). */}
      <FaceLoadTrackingContext.Provider value={false}>
        <PlayingCard card={card} style={landed ? LANDED_CARD_STYLE : undefined} onFacePainted={onFacePainted} />
      </FaceLoadTrackingContext.Provider>
    </Animated.View>
  )
}

/** One pair flight's ghosts. A ghost is a fresh Image, blank for a frame or two (cardFacePaint.ts), so the pair stays
 * invisible - while its sources keep drawing the cards - until BOTH faces have painted (useGhostPaintGate; together, so
 * the lower card's ghost can never show over a still-held top card), then both appear and fly. */
function PairFlightGroup({ flight, frame, onCardLanded, onCardRetired }: { flight: PairFlightState; frame: OverlayFrame; onCardLanded: (gen: number, cardId: string) => void; onCardRetired: (gen: number, cardId: string) => void }) {
  const faceIds = useMemo(() => flight.cards.map((c) => c.card.id), [flight.cards])
  const shownOnce = useRef(false)
  const handleShown = useCallback(() => {
    if (shownOnce.current) return
    shownOnce.current = true
    flight.releasePending()
    flight.onShown?.()
  }, [flight])
  const { shown, markPainted } = useGhostPaintGate(faceIds, handleShown)
  // Gone before it ever showed (a New Game): its sources must not keep holding, and a dragged card's ghost must still go.
  useEffect(() => handleShown, [handleShown])
  return (
    <CardSizeProvider width={flight.cardWidth}>
      {flight.cards.map(({ card, from, to }) => (
        <FlyingPairCard key={`${flight.gen}-${card.id}`} gen={flight.gen} card={card} from={from} to={to} frame={frame} cardWidth={flight.cardWidth} go={shown} landed={flight.landed.has(card.id)} onFacePainted={() => markPainted(card.id)} onLanded={() => onCardLanded(flight.gen, card.id)} onRetired={onCardRetired} />
      ))}
    </CardSizeProvider>
  )
}

// Module-level (not the theme-dependent `styles` inside PyramidScreenInner below) - FlyingPairCard
// is its own top-level component with no access to that function-local variable, and this style
// has no theme dependency anyway (always the same three constants).
const pairFlightStyles = StyleSheet.create({
  ghostCard: {
    left: 0,
    position: 'absolute',
    top: 0
  },
  unpainted: {
    opacity: 0
  }
})

/** Renders Pyramid's pair-removal flights: "first" and "second" travel to the discard pile
 * independently, each from its own real position, rather than through the single shared `ghost`
 * (DragGhostLayer), which only ever animates one origin/delta for its whole group at a time - see
 * PyramidScreenInner's startPairFlight. Same "N independent simultaneous ghosts" idiom
 * DealLayer/WinCascadeLayer already use, for the same reason the single-slot drag ghost can't do
 * it (see DealLayer.tsx's doc comment). Renders EVERY flight in `flights` - a fast player's next
 * pair takes off while the last one is still in the air, and each must keep flying. Always mounted
 * (only the flights' presence is conditional) so its own offset-correction effect can measure a
 * real position at all times, same reasoning as those two. */
function PairFlightGhosts({ flights, onCardLanded, onCardRetired }: { flights: PairFlightState[]; onCardLanded: (gen: number, cardId: string) => void; onCardRetired: (gen: number, cardId: string) => void }) {
  // Same overlay-placement pattern as DragGhostLayer/DealLayer - see overlayFrame.ts.
  const { overlayRef, frame } = useOverlayFrame()

  return (
    <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
      {flights.map((flight) => (
        <PairFlightGroup key={flight.gen} flight={flight} frame={frame} onCardLanded={onCardLanded} onCardRetired={onCardRetired} />
      ))}
    </View>
  )
}

interface PyramidCellProps {
  index: number
  /** The cell's card on the current board (null once removed). */
  card: Card | null
  /** Whether `card` is exposed on the current board (rules.ts's isExposed). */
  exposed: boolean
  /** `card` is hidden: its deal or undo ghost has not landed here yet (pyramidHiddenIds). */
  hidden: boolean
  /** This cell is the current selection. */
  selected: boolean
  hinted: boolean
  /** The screen's last shake's token when it is `card`'s, WHETHER OR NOT the card is exposed - see the cell's comment. */
  shakeToken: number | undefined
  /** useDimAfterDeal's `held`: the deal is still in the air, nothing is dimmed yet. */
  dimHeld: boolean
  left: number
  top: number
  zIndex: number
  dropZones: DropZoneRegistry
  /** Stable for the screen's lifetime (they read the latest handlers through a ref - see PyramidScreenInner's cellHandlersRef). */
  onSelect: (index: number, measure: () => Promise<ScreenPoint>) => void
  onDrop: (index: number, cardId: string, absoluteX: number, absoluteY: number, flight: DragFlightHandle) => Promise<boolean>
}

/**
 * One triangle cell. Keyed by cell (one card ever occupies a cell), and the same element tree whether its card is covered,
 * exposed or has just taken off (useTakeOffHold: drawn until its ghost is on screen), so its painted face survives every
 * change - a covered card used to be a plain PlayingCard that REMOUNTED, blank for a frame or two, the moment a move exposed
 * it (cardFacePaint.ts). A covered card is just not a drop target, not playable, not registered, and dimmed.
 *
 * Memoized, with only primitive props and stable callbacks, so a screen render re-renders just the cells whose own props
 * changed. Every cell - covered ones too, since the restructure above - is a DraggableCard, and with it a GestureDetector
 * whose effect re-sends its whole gesture config to the native side (findNodeHandle + updateGestureHandler) on EVERY render;
 * the screen re-renders several times per move (a selection, each flight claim, landing and hold), and re-rendering all 28
 * cells for each of those multiplied the native gesture updates the exposed cells alone used to cost (worked out from
 * RNGH's source, not measured on a device). The same reason PileView's DraggableTableauCard is memoized.
 *
 * A held cell (its card has just taken off and its ghost is not on screen yet) is inert AND not a touch target
 * (pointerEvents none, as PileView's held cards are): it overlaps the lower part of the card(s) its leaving uncovered, which
 * are exposed and playable in the very commit the move made, and a disabled Pressable still catches the touch - the
 * responder only bubbles to ancestors, never to the sibling cell underneath - so a quick tap or drag on the card just
 * uncovered would otherwise do nothing for that frame or two.
 *
 * `shakeToken` is passed whether or not the card is exposed: a covered card can never be tapped, so it can never get a NEW
 * token while covered - the one it carries is a shake that is over (this card's own, played before something covered it
 * again, or the last shake of the board before a New Game dealt the card here), and useShakeStyle records the token a card
 * arrives with as played. Masking it while covered made the card record "no token" for itself (on the mount or the re-seed
 * a New Game gives it) and then play the stale one the moment a move uncovered it. Not while held, though: `shakeToken` is
 * computed for the cell's CURRENT card, which is then not the one drawn.
 */
export const PyramidCell = memo(function PyramidCell({ index, card, exposed: exposedOnBoard, hidden, selected, hinted, shakeToken, dimHeld, left, top, zIndex, dropZones, onSelect, onDrop }: PyramidCellProps) {
  const { shown, holding } = useTakeOffHold(card)
  const exposed = !holding && exposedOnBoard
  const covered = !exposed && !holding
  const shownId = shown?.id
  const pileRef = useMemo<PileRef>(() => ({ zone: 'pyramid', index }), [index])
  const style = useMemo(() => [cellStyles.card, { left, top, zIndex }, holding && cellStyles.noTouch], [left, top, zIndex, holding])
  const handlePress = useCallback((measure: () => Promise<ScreenPoint>) => onSelect(index, measure), [onSelect, index])
  const handleDrop = useCallback((absoluteX: number, absoluteY: number, flight: DragFlightHandle) => (shownId ? onDrop(index, shownId, absoluteX, absoluteY, flight) : Promise.resolve(false)), [onDrop, index, shownId])
  if (!shown) return null
  return (
    <DropZone registry={dropZones} pileRef={pileRef} style={style} enabled={exposed}>
      <DraggableCard card={shown} selected={exposed && selected} hidden={!holding && hidden} disabled={!exposed} dimmed={covered} dimHold={covered ? hidden || dimHeld : undefined} registryId={exposed ? undefined : null} hinted={exposed && hinted} onPress={exposed ? handlePress : undefined} onDrop={exposed ? handleDrop : undefined} shakeToken={holding ? undefined : shakeToken} testID={`pyramid-${index}`} />
    </DropZone>
  )
})

// Module-level and theme-free, so a memoized cell never sees a new style object from a screen render.
const cellStyles = StyleSheet.create({
  card: {
    position: 'absolute'
  },
  noTouch: {
    pointerEvents: 'none'
  }
})

// The triangle's widest row is the base: ROWS cards laid out with no overlap, so it reuses
// cardWidthForRow's clamping/fit math as a plain "row of ROWS columns" with a real gap.
const TRIANGLE_WIDTH_UNITS = ROWS

// A stable empty pile for the sweep/hand-off display (a fresh literal per render would change identity every time).
const NO_CARDS: Card[] = []
const WASTE: PileRef = { zone: 'waste', index: 0 }
// A new pair flight's `landed`: none of its cards has landed yet.
const NONE_LANDED: ReadonlySet<string> = new Set()

export default withGameProviders(PyramidScreenInner)

function PyramidScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth, isWide, availableHeight: layoutAvailableHeight } = useGameLayout()
  // The screen is visually rotated by FakeLandscapeView, so every measured container origin below is a
  // rotated bounding box - see geometry.ts's pyramidCellScreenPoint.
  const rotation = useRotation()
  const { cardWidth: widthCardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TRIANGLE_WIDTH_UNITS)
  // Pyramid has no PileView/height-budget concept - the triangle's own height is a pure function of
  // cardWidth, so a wider window could otherwise drive cardWidth taller than the viewport fits. Portrait
  // keeps its original clamp against useTableauMaxHeight's budget (a second-order approximation, fed
  // the width-derived cardWidth); the wide layout instead solves Pyramid's real board height (control
  // row + triangle + margins - see geometry.ts's PYRAMID_BOARD_MODEL) against the layout's height.
  const portraitAvailableHeight = useTableauMaxHeight(widthCardWidth)
  const cardWidth = pyramidCardWidth(widthCardWidth, isWide, layoutAvailableHeight, portraitAvailableHeight)
  const cardHeight = cardWidth / CARD_ASPECT
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with each
  // other - PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`,
  // `commitState`, `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working
  // unchanged. `shrinkFlying` is unused here - Pyramid never lands a multi-card flight one card at a
  // time (no draw-3-style fan; a recycle/pair flight always lands as one group completion).
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<PyramidState>()
  const [selected, setSelected] = useState<PileRef | null>(null)
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: PyramidState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Both cards of a hinted pair are rung: both leave the board together (the glide shows one going onto the other).
  // hintCountFor rings only a move's source, which for a pair would leave its partner unmarked.
  const pairHinted = (ref: PileRef) => hintCountFor(activeHint, ref) > 0 || (activeHint?.kind === 'move' && activeHint.move.to.zone === ref.zone && activeHint.move.to.index === ref.index)
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useDerivedWinCheck's own hintsUsedRef param), to
  // decide whether this win counts toward the "wins without hint" stat/achievement. Reset on every
  // fresh deal (startNewGame) and resume (restoreGame).
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  // Which card (if any) should play its "that pairing didn't work" shake right now - bumped
  // (not toggled) so tapping into the same failed pairing twice in a row re-triggers it both
  // times. Always exactly one card (the just-tapped one, `to` in attemptMove) since Pyramid
  // moves are never multi-card runs the way Klondike/Spider tableau moves can be.
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  const wasteViewRef = useRef<View>(null)
  const triangleViewRef = useRef<View>(null)
  const discardViewRef = useRef<View>(null)
  const [pyramidHiddenIds, setPyramidHiddenIds] = useState<Set<string>>(new Set())
  // Covered cells are not dimmed while the deal is in the air; the whole pyramid dims at once when it has landed (see
  // useDimAfterDeal - fed through `dimHold` below, so the release fades each covered cell in instead of popping it on).
  const dimAfterDeal = useDimAfterDeal()
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const ghost = useDragGhost()
  const playHintGlide = useHintGlide(state, ghost.cardRegistry, dropZones)
  // True while the stock slot's real content is mid-flight elsewhere (a stock recycle, either
  // direction - see handleDrawStock's recycle branch / undoRecycle - or a draw being undone, whose
  // card is flying back to it) and should stay frozen on its
  // pre-flight appearance instead of instantly revealing the new one - see StockWaste's own
  // `stockHidden` doc comment.
  const [stockHidden, setStockHidden] = useState(false)
  /** Draw flights awaiting their post-commit measurement + ghost.flyTo (see the effect below) - queued by
   * handleDrawStock once the drawn card's own render has been committed. A list (not a single slot) since
   * these can now genuinely overlap (see PATTERN_OVERLAP_GATE): rapid stock-draw taps can each still be
   * awaiting their own measurement when the next one starts, so a single ref slot would let a later entry
   * clobber an earlier one, permanently stranding it - see stateRef's own doc comment for the identical
   * rapid-tap race this mirrors. Only a DRAW needs this deferral (its destination is the drawn card's own
   * registration, which exists only once that card has mounted in the waste): every reverse flight - an
   * undone draw included - measures both its endpoints from always-mounted containers before it commits
   * (see handleUndo). `gen` is the dealTokenRef value captured at the moment this flight was queued -
   * re-checked once the async measurement below resolves, so a flight queued against a game that's since
   * been replaced by "New Game" doesn't measure/land against the new deal's DOM (card ids are
   * shuffle-independent and reused across deals - see deck.ts). `flyingId` removes exactly this entry's own
   * `flying` array entry once it lands, and `settle` is this flight's own claim on activeFlightCount (see
   * claimFlight). Mirrors Klondike's own pendingFlightRef. */
  const pendingFlightRef = useRef<{ cardId: string; gen: number; flyingId: number; flight: DragFlightHandle; settle: () => void }[]>([])
  const winCascade = useWinCascade()
  // Derived from `state` every render (see useDerivedWinCheck) rather than mirrored into its own
  // useState: it's a pure function of state, so Undo-ing out of a won position correctly drops the
  // win banner immediately, rather than leaving it stuck showing.
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(PyramidController, state, 'pyramid', session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing in the air (every removal/draw/undo flight, pair flights included, is counted by
  // startFlights/settleFlight) and no card still waiting on the initial deal - what the win
  // celebration waits for (see useWinReveal).
  const settled = activeFlightCount === 0 && pyramidHiddenIds.size === 0
  // `won` is game state (clock, stat, save, hint/undo gating) and flips with the winning move; the
  // celebration - the discard giving way to the win cascade, fireworks, banner - waits until the last
  // card has flown to the discard and landed AND the leftover stock/waste cards have been dealt onto it (the win
  // sweep, which holds its own claim on the flight count), so the finished pile reads for a beat first and nothing
  // hides while a card is still travelling to it.
  const winRevealed = useWinReveal(won, settled, SWEEP_WIN_REVEAL_MAX_WAIT_MS)
  // The board the win cascade has taken over from (set once its ghosts are on screen - startChains' onShown, see
  // runWinCascade): once state IS the current state, and the win is revealed, the discard's real top blanks - not a moment
  // earlier. Blanking on winRevealed alone left the discard EMPTY for the few frames it takes runWinCascade to measure and
  // mount the ghosts (the pile teleported away, then the ghosts appeared), so the cascade's ghosts are on screen by the
  // commit that blanks it. Compared
  // by identity (state is replaced wholesale on every change) so an undo or a New Game un-blanks the pile with no reset to
  // remember. By then the win sweep has dealt the stock and waste onto the discard, so the discard is the only pile with
  // anything left to hand over - one chain, one hand-off.
  const [cascadeHandoff, setCascadeHandoff] = useState<{ state: PyramidState } | null>(null)
  // The win sweep's display state (see SweepUi) and its imperative half (see SweepRun).
  const [sweepUi, setSweepUi] = useState<SweepUi | null>(null)
  const sweepRef = useRef<SweepRun | null>(null)
  /** Pyramid's pair-removal flights - both cards of a pair travel to the discard pile
   * independently, each from its own real position (see startPairFlight/PairFlightGhosts below),
   * rather than through the single shared `ghost` above, which can only ever animate one
   * origin/delta for its whole group and so can't have two cards converge from different starting
   * points at once. A LIST, and the ledger beside it keyed by each flight's own gen: a fast player
   * completes the next pair while the last one's two ghosts are still in the air (see
   * PATTERN_OVERLAP_GATE), and a single slot let the new flight replace the old one - its ghosts
   * vanished mid-air, its landing was dropped, and its claim on activeFlightCount was never settled
   * (undo stayed disabled for the rest of the game, the win celebration waited out its max wait). */
  const [pairFlights, setPairFlights] = useState<PairFlightState[]>([])
  const pairFlightGenRef = useRef(0)
  const pairFlightLedgerRef = useRef(new Map<number, PairFlightLedger>())
  // Takes down a landed pair ghost once the card it revealed has painted (FlyingPairCard's landed hold); the flight goes
  // with its last card. Everything the landing owed was settled AT the landing (handlePairFlightLanded) - this only removes
  // the ghost. Stable (it only uses the setter), so a screen render never restarts a landed ghost's wait.
  const retirePairCard = useCallback((gen: number, cardId: string) => {
    setPairFlights((flights) =>
      flights.flatMap((f) => {
        if (f.gen !== gen || !f.cards.some((c) => c.card.id === cardId)) return [f]
        const cards = f.cards.filter((c) => c.card.id !== cardId)
        return cards.length === 0 ? [] : [{ ...f, cards }]
      })
    )
  }, [])
  /** Ids of the cards still flying TO the discard pile (a solo King's ghost or either card of a
   * pair) - the real discard top stays hidden while any are (see DiscardCell), and the pile shows
   * the topmost card NOT in this set underneath (topLandedCard) so it is right as each of several
   * overlapping flights lands, not just after the last. Set in the same commit as the removal, and
   * cleared per card when its own ghost lands. A winning removal also marks every leftover stock/waste
   * card the win folded into the discard: they are dealt onto it one by one (see the win sweep) and
   * the pile shows only what has landed. */
  const [discardInAir, setDiscardInAir] = useState<ReadonlySet<string>>(() => new Set())
  /** Ids of the cards drawn from the stock whose ghosts are still flying to the waste - the waste's own counterpart of
   * discardInAir. The real waste top stays hidden while any is (wasteHiddenCount), and the slot shows the topmost waste card
   * NOT in this set underneath (settledWasteTop), so it stays right as each of several overlapping draws lands rather than
   * showing the card from before the whole stream. The ref is what handlers read (a tap, a drop, a recycle deciding whether to
   * wait), the state copy what render reads; both are updated together (markWasteInAir/markWasteLanded). */
  const [wasteInAir, setWasteInAir] = useState<ReadonlySet<string>>(() => new Set())
  const wasteInAirRef = useRef(new Set<string>())
  /** True while a recycle's group ghost is flying waste -> stock: a draw must not start from the stock slot while it is frozen
   * on its pre-flight (empty) look. */
  const recycleAirRef = useRef(false)
  /** Actions parked until some flight has landed (see whenLanded). */
  const landWaitersRef = useRef<LandWaiter[]>([])
  /** Every flight on the shared ghost layer that is still in the air (a King's, a draw's, a recycle's, an undo's), so a New Game
   * can retire them: they would otherwise keep flying across the freshly dealt board. */
  const airborneFlightsRef = useRef(new Set<DragFlightHandle>())

  // One claim on activeFlightCount for the board generation it was made in, settled at most once.
  // Every flight-starting action takes it SYNCHRONOUSLY (before its first await) and settles it on
  // EVERY exit path, so undo (which waits on the count) and the win celebration (which waits for
  // it to hit 0) see the action for as long as it is genuinely outstanding - including its
  // measurement awaits. Once a New Game/restore has replaced the board, resetFlightConcurrency has
  // already zeroed the count, so a late settle from the old game must do nothing: it would
  // otherwise eat a claim the NEW game just made and re-enable undo while a flight is in the air.
  function claimFlight(): () => void {
    const gen = dealTokenRef.current
    startFlights(1)
    let settled = false
    return () => {
      if (settled) return
      settled = true
      if (dealTokenRef.current === gen) settleFlight()
    }
  }

  function markDiscardInAir(ids: string[]) {
    setDiscardInAir((air) => new Set([...air, ...ids]))
  }

  function markDiscardLanded(cardId: string) {
    setDiscardInAir((air) => {
      if (!air.has(cardId)) return air
      const next = new Set(air)
      next.delete(cardId)
      return next
    })
  }

  function markWasteInAir(cardId: string) {
    wasteInAirRef.current.add(cardId)
    setWasteInAir(new Set(wasteInAirRef.current))
  }

  function markWasteLanded(cardId: string) {
    if (!wasteInAirRef.current.delete(cardId)) return
    setWasteInAir(new Set(wasteInAirRef.current))
    notifyLanded()
  }

  // Registers a shared-ghost flight as airborne until its landing callback un-registers it (untrackFlight), so a New Game can
  // retire whatever is still in the air (hideAirborneFlights). Returns the handle for chaining.
  function trackFlight(flight: DragFlightHandle): DragFlightHandle {
    airborneFlightsRef.current.add(flight)
    return flight
  }

  function untrackFlight(flight: DragFlightHandle) {
    airborneFlightsRef.current.delete(flight)
  }

  // Retires every shared-ghost flight still in the air. hide() also fires a flight's own pending completion (see
  // DragGhostLayer's flushPendingSettle), which is why a New Game bumps dealTokenRef FIRST: every completion here is
  // generation-guarded, so none of them touches the new board.
  function hideAirborneFlights() {
    const flights = [...airborneFlightsRef.current]
    airborneFlightsRef.current.clear()
    flights.forEach((flight) => flight.hide())
  }

  // Parks an action until `done()` holds - re-checked every time a flight lands (notifyLanded) - or `maxWaitMs` has passed,
  // whichever comes first. What the fast player would otherwise get is a tap silently ignored or a card emerging from a slot
  // that is frozen mid-flight; what they get instead is a moment's delay, the card visibly arriving, and THEN the move.
  //
  // Being resumed is NOT proof that `done()` still holds: a landing resolves EVERY waiter whose predicate held at that instant
  // (notifyLanded), but their continuations then run one after another, and the first to run can undo the condition for the rest
  // (a recycle committed by the first waiter freezes the stock again for the second). So every call site is a LOOP -
  // `while (!done() && before the deadline) await whenLanded(done, remaining)` - whose condition is re-evaluated by the very
  // continuation that then acts, in the same synchronous stretch (no await between the last check and the commit it guards). It
  // must stay inline at the call site: a helper that loops inside an async function would hand the answer back across a
  // microtask boundary, in which a sibling waiter's continuation can already have changed it. The deadline is ONE budget for the
  // whole wait, not one per resume (startDeferBudget, DEFER_MAX_WAIT_MS), and `maxWaitMs` is what is left of it.
  function whenLanded(done: () => boolean, maxWaitMs: number = DEFER_MAX_WAIT_MS): Promise<void> {
    if (done()) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter: LandWaiter = { done, resolve: () => {} }
      const timer = setTimeout(() => {
        landWaitersRef.current = landWaitersRef.current.filter((w) => w !== waiter)
        resolve()
      }, maxWaitMs)
      waiter.resolve = () => {
        clearTimeout(timer)
        resolve()
      }
      landWaitersRef.current.push(waiter)
    })
  }

  function notifyLanded() {
    const waiting = landWaitersRef.current
    landWaitersRef.current = []
    for (const waiter of waiting) {
      if (waiter.done()) waiter.resolve()
      else landWaitersRef.current.push(waiter)
    }
  }

  // Whether none of these cards is still flying onto the waste. A tap or drop on a card whose draw ghost is still travelling
  // would otherwise measure the real (hidden) card at the waste slot and start its own flight from there while the drawn card
  // is not there yet - the card shown twice, once per ghost. So such an action waits (whenLanded) for this to hold. Pyramid cells
  // are never in the set, so passing them is a no-op. Callers check it BEFORE awaiting, so the common case (nothing in the air)
  // does not even yield.
  function onWaste(...cardIds: string[]): boolean {
    return cardIds.every((id) => !wasteInAirRef.current.has(id))
  }

  // Forgets every airborne discard-bound card, pair flight, shared-ghost flight and win sweep - for a New Game/restore, whose new
  // board must not inherit (or be settled by) anything the old one had in the air. Callers bump dealTokenRef first. The
  // unmounted pair ghosts' landing timers die with them, and any callback that still arrives finds no ledger entry.
  function dropAirborneFlights() {
    pairFlightLedgerRef.current.clear()
    setPairFlights([])
    setDiscardInAir(new Set())
    hideAirborneFlights()
    wasteInAirRef.current.clear()
    setWasteInAir(new Set())
    recycleAirRef.current = false
    cancelSweep()
    setSweepUi(null)
    notifyLanded()
  }

  // Where the card at `ref` sits on screen right now: its own registered view when it has one, else the
  // slot it occupies - the waste slot's card-sized container, or the triangle cell's analytic position
  // (the same math the deal and undo flights use). A flight's origin/destination that fails to resolve
  // would otherwise make the card simply appear/vanish with no ghost, when its slot is always there to
  // measure.
  async function measureCardOrigin(ref: PileRef, cardId: string): Promise<ScreenPoint | null> {
    const registered = await ghost.cardRegistry.measure(cardId)
    if (registered) return registered
    if (ref.zone === 'waste') return measureView(wasteViewRef.current)
    if (ref.zone === 'pyramid') {
      const triangleOrigin = await measureView(triangleViewRef.current)
      if (!triangleOrigin) return null
      const { row, col } = rowColOf(ref.index)
      return pyramidCellScreenPoint(triangleOrigin, row, col, cardWidth, gap, rotation)
    }
    return null
  }

  // Same race documented for Klondike's deal/tap-move fixes: measuring CardRegistry synchronously
  // right after the setState in handleDrawStock would find the still-mounted PREVIOUS waste card
  // (the new one's own registration effect hasn't run yet), so the ghost would "fly" a near-zero
  // distance - indistinguishable from a snap. Deferring to a [state]-keyed effect guarantees the
  // new waste card has already registered by the time this runs.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        // A draw's card lands in the waste - if its own view isn't registered yet/any more, fly to the
        // waste slot rather than hiding the ghost (which would just make the card appear there).
        const landed = await measureCardOrigin({ zone: 'waste', index: 0 }, p.cardId)
        // A new game can start while the measurement above is in flight - `landed`, if it resolved
        // at all, would then be measuring an unrelated card in the NEW deal (ids are
        // shuffle-independent and reused across deals - see deck.ts), so drop this flight instead of
        // landing on a nonsensical position. (The New Game itself already retired the ghost and the
        // waste bookkeeping - see dropAirborneFlights - so only a failed measurement has cleanup to do.)
        if (dealTokenRef.current !== p.gen) {
          p.settle()
          return
        }
        if (!landed) {
          untrackFlight(p.flight)
          p.flight.hide()
          markWasteLanded(p.cardId)
          endFlying(p.flyingId)
          p.settle()
          return
        }
        p.flight.flyTo(landed.x, landed.y, () => {
          untrackFlight(p.flight)
          if (dealTokenRef.current === p.gen) markWasteLanded(p.cardId)
          endFlying(p.flyingId)
          p.settle()
        })
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Shared primitive behind both directions of Pyramid's independent-card-flight overlay: a
  // forward (removal) flight's cards each already carry their own origin and share one destination
  // (the discard pile - see attemptMove/attemptDrop); an undo-of-removal flight's cards share one
  // origin (the discard pile) but each carries its own destination (see undoRemoval). Either way,
  // by the time this runs every card's full {from, to} is already resolved. Each call adds an
  // INDEPENDENT flight with its own ledger entry - it never touches one already in the air - and
  // `settle` (the caller's claim on activeFlightCount) is settled by handlePairFlightLanded when
  // this flight's own last card lands.
  // `takeOff`: the cards whose sources hold them until the pair's ghosts show (cardFacePaint.ts) - every card, unless the
  // caller says otherwise (a drag-completed pair: the dragged card is already in the air as its drag ghost, hidden in
  // `onShown`).
  function startPairFlight(cards: PairFlightCardSpec[], flying: { id: number; cardId: string } | null, settle: () => void, takeOff?: { cardIds: string[]; onShown: () => void }) {
    const gen = ++pairFlightGenRef.current
    pairFlightLedgerRef.current.set(gen, { pending: new Set(cards.map((c) => c.card.id)), flying, settle })
    const releasePending = markGhostPending(takeOff ? takeOff.cardIds : cards.map((c) => c.card.id))
    setPairFlights((flights) => [...flights, { gen, cardWidth, cards, landed: NONE_LANDED, releasePending, onShown: takeOff?.onShown }])
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The win sweep. rules.ts folds whatever is left in the stock and waste into the discard ON the winning move (so a won
  // game's discard is all 52 cards), which used to happen with nothing flying anywhere: the piles just emptied. Now those
  // leftover cards are DEALT onto the discard, one after another with the same stagger, spring, sound and skip-tap as the
  // initial deal (the deal layer, not a flight layer of its own), and only when the last has landed does the celebration
  // start - so all 52 cards are in ONE pile when the win cascade takes off from it. Landing order is the discard array's
  // order (waste bottom-to-top, then stock bottom-to-top), which is also the cascade chain's order, so the pile's top is
  // always the card that just arrived and nothing swaps at the hand-off.
  //
  // Timeline: the winning removal commits and claims the sweep (beginWinSweep) in the same synchronous stretch, so
  // `settled` (and with it useWinReveal) never blips true between the last removal landing and the sweep starting; the sweep
  // starts once every OTHER flight has landed (activeFlightCount is down to the sweep's own claim); it settles its claim
  // when the deal reports every card landed (or the whole deal was skipped) - exactly once, on every exit path.
  // ---------------------------------------------------------------------------------------------------------------

  // Called from the winning removal's commit stretch. Records what the board must keep showing (SweepUi) and, when the discard
  // could be measured (`flies` - the same condition the removal's own flight needs), marks the leftovers as in the air (so the
  // discard shows only the cards that have landed) and claims the flight.
  function beginWinSweep(prev: PyramidState, next: PyramidState, removedCards: RemovedCardRef[], flies: boolean) {
    const view = winHoldView(next, { state: prev, removedCards })
    if (!view) return
    const cards = [...view.wasteCards, ...view.stockCards]
    if (cards.length === 0) return
    setSweepUi({ state: next, view, flies, wasteGone: false, stockGone: false })
    if (!flies) return
    markDiscardInAir(cards.map((c) => c.id))
    sweepRef.current = { state: next, gen: dealTokenRef.current, cards, wasteCount: view.wasteCards.length, settle: claimFlight(), started: false, dealing: false, timers: [] }
  }

  function markPileGone(run: SweepRun, pile: 'waste' | 'stock') {
    setSweepUi((ui) => (ui && ui.state === run.state ? { ...ui, [pile === 'waste' ? 'wasteGone' : 'stockGone']: true } : ui))
  }

  // Every leftover has landed (or the deal was skipped, which lands them all at once): both piles are empty, the discard holds
  // everything, and the claim is released - which is what lets the reveal's hold start.
  function finishSweep(run: SweepRun) {
    if (sweepRef.current !== run) return
    sweepRef.current = null
    run.timers.forEach(clearTimeout)
    markPileGone(run, 'waste')
    markPileGone(run, 'stock')
    run.settle()
  }

  // Cuts a sweep short: a New Game replaced the board, or the reveal's fallback timer fired first (a flight that never landed) and
  // the celebration goes ahead regardless. Silences the deal (an empty start() retires its ghosts and drops its callbacks - the
  // deal layer has no cancel of its own), takes the leftovers back out of the air so the discard is whole, and releases the claim
  // (a no-op after a New Game - see claimFlight).
  function cancelSweep() {
    const run = sweepRef.current
    if (!run) return
    sweepRef.current = null
    run.timers.forEach(clearTimeout)
    if (run.dealing)
      deal.start(
        [],
        cardWidth,
        () => {},
        () => {}
      )
    const ids = new Set(run.cards.map((c) => c.id))
    setDiscardInAir((air) => new Set([...air].filter((id) => !ids.has(id))))
    run.settle()
  }

  async function runSweep(run: SweepRun) {
    const [discardPos, wastePos, stockPos] = await Promise.all([measureView(discardViewRef.current), measureView(wasteViewRef.current), measureView(stockViewRef.current)])
    // A New Game (or the reveal's fallback) ended this sweep while it measured.
    if (sweepRef.current !== run || dealTokenRef.current !== run.gen) return

    const stagger = dealStaggerMs(run.cards.length)
    const entries: DealCardSpec[] = []
    const grounded: string[] = []
    // The last card of each pile that actually flies (entries are in take-off order, so it is the last one taken off).
    let lastWasteId: string | null = null
    let lastStockId: string | null = null
    run.cards.forEach((card, i) => {
      const fromWaste = i < run.wasteCount
      // A pile whose own view cannot be measured deals from the other one rather than not at all - no card teleports while any
      // origin exists. Only when there is no origin (or no discard) at all does a card simply land: the deal below never sees it.
      // Every swept card is face-up already (rules.ts flips them into the discard), so a stock card - face-down on the board -
      // flies face-up from take-off: the deal layer cannot turn a card over in flight, and it must fly, not appear.
      const from = fromWaste ? (wastePos ?? stockPos) : (stockPos ?? wastePos)
      if (!discardPos || !from) {
        grounded.push(card.id)
        return
      }
      const delayMs = entries.length * stagger
      entries.push({ cardId: card.id, card, from, to: discardPos, delayMs })
      if (fromWaste) lastWasteId = card.id
      else lastStockId = card.id
    })
    if (grounded.length > 0) setDiscardInAir((air) => new Set([...air].filter((id) => !grounded.includes(id))))
    if (entries.length === 0) {
      finishSweep(run)
      return
    }

    // A pile is empty from the moment its last card takes off - and "takes off" is the deal layer's own signal (onCardDealt),
    // not a timer of ours. A timer armed here, from the scheduled delays, runs on the wrong clock: the deal's clock only starts
    // once its ghost pool has rendered and mounted (several frames on a phone), and a card's real departure is that clock plus its
    // re-based delay plus the render of its launch - so the timer ran AHEAD of the last card's actual take-off and the pile sat
    // empty, its top card gone and no ghost drawn yet, until the ghost popped in (worst for a pile whose last card leaves at
    // delay 0). Keyed by the pile's last card; a pile none of whose cards flew (grounded above) is emptied at once.
    const blankWhenTakenOff = new Map<string, 'waste' | 'stock'>()
    for (const [pile, lastId, count] of [
      ['waste', lastWasteId, run.wasteCount],
      ['stock', lastStockId, run.cards.length - run.wasteCount]
    ] as const) {
      if (count === 0) continue
      if (lastId === null) markPileGone(run, pile)
      else blankWhenTakenOff.set(lastId, pile)
    }

    run.dealing = true
    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        if (sweepRef.current === run) markDiscardLanded(cardId)
      },
      () => finishSweep(run),
      (cardId) => {
        const pile = blankWhenTakenOff.get(cardId)
        // The lag covers the ghost's own first frame (its opacity flips on the UI thread, a beat after the JS-side take-off), so
        // the real top card is never removed a frame before the ghost that replaces it is drawn. On the run's timers, so a
        // New Game / the reveal's fallback (cancelSweep) or a finished sweep clears it.
        if (pile && sweepRef.current === run) run.timers.push(setTimeout(() => markPileGone(run, pile), SWEEP_PILE_BLANK_LAG_MS))
      }
    )
  }

  // Starts a claimed sweep once nothing but the sweep itself is still in the air (the winning removal's own flights, and any draw
  // or recycle that was flying when it committed, have landed): the count includes the sweep's own claim, so 1 is "alone".
  useEffect(() => {
    const run = sweepRef.current
    if (!run || run.started || run.state !== state || activeFlightCount > 1) return
    run.started = true
    runSweep(run)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activeFlightCount])

  // By the time isWon() is true state.discard holds all 52 cards (rules.ts's sweepRemainderOnWin), in true removal order -
  // reversed here so the most-recently-arrived (the card on top of the physical pile) leads the chain. The sweep has already
  // dealt every leftover onto the discard, so ONE chain from the discard's own container carries all of them, and the pile blanks
  // (cascadeHandoff, set from startChains' onShown) only once the ghosts are on screen - in the commit they appear, which waits
  // for the parked head's face to paint (see WinCascadeLayer's CascadeChains) - so it is never empty before the ghosts arrive,
  // nor covered by a blank-faced head for a frame or two (blanking in the commit that mounted them). An undo or New Game before
  // then clears the cascade, which drops the callback (and the hand-off is keyed to `s` anyway). A 52-card chain at the usual
  // 42ms per card would trail its head by ~2.1s, more than two bounce half-periods, and split into a wave: segmentDelayMs caps
  // the whole chain's span (see chainSegmentDelayMs). If the sweep is somehow still running (the reveal's fallback timer fired
  // first) it is cut short first and the chain simply carries every card. If no chain can start (an unmeasurable discard),
  // nothing blanks and the finished board stays up under the banner instead of vanishing. Same dealTokenRef guard as every
  // other async measurement in this file, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: PyramidState, gen: number) {
    cancelSweep()
    const discardOrigin = await measureView(discardViewRef.current)
    if (dealTokenRef.current !== gen || !discardOrigin) return
    const cards = s.discard.slice().reverse()
    winCascade.startChains([{ cards, origin: discardOrigin, entranceDelayMs: 0, segmentDelayMs: chainSegmentDelayMs(cards.length) }], cardWidth, () => setCascadeHandoff({ state: s }))
  }

  // Starts once the win is REVEALED (winRevealed - which waits for the winning removal's flight(s) AND the sweep to land and
  // then holds a beat, see useWinReveal), not on the winning commit itself: the winning pair/King's own flight is still
  // travelling to the discard pile then, and state.discard already includes it, so starting now would show that same card twice
  // at once - mid-flight via PairFlightGhosts/the shared ghost AND already bouncing at the discard via WinCascadeGhosts.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  function pushUndo(prev: PyramidState, move: MoveInfo | null, removedCards: RemovedCardRef[] | null = null) {
    setUndoStack((stack) => [...stack, { state: prev, move, removedCards }])
  }

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    const s = PyramidController.newGame(randomSeed())
    setSelected(null)
    // The last shake belongs to the old board: card ids are reused by the next deal, so a cell dealt the shaken card must
    // not be handed its token at all (PyramidCell records whatever token its card arrives with as already played, so this
    // is a second line of defence, not the fix).
    setShake(null)
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    dropAirborneFlights()
    // Queued draw flights have their ghosts on the shared layer already (ghost.show ran before they were queued): every one of
    // them is registered as airborne, so dropAirborneFlights above has just hidden it - dropping the entry alone would leave that
    // ghost mounted over the new board for good.
    pendingFlightRef.current = []
    setStockHidden(false)
    session.reset()
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.pyramid.filter((c): c is Card => !!c).map((c) => c.id))
    setPyramidHiddenIds(dealtIds)
    dimAfterDeal.hold()
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<PyramidState, UndoEntry>) {
    ++dealTokenRef.current
    setSelected(null)
    setShake(null) // see startNewGame
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    dropAirborneFlights()
    // Queued draw flights have their ghosts on the shared layer already (ghost.show ran before they were queued): every one of
    // them is registered as airborne, so dropAirborneFlights above has just hidden it - dropping the entry alone would leave that
    // ghost mounted over the new board for good.
    pendingFlightRef.current = []
    setStockHidden(false)
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setPyramidHiddenIds(new Set())
    dimAfterDeal.releaseNow()
    commitState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('pyramid')
    startNewGame()
  }

  // Simpler than Klondike's equivalent: buildPyramidDealSequence has nothing to reorder (pyramid's
  // own flat index order already IS the natural apex-first, row-by-row deal order - see
  // dealSequence.ts), and every destination is analytically computable via cardPosition() - no
  // CardRegistry measurement needed for destinations, only for the stock/triangle origin points.
  // Same dealTokenRef guard as Klondike's runDeal, for the same reason (shuffle-independent card
  // ids - see deck.ts). Still deferred to the [state]-keyed effect below rather than called
  // directly from startNewGame, though: on the very first mount, `state` starts null and the whole
  // board (including stockViewRef/triangleViewRef) is behind the `if (!state)` Loading branch, so
  // those refs aren't attached yet when startNewGame's setState is only queued, not committed - a
  // direct call here would measure two null refs and silently skip the deal (pyramidHiddenIds reset to
  // empty, cards just appearing with no animation). A later "New Game" from an already-mounted board
  // would happen to work either way, since the container refs are already attached by then - but the
  // very first deal needs the same commit-then-measure sequencing Klondike/FreeCell/Spider use.
  async function runDeal(s: PyramidState, token: number) {
    const [stockOrigin, triangleOrigin] = await Promise.all([measureView(stockViewRef.current), measureView(triangleViewRef.current)])
    if (dealTokenRef.current !== token) return
    if (!stockOrigin || !triangleOrigin) {
      setPyramidHiddenIds(new Set())
      dimAfterDeal.release()
      return
    }

    const sequence = buildPyramidDealSequence(s.pyramid)
    const entries: DealCardSpec[] = sequence.map((step) => {
      const { row, col } = rowColOf(step.index)
      return {
        cardId: step.cardId,
        card: step.card,
        from: stockOrigin,
        to: pyramidCellScreenPoint(triangleOrigin, row, col, cardWidth, gap, rotation),
        delayMs: step.visitOrder * dealStaggerMs(sequence.length)
      }
    })
    if (entries.length === 0) {
      setPyramidHiddenIds(new Set())
      dimAfterDeal.release()
      return
    }

    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        if (dealTokenRef.current !== token) return
        setPyramidHiddenIds((ids) => {
          if (!ids.has(cardId)) return ids
          const next = new Set(ids)
          next.delete(cardId)
          return next
        })
      },
      () => {
        if (dealTokenRef.current !== token) return
        dimAfterDeal.release()
      }
    )
  }

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<PyramidState, UndoEntry>('pyramid').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('pyramid')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won so a
  // just-won deal doesn't get checkpointed as still in-progress (the win-check effect above clears the
  // save outright instead) - since `won` is derived fresh from `state` on every render, undoing back
  // out of a won position re-enables saving again on that same render, no separate reset needed.
  // Deliberately NOT also keyed on a ticking elapsed-seconds value the way an earlier version of this
  // effect was: `session.getElapsed()` computes the true current elapsed from wall-clock time on demand
  // (see useGameSession.ts), but a save still holds the elapsed time from when it was made, so
  // useSaveInProgressBackstop saves again every 10s, when the screen is left, and when the app is
  // backgrounded.
  useEffect(() => {
    if (state && !won) saveGameInProgress('pyramid', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('pyramid', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

  // Mirrors handleDrawStock's forward flight, just in reverse: the drawn card is still sitting in
  // the waste (`move.to`) - measure its real current position AND the stock pile it flies back to,
  // both before reverting (the ORIGIN has to be captured against the still-current state, and the
  // destination is a plain always-mounted container), then revert, mount the ghost, hide the stock
  // slot and start the flight in ONE synchronous stretch: the returning card is never nowhere, and
  // the stock pile does not show it as landed before the ghost gets there.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // A removal's undo flies its card(s) off the discard, where nothing lands during an undo, and a
  // draw's takes the waste's top card back to the stock - so both overlap the undos before them. One
  // that lands on the waste, or leaves it, waits for the waste to be quiet: its frozen top expects one
  // arrival at a time. (Overlapping draws share the stock's one stockHidden flag: the first landing
  // unfreezes it while a later card is still flying in, which shows a card back that is already
  // there - every back looks the same.) A recycle moves the whole waste - one at a time.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!entry || !stateRef.current) return null
    const { move, removedCards } = entry
    if (removedCards) return { takesFrom: removedCards.some((r) => r.ref.zone === 'waste') ? [WASTE] : [] }
    if (move && move.from.zone === 'stock' && move.to.zone === 'waste') return { takesFrom: [WASTE] }
    return 'exclusive'
  }

  async function revertTopUndo() {
    // The stack and the board are read via their refs, not the closure: undos can run back-to-back
    // before React re-renders (see runUndo).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    // Undo only ever moves backward into an earlier, necessarily-not-won state (won is a terminal
    // condition - the only move available once it's true is New Game), so any undo reachable while
    // won must be undoing the winning move itself. `won` (derived from state above) clears itself
    // on the very next render once prevState commits below, but the bouncing win cascade doesn't
    // stop on its own - it only ever stops via winCascade.clear() (see startNewGame), so without
    // this it would keep animating over a board that's already reverted underneath it.
    if (won) winCascade.clear()
    const myGen = dealTokenRef.current
    const { move, removedCards, state: prevState } = entry

    if (removedCards) {
      await undoRemoval(removedCards, prevState)
      return
    }

    // A recycle move (see handleDrawStock's own recycle branch) - the whole waste became the new
    // stock, so there's no single anchor card still sitting at state.waste's top to measure the
    // usual way. Reverse it as its own group-ghost flight instead (see undoRecycle/PATTERN_RECYCLE).
    if (move && move.from.zone === 'waste' && move.to.zone === 'stock') {
      await undoRecycle(move, prevState)
      return
    }

    if (!move) {
      // Nothing will ever fly for this undo - claim and immediately settle, so undoBusyRef clears
      // through the same accounting path every other branch uses instead of a bare direct clear.
      startFlights(1)
      setUndoStack((stack) => stack.slice(0, -1))
      commitState(prevState)
      setSelected(null)
      settleFlight()
      return
    }

    const movingCard = current.waste[current.waste.length - 1]
    // Claimed up front, before this function's own awaits, like undoRecycle's: the count stays accurate for as long as this undo
    // is genuinely outstanding.
    const settle = claimFlight()
    const [origin, stockPos] = await Promise.all([movingCard && movingCard.id === move.anchorCardId ? measureCardOrigin(move.to, move.anchorCardId) : null, measureView(stockViewRef.current)])
    // A New Game tapped mid-measurement already replaced the board, the undo stack and undoBusyRef
    // - committing prevState now would overwrite the fresh deal with the old game's board.
    if (dealTokenRef.current !== myGen) {
      settle()
      return
    }

    setUndoStack((stack) => stack.slice(0, -1))
    setSelected(null)

    if (origin && stockPos && movingCard) {
      playCardSound()
      hapticCard()
      const flight = trackFlight(ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y }))
      const flyingId = beginFlying(move.from, move.count)
      // The card is on its way back to the stock: the slot keeps its pre-flight look (frozen, see StockWaste's stockHidden) until
      // the ghost lands, instead of showing the returned card the instant the state reverts.
      setStockHidden(true)
      commitState(prevState)
      flight.flyTo(stockPos.x, stockPos.y, () => {
        untrackFlight(flight)
        setStockHidden(false)
        endFlying(flyingId)
        settle()
      })
    } else {
      commitState(prevState)
      settle()
    }
  }

  // Reverses a stock recycle (see handleDrawStock's recycle branch): the recycled cards fly back
  // from the stock slot to the waste slot as one group-ghost flight, the mirror image of the
  // forward flight. Unlike undoRemoval, both endpoints here are plain container refs (stockViewRef/
  // wasteViewRef), not per-card CardRegistry lookups, so - like the forward flight - no post-commit
  // deferral is needed; both can be measured synchronously before prevState is even applied. Guards
  // against a "New Game" tapped mid-measurement the same way runDeal/runWinCascade do elsewhere in
  // this file.
  async function undoRecycle(move: MoveInfo, prevState: PyramidState) {
    const myGen = dealTokenRef.current
    // Claimed up front, before this function's own await - closes the same window
    // PATTERN_OVERLAP_GATE protects everywhere else (an undo already holds undoBusyRef, so nothing
    // else can start meanwhile, but the claim keeps activeFlightCountRef accurate for as long as
    // this flight is genuinely outstanding).
    const settle = claimFlight()
    const [stockOrigin, wasteDest] = await Promise.all([measureView(stockViewRef.current), measureView(wasteViewRef.current)])

    if (dealTokenRef.current !== myGen) {
      // New Game was tapped mid-measurement - drop this stale undo-of-recycle entirely rather than
      // overwrite whatever startNewGame already applied (same reasoning as handleUndo's own
      // mismatch branch). Deliberately skip setUndoStack/setSelected/setState here too -
      // startNewGame already reset the undo stack, selection, board, claims and undoBusyRef for
      // the new game - settle is a no-op for this stale claim (see claimFlight), just call it.
      settle()
      return
    }

    setUndoStack((stack) => stack.slice(0, -1))
    setSelected(null)

    if (!stockOrigin || !wasteDest || prevState.waste.length === 0) {
      commitState(prevState)
      settle()
      return
    }

    // prevState.waste is exactly the set of cards this undo restores, in their original
    // (pre-recycle, face-up) order - the same cards currently sitting reversed/face-down in
    // state.stock.
    const cards = prevState.waste
    playCardSound()
    hapticCard()
    // The stock is the pile these cards LEAVE, so it empties as they take off (no stockHidden: freezing it kept a back on the
    // stock for the whole flight). The ghost is the stock as it looked, face down - drawn in the commit it mounts, so the
    // stock never empties under a ghost not on screen yet - and it turns up on the waste as it lands, the mirror image of the
    // recycle. One back stands for the pile (a stack only shows its top, and every back is an SVG), carrying the id of the
    // card that ends on top of the waste, so the landed ghost stays until that face has painted.
    const flight = trackFlight(ghost.show({ cards: [{ ...cards[cards.length - 1], faceUp: false }], offsetStep: 0, cardWidth }, { x: stockOrigin.x, y: stockOrigin.y }))
    const flyingId = beginFlying({ zone: 'waste', index: 0 }, move.count)
    commitState(prevState)
    flight.flyTo(wasteDest.x, wasteDest.y, () => {
      untrackFlight(flight)
      endFlying(flyingId)
      settle()
    })
  }

  // Undoing a pairing/King removal: each removed card flies independently from the discard pile
  // (where it currently, physically sits) back to its own original spot - the mirror image of the
  // forward removal flight (which shares one destination but starts from independent origins;
  // this shares one origin but ends at independent destinations - see PairFlightCardSpec).
  //
  // EVERY endpoint is resolved BEFORE anything commits, and the revert, the hide flags and the
  // ghosts then land in ONE synchronous stretch (one React commit): the discard pile's origin and
  // the triangle container are plain always-mounted views, a pyramid cell's spot is pure math from
  // the triangle, and a waste-bound card's spot is the waste slot's own container (the same place
  // its registration would say - there is one waste slot). Resolving them after the commit, as this
  // used to, left the restored cards visible NOWHERE for a frame or two - the discard already
  // showing its older top, the cards hidden, their ghosts not mounted yet - and then popped the
  // ghosts in. Hiding the restored card(s) shares that commit for the same reason as always: a
  // restored card must never flash fully visible before its ghost covers it (startNewGame's
  // setPyramidHiddenIds(dealtIds) relies on the same batching for the initial deal).
  async function undoRemoval(removed: RemovedCardRef[], prevState: PyramidState) {
    const myGen = dealTokenRef.current
    // Claimed up front, before the awaits, like undoRecycle's.
    const settle = claimFlight()
    const needsTriangle = removed.some((r) => r.ref.zone === 'pyramid')
    const needsWaste = removed.some((r) => r.ref.zone === 'waste')
    const [discardOrigin, triangleOrigin, wasteOrigin] = await Promise.all([measureView(discardViewRef.current), needsTriangle ? measureView(triangleViewRef.current) : null, needsWaste ? measureView(wasteViewRef.current) : null])
    // A New Game tapped mid-measurement already replaced the board, the undo stack and undoBusyRef
    // (see handleUndo) - applying prevState now would overwrite the fresh deal.
    if (dealTokenRef.current !== myGen) {
      settle()
      return
    }

    setUndoStack((stack) => stack.slice(0, -1))
    setSelected(null)

    // A card whose spot cannot be resolved (a rare measurement failure) simply has no ghost and is not hidden: it reappears where
    // it belongs rather than being left invisible waiting for a flight that will never exist.
    const specs: PairFlightCardSpec[] = []
    if (discardOrigin) {
      for (const entry of removed) {
        const card = cardAt(prevState, entry.ref)
        let to: ScreenPoint | null = wasteOrigin
        if (entry.ref.zone === 'pyramid') {
          const { row, col } = rowColOf(entry.ref.index)
          to = triangleOrigin ? pyramidCellScreenPoint(triangleOrigin, row, col, cardWidth, gap, rotation) : null
        }
        if (card && to) specs.push({ card, from: discardOrigin, to })
      }
    }
    if (specs.length === 0) {
      commitState(prevState)
      settle()
      return
    }

    playCardSound()
    hapticCard()

    const flownIds = new Set(specs.map((spec) => spec.card.id))
    const pyramidIds = removed.filter((r) => r.ref.zone === 'pyramid' && flownIds.has(r.cardId)).map((r) => r.cardId)
    if (pyramidIds.length > 0) setPyramidHiddenIds((ids) => new Set([...ids, ...pyramidIds]))
    // Only a waste-bound restoration needs a `flying` entry (hiding the real waste card until the ghost lands there) - a
    // pyramid-bound one is already covered by pyramidHiddenIds above. handlePairFlightLanded ends it with the flight.
    const wasteCard = removed.find((r) => r.ref.zone === 'waste' && flownIds.has(r.cardId))
    startPairFlight(specs, wasteCard ? { id: beginFlying({ zone: 'waste', index: 0 }, 1), cardId: wasteCard.cardId } : null, settle)
    commitState(prevState)
  }

  function refsEqual(a: PileRef, b: PileRef): boolean {
    return a.zone === b.zone && a.index === b.index
  }

  function handleSelectPyramid(index: number, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state) return
    const card = state.pyramid[index]
    if (!card) return
    const { row, col } = rowColOf(index)
    if (!isExposed(state.pyramid, row, col)) return

    const ref: PileRef = { zone: 'pyramid', index }

    // Kings never pair with anything (no rank sums to 13 with one), so removing one is always a
    // standalone action - a single tap removes it immediately instead of needing a confirming
    // second tap the way an actual two-card pair does. This also clears/overrides any unrelated
    // card that happened to be selected, since a King tap was never going to complete that pair.
    if (card.rank === 13) {
      attemptMove(ref, ref, measure)
      return
    }

    if (selected && refsEqual(selected, ref)) {
      // Tapping the same selected card again deselects. Never calls measure() - a plain
      // select/deselect has no use for the tapped card's position (see PileView.tsx's onPress
      // doc comment for why that's worth avoiding).
      setSelected(null)
      return
    }

    if (!selected) {
      setSelected(ref)
      return
    }

    attemptMove(selected, ref, measure)
  }

  function handleSelectWaste(measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state) return
    if (state.waste.length === 0) return
    const ref: PileRef = { zone: 'waste', index: 0 }
    const card = state.waste[state.waste.length - 1]

    // Kings never pair with anything - a single tap removes one immediately, same as in the
    // pyramid (see handleSelectPyramid).
    if (card.rank === 13) {
      attemptMove(ref, ref, measure)
      return
    }

    if (selected && refsEqual(selected, ref)) {
      setSelected(null)
      return
    }

    if (!selected) {
      setSelected(ref)
      return
    }

    attemptMove(selected, ref, measure)
  }

  // Each flying card reports here as its own independent flight settles (see
  // PairFlightGhosts/FlyingPairCard). It settles ONLY its own flight: the card is counted as
  // landed on the discard (forward flight) or un-hidden on its pyramid cell (undo of a removal -
  // see undoRemoval; a no-op in the other direction, whose cards were never in pyramidHiddenIds)
  // or un-hidden on the waste (the `flying` entry of a waste-bound undo ends with ITS card, not
  // with the pair), and once THIS flight's last card has landed it settles its own claim - never
  // another flight's. All of that happens on the landing itself; only the card's GHOST is not
  // removed here but marked landed, in this same commit, and stays until the card it revealed has
  // painted (FlyingPairCard's landed hold, which then retires it through retirePairCard) - on its
  // own, never until its partner arrives. A callback for a flight the ledger no longer knows (a New
  // Game replaced the board) does nothing.
  function handlePairFlightLanded(gen: number, cardId: string) {
    const entry = pairFlightLedgerRef.current.get(gen)
    if (!entry || !entry.pending.delete(cardId)) return
    setPairFlights((flights) => flights.map((f) => (f.gen === gen ? { ...f, landed: new Set(f.landed).add(cardId) } : f)))
    setPyramidHiddenIds((ids) => {
      if (!ids.has(cardId)) return ids
      const next = new Set(ids)
      next.delete(cardId)
      return next
    })
    markDiscardLanded(cardId)
    if (entry.flying?.cardId === cardId) endFlying(entry.flying.id)
    if (entry.pending.size > 0) return
    pairFlightLedgerRef.current.delete(gen)
    // clears undoBusyRef once every outstanding completion (this flight's own claim, from whichever
    // direction started it) has reported in.
    entry.settle()
  }

  // A card that flew to the discard pile on a shared ghost (a solo King) lands: count it, then
  // release the flight's claim. `gen` guards the count only - see claimFlight for the claim.
  function flyToDiscardPile(flight: DragFlightHandle, cardId: string, discardPos: ScreenPoint, gen: number, settle: () => void) {
    trackFlight(flight)
    flight.flyTo(discardPos.x, discardPos.y, () => {
      untrackFlight(flight)
      if (dealTokenRef.current === gen) markDiscardLanded(cardId)
      settle()
    })
  }

  // Re-checks a removal against the board as it is NOW, after the awaits (measurements) that sit
  // between deciding on a move and committing it. Everything else that can commit meanwhile - another
  // tap, a stock draw, a drop, all allowed to overlap by PATTERN_OVERLAP_GATE - builds on
  // stateRef.current, so a `result` computed BEFORE the awaits would silently overwrite it (a card
  // reappears, a draw vanishes) or, for a double-tap on a King, commit the same removal twice. The
  // move's own cards must still be exactly where they were (a bare tryMove could succeed with
  // whatever card now sits at a `waste` ref), and the move must still be legal; null means abort -
  // nothing has been committed, the caller just settles its claim.
  function replayMove(from: PileRef, to: PileRef, fromId: string, toId: string): { prev: PyramidState; next: PyramidState } | null {
    const prev = stateRef.current
    if (!prev || cardAt(prev, from)?.id !== fromId || cardAt(prev, to)?.id !== toId) return null
    const next = PyramidController.tryMove(prev, { from, to, count: 1 })
    return next ? { prev, next } : null
  }

  // The synchronous commit stretch every removal ends in (no await between reading the board and
  // committing it): the move is counted, recorded for undo against the board it was really made
  // on, and the cards about to fly to the discard are marked in the air in the SAME commit as the
  // move, so the pile never flashes its new top before the ghosts arrive. A removal that WINS also
  // claims the win sweep here (beginWinSweep), while its own claim is still held, so nothing settles
  // in between and the celebration cannot start before the leftover cards have been dealt.
  function commitRemoval(prev: PyramidState, next: PyramidState, removedCards: RemovedCardRef[], inAir: string[]) {
    session.registerMove()
    pushUndo(prev, null, removedCards)
    // A selection made while this move was deferred (its action clears the selection up front, then may park behind a draw flight
    // for a while, and taps in that window are handled normally) can name a card this very commit removes - typically the
    // waste ref: {waste, 0} means "whatever is on top", so once the top is gone it would silently point at the card that was
    // UNDER it, highlight it, and pair it on the next tap: a move the player never chose. Such a selection is dropped; an
    // unrelated one (another pyramid card, a waste card that stays) is kept.
    setSelected((sel) => (sel && removedCards.some((r) => refsEqual(r.ref, sel)) ? null : sel))
    if (inAir.length > 0) markDiscardInAir(inAir)
    commitState(next)
    playCardSound()
    hapticCard()
    if (PyramidController.isWon(next)) beginWinSweep(prev, next, removedCards, inAir.length > 0)
  }

  // Tap-completed pairing/King removal. The real state change applies immediately (game logic
  // never waits on an animation, same as every other move in this app) - the ghost is purely a
  // visual overlay catching up to an already-true reality, hiding the discard pile's real new top
  // card (via discardInAir/DiscardCell's isFlyingHere) until it visually arrives.
  //
  // Shape, for fast play: decide on the move against the board as it is when tapped (a plain
  // illegal pairing shakes at once, with no measuring); claim the flight and clear the selection
  // synchronously, so undo and any further tap see this move as underway; MEASURE everything (the
  // tapped card, "first" via the registry, the discard pile) in one await; then re-validate the
  // move against the board as it is by then (replayMove) and commit it in one synchronous stretch
  // that ends by starting the flight. Any other tap, draw or drop can commit during the awaits, so
  // committing the pre-await result would overwrite it - a move that no longer applies (the King
  // already removed by a double-tap, "first" consumed by another pair) aborts cleanly instead:
  // no commit, no undo entry, no move counted, no sound, no ghost.
  async function attemptMove(from: PileRef, to: PileRef, measureOrigin: () => Promise<ScreenPoint>) {
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const board = stateRef.current
    if (!board) return
    const isSolo = refsEqual(from, to)
    const fromCard = cardAt(board, from)
    const toCard = isSolo ? fromCard : cardAt(board, to)

    if (!PyramidController.tryMove(board, { from, to, count: 1 }) || !fromCard || !toCard) {
      // Illegal pairing: swap the selection to the newly tapped card instead
      // of just clearing it, so the user doesn't have to tap twice again. Shake the
      // just-tapped card (not the previously-selected one) so the rejection reads as "that
      // one, not this pairing" - same "received, just stuck" feedback the other 3 games give
      // a single stuck card, with a short haptic tap alongside (see shakeAnimation.ts).
      // Deliberately never calls measureOrigin() - an illegal pairing has no use for the
      // tapped card's position, so it skips paying for the measurement at all (see
      // PileView.tsx's onPress doc comment).
      if (toCard) setShake({ cardId: toCard.id, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      setSelected(to)
      return
    }

    const settle = claimFlight()
    const gen = dealTokenRef.current
    setSelected(null)
    // A card the player taps while its own draw ghost is still travelling to the waste (a King drawn and tapped a beat later)
    // waits for that landing: the card arrives, THEN it flies on - measuring the hidden real card now would start this flight
    // from a slot the drawn card has not reached yet, showing it twice. The claim above keeps undo out for the wait.
    const landedOnWaste = () => onWaste(fromCard.id, toCard.id)
    if (!landedOnWaste()) {
      // A loop, re-checked after every resume (see whenLanded) - and given up on once a New Game has replaced the board.
      const budget = startDeferBudget()
      while (dealTokenRef.current === gen && !landedOnWaste() && budget.left() > 0) await whenLanded(landedOnWaste, budget.left())
      if (dealTokenRef.current !== gen) {
        settle()
        return
      }
    }
    // All three measurements are started in this same tick, while the tapped views are certainly
    // still mounted. toOrigin IS the King's own tap position when solo ("first" was selected on a
    // PREVIOUS tap for a pair, so its position comes from the registry - and from its slot if it
    // is not registered, see measureCardOrigin - not from this tap).
    const [toOrigin, fromOrigin, discardPos] = await Promise.all([measureOrigin(), isSolo ? Promise.resolve(null) : measureCardOrigin(from, fromCard.id), measureView(discardViewRef.current)])

    // A New Game tapped mid-measurement already replaced the board and dropped this claim.
    const replay = dealTokenRef.current === gen ? replayMove(from, to, fromCard.id, toCard.id) : null
    if (!replay) {
      settle()
      return
    }

    const kingRemoval: RemovedCardRef[] = [{ cardId: fromCard.id, ref: from }]
    if (isSolo) {
      commitRemoval(replay.prev, replay.next, kingRemoval, discardPos ? [fromCard.id] : [])
      // Only an unmeasurable discard pile (a zero-size or detached view) leaves nothing to fly to.
      if (!discardPos) {
        settle()
        return
      }
      const flight = ghost.show({ cards: [{ ...fromCard, faceUp: true }], offsetStep: 0, cardWidth }, { x: toOrigin.x, y: toOrigin.y })
      flyToDiscardPile(flight, fromCard.id, discardPos, gen, settle)
      return
    }

    // Both cards then fly independently from their two real positions straight to the discard
    // (see startPairFlight) - neither one visits the other first. A card whose position can't be
    // resolved at all (neither its registration nor its slot is measurable) simply has no ghost;
    // only an unmeasurable discard pile - nothing to fly to - commits the pair with no flight.
    const specs: PairFlightCardSpec[] = []
    if (discardPos) {
      if (fromOrigin) specs.push({ card: { ...fromCard, faceUp: true }, from: fromOrigin, to: discardPos })
      specs.push({ card: { ...toCard, faceUp: true }, from: toOrigin, to: discardPos })
    }
    commitRemoval(
      replay.prev,
      replay.next,
      [...kingRemoval, { cardId: toCard.id, ref: to }],
      specs.map((spec) => spec.card.id)
    )
    if (specs.length === 0) {
      settle()
      return
    }
    startPairFlight(specs, null, settle)
  }

  // Drag-completed pairing/King removal - same choreography as attemptMove above, just sourced
  // from a drop instead of a second tap. The dragged ("first") card's own flight already exists by
  // drop time (DraggableCard's own pan gesture calls ghost.showLive() on drag start, and hands that
  // same DragFlightHandle in here as `flight` on a successful drop - see DraggableCard.tsx's
  // onDrop), so a solo (King) drop can fly it on to the discard as-is; a pair instead reads
  // "first"'s current position straight off that same flight, retires it, and hands both cards off
  // to startPairFlight so they can travel to the discard on their own, independent paths. `fromId`
  // is the card this drop was rendered for (the one being dragged): a draw or removal that commits
  // while the hit test is still resolving can change what a `waste` ref points at, and the move
  // must still be that card's. Returning false snaps the dragged card back.
  async function attemptDrop(from: PileRef, fromId: string | undefined, absoluteX: number, absoluteY: number, flight: DragFlightHandle): Promise<boolean> {
    if (undoBusyRef.current) return false // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    if (!stateRef.current) return false
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target) return false

    // From here to the claim below is one synchronous stretch (the hit test above is the only
    // await before it), so undo cannot slip in between the board check and the claim.
    if (undoBusyRef.current) return false
    const board = stateRef.current
    if (!board || !fromId) return false
    const isSolo = refsEqual(from, target)
    const fromCard = cardAt(board, from)
    const toCard = isSolo ? fromCard : cardAt(board, target)
    if (!fromCard || !toCard || fromCard.id !== fromId || !PyramidController.tryMove(board, { from, to: target, count: 1 })) return false

    const settle = claimFlight()
    const gen = dealTokenRef.current
    setSelected(null)
    // Same wait as attemptMove's: a card dragged (or dropped onto) while its own draw ghost is still travelling to the waste
    // lets that flight land first. The dragged ghost simply rests at the drop point meanwhile.
    const landedOnWaste = () => onWaste(fromCard.id, toCard.id)
    if (!landedOnWaste()) {
      const budget = startDeferBudget()
      while (dealTokenRef.current === gen && !landedOnWaste() && budget.left() > 0) await whenLanded(landedOnWaste, budget.left())
    }
    // "second" (target)'s exact position isn't necessarily where the pointer released (anywhere
    // within its drop-zone hit-box counts) - measure it via the registry (or its slot) before the
    // commit unmounts it.
    const [toOrigin, discardPos] = await Promise.all([isSolo ? Promise.resolve(null) : measureCardOrigin(target, toCard.id), measureView(discardViewRef.current)])

    if (dealTokenRef.current !== gen) {
      // A New Game tapped mid-drop: the old board is gone, so there is nothing to land on or snap
      // back to - retire the dragged ghost.
      flight.hide()
      settle()
      return true
    }
    const replay = replayMove(from, target, fromCard.id, toCard.id)
    if (!replay) {
      settle()
      return false
    }

    const removed: RemovedCardRef[] = isSolo
      ? [{ cardId: fromCard.id, ref: from }]
      : [
          { cardId: fromCard.id, ref: from },
          { cardId: toCard.id, ref: target }
        ]
    if (isSolo) {
      commitRemoval(replay.prev, replay.next, removed, discardPos ? [fromCard.id] : [])
      if (!discardPos) {
        flight.hide()
        settle()
        return true
      }
      flyToDiscardPile(flight, fromCard.id, discardPos, gen, settle)
      return true
    }

    // "first" is still mid-drag in `flight` (wherever the pointer released it, not necessarily
    // "second"'s own position) - read its current screen position straight off its shared values
    // before retiring that flight: from here the pair flies independently instead.
    const fromOrigin = { x: flight.originX.value + flight.dx.value, y: flight.originY.value + flight.dy.value }
    const specs: PairFlightCardSpec[] = []
    if (discardPos) {
      specs.push({ card: { ...fromCard, faceUp: true }, from: fromOrigin, to: discardPos })
      if (toOrigin) specs.push({ card: { ...toCard, faceUp: true }, from: toOrigin, to: discardPos })
    }
    commitRemoval(
      replay.prev,
      replay.next,
      removed,
      specs.map((spec) => spec.card.id)
    )
    if (specs.length === 0) {
      flight.hide()
      settle()
      return true
    }
    // The drag ghost stays (resting where it was dropped) until the pair's own ghosts show - see PairFlightState.onShown.
    startPairFlight(specs, null, settle, { cardIds: toOrigin ? [toCard.id] : [], onShown: () => flight.hide() })
    return true
  }

  // Mirrors Klondike's handleDrawStock: a ghost copy of the newly-drawn card flies from the stock
  // pile to the waste slot, landing once the pendingFlightRef effect above measures its real
  // (already re-rendered) position. The draw is decided on the board as tapped, but what is
  // actually drawn - or recycled - is worked out from the board as it is once the measurements are
  // back (see attemptMove for why): three rapid taps must draw three DIFFERENT cards, and a draw
  // racing a removal must build on it instead of overwriting it.
  async function handleDrawStock() {
    if (won || !state) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const board = stateRef.current
    if (!board || !PyramidController.drawStock!(board)) return
    // Claimed up front, before the await, covering whichever branch this draw turns out to be
    // (recycle or plain draw) - exactly one outstanding completion either way, matching
    // Klondike's own handleDrawStock.
    const settle = claimFlight()
    const gen = dealTokenRef.current

    // Both containers are always mounted and card-sized, so they are measured whichever branch
    // the re-validated draw below turns out to be.
    const [stockPos, wastePos] = await Promise.all([measureView(stockViewRef.current), measureView(wasteViewRef.current)])
    // A draw needs a quiet stock and waste. While a recycle's group ghost is still flying into the stock, the stock slot is frozen on
    // its pre-flight (empty) look, so a card drawn now would emerge from an empty slot; and a recycle (stock already empty) taken
    // while a drawn card is still flying to the waste would pick that card up twice, in the group ghost and in its own. Plain draws
    // overlap each other freely - only these two pairings wait. Checked AFTER the measurement, not before: a second tap made while
    // the first draw is still measuring has not seen that draw become a recycle yet, but by the time its own measurement is back
    // the first has committed and flagged the flight (and the check does not yield when nothing is in the way, so an earlier tap's
    // commit and flight start are never interleaved with a later one's). The claim above keeps undo out for the wait.
    const quiet = () => !recycleAirRef.current && !(stateRef.current?.stock.length === 0 && wasteInAirRef.current.size > 0)
    // A LOOP, re-checked after every resume (see whenLanded): `quiet` is not monotonic. Several taps parked on the same landing
    // all resolve together, and the first to run may itself be a recycle - it flags recycleAirRef and freezes the stock - after
    // which the next must wait again for THAT flight instead of drawing from the freshly recycled stock while the group ghost is
    // still flying into it. (The reverse pairing - a recycle behind a draw still in the air - is the same predicate, so the same
    // loop.) Checked in the same synchronous stretch as the draw/recycle below, which has no await before its commit.
    const budget = startDeferBudget()
    while (dealTokenRef.current === gen && !quiet() && budget.left() > 0) await whenLanded(quiet, budget.left())
    // A New Game tapped mid-measurement already replaced the board and dropped this claim - drop
    // this stale draw entirely rather than overwrite what startNewGame applied.
    const latest = dealTokenRef.current === gen ? stateRef.current : null
    const result = latest && PyramidController.drawStock!(latest)
    if (!latest || !result) {
      settle()
      return
    }
    session.registerMove()

    const drawnCard = result.waste[result.waste.length - 1]
    if (!drawnCard) {
      // Recycle: stock was empty, so PyramidController.drawStock! just flipped the whole waste
      // back over into a new (reversed, face-down) stock - see rules.ts's drawStock. Animate it as
      // one group-ghost flight from the waste slot to the stock slot (same idiom a dragged
      // multi-card run uses: one shared origin/destination for the whole clump), not a per-card
      // deal-style flight - see PATTERN_RECYCLE. Both endpoints are plain container refs, so no
      // post-commit deferral is needed.
      const recycledCards = latest.waste.slice()
      const recycleMove: MoveInfo = { from: { zone: 'waste', index: 0 }, to: { zone: 'stock', index: 0 }, count: recycledCards.length, anchorCardId: recycledCards[0].id }
      // Recorded with its move even when nothing can fly, so undoing it can still animate (undoRecycle
      // measures for itself).
      pushUndo(latest, recycleMove)
      commitState(result)
      setSelected(null)
      if (!wastePos || !stockPos) {
        settle()
        return
      }
      playCardSound()
      hapticCard()
      const flight = trackFlight(ghost.show({ cards: recycledCards, offsetStep: 0, cardWidth }, { x: wastePos.x, y: wastePos.y }))
      const flyingId = beginFlying({ zone: 'stock', index: 0 }, recycledCards.length)
      setStockHidden(true)
      recycleAirRef.current = true
      flight.flyTo(stockPos.x, stockPos.y, () => {
        untrackFlight(flight)
        if (dealTokenRef.current === gen) {
          recycleAirRef.current = false
          setStockHidden(false)
          notifyLanded()
        }
        endFlying(flyingId)
        settle()
      })
      return
    }
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }
    pushUndo(latest, move)
    commitState(result)
    setSelected(null)
    if (!stockPos) {
      // Only an unmeasurable stock pile (a zero-size or detached view) leaves nothing to fly from.
      settle()
      return
    }

    playCardSound()
    hapticCard()
    const flight = trackFlight(ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth }, { x: stockPos.x, y: stockPos.y }))
    const flyingId = beginFlying({ zone: 'waste', index: 0 }, 1)
    markWasteInAir(drawnCard.id)
    pendingFlightRef.current.push({ cardId: drawnCard.id, gen, flyingId, flight, settle })
  }

  // Finds one legal move (a pairing/solo King) or a stock-draw suggestion to highlight - see
  // engine/hint.ts's findHint, which reuses this game's own legalMoves(). Only highlights; the
  // player still taps/drags the suggested card(s) through the normal flow.
  function handleHint(request?: HintRequest) {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(PyramidController, state, skip)
    if (result.kind === 'none') {
      if (!request?.auto) infoToast('No helpful moves right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('pyramid')
    if (result.kind === 'move') {
      const { from, to } = result.move
      const cardAt = (ref: PileRef) => (ref.zone === 'waste' ? state.waste[state.waste.length - 1] : state.pyramid[ref.index]) ?? undefined
      const card = cardAt(from)
      // A pair glides one card onto its partner; a lone King glides to the discard (not a drop zone: its own container).
      const king = refsEqual(from, to)
      const partner = king ? undefined : cardAt(to)
      if (card) void playHintGlide({ moving: [card], dest: partner ? [partner] : [], destFanned: false, measureSlot: king ? () => measureView(discardViewRef.current) : undefined, cardWidth })
    }
  }

  // The triangle cells' press and drop handlers: STABLE for the screen's lifetime, so the memoized PyramidCell is not
  // re-rendered by every screen render (see its comment), and reading the latest render's handlers through this ref - the
  // way PileView's `latest` does. Refreshed in a layout effect, so a tap or drop arriving right after a commit already
  // runs that commit's handlers, exactly as the inline closures every cell used to be handed did.
  const cellHandlersRef = useRef({ handleSelectPyramid, attemptDrop })
  useLayoutEffect(() => {
    cellHandlersRef.current = { handleSelectPyramid, attemptDrop }
  })
  const onSelectCell = useCallback((index: number, measure: () => Promise<ScreenPoint>) => cellHandlersRef.current.handleSelectPyramid(index, measure), [])
  const onDropCell = useCallback((index: number, cardId: string, absoluteX: number, absoluteY: number, flight: DragFlightHandle) => cellHandlersRef.current.attemptDrop({ zone: 'pyramid', index }, cardId, absoluteX, absoluteY, flight), [])

  if (!state) return <GameLoading />

  const width = triangleWidth(cardWidth, gap)
  const height = triangleHeight(cardWidth)
  // A won board's stock/waste were folded into the discard by the winning move itself (rules.ts's sweepRemainderOnWin), but
  // the cards did not get there yet - they are dealt onto it one by one (see the win sweep above). Until each pile's last card
  // has taken off, the board keeps showing that pile as it was before the fold (SweepUi.view): they empty as their cards leave,
  // not the instant the last pair is removed. The discard shows the topmost card that has LANDED under the flying ones
  // (discardInAir marks the winning removal's cards and every leftover from the winning commit, and each lands one by one), so
  // its top is always a card that really arrived. When the discard could not be measured at the winning move nothing flies
  // (`flies` false): the board then simply stays as the finished board showed it - the pre-fold discard and piles - under the
  // banner. Once the cascade has taken over (cascadeHandoff, once its ghosts are on screen) the discard blanks too.
  const handoff = winRevealed && cascadeHandoff?.state === state ? cascadeHandoff : null
  const sweep = sweepUi && sweepUi.state === state ? sweepUi : null
  const stockCards = handoff ? NO_CARDS : sweep ? (sweep.stockGone ? NO_CARDS : sweep.view.stockCards) : state.stock
  const wasteCards = handoff ? NO_CARDS : sweep ? (sweep.wasteGone ? NO_CARDS : sweep.view.wasteCards) : state.waste
  const discardCards = sweep && !sweep.flies ? sweep.view.discardCards : state.discard
  const wasteTop = wasteCards[wasteCards.length - 1]
  // While cards are still flying to the discard, the pile shows the topmost card that has landed
  // under their ghosts, so it stays right as each of several overlapping flights arrives. The waste
  // does the same while drawn cards are still flying to it - see StockWaste's settledWasteTop.
  const discardFlying = discardInAir.size > 0
  const discardSettled = discardFlying ? topLandedCard(discardCards, discardInAir) : undefined
  const settledWasteTop = wasteInAir.size > 0 ? topLandedCard(wasteCards, wasteInAir) : undefined

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Pyramid' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} autoHintKey={state} hintShowing={!!activeHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} pauseClock={session.setPaused} par={parFor('pyramid')} clockRunning={session.started && !won} movesCount={session.moves} rules={PYRAMID_RULES}>
        <View style={styles.board}>
          <View style={[styles.controlRow, { width }]}>
            <DiscardCell card={handoff ? undefined : discardCards[discardCards.length - 1]} isFlyingHere={discardFlying} settledCard={discardSettled} viewRef={discardViewRef} />
            <StockWaste gap={gap} dropZones={dropZones} stockTopCard={stockCards[stockCards.length - 1]} wasteTop={wasteTop} wasteUnder={wasteCards[wasteCards.length - 2]} wasteSelected={!!selected && selected.zone === 'waste'} wasteHinted={pairHinted({ zone: 'waste', index: 0 })} stockHinted={activeHint?.kind === 'drawStock'} wasteHiddenCount={flying.some((f) => f.to.zone === 'waste') ? 1 : 0} settledWasteTop={settledWasteTop} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} onDrawStock={handleDrawStock} onWastePress={handleSelectWaste} onWasteDrop={(x, y, flight) => attemptDrop({ zone: 'waste', index: 0 }, state.waste[state.waste.length - 1]?.id, x, y, flight)} stockRef={stockViewRef} wasteRef={wasteViewRef} stockHidden={stockHidden} />
          </View>

          <View ref={triangleViewRef} collapsable={false} style={[styles.triangle, { width, height }]}>
            {/* One memoized cell per index, keyed by the cell - see PyramidCell. Every prop is a primitive (or stable), so
            only the cells whose own state changed re-render. */}
            {state.pyramid.map((card, index) => {
              const { row, col } = rowColOf(index)
              const { left, top } = cardPosition(row, col, cardWidth, cardHeight, gap)
              return <PyramidCell key={index} index={index} card={card} exposed={isExposed(state.pyramid, row, col)} hidden={!!card && pyramidHiddenIds.has(card.id)} selected={!!selected && selected.zone === 'pyramid' && selected.index === index} hinted={pairHinted({ zone: 'pyramid', index })} shakeToken={card && shake?.cardId === card.id ? shake.token : undefined} dimHeld={dimAfterDeal.held} left={left} top={top} zIndex={row} dropZones={dropZones} onSelect={onSelectCell} onDrop={onDropCell} />
            })}
          </View>
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    dialog comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it (also backstopped by WinBanner's own explicit zIndex). */}
      {winRevealed && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <PairFlightGhosts flights={pairFlights} onCardLanded={handlePairFlightLanded} onCardRetired={retirePairCard} />
      <WinCascadeGhosts />
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} par={parFor('pyramid')} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles() {
  return StyleSheet.create({
    // GameChrome's own content area now centers a natural-width board itself (see GameChrome.tsx's
    // GAME_CONTENT_MAX_WIDTH/ContentGutter wiring) - board no longer needs width:'100%' to opt into
    // that. alignItems:'center' still does its own separate job here: centering controlRow (narrower
    // than triangle) within board's own width, which now naturally shrinks to match triangle's real
    // width instead of an artificial full-window one.
    board: {
      alignItems: 'center'
    },
    controlRow: {
      // Spans the triangle's own full width (set inline via the `width` prop) and spaces its two
      // children apart - discard on the left, waste+stock on the right, so stock still lands on
      // the same right edge every other game's stock does (Klondike/Spider/Canfield's right edge,
      // Golf's right-aligned topRow) while discard gets its own distinct spot on the left instead
      // of sitting clustered right next to waste.
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 20
    },
    // zIndex below (`row`) only stays scoped to this container if the container itself
    // establishes a stacking context - position:relative alone doesn't, without its own zIndex
    // (see PileView.tsx's identical fix for its tableau fan). Without this, a row's zIndex leaks
    // out to compete with the screen-level drag/deal ghost overlays, which lost that fight past
    // row 0, rendering "under" the triangle mid-flight.
    triangle: {
      marginBottom: 20,
      position: 'relative',
      zIndex: 0
    }
  })
}
