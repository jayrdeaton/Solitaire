// Pyramid solitaire screen: triangle tap-to-select board + stock/waste row.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CARD_ASPECT, CardSizeProvider, type TableColors } from '@tastic/cards'
import { computeContentBounds, useRotatedWindowDimensions } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { SharedValue, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'

import { cardLayoutForRow } from '@/components/cardLayout'
import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView, ScreenPoint } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { autoMoveSpringFor } from '@/components/dragdrop/dragSpring'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PlayingCard } from '@/components/PlayingCard'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { PYRAMID_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { clampCardWidthForHeight } from '@/games/shared/clampCardWidthForHeight'
import { DiscardCell } from '@/games/shared/DiscardCell'
import { MoveInfo } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { buildPyramidDealSequence } from './dealSequence'
import { cardAt, isExposed, PyramidController, PyramidState, rowColOf } from './rules'

const ROWS = 7

/** One card's original spot, recorded so undoing a pairing/King removal can fly it back there
 * (see handleUndo's undoRemoval branch) instead of just reappearing there instantly. ref.zone is
 * always 'pyramid' or 'waste' - the only two zones tryMove ever accepts a removal from. */
interface RemovedCardRef {
  cardId: string
  ref: PileRef
}

interface UndoEntry {
  state: PyramidState
  /** Non-null for a stock draw (the only MoveInfo-shaped move this game has - see handleUndo's
   * `viaStock` branch). Mutually exclusive with `removedCards` below - a stock draw and a
   * pairing/King removal are never the same move. */
  move: MoveInfo | null
  /** Non-null for a pairing/King removal - always 1 (a solo King) or 2 (a pair) entries, since
   * Pyramid removals are never more than a pair. Mutually exclusive with `move` above. */
  removedCards: RemovedCardRef[] | null
}

/** Each card's own leg gets its own origin AND destination - unlike the forward (removal) flight,
 * where every card shares one destination (the discard pile), an undo-of-removal flight has every
 * card share one ORIGIN (the discard pile) but fly to its own distinct destination instead. Both
 * shapes fit the same per-card {from, to} spec - see flyPairIndependently vs. undoRemoval below. */
interface PairFlightCardSpec {
  card: Card
  from: ScreenPoint
  to: ScreenPoint
}

interface PairFlightState {
  gen: number
  cardWidth: number
  cards: PairFlightCardSpec[]
}

/** One card's independent leg of a pair's removal flight (see PairFlightGhosts) - its own spring,
 * scaled to its own distance from the discard pile, the same distance-scaled shape every other
 * flight in this app uses (see dragSpring.ts's autoMoveSpringFor), so a card starting closer
 * settles sooner than one starting further away instead of both being forced to move in lockstep.
 * Settlement is a plain timer matching the spring's own duration rather than the spring's
 * completion callback - confirmed elsewhere in this codebase (DragGhostLayer.tsx/DealLayer.tsx)
 * not to reliably fire on this app's web target. */
function FlyingPairCard({ card, from, to, containerOffsetX, containerOffsetY, onLanded }: { card: Card; from: ScreenPoint; to: ScreenPoint; containerOffsetX: SharedValue<number>; containerOffsetY: SharedValue<number>; onLanded: () => void }) {
  const tx = useSharedValue(from.x)
  const ty = useSharedValue(from.y)
  const notified = useRef(false)

  useEffect(() => {
    const config = autoMoveSpringFor(Math.hypot(to.x - from.x, to.y - from.y))
    tx.value = withSpring(to.x, config)
    ty.value = withSpring(to.y, config)
    const timer = setTimeout(() => {
      if (notified.current) return
      notified.current = true
      onLanded()
    }, config.duration ?? 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value - containerOffsetX.value }, { translateY: ty.value - containerOffsetY.value }]
  }))

  return (
    <Animated.View style={[pairFlightStyles.ghostCard, style]}>
      <PlayingCard card={card} />
    </Animated.View>
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
  }
})

/** Renders Pyramid's pair-removal flight: "first" and "second" travel to the discard pile
 * independently, each from its own real position, rather than through the single shared `ghost`
 * (DragGhostLayer), which only ever animates one origin/delta for its whole group at a time - see
 * PyramidScreenInner's flyPairIndependently. Same "N independent simultaneous ghosts" idiom
 * DealLayer/WinCascadeLayer already use, for the same reason the single-slot drag ghost can't do
 * it (see DealLayer.tsx's doc comment). Always mounted (only `flight`'s presence is conditional)
 * so its own offset-correction effect can measure a real position at all times, same reasoning as
 * those two. */
function PairFlightGhosts({ flight, onCardLanded }: { flight: PairFlightState | null; onCardLanded: (gen: number, cardId: string) => void }) {
  const overlayRef = useRef<View>(null)
  const containerOffsetX = useSharedValue(0)
  const containerOffsetY = useSharedValue(0)
  // Rotation-aware, same reasoning as DragGhostLayer/DealLayer's identical overlay-offset pattern.
  const { width: winWidth, height: winHeight } = useRotatedWindowDimensions()

  useEffect(() => {
    overlayRef.current?.measureInWindow((x, y) => {
      containerOffsetX.value = x
      containerOffsetY.value = y
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winWidth, winHeight])

  return (
    <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
      {flight && (
        <CardSizeProvider width={flight.cardWidth}>
          {flight.cards.map(({ card, from, to }) => (
            <FlyingPairCard key={`${flight.gen}-${card.id}`} card={card} from={from} to={to} containerOffsetX={containerOffsetX} containerOffsetY={containerOffsetY} onLanded={() => onCardLanded(flight.gen, card.id)} />
          ))}
        </CardSizeProvider>
      )}
    </View>
  )
}

// The triangle's widest row is the base: ROWS cards laid out with no overlap, so it reuses
// cardWidthForRow's clamping/fit math as a plain "row of ROWS columns" with a real gap.
const TRIANGLE_WIDTH_UNITS = ROWS

function triangleWidth(cardWidth: number, gap: number): number {
  return cardWidth * ROWS + gap * (ROWS - 1)
}

// gap: the render-scoped value from this file's own cardLayoutForRow call - horizontal gap between
// cards within a row (no overlap, so corner pips stay visible), same floor as every other game's
// tableau/pile row (see components/cardLayout.ts).
function cardPosition(row: number, col: number, cardWidth: number, cardHeight: number, gap: number): { left: number; top: number } {
  const width = triangleWidth(cardWidth, gap)
  const rowWidth = cardWidth * (row + 1) + gap * row
  const rowLeftStart = (width - rowWidth) / 2
  const left = rowLeftStart + col * (cardWidth + gap)
  // Rows cascade vertically like a FreeCell cascade - same offset ratio, so only the row below
  // (drawn on top, per its higher zIndex) overlaps the bottom of the row above.
  const top = row * (cardHeight * FACE_UP_OFFSET_RATIO)
  return { left, top }
}

export default withGameProviders(PyramidScreenInner)

function PyramidScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  // Rotation-aware (swaps width/height when rendered inside a rotated wrapper) - exact identity
  // with plain useWindowDimensions() otherwise, see the rotation plan.
  const { width: winWidth } = useRotatedWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const { cardWidth: widthCardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TRIANGLE_WIDTH_UNITS)
  // Pyramid has no PileView/height-budget concept - the triangle's own height is a pure function of
  // cardWidth (see `height` below), so a landscape hold's much wider available width could otherwise
  // drive cardWidth (and therefore triangle height) taller than the now-shorter viewport can fit.
  // Clamps cardWidth by BOTH axes: reuses useTableauMaxHeight's own "how much vertical room is
  // there" budget (built for PileView's maxHeight, but the underlying available-height question is
  // the same one) to back-solve the largest cardWidth whose resulting triangle height still fits,
  // fed the width-derived cardWidth since the correction term it needs (topRowHeight) only matters
  // at second order here.
  const availableHeight = useTableauMaxHeight(widthCardWidth, 0)
  const cardWidth = clampCardWidthForHeight(widthCardWidth, availableHeight, ROWS - 1, FACE_UP_OFFSET_RATIO, CARD_ASPECT)
  const cardHeight = cardWidth / CARD_ASPECT
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with each
  // other - PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`,
  // `commitState`, `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working
  // unchanged. `shrinkFlying` is unused here - Pyramid never lands a multi-card flight one card at a
  // time (no draw-3-style fan; a recycle/pair flight always lands as one group completion).
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, activeFlightCountRef, startFlights, settleFlight, undoBusyRef, reset: resetFlightConcurrency } = useFlightConcurrency<PyramidState>()
  const [selected, setSelected] = useState<PileRef | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: PyramidState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
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
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const ghost = useDragGhost()
  // True while the stock slot's real content is mid-flight elsewhere (a stock recycle, either
  // direction - see handleDrawStock's recycle branch / undoRecycle) and should stay frozen on its
  // pre-flight appearance instead of instantly revealing the new one - see StockWaste's own
  // `stockHidden` doc comment.
  const [stockHidden, setStockHidden] = useState(false)
  /** Flights awaiting their post-commit measurement + ghost.flyTo (see the effect below) - queued by
   * handleDrawStock once the drawn card's own render has been committed, or by handleUndo when
   * reversing a draw. A list (not a single slot) since these can now genuinely overlap (see
   * PATTERN_OVERLAP_GATE): rapid stock-draw taps can each still be awaiting their own measurement
   * when the next one starts, so a single ref slot would let a later entry clobber an earlier one,
   * permanently stranding it - see stateRef's own doc comment for the identical rapid-tap race this
   * mirrors. `viaStock` measures via stockViewRef (a plain View, not per-card) instead of
   * CardRegistry - only undoing a draw flies back toward the stock; drawing itself flies to the
   * real per-card-registered waste slot. `gen` is the dealTokenRef value captured at the moment
   * this flight was queued - re-checked once the async measurement below resolves, so a flight
   * queued against a game that's since been replaced by "New Game" doesn't measure/land against
   * the new deal's DOM (card ids are shuffle-independent and reused across deals - see deck.ts).
   * `flyingId` removes exactly this entry's own `flying` array entry once it lands. Mirrors
   * Klondike's own pendingFlightRef exactly. */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  const winCascade = useWinCascade()
  // Derived from `state` every render (see useDerivedWinCheck) rather than mirrored into its own
  // useState: it's a pure function of state, so Undo-ing out of a won position correctly drops the
  // win banner immediately, rather than leaving it stuck showing.
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(PyramidController, state, 'pyramid', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** Pyramid's pair-removal flight - both cards travel to the discard pile independently, each
   * from its own real position (see flyPairIndependently/PairFlightGhosts below), rather than
   * through the single shared `ghost` above, which can only ever animate one origin/delta for its
   * whole group and so can't have two cards converge from different starting points at once. */
  const [pairFlight, setPairFlight] = useState<PairFlightState | null>(null)
  const pairFlightGenRef = useRef(0)
  const pairFlightTotalRef = useRef(0)
  const pairFlightLandedRef = useRef(0)
  /** The `flying` array entry id (if any) covering the CURRENT pair-flight generation, set by
   * whichever direction started it (startPairFlight's own `flyingId` param) - a forward
   * (discard-bound) flight always has one; an undo-of-removal flight only has one when a removed
   * card is headed back to the waste (see undoRemoval's `wasteFlyingId`). Read once, in
   * handlePairFlightLanded's all-landed branch, to end that entry - null-checked there since a
   * pyramid-only undo-of-removal never creates one. */
  const pairFlightFlyingIdRef = useRef<number | null>(null)
  /** Stashed by handleUndo's undoRemoval, resolved by the effect below once prevState has actually
   * committed - mirrors pendingFlightRef's own shape, but deliberately stays a single slot (not a
   * list): undo itself is still fully serialized (undoBusyRef/activeFlightCountRef - see
   * PATTERN_OVERLAP_GATE), so at most one of these is ever pending at a time, the same reasoning
   * Klondike's own pendingCascadeUndoRef documents. Every removed card resolves through this same
   * deferred path, even a pyramid-cell destination whose position is pure math not dependent on the
   * commit - a card that came from the waste genuinely needs it (CardRegistry can only measure a
   * card once it's actually mounted there), and keeping both kinds on one path is simpler than
   * splitting an immediate case out from a deferred one. `wasteFlyingId` is the `flying` array entry
   * (if any) covering a waste-bound restoration - see undoRemoval. */
  const pendingRemovalUndoRef = useRef<{ removed: RemovedCardRef[]; discardOrigin: ScreenPoint; gen: number; wasteFlyingId: number | null } | null>(null)

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
        const landed = p.viaStock ? await measureView(stockViewRef.current) : await ghost.cardRegistry.measure(p.cardId)
        // A new game can start while the measurement above is in flight - `landed`, if it resolved
        // at all, would then be measuring an unrelated card in the NEW deal (ids are
        // shuffle-independent and reused across deals - see deck.ts), so drop this flight instead of
        // landing on a nonsensical position.
        if (dealTokenRef.current !== p.gen || !landed) {
          p.flight.hide()
          endFlying(p.flyingId)
          settleFlight()
          return
        }
        p.flight.flyTo(landed.x, landed.y, () => {
          endFlying(p.flyingId)
          settleFlight()
        })
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Both declared here, before the effect below that calls them, purely so the effect's references
  // to them aren't "accessed before declared" (react-hooks/immutability) - function declarations
  // hoist at runtime regardless of source position, so this reorder is a no-op behaviorally.
  function resolveUndoDestination(ref: PileRef, cardId: string, triangleOrigin: ScreenPoint | null): Promise<ScreenPoint | null> {
    if (ref.zone === 'pyramid') {
      if (!triangleOrigin) return Promise.resolve(null)
      const { row, col } = rowColOf(ref.index)
      const { left, top } = cardPosition(row, col, cardWidth, cardHeight, gap)
      return Promise.resolve({ x: triangleOrigin.x + left, y: triangleOrigin.y + top })
    }
    return ghost.cardRegistry.measure(cardId)
  }

  // Shared primitive behind both directions of Pyramid's independent-card-flight overlay: a
  // forward (removal) flight's cards each already carry their own origin and share one destination
  // (the discard pile - see flyPairIndependently below); an undo-of-removal flight's cards share
  // one origin (the discard pile) but each carries its own destination (see undoRemoval). Either
  // way, by the time this runs every card's full {from, to} is already resolved.
  function startPairFlight(cards: PairFlightCardSpec[], flyingId: number | null) {
    pairFlightGenRef.current += 1
    pairFlightTotalRef.current = cards.length
    pairFlightLandedRef.current = 0
    pairFlightFlyingIdRef.current = flyingId
    setPairFlight({ gen: pairFlightGenRef.current, cardWidth, cards })
  }

  // Resolves each removed card's real fly-back destination once prevState has actually committed
  // (see pendingRemovalUndoRef and undoRemoval below), then starts their independent flight. A
  // card whose destination fails to resolve (a rare measurement failure) is un-hidden instead of
  // left stuck invisible forever - only a landed flight clears pyramidHiddenIds/flying (see
  // handlePairFlightLanded), and a card with no flight never gets one.
  useEffect(() => {
    const pending = pendingRemovalUndoRef.current
    if (!pending || !state) return
    pendingRemovalUndoRef.current = null
    if (dealTokenRef.current !== pending.gen) {
      // New Game was tapped before this undo's card destinations could be resolved - bail rather
      // than fly stale ghosts onto the freshly-dealt board. Deliberately does NOT touch
      // pyramidHiddenIds here (unlike the resolved path below) - these removed cards' ids are
      // shuffle-independent (see deck.ts) and could collide with the NEW deal's own in-flight
      // hidden set, so mutating it here risks un-hiding an unrelated card that just happens to
      // share an id with one of these. startNewGame/restoreGame already reset the flight
      // concurrency bookkeeping for the new board; only clear this entry's own flying id and
      // undoBusyRef here too, for the (rarer) case this fires first. No startFlights was ever
      // claimed for this pending entry (only the resolved path below claims one, right before
      // startPairFlight), so there's nothing to settleFlight - undoBusyRef clears directly.
      if (pending.wasteFlyingId !== null) endFlying(pending.wasteFlyingId)
      undoBusyRef.current = false
      return
    }
    ;(async () => {
      const needsTriangle = pending.removed.some((r) => r.ref.zone === 'pyramid')
      const triangleOrigin = needsTriangle ? await measureView(triangleViewRef.current) : null

      const specs: PairFlightCardSpec[] = []
      for (const entry of pending.removed) {
        const card = cardAt(state, entry.ref)
        const to = card ? await resolveUndoDestination(entry.ref, entry.cardId, triangleOrigin) : null
        if (card && to) specs.push({ card, from: pending.discardOrigin, to })
      }

      const resolvedIds = new Set(specs.map((s) => s.card.id))
      const unresolved = pending.removed.filter((r) => !resolvedIds.has(r.cardId))
      if (unresolved.length > 0) {
        setPyramidHiddenIds((ids) => {
          const next = new Set(ids)
          unresolved.forEach((r) => next.delete(r.cardId))
          return next
        })
        // endFlying is idempotent (a no-op once the id is already gone) - safe to call here even
        // if the OTHER removed card still resolves below and re-passes this same id into
        // startPairFlight (rare: only possible when one of a pair's two cards fails to measure
        // while the other succeeds).
        if (unresolved.some((r) => r.ref.zone === 'waste') && pending.wasteFlyingId !== null) endFlying(pending.wasteFlyingId)
      }
      // Claimed here, right before the pair-flight actually starts (see
      // useFlightConcurrency.startFlights's own doc comment) - not any earlier, since specs may
      // turn out empty (nothing to fly) below, in which case nothing is ever claimed at all.
      if (specs.length > 0) {
        startFlights(1)
        startPairFlight(specs, pending.wasteFlyingId)
      } else {
        undoBusyRef.current = false
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // state.discard always holds all 52 cards by the time isWon() is true (rules.ts's
  // sweepRemainderOnWin folds in whatever was left in stock/waste on the winning move), in true
  // removal order - reversed here so the most-recently-removed (currently on top of the physical
  // pile) leads the chain. Origin reuses discardViewRef, the same plain-view measurement the
  // pair/King fly-to-discard flight above already does. Same dealTokenRef guard as every other
  // async measurement in this file, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: PyramidState, gen: number) {
    const origin = await measureView(discardViewRef.current)
    if (dealTokenRef.current !== gen || !origin) return
    winCascade.startChains([{ cards: s.discard.slice().reverse(), origin, entranceDelayMs: 0 }], cardWidth)
  }

  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    // The winning pair/King's own removal flight (flyPairIndependently/flyToDiscardPile) is still
    // travelling to the discard pile on this exact commit - state.discard already includes it
    // (rules.ts's sweepRemainderOnWin), so starting the cascade now would render that same card
    // twice at once: once mid-flight via PairFlightGhosts/the shared ghost, once already bouncing
    // at the discard pile via WinCascadeGhosts (whose head-of-chain card gets a zero entrance
    // delay). Wait for every in-flight completion to settle (handlePairFlightLanded/flyToDiscardPile's
    // own callback, via settleFlight) before capturing state.discard, so the cascade only ever shows
    // a card once it's actually landed for real. Checks activeFlightCountRef (not the `flying`
    // array) since this is really asking "is anything still animating," not specifically about the
    // discard/waste zone `flying` tracks - activeFlightCount (the state mirror) drives the
    // dependency array so this effect re-runs once the ref's value actually changes (see
    // useFlightConcurrency's own doc comment on why both exist).
    if (activeFlightCountRef.current > 0) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activeFlightCount])

  function pushUndo(prev: PyramidState, move: MoveInfo | null, removedCards: RemovedCardRef[] | null = null) {
    setUndoStack((stack) => [...stack, { state: prev, move, removedCards }])
  }

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    const s = PyramidController.newGame(randomSeed())
    setSelected(null)
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingRemovalUndoRef.current = null
    setStockHidden(false)
    session.reset()
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.pyramid.filter((c): c is Card => !!c).map((c) => c.id))
    setPyramidHiddenIds(dealtIds)
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<PyramidState, UndoEntry>) {
    ++dealTokenRef.current
    setSelected(null)
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingRemovalUndoRef.current = null
    setStockHidden(false)
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setPyramidHiddenIds(new Set())
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
      return
    }

    const sequence = buildPyramidDealSequence(s.pyramid)
    const entries: DealCardSpec[] = sequence.map((step) => {
      const { row, col } = rowColOf(step.index)
      const { left, top } = cardPosition(row, col, cardWidth, cardHeight, gap)
      return {
        cardId: step.cardId,
        card: step.card,
        from: stockOrigin,
        to: { x: triangleOrigin.x + left, y: triangleOrigin.y + top },
        delayMs: step.visitOrder * DEAL_STAGGER_MS
      }
    })
    if (entries.length === 0) {
      setPyramidHiddenIds(new Set())
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
      () => {}
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

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won so
  // a just-won deal doesn't get checkpointed as still in-progress (the win-check effect above
  // clears the save outright instead) - since `won` is derived fresh from `state` on every render,
  // undoing back out of a won position re-enables saving again on that same render, no separate
  // reset needed. Deliberately NOT also keyed on a ticking elapsed-seconds value the way an
  // earlier version of this effect was: `session.getElapsed()` computes the true current elapsed
  // from wall-clock time on demand (see useGameSession.ts), so a save made at the last real move is
  // never stale even once the player just sits looking at the board afterward - resuming always
  // recomputes the exact right value instead of depending on whenever this effect last happened to
  // run.
  useEffect(() => {
    if (state && !won) saveGameInProgress('pyramid', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('pyramid', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

  // Mirrors handleDrawStock's forward flight, just in reverse: the drawn card is still sitting in
  // the waste (`move.to`) - measure its real current position before reverting (the
  // pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and fly it back toward the stock (see pendingFlightRef's `viaStock`).
  async function handleUndo() {
    if (undoBusyRef.current || activeFlightCountRef.current > 0 || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    // Undo only ever moves backward into an earlier, necessarily-not-won state (won is a terminal
    // condition - the only move available once it's true is New Game), so any undo reachable while
    // won must be undoing the winning move itself. `won` (derived from state above) clears itself
    // on the very next render once prevState commits below, but the bouncing win cascade doesn't
    // stop on its own - it only ever stops via winCascade.clear() (see startNewGame), so without
    // this it would keep animating over a board that's already reverted underneath it.
    if (won) winCascade.clear()
    const entry = undoStack[undoStack.length - 1]
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

    // Reads via stateRef.current, not the closure `state` - mirrors Klondike's identical
    // stateRef.current idiom (see useFlightConcurrency's own doc comment on why).
    const current = stateRef.current
    const movingCard = current?.waste[current.waste.length - 1]
    const origin = movingCard && movingCard.id === move.anchorCardId ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))
    setSelected(null)

    if (origin && movingCard) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
      startFlights(1)
      const flyingId = beginFlying(move.from, move.count)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, viaStock: true, gen: dealTokenRef.current, flyingId, flight })
    } else {
      commitState(prevState)
      undoBusyRef.current = false
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
    startFlights(1)
    const [stockOrigin, wasteDest] = await Promise.all([measureView(stockViewRef.current), measureView(wasteViewRef.current)])

    if (dealTokenRef.current !== myGen) {
      // New Game was tapped mid-measurement - drop this stale undo-of-recycle entirely rather than
      // overwrite whatever startNewGame already applied (same reasoning as pendingRemovalUndoRef's
      // mismatch branch below). Deliberately skip setUndoStack/setSelected/setState here too -
      // startNewGame already reset the undo stack, selection, and board for the new game; only
      // settleFlight (which clears undoBusyRef once the count reaches 0) needs calling here too,
      // for the rarer case this fires first.
      settleFlight()
      return
    }

    setUndoStack((stack) => stack.slice(0, -1))
    setSelected(null)

    if (!stockOrigin || !wasteDest) {
      commitState(prevState)
      settleFlight()
      return
    }

    // prevState.waste is exactly the set of cards this undo restores, in their original
    // (pre-recycle, face-up) order - the same cards currently sitting reversed/face-down in
    // state.stock.
    const cards = prevState.waste
    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards, offsetStep: 0, cardWidth }, { x: stockOrigin.x, y: stockOrigin.y })
    const flyingId = beginFlying({ zone: 'waste', index: 0 }, move.count)
    setStockHidden(true)
    commitState(prevState)
    flight.flyTo(wasteDest.x, wasteDest.y, () => {
      setStockHidden(false)
      endFlying(flyingId)
      settleFlight()
    })
  }

  // Undoing a pairing/King removal: each removed card flies independently from the discard pile
  // (where it currently, physically sits) back to its own original spot - the mirror image of the
  // forward removal flight (which shares one destination but starts from independent origins;
  // this shares one origin but ends at independent destinations - see PairFlightCardSpec). The
  // discard pile itself doesn't move, so its origin is measured immediately; each card's actual
  // destination is resolved afterward, once prevState has committed (see pendingRemovalUndoRef).
  // Hiding the restored card(s) has to be batched into the SAME commit as prevState (React batches
  // same-tick setState calls into one render) - setting it after the fact would let a restored
  // card flash fully visible for a frame before the flight starts covering it, same reasoning
  // startNewGame's setPyramidHiddenIds(dealtIds) already relies on for the initial deal.
  async function undoRemoval(removed: RemovedCardRef[], prevState: PyramidState) {
    const discardOrigin = await measureView(discardViewRef.current)

    setUndoStack((stack) => stack.slice(0, -1))
    setSelected(null)

    if (!discardOrigin) {
      // No flight was ever claimed for this attempt (that only happens once the deferred effect
      // below actually starts the pair-flight) - nothing to settleFlight, so undoBusyRef clears
      // directly, same as the original code.
      commitState(prevState)
      undoBusyRef.current = false
      return
    }

    playCardSound()
    hapticCard()

    const pyramidIds = removed.filter((r) => r.ref.zone === 'pyramid').map((r) => r.cardId)
    if (pyramidIds.length > 0) setPyramidHiddenIds((ids) => new Set([...ids, ...pyramidIds]))
    // Only a waste-bound restoration needs a `flying` entry (hiding the real waste card until the
    // ghost lands there) - a pyramid-bound one is already covered by pyramidHiddenIds above. Stashed
    // on the pending ref (not just a local variable) so the deferred effect below - and, on
    // failure, handlePairFlightLanded/the dealTokenRef-mismatch branch - can find and end it later.
    const wasteFlyingId = removed.some((r) => r.ref.zone === 'waste') ? beginFlying({ zone: 'waste', index: 0 }, 1) : null

    pendingRemovalUndoRef.current = { removed, discardOrigin, gen: dealTokenRef.current, wasteFlyingId }
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

  // Shared tail for the solo (King) paths below: flies whichever single card `flight` is
  // currently showing on to the discard pile's real position. Counted exactly like any other
  // Klondike-style single-ghost flight - the caller claims startFlights(1)/beginFlying before
  // calling this, and this settles it in whichever way the flight actually ends.
  async function flyToDiscardPile(flight: DragFlightHandle, flyingId: number) {
    const discardPos = await measureView(discardViewRef.current)
    if (discardPos) {
      flight.flyTo(discardPos.x, discardPos.y, () => {
        endFlying(flyingId)
        settleFlight()
      })
    } else {
      flight.hide()
      endFlying(flyingId)
      settleFlight()
    }
  }

  // Each flying card reports here as its own independent flight settles (see
  // PairFlightGhosts/FlyingPairCard) - if it was hidden while restoring to a pyramid cell (undo of
  // a removal - see undoRemoval), un-hide it now that the real card is covered by nothing else;
  // this is a no-op for a forward (discard-bound) flight, whose cards were never in
  // pyramidHiddenIds to begin with. Once every card in the flight has landed, it's done: clear it
  // and reveal whichever destination pile was hidden meanwhile (`flying`). Guarded on `gen` so a
  // straggling callback from a flight a newer one already superseded (see startPairFlight) can't
  // fire this early.
  function handlePairFlightLanded(gen: number, cardId: string) {
    if (gen !== pairFlightGenRef.current) return
    setPyramidHiddenIds((ids) => {
      if (!ids.has(cardId)) return ids
      const next = new Set(ids)
      next.delete(cardId)
      return next
    })
    pairFlightLandedRef.current += 1
    if (pairFlightLandedRef.current >= pairFlightTotalRef.current) {
      setPairFlight(null)
      // Ends whichever `flying` entry (if any) this generation's start (flyPairIndependently, or
      // the pendingRemovalUndoRef effect's own undo-of-removal start) stashed via startPairFlight -
      // a pyramid-only undo-of-removal never creates one, hence the null check.
      if (pairFlightFlyingIdRef.current !== null) {
        endFlying(pairFlightFlyingIdRef.current)
        pairFlightFlyingIdRef.current = null
      }
      // Replaces the direct undoBusyRef clear this used to do - settleFlight() clears it once
      // every outstanding completion (this pair-flight's own startFlights(1) claim, from whichever
      // direction started it) has reported in.
      settleFlight()
    }
  }

  // Pair-removal flight: both cards travel to the discard pile independently, each from its own
  // real position - something the single-origin shared `ghost` can't do (it only ever animates
  // one origin/delta for its whole group) - so this hands off to PairFlightGhosts's own small "N
  // simultaneous ghosts" overlay instead (same idiom DealLayer/WinCascadeLayer use, and the same
  // reason - see DealLayer.tsx's doc comment). Claims startFlights(1) itself, right before its own
  // await (see useFlightConcurrency's own doc comment) - the pair as a whole counts as ONE
  // outstanding completion, matching how Klondike counts its own multi-card recycle/cascade
  // flights as one. `flyingId` is the caller's own `flying` array entry (covering the discard
  // pile's incoming-card hidden state for the whole pair) - ended here on failure, or later by
  // handlePairFlightLanded once every card has actually landed.
  async function flyPairIndependently(cards: { card: Card; from: ScreenPoint }[], flyingId: number) {
    startFlights(1)
    const discardPos = await measureView(discardViewRef.current)
    if (!discardPos) {
      endFlying(flyingId)
      settleFlight()
      return
    }
    startPairFlight(
      cards.map((c) => ({ ...c, to: discardPos })),
      flyingId
    )
  }

  // Tap-completed pairing/King removal. The real state change applies immediately (game logic
  // never waits on an animation, same as every other move in this app) - the ghost is purely a
  // visual overlay catching up to an already-true reality, hiding the discard pile's real new top
  // card (via `flying`/DiscardCell's isFlyingHere) until it visually arrives.
  async function attemptMove(from: PileRef, to: PileRef, measureOrigin: () => Promise<{ x: number; y: number }>) {
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const current = stateRef.current
    if (!current) return
    const isSolo = refsEqual(from, to)
    const fromCard = cardAt(current, from)
    const toCard = isSolo ? fromCard : cardAt(current, to)

    const result = PyramidController.tryMove(current, { from, to, count: 1 })
    if (!result) {
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

    const toOrigin = await measureOrigin()

    if (isSolo) {
      session.registerMove()
      setSelected(null)
      if (!fromCard) {
        pushUndo(current, null)
        commitState(result)
        return
      }
      pushUndo(current, null, [{ cardId: fromCard.id, ref: from }])
      // toOrigin IS the King's own tap position here (from === to) - no registry measurement
      // needed, unlike the pair case below where "first" was selected on a PREVIOUS tap. Counted
      // exactly like any other Klondike-style single-ghost flight (startFlights(1) here, settled
      // inside flyToDiscardPile once it actually lands).
      startFlights(1)
      const flyingId = beginFlying({ zone: 'discard', index: 0 }, 1)
      commitState(result)
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: [{ ...fromCard, faceUp: true }], offsetStep: 0, cardWidth }, { x: toOrigin.x, y: toOrigin.y })
      await flyToDiscardPile(flight, flyingId)
      return
    }

    // Pair: "first" (from) was selected on a previous tap - measure its CURRENT position via the
    // registry (same technique handleUndo uses) before setState unmounts it. "second" (to) is
    // already in hand as toOrigin, from the tap that just completed the pair. Both then fly
    // independently from those two real positions straight to the discard (see
    // flyPairIndependently) - neither one visits the other first.
    const fromOrigin = fromCard ? await ghost.cardRegistry.measure(fromCard.id) : null

    session.registerMove()
    setSelected(null)

    if (!fromCard || !toCard || !fromOrigin) {
      pushUndo(current, null)
      commitState(result)
      return
    }

    pushUndo(current, null, [
      { cardId: fromCard.id, ref: from },
      { cardId: toCard.id, ref: to }
    ])
    // The `flying` entry is created here (same commit as commitState, matching the original code's
    // placement) - the activeFlightCount CLAIM itself is owned by flyPairIndependently, right
    // before its own async measurement gap (see its own doc comment / PATTERN_OVERLAP_GATE).
    const flyingId = beginFlying({ zone: 'discard', index: 0 }, 2)
    commitState(result)
    playCardSound()
    hapticCard()
    flyPairIndependently(
      [
        { card: { ...fromCard, faceUp: true }, from: fromOrigin },
        { card: { ...toCard, faceUp: true }, from: toOrigin }
      ],
      flyingId
    )
  }

  // Drag-completed pairing/King removal - same choreography as attemptMove above, just sourced
  // from a drop instead of a second tap. The dragged ("first") card's own flight already exists by
  // drop time (DraggableCard's own pan gesture calls ghost.showLive() on drag start, and hands that
  // same DragFlightHandle in here as `flight` on a successful drop - see DraggableCard.tsx's
  // onDrop), so a solo (King) drop can fly it on to the discard as-is; a pair instead reads
  // "first"'s current position straight off that same flight, retires it, and hands both cards off
  // to flyPairIndependently so they can travel to the discard on their own, independent paths.
  async function attemptDrop(from: PileRef, absoluteX: number, absoluteY: number, flight: DragFlightHandle): Promise<boolean> {
    if (undoBusyRef.current) return false // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const current = stateRef.current
    if (!current) return false
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target) return false

    const isSolo = refsEqual(from, target)
    const fromCard = cardAt(current, from)
    const toCard = isSolo ? fromCard : cardAt(current, target)

    const result = PyramidController.tryMove(current, { from, to: target, count: 1 })
    if (!result) return false

    session.registerMove()
    setSelected(null)

    if (isSolo) {
      if (!fromCard) {
        pushUndo(current, null)
        commitState(result)
        flight.hide()
        return true
      }
      pushUndo(current, null, [{ cardId: fromCard.id, ref: from }])
      startFlights(1)
      const flyingId = beginFlying({ zone: 'discard', index: 0 }, 1)
      commitState(result)
      await flyToDiscardPile(flight, flyingId)
      return true
    }

    // "second" (target)'s exact position isn't necessarily where the pointer released (anywhere
    // within its drop-zone hit-box counts) - measure it via the registry before setState unmounts
    // it.
    const toOrigin = toCard ? await ghost.cardRegistry.measure(toCard.id) : null

    if (!fromCard || !toCard || !toOrigin) {
      pushUndo(current, null)
      commitState(result)
      flight.hide()
      return true
    }

    // "first" is still mid-drag in `flight` (wherever the pointer released it, not necessarily
    // "second"'s own position) - read its current screen position straight off its shared values
    // before retiring that flight: from here the pair flies independently instead.
    const fromOrigin = { x: flight.originX.value + flight.dx.value, y: flight.originY.value + flight.dy.value }
    flight.hide()

    pushUndo(current, null, [
      { cardId: fromCard.id, ref: from },
      { cardId: toCard.id, ref: target }
    ])
    const flyingId = beginFlying({ zone: 'discard', index: 0 }, 2)
    commitState(result)
    flyPairIndependently(
      [
        { card: { ...fromCard, faceUp: true }, from: fromOrigin },
        { card: { ...toCard, faceUp: true }, from: toOrigin }
      ],
      flyingId
    )
    return true
  }

  // Mirrors Klondike's handleDrawStock: a ghost copy of the newly-drawn card flies from the stock
  // pile to the waste slot, landing once the pendingFlightRef effect above measures its real
  // (already re-rendered) position.
  async function handleDrawStock() {
    if (won || !state) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const current = stateRef.current
    if (!current) return
    const result = PyramidController.drawStock!(current)
    if (!result) return
    session.registerMove()
    // Claimed up front, before either branch's own await, covering whichever one this draw turns
    // out to be (recycle or plain draw) - exactly one outstanding completion either way, matching
    // Klondike's own handleDrawStock.
    startFlights(1)

    const drawnCard = result.waste[result.waste.length - 1]
    if (!drawnCard) {
      // Recycle: stock was empty, so PyramidController.drawStock! just flipped the whole waste
      // back over into a new (reversed, face-down) stock - see rules.ts's drawStock. Animate it as
      // one group-ghost flight from the waste slot to the stock slot (same idiom a dragged
      // multi-card run uses: one shared origin/destination for the whole clump), not a per-card
      // deal-style flight - see PATTERN_RECYCLE. Both endpoints are plain container refs, so no
      // post-commit deferral is needed; guarded against a "New Game" tapped mid-measurement the
      // same way runDeal/runWinCascade are elsewhere in this file.
      const myGen = dealTokenRef.current
      const recycledCards = current.waste.slice()
      const [wasteOrigin, stockDest] = await Promise.all([measureView(wasteViewRef.current), measureView(stockViewRef.current)])
      if (dealTokenRef.current !== myGen) {
        // New Game was tapped mid-measurement - drop this stale recycle entirely rather than
        // overwrite whatever startNewGame already applied (same reasoning as
        // pendingRemovalUndoRef's mismatch branch above). Nothing here has touched
        // flying/stockHidden/pushUndo/commitState yet, so there's nothing to unwind beyond
        // settling the claim made above.
        settleFlight()
        return
      }
      if (!wasteOrigin || !stockDest || recycledCards.length === 0) {
        pushUndo(current, null)
        commitState(result)
        setSelected(null)
        settleFlight()
        return
      }

      const recycleMove: MoveInfo = { from: { zone: 'waste', index: 0 }, to: { zone: 'stock', index: 0 }, count: recycledCards.length, anchorCardId: recycledCards[0].id }

      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: recycledCards, offsetStep: 0, cardWidth }, { x: wasteOrigin.x, y: wasteOrigin.y })
      const flyingId = beginFlying({ zone: 'stock', index: 0 }, recycledCards.length)
      setStockHidden(true)

      pushUndo(current, recycleMove)
      commitState(result)
      setSelected(null)
      flight.flyTo(stockDest.x, stockDest.y, () => {
        setStockHidden(false)
        endFlying(flyingId)
        settleFlight()
      })
      return
    }
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }
    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(current, move)
      commitState(result)
      setSelected(null)
      settleFlight()
      return
    }

    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying({ zone: 'waste', index: 0 }, 1)

    pushUndo(current, move)
    commitState(result)
    setSelected(null)
    pendingFlightRef.current.push({ cardId: drawnCard.id, gen: dealTokenRef.current, flyingId, flight })
  }

  // Finds one legal move (a pairing/solo King) or a stock-draw suggestion to highlight - see
  // engine/hint.ts's findHint, which reuses this game's own legalMoves(). Only highlights; the
  // player still taps/drags the suggested card(s) through the normal flow.
  function handleHint() {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(PyramidController, state, skip)
    if (result.kind === 'none') {
      infoToast('No moves available right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('pyramid')
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.timer}>Loading...</Text>
      </View>
    )
  }

  const width = triangleWidth(cardWidth, gap)
  const height = (ROWS - 1) * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight
  const wasteTop = state.waste[state.waste.length - 1]

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Pyramid' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} rules={PYRAMID_RULES}>
        <View style={styles.board}>
          <View style={[styles.controlRow, { width }]}>
            <DiscardCell card={won ? undefined : state.discard[state.discard.length - 1]} isFlyingHere={flying.some((f) => f.to.zone === 'discard')} viewRef={discardViewRef} />
            <StockWaste gap={gap} dropZones={dropZones} stockTopCard={state.stock[state.stock.length - 1]} wasteTop={wasteTop} wasteSelected={!!selected && selected.zone === 'waste'} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} wasteHiddenCount={flying.some((f) => f.to.zone === 'waste') ? 1 : 0} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} onDrawStock={handleDrawStock} onWastePress={handleSelectWaste} onWasteDrop={(x, y, flight) => attemptDrop({ zone: 'waste', index: 0 }, x, y, flight)} stockRef={stockViewRef} wasteRef={wasteViewRef} stockHidden={stockHidden} />
          </View>

          <View ref={triangleViewRef} collapsable={false} style={[styles.triangle, { width, height }]}>
            {state.pyramid.map((card, index) => {
              if (!card) return null
              const { row, col } = rowColOf(index)
              const { left, top } = cardPosition(row, col, cardWidth, cardHeight, gap)
              const exposed = isExposed(state.pyramid, row, col)
              const isHidden = pyramidHiddenIds.has(card.id)
              const isSelected = !!selected && selected.zone === 'pyramid' && selected.index === index
              const pileRef: PileRef = { zone: 'pyramid', index }
              const cardStyle = [styles.pyramidCard, { left, top, zIndex: row }]

              if (!exposed) {
                return <PlayingCard key={card.id} card={card} disabled dimmed style={[cardStyle, isHidden && styles.hiddenCard]} testID={`pyramid-${index}`} />
              }

              return (
                <DropZone key={card.id} registry={dropZones} pileRef={pileRef} style={cardStyle}>
                  <DraggableCard card={card} selected={isSelected} hidden={isHidden} hinted={hintCountFor(activeHint, pileRef) > 0} onPress={(measure) => handleSelectPyramid(index, measure)} onDrop={(x, y, flight) => attemptDrop(pileRef, x, y, flight)} shakeToken={shake?.cardId === card.id ? shake.token : undefined} testID={`pyramid-${index}`} />
                </DropZone>
              )
            })}
          </View>
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    dialog comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it (also backstopped by WinBanner's own explicit zIndex). */}
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <PairFlightGhosts flight={pairFlight} onCardLanded={handlePairFlightLanded} />
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    // GameChrome's own content area now centers a natural-width board itself (see GameChrome.tsx's
    // GAME_CONTENT_MAX_WIDTH/ContentGutter wiring) - board no longer needs width:'100%' to opt into
    // that. alignItems:'center' still does its own separate job here: centering controlRow (narrower
    // than triangle) within board's own width, which now naturally shrinks to match triangle's real
    // width instead of an artificial full-window one.
    board: {
      alignItems: 'center'
    },
    container: {
      alignItems: 'center',
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 16
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
    hiddenCard: {
      opacity: 0
    },
    pyramidCard: {
      position: 'absolute'
    },
    timer: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      fontWeight: '700'
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
