// Pyramid solitaire screen: triangle tap-to-select board + stock/waste row.

import { Pressable, useVibration } from '@rific/feedback-press'
import { Fireworks } from '@tastic/animations/fireworks'
import { computeContentBounds } from '@tastic/core'
import { RefObject, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import Animated, { SharedValue, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'

import { CARD_ASPECT, CardSizeProvider, cardWidthForRow, FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView, ScreenPoint } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { autoMoveSpringFor } from '@/components/dragdrop/dragSpring'
import { DropZone } from '@/components/dragdrop/DropZone'
import { formatTime, GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors, TableColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { useGameSession } from '@/components/useGameSession'
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { PileRef } from '@/engine/gameTypes'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { HIDDEN_CARD_STYLE } from '@/games/shared/FoundationCell'
import { MoveInfo } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { buildPyramidDealSequence } from './dealSequence'
import { cardAt, isExposed, PyramidController, PyramidState, rowColOf } from './rules'

const ROWS = 7
const COL_GAP = 6 // horizontal gap between cards within a row - no overlap, so corner pips stay visible

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

/** The discard pile's own display - cards removed via a pair or solo King land here (see
 * rules.ts's `discard` field). Always face-up and non-interactive (`disabled`, no DropZone/onPress
 * - tryMove already rejects any `to.zone` other than 'pyramid'/'waste', so it could never be a
 * legal drop target anyway). While `isFlyingHere`, the real (already-updated) top card is hidden
 * and a frozen copy of whatever was on top before is shown instead - same reasoning as Klondike's
 * FoundationCell - so the pile doesn't flash to its new top card before the ghost visually lands.
 * Unlike FoundationCell, this measures its position via a plain view ref (viewRef, passed a stable
 * discardViewRef from the caller), not per-card CardRegistry registration - there's only ever one
 * discard pile, not a slot whose occupant identity keeps changing. */
function DiscardCell({ card, isFlyingHere, viewRef }: { card: Card | undefined; isFlyingHere: boolean; viewRef: RefObject<View | null> }) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere)
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
  const { width: winWidth, height: winHeight } = useWindowDimensions()

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

function triangleWidth(cardWidth: number): number {
  return cardWidth * ROWS + COL_GAP * (ROWS - 1)
}

function cardPosition(row: number, col: number, cardWidth: number, cardHeight: number): { left: number; top: number } {
  const width = triangleWidth(cardWidth)
  const rowWidth = cardWidth * (row + 1) + COL_GAP * row
  const rowLeftStart = (width - rowWidth) / 2
  const left = rowLeftStart + col * (cardWidth + COL_GAP)
  // Rows cascade vertically like a FreeCell cascade - same offset ratio, so only the row below
  // (drawn on top, per its higher zIndex) overlaps the bottom of the row above.
  const top = row * (cardHeight * FACE_UP_OFFSET_RATIO)
  return { left, top }
}

export default withGameProviders(PyramidScreenInner)

function PyramidScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TRIANGLE_WIDTH_UNITS, COL_GAP)
  const cardHeight = cardWidth / CARD_ASPECT
  const [state, setState] = useState<PyramidState | null>(null)
  const [selected, setSelected] = useState<PileRef | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
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
  const triangleViewRef = useRef<View>(null)
  const discardViewRef = useRef<View>(null)
  const [pyramidHiddenIds, setPyramidHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  /** A flight awaiting its post-commit measurement + ghost.flyTo (see the effect below) - set by
   * handleDrawStock once the drawn card's own render has been committed, or by handleUndo when
   * reversing a draw. `viaStock` measures via stockViewRef (a plain View, not per-card) instead of
   * CardRegistry - only undoing a draw flies back toward the stock; drawing itself flies to the
   * real per-card-registered waste slot. */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean } | null>(null)
  const winCascade = useWinCascade()
  // Derived from `state` every render (see useDerivedWinCheck) rather than mirrored into its own
  // useState: it's a pure function of state, so Undo-ing out of a won position correctly drops the
  // win banner immediately, rather than leaving it stuck showing.
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(PyramidController, state, 'pyramid', session, dealTokenRef, recordDealWon)
  /** Pyramid's pair-removal flight - both cards travel to the discard pile independently, each
   * from its own real position (see flyPairIndependently/PairFlightGhosts below), rather than
   * through the single shared `ghost` above, which can only ever animate one origin/delta for its
   * whole group and so can't have two cards converge from different starting points at once. */
  const [pairFlight, setPairFlight] = useState<PairFlightState | null>(null)
  const pairFlightGenRef = useRef(0)
  const pairFlightTotalRef = useRef(0)
  const pairFlightLandedRef = useRef(0)
  /** Stashed by handleUndo's undoRemoval, resolved by the effect below once prevState has actually
   * committed - mirrors pendingFlightRef/pendingDealTokenRef's own shape. Every removed card
   * resolves through this same deferred path, even a pyramid-cell destination whose position is
   * pure math not dependent on the commit - a card that came from the waste genuinely needs it
   * (CardRegistry can only measure a card once it's actually mounted there), and keeping both
   * kinds on one path is simpler than splitting an immediate case out from a deferred one. */
  const pendingRemovalUndoRef = useRef<{ removed: RemovedCardRef[]; discardOrigin: ScreenPoint } | null>(null)
  // Guards handleUndo against being called again before its own previous invocation has fully
  // settled (visually, not just in state) - see handleUndo/undoRemoval below for why an overlapping
  // call would otherwise desync the undo stack or clobber the shared single-flight ghost/pair-flight
  // animation.
  const undoBusyRef = useRef(false)

  // Same race documented for Klondike's deal/tap-move fixes: measuring CardRegistry synchronously
  // right after the setState in handleDrawStock would find the still-mounted PREVIOUS waste card
  // (the new one's own registration effect hasn't run yet), so the ghost would "fly" a near-zero
  // distance - indistinguishable from a snap. Deferring to a [state]-keyed effect guarantees the
  // new waste card has already registered by the time this runs.
  useEffect(() => {
    const pending = pendingFlightRef.current
    if (!pending || !state) return
    pendingFlightRef.current = null
    ;(async () => {
      const landed = pending.viaStock ? await measureView(stockViewRef.current) : await ghost.cardRegistry.measure(pending.cardId)
      if (landed) {
        ghost.flyTo(landed.x, landed.y, () => {
          setFlying(null)
          undoBusyRef.current = false
        })
      } else {
        ghost.hide()
        setFlying(null)
        undoBusyRef.current = false
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Resolves each removed card's real fly-back destination once prevState has actually committed
  // (see pendingRemovalUndoRef and undoRemoval below), then starts their independent flight. A
  // card whose destination fails to resolve (a rare measurement failure) is un-hidden instead of
  // left stuck invisible forever - only a landed flight clears pyramidHiddenIds/flying (see
  // handlePairFlightLanded), and a card with no flight never gets one.
  useEffect(() => {
    const pending = pendingRemovalUndoRef.current
    if (!pending || !state) return
    pendingRemovalUndoRef.current = null
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
        if (unresolved.some((r) => r.ref.zone === 'waste')) setFlying(null)
      }
      if (specs.length > 0) startPairFlight(specs)
      else undoBusyRef.current = false
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  function resolveUndoDestination(ref: PileRef, cardId: string, triangleOrigin: ScreenPoint | null): Promise<ScreenPoint | null> {
    if (ref.zone === 'pyramid') {
      if (!triangleOrigin) return Promise.resolve(null)
      const { row, col } = rowColOf(ref.index)
      const { left, top } = cardPosition(row, col, cardWidth, cardHeight)
      return Promise.resolve({ x: triangleOrigin.x + left, y: triangleOrigin.y + top })
    }
    return ghost.cardRegistry.measure(cardId)
  }

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
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  function pushUndo(prev: PyramidState, move: MoveInfo | null, removedCards: RemovedCardRef[] | null = null) {
    setUndoStack((stack) => [...stack, { state: prev, move, removedCards }])
  }

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    const s = PyramidController.newGame(randomSeed())
    setSelected(null)
    setUndoStack([])
    undoBusyRef.current = false
    session.reset()
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.pyramid.filter((c): c is Card => !!c).map((c) => c.id))
    setPyramidHiddenIds(dealtIds)
    scheduleDeal(myToken)
    setState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal), no fresh undo history.
  function restoreGame(saved: SavedGame<PyramidState>) {
    ++dealTokenRef.current
    setSelected(null)
    setUndoStack([])
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setPyramidHiddenIds(new Set())
    setState(saved.state)
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
      const { left, top } = cardPosition(row, col, cardWidth, cardHeight)
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
    loadGameInProgress<PyramidState>('pyramid').then((saved) => {
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
  // reset needed.
  useEffect(() => {
    if (state && !won) saveGameInProgress('pyramid', { state, moves: session.moves, elapsedSeconds: session.elapsed })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won])

  // Mirrors handleDrawStock's forward flight, just in reverse: the drawn card is still sitting in
  // the waste (`move.to`) - measure its real current position before reverting (the
  // pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and fly it back toward the stock (see pendingFlightRef's `viaStock`).
  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
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

    if (!move) {
      setUndoStack((stack) => stack.slice(0, -1))
      setState(prevState)
      setSelected(null)
      undoBusyRef.current = false
      return
    }

    const movingCard = state.waste[state.waste.length - 1]
    const origin = movingCard && movingCard.id === move.anchorCardId ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))
    setSelected(null)

    if (origin && movingCard) {
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth })
      setFlying({ to: move.from, count: move.count })
      setState(prevState)
      pendingFlightRef.current = { cardId: move.anchorCardId, viaStock: true }
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }
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
      setState(prevState)
      undoBusyRef.current = false
      return
    }

    playCardSound()
    hapticCard()

    const pyramidIds = removed.filter((r) => r.ref.zone === 'pyramid').map((r) => r.cardId)
    if (pyramidIds.length > 0) setPyramidHiddenIds((ids) => new Set([...ids, ...pyramidIds]))
    if (removed.some((r) => r.ref.zone === 'waste')) setFlying({ to: { zone: 'waste', index: 0 }, count: 1 })

    pendingRemovalUndoRef.current = { removed, discardOrigin }
    setState(prevState)
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

  // Shared tail for the solo (King) paths below: flies whichever single card the shared `ghost`
  // is currently showing on to the discard pile's real position.
  async function flyToDiscardPile() {
    const discardPos = await measureView(discardViewRef.current)
    if (discardPos) {
      ghost.flyTo(discardPos.x, discardPos.y, () => setFlying(null))
    } else {
      ghost.hide()
      setFlying(null)
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
      setFlying(null)
      undoBusyRef.current = false
    }
  }

  // Shared primitive behind both directions of Pyramid's independent-card-flight overlay: a
  // forward (removal) flight's cards each already carry their own origin and share one destination
  // (the discard pile - see flyPairIndependently below); an undo-of-removal flight's cards share
  // one origin (the discard pile) but each carries its own destination (see undoRemoval). Either
  // way, by the time this runs every card's full {from, to} is already resolved.
  function startPairFlight(cards: PairFlightCardSpec[]) {
    pairFlightGenRef.current += 1
    pairFlightTotalRef.current = cards.length
    pairFlightLandedRef.current = 0
    setPairFlight({ gen: pairFlightGenRef.current, cardWidth, cards })
  }

  // Pair-removal flight: both cards travel to the discard pile independently, each from its own
  // real position - something the single-origin shared `ghost` can't do (it only ever animates
  // one origin/delta for its whole group) - so this hands off to PairFlightGhosts's own small "N
  // simultaneous ghosts" overlay instead (same idiom DealLayer/WinCascadeLayer use, and the same
  // reason - see DealLayer.tsx's doc comment).
  async function flyPairIndependently(cards: { card: Card; from: ScreenPoint }[]) {
    const discardPos = await measureView(discardViewRef.current)
    if (!discardPos) {
      setFlying(null)
      return
    }
    startPairFlight(cards.map((c) => ({ ...c, to: discardPos })))
  }

  // Tap-completed pairing/King removal. The real state change applies immediately (game logic
  // never waits on an animation, same as every other move in this app) - the ghost is purely a
  // visual overlay catching up to an already-true reality, hiding the discard pile's real new top
  // card (via `flying`/DiscardCell's isFlyingHere) until it visually arrives.
  async function attemptMove(from: PileRef, to: PileRef, measureOrigin: () => Promise<{ x: number; y: number }>) {
    if (!state) return
    const isSolo = refsEqual(from, to)
    const fromCard = cardAt(state, from)
    const toCard = isSolo ? fromCard : cardAt(state, to)

    const result = PyramidController.tryMove(state, { from, to, count: 1 })
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
        pushUndo(state, null)
        setState(result)
        return
      }
      pushUndo(state, null, [{ cardId: fromCard.id, ref: from }])
      // toOrigin IS the King's own tap position here (from === to) - no registry measurement
      // needed, unlike the pair case below where "first" was selected on a PREVIOUS tap.
      setFlying({ to: { zone: 'discard', index: 0 }, count: 1 })
      setState(result)
      ghost.originX.value = toOrigin.x
      ghost.originY.value = toOrigin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: [{ ...fromCard, faceUp: true }], offsetStep: 0, cardWidth })
      await flyToDiscardPile()
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
      pushUndo(state, null)
      setState(result)
      return
    }

    pushUndo(state, null, [
      { cardId: fromCard.id, ref: from },
      { cardId: toCard.id, ref: to }
    ])
    setFlying({ to: { zone: 'discard', index: 0 }, count: 2 })
    setState(result)
    playCardSound()
    hapticCard()
    flyPairIndependently([
      { card: { ...fromCard, faceUp: true }, from: fromOrigin },
      { card: { ...toCard, faceUp: true }, from: toOrigin }
    ])
  }

  // Drag-completed pairing/King removal - same choreography as attemptMove above, just sourced
  // from a drop instead of a second tap. The dragged ("first") card's ghost already exists by drop
  // time (DraggableCard's own pan gesture calls ghost.show() on drag start, against this same
  // shared useDragGhost() context, and deliberately leaves it mounted on a successful drop for the
  // caller to resolve - see handleRelease), so a solo (King) drop can fly it on to the discard
  // as-is; a pair instead reads "first"'s current position straight off that same ghost, retires
  // it, and hands both cards off to flyPairIndependently so they can travel to the discard on
  // their own, independent paths.
  async function attemptDrop(from: PileRef, absoluteX: number, absoluteY: number): Promise<boolean> {
    if (!state) return false
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target) return false

    const isSolo = refsEqual(from, target)
    const fromCard = cardAt(state, from)
    const toCard = isSolo ? fromCard : cardAt(state, target)

    const result = PyramidController.tryMove(state, { from, to: target, count: 1 })
    if (!result) return false

    session.registerMove()
    setSelected(null)

    if (isSolo) {
      if (!fromCard) {
        pushUndo(state, null)
        setState(result)
        ghost.hide()
        return true
      }
      pushUndo(state, null, [{ cardId: fromCard.id, ref: from }])
      setFlying({ to: { zone: 'discard', index: 0 }, count: 1 })
      setState(result)
      await flyToDiscardPile()
      return true
    }

    // "second" (target)'s exact position isn't necessarily where the pointer released (anywhere
    // within its drop-zone hit-box counts) - measure it via the registry before setState unmounts
    // it.
    const toOrigin = toCard ? await ghost.cardRegistry.measure(toCard.id) : null

    if (!fromCard || !toCard || !toOrigin) {
      pushUndo(state, null)
      setState(result)
      ghost.hide()
      return true
    }

    // "first" is still mid-drag in the shared `ghost` (wherever the pointer released it, not
    // necessarily "second"'s own position) - read its current screen position straight off the
    // shared values before retiring that ghost: from here the pair flies independently instead.
    const fromOrigin = { x: ghost.originX.value + ghost.dx.value, y: ghost.originY.value + ghost.dy.value }
    ghost.hide()

    pushUndo(state, null, [
      { cardId: fromCard.id, ref: from },
      { cardId: toCard.id, ref: target }
    ])
    setFlying({ to: { zone: 'discard', index: 0 }, count: 2 })
    setState(result)
    flyPairIndependently([
      { card: { ...fromCard, faceUp: true }, from: fromOrigin },
      { card: { ...toCard, faceUp: true }, from: toOrigin }
    ])
    return true
  }

  // Mirrors Klondike's handleDrawStock: a ghost copy of the newly-drawn card flies from the stock
  // pile to the waste slot, landing once the pendingFlightRef effect above measures its real
  // (already re-rendered) position.
  async function handleDrawStock() {
    if (won || !state) return
    const result = PyramidController.drawStock!(state)
    if (!result) return
    session.registerMove()

    const drawnCard = result.waste[result.waste.length - 1]
    if (!drawnCard) {
      pushUndo(state, null)
      setState(result)
      setSelected(null)
      return
    }
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }
    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(state, move)
      setState(result)
      setSelected(null)
      return
    }

    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth })
    setFlying({ to: { zone: 'waste', index: 0 }, count: 1 })

    pushUndo(state, move)
    setState(result)
    setSelected(null)
    pendingFlightRef.current = { cardId: drawnCard.id }
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.timer}>Loading...</Text>
      </View>
    )
  }

  const width = triangleWidth(cardWidth)
  const height = (ROWS - 1) * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight
  const wasteTop = state.waste[state.waste.length - 1]

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Pyramid' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} hasProgress={session.moves > 0} elapsedSeconds={session.elapsed} movesCount={session.moves}>
        <View style={styles.board}>
          <View ref={triangleViewRef} collapsable={false} style={[styles.triangle, { width, height }]}>
            {state.pyramid.map((card, index) => {
              if (!card) return null
              const { row, col } = rowColOf(index)
              const { left, top } = cardPosition(row, col, cardWidth, cardHeight)
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
                  <DraggableCard card={card} selected={isSelected} hidden={isHidden} onPress={(measure) => handleSelectPyramid(index, measure)} onDrop={(x, y) => attemptDrop(pileRef, x, y)} shakeToken={shake?.cardId === card.id ? shake.token : undefined} testID={`pyramid-${index}`} />
                </DropZone>
              )
            })}
          </View>

          <View style={styles.controlRow}>
            <DiscardCell card={won ? undefined : state.discard[state.discard.length - 1]} isFlyingHere={!!flying && flying.to.zone === 'discard'} viewRef={discardViewRef} />
            <StockWaste style={styles.stockRow} dropZones={dropZones} stockTopCard={state.stock[state.stock.length - 1]} wasteTop={wasteTop} wasteSelected={!!selected && selected.zone === 'waste'} wasteHiddenCount={flying && flying.to.zone === 'waste' ? 1 : 0} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} onDrawStock={handleDrawStock} onWastePress={handleSelectWaste} onWasteDrop={(x, y) => attemptDrop({ zone: 'waste', index: 0 }, x, y)} stockRef={stockViewRef} />
          </View>
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    banner comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it. Also why winBanner itself became a full-screen centering overlay here
    (position:absolute, see its style) instead of staying an in-flow block under controlRow: an
    in-flow, deeply-nested position can't reliably out-paint these screen-level siblings at all,
    regardless of styling. */}
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <PairFlightGhosts flight={pairFlight} onCardLanded={handlePairFlightLanded} />
      <WinCascadeGhosts />
      {won && (
        // box-none (not the default 'auto'): this View covers the full screen, but only its
        // centered winBanner content should ever catch a tap - left uncorrected, the transparent
        // surrounding area silently swallows every touch across the whole screen, including
        // GameChrome's header buttons underneath it (Home/Undo/Settings), since this renders as a
        // later sibling of GameChrome and therefore wins pointer-event hit-testing by plain DOM
        // order (see the comment above on why Fireworks/WinCascadeGhosts/this all live at this
        // level). Confirmed live: Undo was completely unreachable post-win until this was added.
        <View style={styles.winOverlay} pointerEvents='box-none'>
          <View style={styles.winBanner}>
            <Text style={styles.winText}>
              Pyramid cleared! {formatTime(session.elapsed)} · {session.moves} moves · Score {computeScore(session.moves, session.elapsed)}
            </Text>
            <Pressable style={styles.button} onPress={startNewGame}>
              <Text style={styles.buttonText}>New Game</Text>
            </Pressable>
          </View>
        </View>
      )}
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
    button: {
      backgroundColor: '#ffffffee',
      borderRadius: 8,
      paddingHorizontal: 18,
      paddingVertical: 10
    },
    buttonText: {
      color: colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 14,
      fontWeight: '700'
    },
    container: {
      alignItems: 'center',
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 16
    },
    controlRow: {
      flexDirection: 'row',
      gap: 24,
      marginBottom: 20
    },
    hiddenCard: {
      opacity: 0
    },
    pyramidCard: {
      position: 'absolute'
    },
    stockRow: {
      gap: 24
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
    },
    winBanner: {
      alignItems: 'center',
      backgroundColor: '#ffffffee',
      borderRadius: 12,
      gap: 12,
      padding: 18
    },
    // Transparent (unlike Klondike/FreeCell's own winOverlay) - Pyramid's win treatment was never a
    // dimmed scrim, just a centered card; this only exists now to center winBanner as a screen-level
    // overlay instead of an in-flow block (see the JSX for why it has to be one).
    winOverlay: {
      alignItems: 'center',
      bottom: 0,
      justifyContent: 'center',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    winText: {
      color: colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 18,
      fontWeight: '800'
    }
  })
}
