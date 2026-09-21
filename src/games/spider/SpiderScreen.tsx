import { Pressable, useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CARD_ASPECT, CardSizeProvider, faceUpFanOffset, useCardSize } from '@tastic/cards'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS, dealStaggerMs } from '@/components/dealing/dealSpring'
import { measureView, ScreenPoint } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { autoMoveSpringFor, springSettleMs } from '@/components/dragdrop/dragSpring'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { TABLEAU_ROW_PADDING_BOTTOM, useFittedCardWidth, useFittedGap, useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { OverlayFrame, toLocal, useOverlayFrame } from '@/components/overlayFrame'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS, CHAIN_SEGMENT_DELAY_MS } from '@/components/winning/winCascadeMotion'
import { SPIDER_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { isDescendingSameSuit, runCountFrom } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useWinReveal } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { BOARD_MODEL } from './boardModel'
import { buildSpiderDealSequence } from './dealSequence'
import { createSpiderController, SpiderState } from './rules'
import { SpiderSettingsSection } from './SpiderSettingsSection'

const TABLEAU_COLUMNS = 10
// Stock always starts a game with exactly 50 cards (104 total minus the 54 dealt into the tableau,
// true for every numSuits variant - see rules.ts's newGame) - 5 rounds of TABLEAU_COLUMNS cards
// each, so the fan never needs more than 5 packets regardless of how the game was configured.
const STOCK_MAX_PACKETS = 5
// How far each successive fanned packet peeks out from the one behind it, as a fraction of a
// card's width - small enough to read as "a few decks deep," not a wide hand-of-cards spread.
const STOCK_FAN_OFFSET_RATIO = 0.16
// A placeholder face-down card for the stock fan's decorative packets - id/suit/rank are never
// shown (faceUp: false always renders CardBack instead), so any valid values work here.
const STOCK_PACKET_CARD: Card = { id: 'stock-packet', suit: 'spades', rank: 1, faceUp: false }

/** CardRegistry id for the packet at this depth (0 = deepest, present until the very last deal;
 * STOCK_MAX_PACKETS-1 = frontmost, gone after the very first deal - see StockFan/StockPacket). */
function stockPacketId(index: number): string {
  return `stock-packet-${index}`
}

/** Null for a stock deal (10 cards land across every column at once - see runDeal - rather than
 * one card landing somewhere new, so there's no single MoveInfo shape to record) - handleUndo
 * detects this case itself and flies all 10 back to the stock fan (see runUndoDeal). */
type HistoryEntry = UndoEntry<SpiderState>

/** A completed King->Ace run that has not left the tableau yet: it sits fully assembled in its column (completeMove/
 * handleDrawStock's displayState) until sweepRunToFoundation flies it to `slotIndex`. `release` is that run's claim on
 * sweepPendingRef - the board is held still until the sweep gives it back, see claimSweep. */
interface PendingSweep {
  colIndex: number
  slotIndex: number
  run: Card[]
  release: () => boolean
}

/** One tap-to-move or drag-drop's own ghost flight (via `ghost`, DragGhostLayer), queued in
 * pendingMoveFlightsRef awaiting its post-commit measurement + flight.flyTo - see that ref's own
 * doc comment for why this folds together what were three separately-paired single-slot refs
 * before this file was upgraded to support concurrent flights (pendingAutoMoveCardIdRef/
 * pendingFlightRef/pendingRunSweepRef). `sweep` is set only by completeMove, when this same move
 * also completes a King->Ace run - never by finishMoveUndo/undo, which never completes a NEW run. */
interface PendingMoveFlight {
  cardId: string
  flight: DragFlightHandle
  flyingId: number
  sweep: PendingSweep | null
}

/** One card's independent leg of a sequence flight - own origin AND destination, the same shape
 * Pyramid's PairFlightCardSpec uses for the same reason: a forward completion's cards each carry
 * their own `from` (wherever they're currently sitting in the tableau) but share one `to` (the
 * foundation slot); an undo-of-completion's cards share one `from` (that slot) but each carry
 * their own restored `to`. `delayMs` staggers cards within one flight instance so the run visibly
 * peels apart (or reassembles) one card at a time rather than all moving as a single glued unit -
 * see sweepRunToFoundation/startUndoRunCompletion/undoSequenceCompletions for how it's assigned
 * per direction. */
interface SequenceFlightCardSpec {
  card: Card
  from: ScreenPoint
  to: ScreenPoint
  delayMs: number
}

/** One in-flight completed or restored sequence - see SequenceFlightGhosts/startSequenceFlight.
 * Tracked as an array rather than Pyramid's single nullable pair-flight slot, since a single stock
 * deal can complete (or a single stock-deal undo can restore) more than one column at once,
 * needing more than one concurrent flight. Each instance's own landing behavior is supplied by the
 * caller (see startSequenceFlight/sequenceFlightCallbacksRef) rather than baked in here, since a
 * completing run reveals its foundation slot once EVERY card lands while a restoring run reveals
 * each tableau card individually as ITS OWN flight lands. */
interface SequenceFlightInstance {
  id: number
  cardWidth: number
  cards: SequenceFlightCardSpec[]
}

/** One card's independent leg of a sequence flight (see SequenceFlightGhosts) - its own spring,
 * scaled to its own distance between origin and destination, the same distance-scaled shape every
 * other flight in this app uses (see dragSpring.ts's autoMoveSpringFor), so a card starting closer
 * settles sooner than one starting further away instead of both moving in lockstep. `delayMs`
 * (see SequenceFlightCardSpec) pushes both the flight and its settlement back by the same amount,
 * via withDelay, so a staggered card doesn't visibly move until its own turn arrives. Settlement
 * is a plain timer matching the spring's own real end (springSettleMs) rather than the spring's completion callback
 * - confirmed elsewhere in this codebase (DragGhostLayer.tsx/DealLayer.tsx) not to reliably fire
 * on this app's web target. `onDealt` mirrors DealLayer's GhostSlot (formerly DealGhostCard) own doc comment: fired via its own
 * separate timer keyed to just `delayMs` (not delayMs+duration), so this card's own sound/haptic
 * lands the instant ITS turn actually begins, not staggered on top of the landing timer.
 *
 * `zIndex` starts neutral (0) for every card in a flight, so while all of them still sit
 * stationary at their own real positions, plain document order (this file always builds a
 * flight's card list in the run's own King-first order) already gives correct stacking - Ace
 * naturally in front of King, matching the fan they just came from. The instant THIS card's own
 * delay elapses and it actually departs, its zIndex jumps to a value derived from `delayMs` itself
 * (guaranteed higher than any not-yet-departed sibling's neutral 0, and correctly ordered against
 * any OTHER already-departed sibling, since a longer delay always yields a strictly higher step) -
 * so stacking switches to reflect ARRIVAL order instead, letting each card land visibly on top of
 * the ones before it, exactly like a real pile building up, without the two phases (natural fan,
 * then arrival order) ever fighting each other. Otherwise mirrors Pyramid's own FlyingPairCard. */
function FlyingSequenceCard({ card, from, to, delayMs, frame, cardWidth, onDealt, onLanded }: { card: Card; from: ScreenPoint; to: ScreenPoint; delayMs: number; frame: OverlayFrame; cardWidth: number; onDealt: () => void; onLanded: () => void }) {
  const cardHeight = cardWidth / CARD_ASPECT
  const tx = useSharedValue(from.x)
  const ty = useSharedValue(from.y)
  const zIndex = useSharedValue(0)
  const notified = useRef(false)

  useEffect(() => {
    const config = autoMoveSpringFor(Math.hypot(to.x - from.x, to.y - from.y))
    tx.value = withDelay(delayMs, withSpring(to.x, config))
    ty.value = withDelay(delayMs, withSpring(to.y, config))
    zIndex.value = withDelay(delayMs, withTiming(100 + delayMs, { duration: 0 }))
    const dealtTimer = setTimeout(onDealt, delayMs)
    const timer = setTimeout(
      () => {
        if (notified.current) return
        notified.current = true
        onLanded()
      },
      // The spring's real end, not its bare `duration` (see dragSpring.ts's springSettleMs) - the withDelay
      // above starts on the UI thread, a frame or two after this timer does, just like the spring itself.
      delayMs + springSettleMs(config)
    )
    return () => {
      clearTimeout(dealtTimer)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const style = useAnimatedStyle(() => {
    const p = toLocal(tx.value, ty.value, cardWidth, cardHeight, frame)
    return { zIndex: zIndex.value, transform: [{ translateX: p.x }, { translateY: p.y }] }
  })

  return (
    <Animated.View style={[sequenceFlightStyles.ghostCard, style]}>
      <PlayingCard card={card} />
    </Animated.View>
  )
}

const sequenceFlightStyles = StyleSheet.create({
  ghostCard: {
    left: 0,
    position: 'absolute',
    top: 0
  }
})

/** Renders every live sequence flight: each run's cards travel independently, each from its own
 * real position, rather than through the single shared `ghost` (DragGhostLayer, which only ever
 * animates one origin/delta for its whole group) or the shared `deal` animator (whose start()
 * replaces its whole batch on every call - a second call while a stock deal is still flying would
 * silently cancel it, and nothing here stops a tap-triggered completion or undo from landing
 * mid-deal). Same "N independent simultaneous ghosts" idiom DealLayer/WinCascadeLayer/Pyramid's
 * PairFlightGhosts already use. Always mounted (only `flights`'s contents are conditional) so its
 * own offset-correction effect can measure a real position at all times. */
function SequenceFlightGhosts({ flights, onCardLanded }: { flights: SequenceFlightInstance[]; onCardLanded: (id: number, cardId: string) => void }) {
  // Same overlay-placement pattern as DragGhostLayer/DealLayer - see overlayFrame.ts.
  const { overlayRef, frame } = useOverlayFrame()
  // Own instance, same as StockPacket's own useDragGhost() call above - this is a screen-level
  // sibling component, not nested under SpiderScreenInner, so it needs its own hook call to reach
  // these rather than having them threaded down as props.
  const { playCardSound, hapticCard } = useCardSoundEffects()

  return (
    <View ref={overlayRef} pointerEvents='none' style={StyleSheet.absoluteFill}>
      {flights.map((flight) => (
        <CardSizeProvider key={flight.id} width={flight.cardWidth}>
          {flight.cards.map(({ card, from, to, delayMs }) => (
            <FlyingSequenceCard
              key={`${flight.id}-${card.id}`}
              card={card}
              from={from}
              to={to}
              delayMs={delayMs}
              frame={frame}
              cardWidth={flight.cardWidth}
              onDealt={() => {
                playCardSound()
                hapticCard()
              }}
              onLanded={() => onCardLanded(flight.id, card.id)}
            />
          ))}
        </CardSizeProvider>
      ))}
    </View>
  )
}

export default withGameProviders(SpiderScreenInner)

function SpiderScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  const [ready, setReady] = useState(false)
  // The suit count of the game currently in progress - only updated when a new game actually
  // starts (mount, or handleNewGame below), always reading the live `settings.spiderSuits` at
  // that moment. Deliberately NOT derived directly from `settings.spiderSuits` on every render:
  // the in-progress game's own controller/rules must stay fixed to whatever suit count it was
  // dealt with, even if the player changes the setting mid-game without starting a new deal.
  const [numSuits, setNumSuits] = useState<1 | 2 | 4>(settings.spiderSuits)
  const controller = useMemo(() => createSpiderController(numSuits), [numSuits])

  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with
  // each other - PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`,
  // `commitState`, `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working
  // unchanged. Spider has no foundation piles/useAutoFoundationCascade, so activeFlightCount (the state
  // mirror of the ref, which handleUndo's own guard reads) only feeds the win celebration's `settled` flag.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, activeFlightCountRef, startFlights, settleFlight, undoBusyRef, reset: resetFlightConcurrency } = useFlightConcurrency<SpiderState>()
  const [history, setHistory] = useState<HistoryEntry[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: SpiderState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useDerivedWinCheck's own hintsUsedRef param), to
  // decide whether this win counts toward the "wins without hint" stat/achievement. Reset
  // alongside `history` in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const [message, setMessage] = useState<string | null>(null)

  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth, isWide } = useGameLayout()
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  // The width-derived size in portrait (unchanged); in the wide layout also capped so the tallest
  // starting column still fits the ~400pt of height - see boardModel.ts.
  const cardWidth = useFittedCardWidth(widthCardWidth, BOARD_MODEL)
  const gap = useFittedGap(widthGap, widthCardWidth, cardWidth, contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  // Was a fixed 420 literal - now adapts to real window height the same way every other
  // PileView-using game already does (see useTableauMaxHeight's own doc comment), 420 kept as the
  // floor so a short/cramped screen never gets less generous than it did before.
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, 420)
  const ghost = useDragGhost()
  const deal = useDealAnimator()
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  /** A stock deal awaiting its post-commit measurement + deal.start() (see runDeal/the effect
   * below) - stashes the actual dealt cards and the already-measured flight origin (the specific
   * packet dealt from - see handleDrawStock) rather than a bare token, since a card can immediately
   * complete (and get removed as part of) a run the instant it's dealt - see runDeal's comment.
   * `sweeps` maps a completing column's just-dealt card id to the run/slot/column it completes -
   * that card lands normally like any other (via `dealt`'s restored-tableau displayState), then
   * runDeal's onEachLanded hook (see below) sends the whole run on to its foundation slot the
   * instant it arrives, exactly like a tableau move's own two-phase completion.
   *
   * Deliberately still a single nullable slot, not an array, even though tap/drag moves' own
   * pendingMoveFlightsRef (below) had to become one: `deal` (useDealAnimator/DealLayer) only ever
   * supports ONE active batch at a time by its own design (a second deal.start() call mid-flight
   * silently replaces/cancels whatever batch is already animating - see SequenceFlightGhosts' own
   * doc comment) - an existing constraint this refactor doesn't touch. Since at most one stock-deal
   * (or stock-deal-undo, see pendingUndoDealRef below) can ever really be in flight regardless of
   * this ref's own shape, making it an array would add bookkeeping without enabling any genuine
   * concurrency the underlying `deal` provider can't already serialize away on its own. */
  const pendingDealRef = useRef<{
    dealt: { card: Card; colIndex: number }[]
    origin: { x: number; y: number } | null
    token: number
    sweeps?: Map<string, PendingSweep>
  } | null>(null)
  /** The token of the stock deal in flight, from the tap that started it until the deal has settled - null when there is none.
   * At most one at a time, which is what `deal` (one active batch) and pendingDealRef (one slot) already assume: a second draw
   * mid-way used to either replace the first's pendingDealRef (dropping its flight claim and any run sweep it held, which
   * locks every later action - see claimSweep - and undo, for good) or call deal.start() over a batch still in the air (the
   * first batch's landed/settled callbacks are then silenced for good). Refused up front instead, before it claims anything.
   * Released where the deal's own claim is (runDeal's onSettled, wired in the [state]-effect below), and dropped by New
   * Game/restore, which reset every claim outright. */
  const stockDealTokenRef = useRef<number | null>(null)
  // runInitialDeal re-reads the dealt tableau straight from `state`, exactly like Klondike's own
  // initial-deal effect does - see useDeferredDeal's own doc comment for the race this guards.
  const scheduleInitialDeal = useDeferredDeal(state, dealTokenRef, runInitialDeal)
  /** An undone stock deal awaiting its post-commit measurement + deal.start() (see runUndoDeal/the
   * effect below) - the mirror image of pendingDealRef: this flight's origins (where the dealt
   * cards currently sit) are measured up front, before the revert below removes them, while its
   * single shared destination (the stock fan's restored packet) can only be measured after, once
   * that packet exists to register itself - the same "measure whichever side hasn't mounted yet"
   * split as every other deferred deal effect here, just with which side is early/late swapped.
   * Same single-slot reasoning as pendingDealRef above - `deal`'s own one-active-batch-at-a-time
   * constraint means at most one stock-deal-undo is ever really in flight regardless. */
  const pendingUndoDealRef = useRef<{
    entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[]
    destinationPacketIndex: number
    token: number
  } | null>(null)
  /** A tap-to-move or drag-drop's own ghost flight (via `ghost`, DragGhostLayer), awaiting its
   * post-commit measurement + flight.flyTo - a list, not a single slot like pendingDealRef/
   * pendingUndoDealRef above, since these genuinely CAN overlap now (see PATTERN_OVERLAP_GATE):
   * two taps/drags queued in the same commit (or back-to-back before React re-renders) would
   * otherwise clobber each other in a single ref slot, permanently stranding whichever one lost.
   * Combines what were three separately-paired single-slot refs before this refactor
   * (pendingAutoMoveCardIdRef/pendingFlightRef/pendingRunSweepRef) into one entry per queued
   * flight, since all three always moved together 1:1 - once genuine concurrency is possible, a
   * SEPARATE single-slot pendingRunSweepRef would risk a second concurrent move's own sweep
   * clobbering the first's before its landing effect below ever reads it. `sweep` carries what
   * pendingRunSweepRef used to (set only by completeMove, never by finishMoveUndo/undo, which
   * never completes a NEW run) - once this entry's own ghost lands, the effect below hands off to
   * sweepRunToFoundation instead of just ending this flying entry, exactly as before. */
  const pendingMoveFlightsRef = useRef<PendingMoveFlight[]>([])
  /** How many completed runs are still assembled in the tableau waiting for sweepRunToFoundation (see PendingSweep) - a
   * counter, since one stock deal can complete several columns. A run leaves as a second phase AFTER the move (or the dealt
   * card) that completed it lands, so for that stretch - the move's ghost, then the sweep's measurements - the board still
   * shows the run in its column, and a tap, drag, stock deal or undo in that window would act on cards the sweep is about to
   * remove: removeRun slices the run off the END of its column by length, so it would cut whichever cards are on top by
   * then. Every entry point that moves, deals or undoes therefore bows out while this is above zero (a second run completing
   * concurrently would also be handed the same foundation slot). A ref, not state: only those guards read it, synchronously. */
  const sweepPendingRef = useRef(0)
  /** Bumped by every New Game/restore. A claim made under an older epoch belongs to a game that no longer exists - see claimSweep. */
  const sweepEpochRef = useRef(0)
  /** Set by startUndoRunCompletion once the run's cards' shared origin (the foundation slot) has
   * been measured - resolved by the effect below once the intermediate state (with those cards
   * freshly restored into the tableau) has actually committed, since each card's own destination
   * fan position can only be measured once it's mounted there. Once every card in that flight has
   * landed, it hands off to finishMoveUndo to run its own second phase: peeling the actively-moved
   * subgroup back to its source column, exactly like a normal move-undo. */
  const pendingRunRestoreRef = useRef<{ run: Card[]; origin: { x: number; y: number }; move: MoveInfo; prevState: SpiderState; token: number } | null>(null)
  // undoBusyRef (guards handleUndo against overlapping invocations) now comes from
  // useFlightConcurrency above. Undoing a stock deal that ALSO completed one or more runs kicks
  // off two independent flight pipelines from one commitState: the dealt cards flying back into
  // the stock fan (runUndoDeal) and the completed run(s) flying back into the tableau
  // (undoSequenceCompletions's own effect below). Either can finish before the other - see
  // handleUndo's own startFlights(2)/two-settleFlight()-call comment for how the shared
  // activeFlightCountRef (not a bespoke pipeline counter, as this used to work) now tracks that.
  const winCascade = useWinCascade()
  // Derived from `state` every render (see useDerivedWinCheck) rather than mirrored into its own
  // useState: it's a pure function of state, so Undo-ing out of a won position correctly drops the
  // win banner immediately, rather than leaving it stuck showing.
  const { won, recordedRef, pendingWinCascadeRef } = useDerivedWinCheck(controller, state, 'spider', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** One ref per completed-sequence slot below - unlike a foundation pile's own card, these slots
   * have no per-card CardRegistry registration (there's no single occupant identity to track, just
   * "is this run done or not") - measured the same plain-view way Pyramid's discard pile is. */
  const completedSlotRefs = useRef<(View | null)[]>(new Array(8).fill(null))
  /** Slots whose real card is hidden while a sequence flight is en route to them (see
   * completeMoveWithSequenceFlight/handleDrawStock) - the same "hide the destination until the
   * ghost visually catches up" technique dealHiddenIds/flying already use elsewhere in this file. */
  const [completingSlots, setCompletingSlots] = useState<Set<number>>(new Set())
  const [sequenceFlights, setSequenceFlights] = useState<SequenceFlightInstance[]>([])
  const sequenceFlightIdRef = useRef(0)
  // Nothing animating: every ghost flight (tap/drag, stock deal, run sweep, undo) holds an activeFlightCount claim
  // until it lands (startSequenceFlight claims one per sweep/restore flight), and the initial deal holds dealHiddenIds
  // until its last card does. sequenceFlights is the ghosts actually still mounted - checked directly as well.
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0 && sequenceFlights.length === 0
  // `won` is derived from the SWEPT state - it flips when the last run leaves the tableau for its slot, so the
  // celebration (slots blanking for the win cascade, fireworks, banner) waits for that last sweep flight to land and
  // the finished board to hold a beat, instead of cutting it short. See useWinReveal.
  const winRevealed = useWinReveal(won, settled)
  // The board the win cascade has taken over from, and the slots it has a chain for (set together with startChains, see
  // runWinCascade): a slot blanks only once the win is revealed AND the current state IS that board AND its own chain
  // started - never a moment earlier (the slot would sit empty until its ghosts mount) and never without a chain to show for
  // it (an unmeasurable slot keeps its King rather than vanishing). Compared by identity (state is replaced wholesale on every
  // change), so an undo or a New Game un-blanks the slots with no reset to remember.
  const [cascadeHandoff, setCascadeHandoff] = useState<{ forState: SpiderState; slots: ReadonlySet<number> } | null>(null)
  // Per-flight-instance "cards still in flight" counter - decremented by handleSequenceFlightLanded
  // as each of that instance's own cards lands, so multiple concurrent instances (a stock deal that
  // completes more than one column at once) can each detect their OWN completion independently.
  const sequenceFlightPendingRef = useRef<Map<number, number>>(new Map())
  /** Per-instance landing behavior, keyed by the same id as sequenceFlightPendingRef - a ref (not
   * state) so handleSequenceFlightLanded always reads the callbacks a flight actually started with,
   * never a stale snapshot from whatever render last touched `sequenceFlights`. */
  const sequenceFlightCallbacksRef = useRef<Map<number, { onCardLanded?: (cardId: string) => void; onAllLanded: () => void }>>(new Map())
  /** One or more runs awaiting undo - stashed by undoSequenceCompletions, resolved by the effect
   * below once prevState has actually committed (each card's restored tableau position can only be
   * measured once it's re-mounted there) - mirrors pendingDealRef/pendingRemovalUndoRef's own shape. */
  const pendingSequenceUndoRef = useRef<{ bySlot: { slotIndex: number; origin: { x: number; y: number } | null; run: Card[] }[]; token: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handlePressCard and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  // Claims one pending run sweep (see sweepPendingRef). The returned `release` gives the claim back exactly once however often
  // it is called, and reports whether the claim was still live: false once a New Game/restore has replaced the board since,
  // which already zeroed the counter (so it is not decremented a second time) and means the sweep the claim belonged to must
  // not touch the fresh game - its removeRun would cut a run's worth of cards out of a board that never completed one.
  function claimSweep(): () => boolean {
    const epoch = sweepEpochRef.current
    sweepPendingRef.current += 1
    let released = false
    return () => {
      const live = sweepEpochRef.current === epoch
      if (live && !released) sweepPendingRef.current -= 1
      released = true
      return live
    }
  }

  function resetSweepClaims() {
    sweepEpochRef.current += 1
    sweepPendingRef.current = 0
  }

  const startNewGame = useCallback(
    (ctrl: ReturnType<typeof createSpiderController>) => {
      const myToken = ++dealTokenRef.current
      const s = ctrl.newGame(randomSeed())
      setHistory([])
      setHint(null)
      hintsUsedRef.current = false
      resetFlightConcurrency()
      resetSweepClaims()
      stockDealTokenRef.current = null
      pendingMoveFlightsRef.current = []
      pendingDealRef.current = null
      pendingUndoDealRef.current = null
      session.reset()
      setMessage(null)
      recordedRef.current = false
      winCascade.clear()
      pendingWinCascadeRef.current = null

      const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
      setDealHiddenIds(dealtIds)
      scheduleInitialDeal(myToken)
      commitState(s)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo history (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment). `saved.config` is the suit
  // count the game was actually dealt under (see numSuits's own doc comment above) - falls back to
  // the live setting only if the saved value is somehow missing/invalid. Setting numSuits here is
  // enough to bring `controller` (a useMemo keyed on it) back in sync by the same render that
  // commits `state` below - both setters run inside the same batch.
  function restoreGame(saved: SavedGame<SpiderState>) {
    ++dealTokenRef.current
    const suits = saved.config === 1 || saved.config === 2 || saved.config === 4 ? saved.config : settings.spiderSuits
    setNumSuits(suits)
    setHistory(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    resetSweepClaims()
    stockDealTokenRef.current = null
    pendingMoveFlightsRef.current = []
    pendingDealRef.current = null
    pendingUndoDealRef.current = null
    session.restore(saved.moves, saved.elapsedSeconds)
    setMessage(null)
    recordedRef.current = false
    setDealHiddenIds(new Set())
    commitState(saved.state)
  }

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<SpiderState>('spider').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame(controller)
      setReady(true)
      setLastActiveGame('spider')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won so
  // a just-won deal doesn't get checkpointed as still in-progress (the win-check effect below
  // clears the save outright instead) - since `won` is derived fresh from `state` on every render,
  // undoing back out of a won position re-enables saving again on that same render, no separate
  // reset needed. Deliberately NOT also keyed on a ticking elapsed-seconds value the way an
  // earlier version of this effect was: `session.getElapsed()` computes the true current elapsed
  // from wall-clock time on demand (see useGameSession.ts), so a save made at the last real move is
  // never stale even once the player just sits looking at the board afterward - resuming always
  // recomputes the exact right value instead of depending on whenever this effect last happened to
  // run.
  useEffect(() => {
    if (state && !won) {
      saveGameInProgress('spider', { state, undoStack: history, moves: session.moves, elapsedSeconds: session.getElapsed(), config: numSuits })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, numSuits, history])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('spider', { state, undoStack: history, moves: session.moves, elapsedSeconds: session.getElapsed(), config: numSuits })
  })

  // Foundation-equivalent measurement for Spider's win cascade: each completed run's own slot
  // (see completedSlotRefs above) is a stable, always-mounted plain View - unlike a foundation
  // pile's per-card CardRegistry registration, there's no per-card identity to look up here, just
  // the slot's own screen position. Same dealTokenRef guard as every other async measurement in
  // this file, for the same "New Game tapped mid-measurement" reason.
  //
  // The slots keep drawing their Kings while this measures (their containers are card-sized and always mounted, so they
  // measure the same whether or not a King is drawn) and blank only in the SAME commit that mounts the cascade's ghosts:
  // startChains and setCascadeHandoff run in one async continuation, which React batches into one render. Blanking at the
  // reveal instead left every slot empty for the few frames this measurement takes, before any ghost stood there. A slot with
  // no chain (its container could not be measured) simply keeps its King, and if no chain starts at all every slot stays up.
  async function runWinCascade(s: SpiderState, gen: number) {
    const origins = await Promise.all(completedSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    const chained = new Set<number>()
    s.completedRuns.forEach((run, slot) => {
      const origin = origins[slot]
      if (!origin || run.length === 0) return
      chains.push({ cards: run, origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS }) // already King-first, Ace-last
      chained.add(slot)
    })
    winCascade.startChains(chains, cardWidth)
    if (chained.size > 0) setCascadeHandoff({ forState: s, slots: chained })
  }

  // Held back until the win is revealed (see winRevealed): the pending token is set as soon as the last run is swept,
  // but the cascade takes over from the slots, so it must not start while that run is still flying to its slot.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  // THE KEY WIRING for making sequenceFlights participate in the shared activeFlightCountRef (see
  // useFlightConcurrency): every call - whichever of the three call sites (sweepRunToFoundation,
  // undoSequenceCompletions' own [state]-effect, startUndoRunCompletion's own [state]-effect) -
  // claims exactly one outstanding completion here, matching how Klondike counts its own multi-card
  // deal-style flights as one. Balanced 1:1 by handleSequenceFlightLanded's own settleFlight() call
  // below, once every card belonging to THIS instance has landed.
  function startSequenceFlight(cards: SequenceFlightCardSpec[], onAllLanded: () => void, onCardLanded?: (cardId: string) => void) {
    const id = ++sequenceFlightIdRef.current
    sequenceFlightPendingRef.current.set(id, cards.length)
    sequenceFlightCallbacksRef.current.set(id, { onCardLanded, onAllLanded })
    setSequenceFlights((flights) => [...flights, { id, cardWidth, cards }])
    startFlights(1)
  }

  // Phase 2 of a completed run: it currently sits fully assembled in the tableau (see
  // completeMove/handleDrawStock's displayState) - measure each of its 13 cards' current position
  // before removing them from the tableau, then fly them to the foundation slot individually, Ace
  // first through King last (King ends up "on top," the only card the slot actually displays) -
  // the same per-card stagger pace the win cascade uses (CHAIN_SEGMENT_DELAY_MS), each with its own
  // sound/haptic as its own turn begins (see FlyingSequenceCard's onDealt). `completingSlots` hides
  // the slot's real King until every card in the flight has landed.
  //
  // Built in the run's own King-first array order (NOT arrival order) so z-order matches the
  // NORMAL tableau fan for the whole (often much longer) stretch before each card's own delay
  // elapses and it actually starts moving - Ace naturally painting in front of King the entire
  // time, exactly like the real fanned pile did a moment ago. Reversing this to arrival order
  // instead (King last => King painted on top) made King visibly "pop" on top of the whole
  // stationary fan for the ENTIRE flight, since z-order here is fixed for a card's whole lifetime,
  // not just its instant of arrival.
  //
  // Removes just THIS run from whatever the live state is at the moment it actually sweeps, rather
  // than jumping to a single precomputed final state - a stock deal can complete more than one
  // column at once, each column's card landing (and therefore sweeping) at its own staggered time,
  // so a column whose own dealt card hasn't landed yet must stay fully assembled and visible in the
  // tableau until its own turn, not disappear the instant some OTHER completing column sweeps.
  // `flyingId`, when given, is the pendingMoveFlightsRef entry this call is the second half of (a
  // tap/drag move that also completed a run - see the pendingMoveFlightsRef effect below) - its own
  // ghost-flight claim (beginFlying/startFlights) settles HERE, the instant this run is confirmed
  // fully landed in the tableau, not later once the sequence flight below also finishes (that's its
  // own, separately self-counted, startSequenceFlight claim - see that function's own doc comment).
  // Left undefined when called from handleDrawStock's own onEachLanded hook instead (a stock-deal's
  // cards were never tracked via `flying` at all - see runDeal/handleDrawStock's own dealHiddenIds-
  // based hiding), in which case there's no matching claim here to settle.
  //
  // `release` is this run's claim on sweepPendingRef (see claimSweep): given back the moment the measurements resolve, in
  // the same synchronous stretch as removeRun's commit below - so the board is held still exactly until the run has left it,
  // whichever of the exits below (unmeasurable slot, no measurable card, a normal flight) is taken. Neither measurement can
  // hang or throw: the registry answers null for an unregistered card and measureView for a missing view.
  async function sweepRunToFoundation(colIndex: number, slotIndex: number, run: Card[], release: () => boolean, flyingId?: number) {
    const [origins, destination] = await Promise.all([Promise.all(run.map((c) => ghost.cardRegistry.measure(c.id))), measureView(completedSlotRefs.current[slotIndex])])
    // A false answer: a New Game/restore replaced the board while those measurements were pending (a ghost of the old game
    // can still land, and card ids repeat from deal to deal, so they even measure). The flying claim below, the removal and
    // the flight all belong to the game that is gone - removeRun on the fresh board would cut cards out of it.
    if (!release()) return
    // Always runs regardless of whether `destination` resolves: `state` already shows this run
    // fully assembled in the tableau (see completeMove/handleDrawStock's own displayState), so
    // leaving this flying entry set would keep PileView hiding those already-landed real cards
    // behind a stale hiddenCount.
    if (flyingId !== undefined) {
      endFlying(flyingId)
      settleFlight()
    }
    const removeRun = (s: SpiderState): SpiderState => ({
      ...s,
      tableau: s.tableau.map((col, i) => (i === colIndex ? col.slice(0, col.length - run.length) : col)),
      completed: [...s.completed, run[0]],
      completedRuns: [...s.completedRuns, run]
    })
    // FINDING 3: bail out of the whole sweep BEFORE touching tableau state if the foundation slot
    // hasn't been measured yet (not laid out/measured on this render) - removing the run here
    // regardless would make it vanish instantly with the King popping into the slot fully opaque,
    // a hard teleport instead of a flight. Leaving the run untouched in the tableau lets a later
    // render (once the slot is actually measurable) retry it instead.
    if (!destination) {
      // The one exception is the LAST run: the win is derived from it being swept (isWon needs all 8 in their
      // slots), and nothing ever retries a bailed sweep, so bailing would leave the game unwinnable with a full
      // run sitting in the tableau. A pathological unmeasurable slot is the one case worth a teleport over that.
      if (slotIndex === completedSlotRefs.current.length - 1 && stateRef.current) commitState(removeRun(stateRef.current))
      return
    }
    // Reads via stateRef.current, not the closure `state` - by the time this async function's own
    // await above resolves, a concurrent action (now genuinely possible - see PATTERN_OVERLAP_GATE)
    // could have committed a newer board than whatever render this closure was created in. The
    // original functional setState((s) => ...) form was already immune to this same staleness;
    // stateRef.current is commitState's own equivalent for a plain (non-updater) commit.
    const current = stateRef.current
    if (current) commitState(removeRun(current))

    const cards: SequenceFlightCardSpec[] = []
    run.forEach((card, i) => {
      const origin = origins[i]
      if (origin) cards.push({ card, from: origin, to: destination, delayMs: (run.length - 1 - i) * CHAIN_SEGMENT_DELAY_MS })
    })
    if (cards.length === 0) return
    setCompletingSlots((slots) => new Set(slots).add(slotIndex))
    startSequenceFlight(cards, () => {
      setCompletingSlots((slots) => {
        if (!slots.has(slotIndex)) return slots
        const next = new Set(slots)
        next.delete(slotIndex)
        return next
      })
    })
  }

  // Phase 2 of an undo-of-completion (see startUndoRunCompletion), and the entire body of a plain
  // move-undo: the card(s) being undone are sitting wherever the move left them (`move.to`) -
  // measure that real position before reverting (the pendingMoveFlightsRef effect above can
  // only measure a DESTINATION once it's committed and re-rendered, so the ORIGIN has to be
  // captured here, synchronously against the still-current `state`), then revert and mark
  // `move.from` as incoming so it flies the rest of the way there exactly like a fresh move would.
  // Reads `state` fresh rather than taking it as a param: for a plain undo that's the live
  // pre-undo board; for phase 2 of a completion-undo, `state` has already moved on to the
  // consolidated-landing intermediate state by the time this runs, and `move.to`'s pile there
  // naturally IS the just-restored full run, so slicing off the top `count` cards already finds
  // exactly the actively-moved subgroup with no extra bookkeeping.
  async function finishMoveUndo(move: MoveInfo, prevState: SpiderState) {
    const sourcePile = state!.tableau[move.to.index] ?? null
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    if (origin) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(move.from, move.count)
      commitState(prevState)
      pendingMoveFlightsRef.current.push({ cardId: move.anchorCardId, flight, flyingId, sweep: null })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // Measuring CardRegistry synchronously right after the setState in commitMove would find the
  // still-mounted SOURCE card (the destination card's own registration effect hasn't run yet), so
  // the ghost would "fly" a near-zero distance back to roughly where it started - indistinguishable
  // from a snap (same race documented for Klondike's deal animation). Deferring to a [state]-keyed
  // effect guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    if (pendingMoveFlightsRef.current.length === 0 || !state) return
    const pending = pendingMoveFlightsRef.current
    pendingMoveFlightsRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        const landed = await ghost.cardRegistry.measure(p.cardId)
        // Once this ghost lands, either hand off to phase 2 of a run completion (see
        // completeMove/sweepRunToFoundation) or finish normally.
        const proceed = () => {
          if (p.sweep) {
            sweepRunToFoundation(p.sweep.colIndex, p.sweep.slotIndex, p.sweep.run, p.sweep.release, p.flyingId)
            return
          }
          endFlying(p.flyingId)
          settleFlight()
        }
        if (landed) {
          p.flight.flyTo(landed.x, landed.y, proceed)
        } else {
          p.flight.hide()
          proceed()
        }
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Resolves each run's cards' real restored destinations once prevState has actually committed
  // (see pendingSequenceUndoRef/undoSequenceCompletions above), then starts their independent
  // flight back into the tableau - the mirror image of the forward completion flight's measure-
  // before-setState timing, since here it's the DESTINATION (not the origin) that only exists once
  // this commit's tableau has re-mounted the restored cards. A run whose origin couldn't be
  // measured, or none of whose cards' destinations resolve, is revealed immediately instead of left
  // stuck hidden forever; if nothing in this whole batch actually started a flight, undoBusyRef is
  // cleared here too, since no landed callback will ever fire to do it (see handleSequenceFlightLanded).
  useEffect(() => {
    const pending = pendingSequenceUndoRef.current
    // Same "don't settle on a stale token" reasoning as runUndoDeal's/runDeal's own guards above -
    // this ref is only ever written by undoSequenceCompletions, itself only ever called from
    // handleUndo's stock-deal-undo branch, which holds full exclusivity (undoBusyRef) against a
    // second overlapping handleUndo - so the only way this token goes stale is a DIFFERENT action
    // (New Game/restore) that's already reset activeFlightCountRef via resetFlightConcurrency.
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingSequenceUndoRef.current = null
    ;(async () => {
      // First pass: resolve every slot's own destinations before starting anything, so the total
      // "how many flights will actually start" count (needed for FINDING 1's shared pipeline
      // counter) is known up front rather than growing mid-loop while earlier flights are already
      // animating.
      const perSlot: { cards: SequenceFlightCardSpec[]; run: Card[]; failedIds: string[] }[] = []
      for (const { origin, run } of pending.bySlot) {
        const destinations = origin ? await Promise.all(run.map((c) => ghost.cardRegistry.measure(c.id))) : run.map(() => null)
        // Same stale-token reasoning as this effect's own outer guard above - deliberately no
        // settleFlight() here either.
        if (dealTokenRef.current !== pending.token) return
        const cards: SequenceFlightCardSpec[] = []
        const failedIds: string[] = []
        if (origin) {
          // King (index 0) flies first and Ace (last index) flies last, mirroring the order they
          // were originally dealt/built in the column (King placed first, Ace last/on top) -
          // reusing the win cascade's own per-card stagger (CHAIN_SEGMENT_DELAY_MS) for a
          // consistent "cards peeling into place" pace.
          //
          // Built in REVERSE (Ace first in the array, King last) even though King departs first:
          // while every card still waits at the shared origin (the foundation slot), all of them
          // sit at zIndex 0 (see FlyingSequenceCard) and plain document order decides who's
          // visible on top of that stack - putting King last keeps the slot looking like it
          // normally does (showing the King) for as long as any card is still waiting there,
          // instead of Ace (array-natural order's own last entry) incorrectly popping to the
          // front the instant this flight starts.
          for (let i = run.length - 1; i >= 0; i--) {
            const card = run[i]
            const to = destinations[i]
            if (to) cards.push({ card, from: origin, to, delayMs: i * CHAIN_SEGMENT_DELAY_MS })
            else failedIds.push(card.id)
          }
        }
        perSlot.push({ cards, run, failedIds })
      }

      // FINDING 1: track how many of these per-slot flights are actually starting, and only
      // settleFlight() the ONE claim handleUndo made for this whole "undoSequenceCompletions"
      // pipeline (see its own startFlights(2) comment) once every one of THEM has also landed - a
      // stock deal can complete more than one column at once, each becoming its own flight
      // instance here, each of which ALSO makes (and settles) its own separate startSequenceFlight
      // claim (see that function's own doc comment) - the local `remaining` countdown below is
      // deliberately a second, independent tally on top of that per-instance self-counting, so this
      // pipeline's own settleFlight() only fires once every one of ITS OWN instances is done, not
      // merely once ANY sequence flight anywhere happens to land.
      const startingFlights = perSlot.filter((s) => s.cards.length > 0)
      let remaining = startingFlights.length
      if (remaining === 0) settleFlight()

      perSlot.forEach(({ cards, run, failedIds }) => {
        if (cards.length === 0) {
          // Nothing in this run could be measured at all - unhide the whole thing immediately
          // rather than leave it stuck invisible forever.
          setDealHiddenIds((ids) => {
            const next = new Set(ids)
            run.forEach((c) => next.delete(c.id))
            return next
          })
          return
        }
        if (failedIds.length > 0) {
          // FINDING 2: at least one (but not all) of this run's cards failed to measure its
          // restored destination - unhide just those now, since the flight below only ever
          // unhides the ids it actually flies (its own onCardLanded callback), which would
          // otherwise leave these specific cards permanently hidden even though every sibling in
          // the same run lands fine.
          setDealHiddenIds((ids) => {
            const next = new Set(ids)
            failedIds.forEach((id) => next.delete(id))
            return next
          })
        }
        startSequenceFlight(
          cards,
          () => {
            remaining -= 1
            if (remaining <= 0) settleFlight()
          },
          (cardId) => {
            setDealHiddenIds((ids) => {
              if (!ids.has(cardId)) return ids
              const next = new Set(ids)
              next.delete(cardId)
              return next
            })
          }
        )
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Resolves each card's real restored fan position once the intermediate state (see
  // startUndoRunCompletion) has actually committed, then flies them individually back into the
  // tableau, King first through Ace last - the same order they were originally built in, mirroring
  // sweepRunToFoundation's own peel-off in reverse. Once every card in that flight has landed
  // (or immediately, if none could be measured), it hands off to phase 2: finishMoveUndo peels the
  // actively-moved subgroup back to its source column.
  //
  // Built in REVERSE (Ace first in the array, King last) even though King departs first - see the
  // identical comment on undoSequenceCompletions' own effect above: while every card still waits
  // at the shared origin (the foundation slot), they all sit at zIndex 0 and document order alone
  // decides who's visibly on top there, so King needs to be last in the array to keep the slot
  // looking like it normally does for as long as anything is still waiting on it.
  //
  useEffect(() => {
    const pending = pendingRunRestoreRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingRunRestoreRef.current = null
    ;(async () => {
      const destinations = await Promise.all(pending.run.map((c) => ghost.cardRegistry.measure(c.id)))
      if (dealTokenRef.current !== pending.token) return
      const cards: SequenceFlightCardSpec[] = []
      const failedIds: string[] = []
      for (let i = pending.run.length - 1; i >= 0; i--) {
        const card = pending.run[i]
        const to = destinations[i]
        if (to) cards.push({ card, from: pending.origin, to, delayMs: i * CHAIN_SEGMENT_DELAY_MS })
        else failedIds.push(card.id)
      }
      if (cards.length === 0) {
        setDealHiddenIds((ids) => {
          const next = new Set(ids)
          pending.run.forEach((c) => next.delete(c.id))
          return next
        })
        await finishMoveUndo(pending.move, pending.prevState)
        return
      }
      if (failedIds.length > 0) {
        // FINDING 2: at least one (but not all) of this run's cards failed to measure its
        // restored fan position - unhide just those now, since the flight below only ever
        // unhides the ids it actually flies.
        setDealHiddenIds((ids) => {
          const next = new Set(ids)
          failedIds.forEach((id) => next.delete(id))
          return next
        })
      }
      startSequenceFlight(
        cards,
        () => finishMoveUndo(pending.move, pending.prevState),
        (cardId) => {
          setDealHiddenIds((ids) => {
            if (!ids.has(cardId)) return ids
            const next = new Set(ids)
            next.delete(cardId)
            return next
          })
        }
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Shared tail for both the initial deal and every later stock-deal (see runInitialDeal and
  // handleDrawStock's effect below) - flies each of `cards` from the same single `origin` (already
  // measured by the caller, which the "no cards left to fly" case below also relies on to tell a
  // real empty deal apart from one that's still waiting on a caller-side measurement) to its own
  // real (already re-rendered) destination, each after its own `delayMs`. A card whose destination
  // can't be measured - namely a Spider run that completed (see resolveCompletedSequence) and
  // removed that very card the instant it landed - simply has no entry, so its own flight is
  // skipped while every other card's still flies normally, mirroring Klondike's own runDeal.
  //
  // `onSettled`, when given, is called exactly once, on whichever of this function's terminal
  // paths is actually reached (no origin, no measurable destinations, or deal.start's own
  // all-landed callback) - the [state]-effect below passes settleFlight here, since it's the ONLY
  // caller with a matching startFlights(1) claim to settle (handleDrawStock's own, made before it
  // stashes pendingDealRef.current - see that effect's own comment). runInitialDeal never passes
  // one: the initial deal happens before any player action (and therefore any undo/flight
  // bookkeeping) is even possible, so there's nothing of this hook's to settle for it.
  async function runDeal(cards: { card: Card; delayMs: number }[], origin: { x: number; y: number } | null, token: number, onEachLanded?: (cardId: string) => void, onSettled?: () => void) {
    if (!origin) {
      setDealHiddenIds(new Set())
      onSettled?.()
      return
    }
    const destinations = await Promise.all(cards.map((c) => ghost.cardRegistry.measure(c.card.id)))
    // A stale token means New Game/restore replaced the game while the destinations were being measured, and already reset
    // every claim (resetFlightConcurrency, resetSweepClaims) - including this deal's own - so, like runUndoDeal's identical
    // guard below, this does NOT settle: that would decrement whatever newer action's claim is current now. (It used to settle
    // here, back when two stock draws could overlap and supersede each other with no reset in between - handleDrawStock's
    // stockDealTokenRef now refuses the second one up front, so a reset is the only way to get here.)
    if (dealTokenRef.current !== token) return

    const entries: DealCardSpec[] = []
    const failedIds: string[] = []
    cards.forEach((c, i) => {
      const dest = destinations[i]
      if (!dest) {
        failedIds.push(c.card.id)
        return
      }
      entries.push({
        cardId: c.card.id,
        card: c.card,
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: c.delayMs
      })
    })
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      onSettled?.()
      return
    }
    if (failedIds.length > 0) {
      // FINDING 2: at least one (but not all) of this batch's destinations failed to measure -
      // unhide just those now, since deal.start below only ever unhides the ids it actually
      // flies (its own onEachLanded callback below), which would otherwise leave these specific
      // cards permanently invisible for the rest of the hand even though every sibling in the
      // same batch (initial deal or stock draw) lands fine.
      setDealHiddenIds((ids) => {
        const next = new Set(ids)
        failedIds.forEach((id) => next.delete(id))
        return next
      })
    }

    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        if (dealTokenRef.current !== token) return
        setDealHiddenIds((ids) => {
          if (!ids.has(cardId)) return ids
          const next = new Set(ids)
          next.delete(cardId)
          return next
        })
        onEachLanded?.(cardId)
      },
      () => onSettled?.()
    )
  }

  // Same race as the pending auto-move effect above (and Klondike's identical deal effect):
  // measuring CardRegistry synchronously right after the setState in handleDrawStock would run
  // before the newly-dealt cards' own registration effects have fired. Deferring to this
  // [state]-keyed effect guarantees they've already registered by the time runDeal measures them.
  useEffect(() => {
    const pending = pendingDealRef.current
    // A stale token here (superseded before this effect even ran) most plausibly means New Game/
    // restore already fired - which calls resetFlightConcurrency() and so has already zeroed
    // activeFlightCountRef itself - so this bail deliberately does NOT settleFlight(), the same
    // reasoning runUndoDeal's own stale-token bail documents below (settling here could instead
    // wrongly decrement whatever NEWER action's own claim is now current).
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingDealRef.current = null
    runDeal(
      pending.dealt.map((d) => ({ card: d.card, delayMs: d.colIndex * DEAL_STAGGER_MS })),
      pending.origin,
      pending.token,
      pending.sweeps
        ? (cardId) => {
            const sweep = pending.sweeps!.get(cardId)
            if (!sweep) return
            // Taken out of the map as it starts, so the settle callback below only sees sweeps that never did.
            pending.sweeps!.delete(cardId)
            sweepRunToFoundation(sweep.colIndex, sweep.slotIndex, sweep.run, sweep.release)
          }
        : undefined,
      // Settles the startFlights(1) claim handleDrawStock made before stashing pendingDealRef -
      // this is the ONLY caller of runDeal with such a claim to settle (see runInitialDeal below,
      // which passes nothing).
      () => {
        // The deal is over: the next draw may start (a token that no longer matches is a superseded game's, already dropped).
        if (stockDealTokenRef.current === pending.token) stockDealTokenRef.current = null
        settleFlight()
        // A run whose completing card never got a flight (runDeal found no origin, or that card's own destination could not
        // be measured) is still assembled in its column and holds a claim on sweepPendingRef - which would block every move
        // and undo for good. Sweep it now: the run leaves like any other, just without a dealt card arriving first.
        pending.sweeps?.forEach((sweep) => sweepRunToFoundation(sweep.colIndex, sweep.slotIndex, sweep.run, sweep.release))
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Mirrors Klondike/Pyramid's own initial-deal animation (see components/dealing/DealLayer.tsx):
  // flies all 54 cards from the stock to their tableau positions, round-robin (see
  // buildSpiderDealSequence), the instant a fresh game commits. Unlike a stock-deal's origin (see
  // handleDrawStock), there's no already-mounted packet to measure BEFORE this commit - state was
  // null (or a previous game's tableau) until now - so the origin here can only be measured the
  // same way the per-card destinations are: after this fresh tableau, and the stock fan sitting
  // above it, have actually mounted and registered themselves.
  async function runInitialDeal(s: SpiderState, token: number) {
    const sequence = buildSpiderDealSequence(s.tableau)
    const originIndex = Math.ceil(s.stock.length / TABLEAU_COLUMNS) - 1
    const origin = await ghost.cardRegistry.measure(stockPacketId(originIndex))
    if (dealTokenRef.current !== token) return
    runDeal(
      // Flies face-down regardless of step.card's real faceUp - a real dealer lays every card
      // down blind and only turns the top one of each column face-up after it's placed, not
      // while it's still sliding across the table. The real card underneath (revealed the
      // instant this ghost lands - see dealHiddenIds) already carries the correct true faceUp,
      // so forcing it here only affects this flight's own appearance. Unlike this, a stock-deal's
      // own cards (see handleDrawStock below) are left showing their real face while flying -
      // every stock-dealt card is always face-up already, with no buried cards to distinguish it
      // from, the same as Klondike's own single-card stock-draw flight.
      sequence.map((step) => ({ card: { ...step.card, faceUp: false }, delayMs: step.visitOrder * dealStaggerMs(sequence.length) })),
      origin,
      token
    )
  }

  // Reverses a stock deal's own forward flight (see runDeal/handleDrawStock): the 10 cards that
  // deal placed fly from their current tableau spots - already measured by the caller, before its
  // own revert removed them - back to the stock fan's restored packet, converging on that one
  // shared point instead of each having its own destination. A card with no origin (the caller
  // couldn't measure it - see handleUndo's comment on a swept-run column) or if the destination
  // itself can't be measured just isn't included, the same graceful-skip every other deal flight
  // here already uses for an unmeasurable side.
  async function runUndoDeal(entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[], destinationPacketIndex: number, token: number) {
    const destination = await ghost.cardRegistry.measure(stockPacketId(destinationPacketIndex))
    // A stale token means some other action (New Game, another stock draw, another undo) has
    // already superseded this one and reset undoBusyRef/activeFlightCountRef itself (via
    // resetFlightConcurrency) - calling settleFlight here would instead decrement whatever NEWER
    // action's own claim is now current, corrupting FINDING 1's fix, so this branch bails without
    // touching it. Unlike runDeal's identical-looking guard above, handleUndo DOES fully guard
    // against a second overlapping call of itself (undoBusyRef, checked at its own top) - so the
    // only way to reach a stale token here is a DIFFERENT action (New Game/restore) that's already
    // reset the counter on its own, never a second handleUndo silently stacking an unsettled claim.
    if (dealTokenRef.current !== token) return
    if (!destination) {
      settleFlight()
      return
    }

    const dealEntries: DealCardSpec[] = []
    entries.forEach((e) => {
      if (!e.origin) return
      dealEntries.push({ cardId: e.card.id, card: e.card, from: e.origin, to: destination, delayMs: e.delayMs })
    })
    if (dealEntries.length === 0) {
      settleFlight()
      return
    }

    deal.start(
      dealEntries,
      cardWidth,
      () => {},
      () => {
        settleFlight()
      }
    )
  }

  useEffect(() => {
    const pending = pendingUndoDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingUndoDealRef.current = null
    runUndoDeal(pending.entries, pending.destinationPacketIndex, pending.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  if (!ready || !state) return <GameLoading />

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint() {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(controller, state, skip)
    if (result.kind === 'none') {
      infoToast('No moves available right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('spider')
  }

  function pushHistory(prev: SpiderState, move: MoveInfo | null) {
    setHistory((h) => [...h, { state: prev, move }])
  }

  // Each flying card reports here as its own independent flight settles (see
  // SequenceFlightGhosts/FlyingSequenceCard) - runs whatever per-card side effect that flight
  // instance was started with (see sequenceFlightCallbacksRef/startSequenceFlight). Once every
  // card belonging to THIS instance has landed, it's done: drop the instance and run its
  // onAllLanded callback.
  function handleSequenceFlightLanded(id: number, cardId: string) {
    const callbacks = sequenceFlightCallbacksRef.current.get(id)
    callbacks?.onCardLanded?.(cardId)
    const remaining = sequenceFlightPendingRef.current.get(id)
    if (remaining === undefined) return
    if (remaining > 1) {
      sequenceFlightPendingRef.current.set(id, remaining - 1)
      return
    }
    sequenceFlightPendingRef.current.delete(id)
    sequenceFlightCallbacksRef.current.delete(id)
    setSequenceFlights((flights) => flights.filter((f) => f.id !== id))
    callbacks?.onAllLanded()
    // Settles the one claim startSequenceFlight made for this instance (see its own doc comment) -
    // every card belonging to this flight id has now landed.
    settleFlight()
  }

  // Mirrors completeMoveWithSequenceFlight/handleDrawStock's forward flight, in reverse: every
  // card of the run(s) being restored currently exists only as the abstracted completed-slot card,
  // so all of them fly from that one shared origin (measured now, while the slot is still
  // occupied) to their own restored tableau position - resolved once prevState's tableau has
  // actually re-mounted them (see the pendingSequenceUndoRef effect below), the same deferred-
  // measurement reasoning as every other post-commit CardRegistry lookup in this file. Hiding the
  // restored cards has to be batched into the SAME commit as prevState (setDealHiddenIds here,
  // setState called by the caller right after) - setting it after the fact would let them flash
  // fully visible for a frame before their flight starts covering them, same reasoning Pyramid's
  // undoRemoval already relies on.
  async function undoSequenceCompletions(fromState: SpiderState, slotIndexes: number[], token: number) {
    const origins = await Promise.all(slotIndexes.map((slotIndex) => measureView(completedSlotRefs.current[slotIndex])))
    const bySlot = slotIndexes.map((slotIndex, i) => ({ slotIndex, origin: origins[i], run: fromState.completedRuns[slotIndex] }))
    setDealHiddenIds((ids) => new Set([...ids, ...bySlot.flatMap(({ run }) => run.map((c) => c.id))]))
    pendingSequenceUndoRef.current = { bySlot, token }
  }

  // Tapping any movable card sends it to the tableau pile that buries the fewest cards (see
  // engine/autoMove.ts) - Spider has no foundation, so unlike Klondike/FreeCell this only ever
  // considers other tableau columns. Tapping the same card again re-evaluates from its new
  // position, so it cycles through its alternatives one tap at a time.
  //
  // The move applies immediately (so game logic/undo never wait on an animation), but the card(s)
  // that just moved stay hidden at their destination until a ghost copy - shown at the tapped
  // origin - flies there and lands. cardRegistry.measure() finds that destination position by
  // measuring the real (already re-rendered) card rather than recomputing pile fan math here, so
  // the ghost always lands exactly on top of it with no seam.
  async function handlePressCard(colIndex: number, card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    // A completed run is still assembled in its column, about to be swept off (see sweepPendingRef) - a tap on it would move
    // cards the sweep is about to remove. Ignored up front, so it doesn't even flash a ghost/sound; completeMove re-checks.
    if (sweepPendingRef.current > 0) return
    const move = controller.autoMoveHint(state, { zone: 'tableau', index: colIndex }, card.id)
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather
      // than a dead press, with a short haptic tap alongside (see shakeAnimation.ts). Tapping mid-
      // stack (indexFromTop > 0) with a valid run below shakes that whole run, not just the one
      // card under the finger - it's the same "stuck" outcome for all of them. Deliberately never
      // calls measure() - this branch has no use for the tapped card's position, so it skips
      // paying for the measurement at all (see PileView.tsx's onPress doc comment).
      const count = Math.max(1, tableauRunCount(colIndex, indexFromTop))
      setShake({ cardId: card.id, count, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    // Claimed synchronously before the await below (see PATTERN_OVERLAP_GATE) - so undo (the only
    // thing that still waits on activeFlightCountRef) sees this tap as in-flight for its whole
    // duration, not just once completeMove lands one.
    startFlights(1)
    const origin = await measure()
    const sourcePile = state.tableau[move.from.index] ?? null
    if (!sourcePile || undoBusyRef.current) {
      settleFlight()
      return
    }
    const movingCards = sourcePile.slice(sourcePile.length - move.count)
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0

    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })

    if (!(await completeMove(move.from, move.to, move.count, card.id, flight))) {
      flight.hide()
      settleFlight()
    }
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual
  // drag's drop) - applies the move, then marks the destination "incoming" and stashes the
  // anchor card id for the pendingMoveFlightsRef effect above to measure and fly the ghost onto,
  // instead of it just vanishing/appearing at the destination instantly.
  //
  // If this move also completes a King->Ace run, resolveCompletedSequence has already swept the
  // whole run out of `next`'s tableau - `displayState` below temporarily restores it so the normal
  // move-ghost still has somewhere real to land, showing the completed run fully assembled in the
  // tableau (Queen through Ace visibly landing on the King) exactly like any other move. Only once
  // that ghost lands does the whole run sweep off to its foundation slot as one consolidated unit
  // (see the entry's own `sweep`/sweepRunToFoundation) - two phases, the same shape a real dealer's
  // "complete the run, then whisk it away" reads as. The move that completes the LAST run gets the
  // same two phases (it used to be skipped, committing the swept state at once): with the run already
  // gone from `next`'s tableau its ghost had nothing to measure, so it just vanished, and the whole
  // run left for its slot without a flight. The win is then derived when that last sweep commits, and
  // the celebration (see winRevealed) waits for the sweep flight to land, so it never races the slot.
  //
  // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
  // closure's `state` - two actions can now be triggered back-to-back before React re-renders (see
  // PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
  // commitState just did, not the same stale board both closures captured. Doesn't itself claim/
  // settle a flight slot - every call site (handlePressCard, dragConfig.onDrop) already claims its
  // own via startFlights(1) before calling this, and settles it on failure.
  async function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle): Promise<boolean> {
    const current = stateRef.current
    if (!current) return false
    // The authoritative check for a tap and a drag alike (a drop reaches here with no guard of its own; a tap may have passed
    // handlePressCard's while awaiting its measurement, just before another move completed a run) - see sweepPendingRef.
    if (sweepPendingRef.current > 0) return false
    const next = controller.tryMove(current, { from, to, count })
    if (!next) return false

    const justCompleted = next.completedRuns.length > current.completedRuns.length ? next.completedRuns[next.completedRuns.length - 1] : null
    const slotIndex = justCompleted ? next.completed.length - 1 : null
    const displayState = slotIndex !== null ? withRunsRestored(next, [{ colIndex: to.index, run: justCompleted! }]) : next

    pushHistory(current, { from, to, count, anchorCardId })
    commitState(displayState)
    session.registerMove()
    // The displayState above holds the last run back in the tableau, so `won` (derived from the swept state) only
    // flips a phase later, once that run leaves - the clock still stops with the winning move itself.
    if (controller.isWon(next)) session.stopClock()
    const flyingId = beginFlying(to, count)
    // The claim is made here, in the same tick as the commit that shows the assembled run, so there is no gap before it holds.
    pendingMoveFlightsRef.current.push({ cardId: anchorCardId, flight, flyingId, sweep: slotIndex !== null ? { colIndex: to.index, slotIndex, run: justCompleted!, release: claimSweep() } : null })
    return true
  }

  // Reinserts one or more just-swept runs back into their tableau columns, and rolls `completed`/
  // `completedRuns` back to match - the mirror image of resolveCompletedSequence, used to build a
  // "display state" so the normal move/deal-in ghost still has somewhere real to land and show the
  // completed run fully assembled, before sweepRunToFoundation sends it on to its foundation slot.
  function withRunsRestored(next: SpiderState, restores: { colIndex: number; run: Card[] }[]): SpiderState {
    return {
      ...next,
      tableau: next.tableau.map((col, i) => {
        const restore = restores.find((r) => r.colIndex === i)
        return restore ? [...col, ...restore.run] : col
      }),
      completed: next.completed.slice(0, next.completed.length - restores.length),
      completedRuns: next.completedRuns.slice(0, next.completedRuns.length - restores.length)
    }
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingSameSuit)
  }

  async function handleDrawStock() {
    if (won) return
    if (!controller.drawStock) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    // A deal would land on top of a run that is still assembled in its column, and its own sweep would then cut the wrong
    // cards off the end of that column - see sweepPendingRef.
    if (sweepPendingRef.current > 0) return
    // One stock deal at a time, until it has fully landed - see stockDealTokenRef. Refused before anything is claimed, so
    // a second tap has nothing to leak.
    if (stockDealTokenRef.current !== null) return
    // Reads via stateRef.current, not the closure `state` - see completeMove's identical comment.
    // Without this, a draw computed against a stale render's board would deal the SAME batch again
    // (a rapid second tap is now refused above until the first deal has landed, so this is the
    // remaining guard for a tap racing some other move's commit).
    const current = stateRef.current
    if (!current) return
    // Captured from the PRE-deal stock - see runDeal's comment on why this can't be re-derived
    // from the post-deal tableau.
    const dealt = current.stock.slice(0, TABLEAU_COLUMNS).map((card, colIndex) => ({ card, colIndex }))
    const next = controller.drawStock(current)
    if (!next) {
      setMessage("Can't deal - clear a column first")
      return
    }
    setMessage(null)
    startFlights(1)
    // A deal has no single MoveInfo shape to record (10 cards land across every column at once,
    // not one card landing somewhere new) - handleUndo detects the null move itself and reverses
    // this same flight (see runUndoDeal) rather than needing anything stashed here.
    pushHistory(current, null)
    session.registerMove()

    const myToken = ++dealTokenRef.current
    stockDealTokenRef.current = myToken

    // The packet this round is dealt from is the frontmost currently-rendered one (see
    // StockFan/StockPacket) - has to be measured now, before the commitState below commits a state
    // with one fewer packet and unmounts (and unregisters) it, unlike the per-card destinations
    // below, which can only be measured AFTER they've mounted.
    const packetIndex = Math.ceil(current.stock.length / TABLEAU_COLUMNS) - 1
    const origin = await ghost.cardRegistry.measure(stockPacketId(packetIndex))
    // New Game/restore replaced the game while the packet was being measured: they already reset every claim (this draw's
    // startFlights included) and stockDealTokenRef, and `current`/`next` belong to a game that is gone - committing them would
    // overwrite the fresh board, and claimSweep below would take a claim out under the NEW game's epoch that nothing releases.
    // Bails before claiming or committing anything, and without settling (that claim was reset, not leaked).
    if (dealTokenRef.current !== myToken) return

    // A card can complete (and immediately sweep) a 13-card run the instant it's dealt - see
    // resolveCompletedSequence. Every column unconditionally grows by exactly 1 from the deal
    // itself, so a column whose FINAL length isn't current.tableau[col].length + 1 is one that had
    // its whole top run swept. drawStock's own sweep loop and this check both iterate columns in
    // ascending order, so the Nth such column pairs with the Nth run appended to
    // next.completedRuns beyond however many existed before this deal. A deal can never win the
    // game outright (a deal needs all 10 columns non-empty, and only 8 runs exist to empty them),
    // so the isWon guard below never fires - kept as a cheap invariant, not a real branch.
    const priorCompletedCount = current.completedRuns.length
    const completingColumns = controller.isWon(next) ? [] : dealt.filter(({ colIndex }) => next.tableau[colIndex].length !== current.tableau[colIndex].length + 1).map(({ colIndex }) => colIndex)

    if (completingColumns.length === 0) {
      setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
      pendingDealRef.current = { dealt, origin, token: myToken }
      commitState(next)
      return
    }

    // Every dealt card - including the one(s) that complete a run - lands normally in the tableau
    // first (displayState below temporarily restores each completing column's run, the same
    // withRunsRestored trick completeMove uses), showing the completed run fully assembled there
    // for a beat exactly like a tableau move would. Only once that specific card actually lands
    // (runDeal's onEachLanded hook, wired via pendingDealRef.sweeps below) does its whole run sweep
    // on to its foundation slot as one unit - see sweepRunToFoundation.
    const completingSlotIndexes = completingColumns.map((_, i) => priorCompletedCount + i)
    const displayState = withRunsRestored(
      next,
      completingColumns.map((colIndex, i) => ({ colIndex, run: next.completedRuns[completingSlotIndexes[i]] }))
    )
    // One claim per completing column (see sweepPendingRef), released by that column's own sweep - or by the settle callback in
    // the pendingDealRef effect if its completing card never gets a flight to trigger it. Made in the same tick as the commit below.
    const sweeps = new Map<string, PendingSweep>(completingColumns.map((colIndex, i) => [dealt.find((d) => d.colIndex === colIndex)!.card.id, { colIndex, slotIndex: completingSlotIndexes[i], run: next.completedRuns[completingSlotIndexes[i]], release: claimSweep() }]))

    setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
    pendingDealRef.current = { dealt, origin, token: myToken, sweeps }
    commitState(displayState)
  }

  // Mirrors handlePressCard's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingMoveFlightsRef effect above can only measure a DESTINATION once it's committed
  // and re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would.
  async function handleUndo() {
    // sweepPendingRef: a stock deal's last card can land (settling its flight claim) a few milliseconds before the sweep it
    // triggered has measured and removed its run - undoing in that gap would revert the board the sweep is about to edit.
    if (undoBusyRef.current || activeFlightCountRef.current > 0 || sweepPendingRef.current > 0 || history.length === 0 || !state) return
    undoBusyRef.current = true
    // Undo only ever moves backward into an earlier, necessarily-not-won state (won is a terminal
    // condition - the only move available once it's true is New Game), so any undo reachable while
    // won must be undoing the winning move itself. `won` (derived from state above) clears itself
    // on the very next render once prevState commits below, but the bouncing win cascade doesn't
    // stop on its own - it only ever stops via winCascade.clear() (see startNewGame), so without
    // this it would keep animating over a board that's already reverted underneath it.
    if (won) winCascade.clear()
    const entry = history[history.length - 1]
    const { move, state: prevState } = entry

    // A move or stock deal that completed one or more King->Ace runs (see completeMove/
    // handleDrawStock) swept those cards out of the tableau into the abstracted completed-slot
    // card - undoing it needs to fly them back into the tableau (see undoSequenceCompletions).
    // `completedRuns` only ever grows, so its length exactly tracks how many runs are currently
    // completed - a move can complete at most one (tryMove only ever resolves one column), a
    // stock deal can complete more than one.
    const undoneSlots = state.completedRuns.length > prevState.completedRuns.length ? Array.from({ length: state.completedRuns.length - prevState.completedRuns.length }, (_, i) => prevState.completedRuns.length + i) : []

    if (!move) {
      // Undoing a stock deal (see runUndoDeal above): the 10 cards it dealt fly from their
      // current tableau spots back to the stock fan, converging on the packet this revert is
      // about to restore. Every history entry is undone in strict most-recent-first order, so at
      // the moment THIS entry is undone, nothing later has touched these columns since the deal
      // itself - state.tableau[col]'s current top card is reliably the one that deal placed
      // there, UNLESS that same deal immediately completed (and swept away) a 13-card run in that
      // column (see resolveCompletedSequence) - column lengths grow by exactly 1 per dealt card,
      // so a column that doesn't fit that shape had its card swept, and is left out entirely:
      // there's nothing left in the tableau to measure or fly back for it (its own run instead
      // flies back independently below, via undoSequenceCompletions).
      const myToken = ++dealTokenRef.current
      const dealtColumns = state.tableau.map((col, colIndex) => ({ col, colIndex })).filter(({ col, colIndex }) => col.length === prevState.tableau[colIndex].length + 1)
      const dealtCards = dealtColumns.map(({ col }) => col[col.length - 1])
      const origins = await Promise.all(dealtCards.map((c) => ghost.cardRegistry.measure(c.id)))
      const destinationPacketIndex = Math.ceil(prevState.stock.length / TABLEAU_COLUMNS) - 1

      // FINDING 1: this action always starts the deal-back pipeline (runUndoDeal, wired via
      // pendingUndoDealRef below) plus, when this deal also completed one or more runs, the
      // sequence-restore pipeline (undoSequenceCompletions) - claim both up front (before either
      // can possibly report done) via the shared activeFlightCountRef, settled by runUndoDeal's own
      // settleFlight() calls and, separately, by the pendingSequenceUndoRef effect's own
      // settleFlight() once every one of ITS OWN per-slot sequence flights has landed (see that
      // effect's own comment on why that's a second, independent tally on top of each individual
      // startSequenceFlight/handleSequenceFlightLanded pairing).
      startFlights(undoneSlots.length > 0 ? 2 : 1)

      if (undoneSlots.length > 0) await undoSequenceCompletions(state, undoneSlots, myToken)

      setHistory((h) => h.slice(0, -1))
      pendingUndoDealRef.current = {
        entries: dealtCards.map((c, i) => ({ card: c, delayMs: dealtColumns[i].colIndex * DEAL_STAGGER_MS, origin: origins[i] })),
        destinationPacketIndex,
        token: myToken
      }
      commitState(prevState)
      return
    }

    setHistory((h) => h.slice(0, -1))

    if (undoneSlots.length > 0) {
      // Only ever one slot here - a single tableau move (tryMove) resolves at most one column.
      // Two-phase, the mirror image of completeMove/sweepRunToFoundation: the whole run first
      // lands back in the tableau as one consolidated group (see startUndoRunCompletion), then the
      // actively-moved subgroup peels off back to its own source column (see finishMoveUndo) -
      // exactly like a normal move-undo, since by the time that runs, the moved cards are sitting
      // right there at the top of the newly-restored stack. One claim spans both phases - phase 1's
      // own restore flight is separately self-counted via startSequenceFlight (see its own doc
      // comment), so this claim is settled once phase 2 (finishMoveUndo) actually concludes, not
      // any sooner.
      startFlights(1)
      await startUndoRunCompletion(state, prevState, move, undoneSlots[0])
      return
    }

    startFlights(1)
    await finishMoveUndo(move, prevState)
  }

  // Phase 1 of undoing a tableau move that completed a run: the whole run currently exists only as
  // the abstracted completed-slot card - measure that shared origin now, while the slot is still
  // occupied, then defer to the pendingRunRestoreRef effect above to fly each card individually
  // back into the tableau column it was completed in (once `intermediateState` below has actually
  // committed and each card has a real fan position to measure). `intermediateState` reinserts only
  // the actively-moved cards on top of `to.index`'s own resident portion (already sitting there in
  // `prevState`) - `from.index` deliberately keeps its CURRENT (not yet restored) cards, since the
  // moved subgroup hasn't flown back there yet; that's phase 2's job (finishMoveUndo), once every
  // card in this restore flight has landed. Hiding the run has to be batched into the SAME commit
  // as `intermediateState` (setDealHiddenIds here, setState right after) so it doesn't flash fully
  // visible before each card's own flight arrives to cover it.
  async function startUndoRunCompletion(currentState: SpiderState, prevState: SpiderState, move: MoveInfo, slotIndex: number) {
    const run = currentState.completedRuns[slotIndex]
    const origin = await measureView(completedSlotRefs.current[slotIndex])
    if (!origin) {
      commitState(prevState)
      // Settles the single startFlights(1) claim handleUndo made for this whole phase1->phase2
      // chain (see its own comment) - phase 1 never even started, so there's no self-counted
      // startSequenceFlight claim of its own to also settle here.
      settleFlight()
      return
    }

    const movedCards = run.slice(run.length - move.count)
    const intermediateState: SpiderState = {
      ...prevState,
      tableau: prevState.tableau.map((col, i) => {
        if (i === move.to.index) return [...col, ...movedCards]
        if (i === move.from.index) return currentState.tableau[move.from.index]
        return col
      })
    }

    setDealHiddenIds((ids) => new Set([...ids, ...run.map((c) => c.id)]))
    pendingRunRestoreRef.current = { run, origin, move, prevState, token: dealTokenRef.current }
    commitState(intermediateState)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog). Also reachable directly from the win
  // banner's own "New Game" button below, which calls this same function - the `!won` guard is
  // required there: without it, tapping that button would fire recordDealAbandoned right alongside
  // the recordDealWon the win-check effect above already recorded for this same deal.
  function handleNewGame() {
    // session.moves, not history.length: a resumed deal always restores with an empty history
    // (see restoreGame above) even when it has real progress, so history alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('spider')
    setNumSuits(settings.spiderSuits)
    startNewGame(createSpiderController(settings.spiderSuits))
  }

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Spider' subtitle={`${numSuits} Suit${numSuits > 1 ? 's' : ''}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={history.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<SpiderSettingsSection />} rules={SPIDER_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={[styles.completedGroup, { gap }]}>
            {Array.from({ length: 8 }).map((_, i) => {
              // Hidden once the win cascade has taken this slot over - the win cascade owns these cards
              // then (see runWinCascade), the same way Pyramid's discard-top goes blank once its own
              // chain takes over. NOT keyed on `won`: that flips as the last run is swept, and blanking
              // its slot then would cut that run's flight short. And not on `winRevealed` alone either:
              // runWinCascade measures first, so the slots blank in the very commit its ghosts land
              // (cascadeHandoff), never a moment before. Also hidden while this slot's own sequence
              // flight is still en route (see completingSlots) so the King doesn't pop in before the
              // ghost visually lands on top of it.
              const handedOff = winRevealed && cascadeHandoff?.forState === state && cascadeHandoff.slots.has(i)
              const completedCard = handedOff || completingSlots.has(i) ? undefined : state.completed[i]
              return (
                <View
                  key={i}
                  ref={(el) => {
                    completedSlotRefs.current[i] = el
                  }}
                  collapsable={false}
                  style={{ width: cardWidth }}
                >
                  {completedCard ? <PlayingCard card={completedCard} /> : <EmptySlot />}
                </View>
              )
            })}
          </View>
          <StockFan count={state.stock.length} onPress={handleDrawStock} hinted={activeHint?.kind === 'drawStock'} />
          {/* Wide layout: the same message, but laid over the topRow's own marginBottom band instead of
          in the flow. The board has no vertical slack to spare there - useTableauMaxHeight hands the
          columns every last point of the window - so a message in the flow (line height + 4) would push
          the tableau's bottom edge off the screen for as long as it's showing. */}
          {message && isWide ? <Text style={[styles.message, styles.messageWide]}>{message}</Text> : null}
        </View>

        {message && !isWide ? <Text style={styles.message}>{message}</Text> : null}

        <View style={[styles.tableauRow, isWide && styles.tableauRowWide, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              // Claims a flight slot (see activeFlightCountRef's doc comment) purely so undo sees
              // this drop as in-flight for its whole duration, not just once completeMove lands one
              // - PileView.tsx (shared, not ours to edit) already ran its own hitTest await before
              // invoking this callback, so this is the earliest point SpiderScreen gets a look-in.
              // Rejects outright if undo is running (see handlePressCard's identical comment on why
              // undo holds full mutual exclusion, not just a one-way wait).
              onDrop: async (to, count, anchorCardId, flight) => {
                if (undoBusyRef.current) return false
                startFlights(1)
                if (!(await completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId, flight))) {
                  settleFlight()
                  return false
                }
                return true
              }
            }
            const hiddenCount = flying.filter((f) => f.to.zone === 'tableau' && f.to.index === colIndex).reduce((sum, f) => sum + f.count, 0)
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.column, { width: cardWidth }]}>
                {/* dimUnplayable: dropping a single card here only checks rank (see rules.ts's
                tryMove, destTop.rank === movingBottom.rank + 1 - no suit check), but dragging 2+
                cards as a group requires the whole span to be same-suit descending
                (isDescendingSameSuit). So a card placed by suit-mismatched single-card moves can
                leave a lower, face-up card unable to move together with what's stacked on it - the
                same "face-up but not currently a legal run head" case FreeCell/Canfield's own
                dimUnplayable exists for, not Klondike's (whose own drop rule already forces every
                face-up run to stay internally valid). */}
                <PileView cards={col} maxHeight={tableauMaxHeight} onPressCard={(card, indexFromTop, measure) => handlePressCard(colIndex, card, indexFromTop, measure)} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    dialog comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it (also backstopped by WinBanner's own explicit zIndex). */}
      {winRevealed && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <SequenceFlightGhosts flights={sequenceFlights} onCardLanded={handleSequenceFlightLanded} />
      <WinCascadeGhosts />
      {winRevealed && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={handleNewGame} />}
    </CardSizeProvider>
  )
}

/** One fanned packet in the stock (see StockFan) - registered into CardRegistry under its depth
 * index so handleDrawStock can measure exactly where it sits on screen right before dealing it
 * out, the same way a foundation/freecell slot registers itself (see FoundationCell/FreecellCell
 * in KlondikeScreen.tsx/FreeCellScreen.tsx) so a tap-to-move flight can measure its destination.
 * Wrapped in pointerEvents="none" so its own internal Pressable (PlayingCard always renders one)
 * can't intercept the tap meant for StockFan's single covering Pressable - the same pattern
 * DragGhostLayer/DealLayer use for their own non-interactive card copies. */
function StockPacket({ index, hinted, style }: { index: number; hinted?: boolean; style: StyleProp<ViewStyle> }) {
  const ghost = useDragGhost()
  const viewRef = useRef<View>(null)

  useEffect(() => {
    const id = stockPacketId(index)
    ghost.cardRegistry.register(id, viewRef)
    return () => ghost.cardRegistry.unregister(id, viewRef)
  }, [index, ghost.cardRegistry])

  return (
    <View ref={viewRef} collapsable={false} pointerEvents='none' style={style}>
      <PlayingCard card={STOCK_PACKET_CARD} hinted={hinted} />
    </View>
  )
}

/** The stock, shown as up to 5 fanned face-down packets - one per remaining round of
 * TABLEAU_COLUMNS cards (see rules.ts's drawStock) - instead of a single pile with a card count on
 * it, so depleting the stock reads as packets disappearing one at a time rather than a number
 * ticking down. Anchored to the right edge and fanned leftward (toward the completed-sequence
 * slots), each packet peeking out from under the one before it - depth 0 is deepest/rendered
 * first (furthest right, bottom of the stack) and STOCK_MAX_PACKETS-1 is frontmost (furthest
 * left, on top), so the front packet is both the one a round visually deals from and the one that
 * disappears first as the stock depletes. */
function StockFan({ count, onPress, hinted }: { count: number; onPress: () => void; hinted?: boolean }) {
  const { width, height } = useCardSize()
  const packets = Math.min(STOCK_MAX_PACKETS, Math.ceil(count / TABLEAU_COLUMNS))
  const fanOffset = width * STOCK_FAN_OFFSET_RATIO
  const totalWidth = width + fanOffset * (STOCK_MAX_PACKETS - 1)

  return (
    <View style={{ width: totalWidth, height }}>
      {packets === 0 ? (
        <EmptySlot onPress={onPress} hinted={hinted} />
      ) : (
        <Pressable onPress={onPress} style={{ width: totalWidth, height }}>
          {Array.from({ length: packets }).map((_, i) => {
            const packetStyle = { position: 'absolute' as const, right: i * fanOffset, top: 0 }
            // Only the frontmost packet (the one this round actually deals from) shows the ring -
            // highlighting every packet would read as "5 things to tap" instead of "tap here."
            return <StockPacket key={i} index={i} hinted={hinted && i === packets - 1} style={packetStyle} />
          })}
        </Pressable>
      )}
    </View>
  )
}

function makeStyles() {
  return StyleSheet.create({
    column: {},
    completedGroup: {
      flexDirection: 'row'
    },
    message: {
      color: '#FFE082',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 12,
      marginBottom: 4,
      textAlign: 'center'
    },
    // See the wide-layout message in the JSX: pinned just below the topRow (whose own height is one
    // card), inside the 16pt marginBottom gap it leaves above the tableau.
    messageWide: {
      left: 0,
      position: 'absolute',
      right: 0,
      top: '100%'
    },
    tableauRow: {
      flexDirection: 'row',
      paddingBottom: 24
    },
    // useTableauMaxHeight budgets the shared 20 for this padding (every other column game's own
    // value), not Spider's 24 - in portrait the 4pt difference disappears into that hook's generous
    // floor, but the wide layout has no floor and no slack, so it uses the budgeted value there.
    tableauRowWide: {
      paddingBottom: TABLEAU_ROW_PADDING_BOTTOM
    },
    // width is set inline (cardWidth * TABLEAU_COLUMNS + gaps) rather than left to stretch - on a
    // wide-enough screen, cardLayoutForRow clamps cardWidth at its max, so the tableau row below
    // stops growing and ends up narrower than the full available width. Left unconstrained, this
    // row's own space-between would still spread across that full (wider) width, dragging StockFan
    // past the tableau's real right edge instead of lining up with column 10.
    topRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16
    }
  })
}
