import { Pressable, useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset, type TableColors, useCardSize } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleProp, StyleSheet, Text, useWindowDimensions, View, ViewStyle } from 'react-native'
import Animated, { SharedValue, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView, ScreenPoint } from '@/components/dealing/measureView'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { autoMoveSpringFor } from '@/components/dragdrop/dragSpring'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
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
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

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
 * is a plain timer matching the spring's own duration rather than the spring's completion callback
 * - confirmed elsewhere in this codebase (DragGhostLayer.tsx/DealLayer.tsx) not to reliably fire
 * on this app's web target. `onDealt` mirrors DealGhostCard's own doc comment: fired via its own
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
function FlyingSequenceCard({ card, from, to, delayMs, containerOffsetX, containerOffsetY, onDealt, onLanded }: { card: Card; from: ScreenPoint; to: ScreenPoint; delayMs: number; containerOffsetX: SharedValue<number>; containerOffsetY: SharedValue<number>; onDealt: () => void; onLanded: () => void }) {
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
      delayMs + (config.duration ?? 0)
    )
    return () => {
      clearTimeout(dealtTimer)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const style = useAnimatedStyle(() => ({
    zIndex: zIndex.value,
    transform: [{ translateX: tx.value - containerOffsetX.value }, { translateY: ty.value - containerOffsetY.value }]
  }))

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
  const overlayRef = useRef<View>(null)
  const containerOffsetX = useSharedValue(0)
  const containerOffsetY = useSharedValue(0)
  const { width: winWidth, height: winHeight } = useWindowDimensions()
  // Own instance, same as StockPacket's own useDragGhost() call above - this is a screen-level
  // sibling component, not nested under SpiderScreenInner, so it needs its own hook call to reach
  // these rather than having them threaded down as props.
  const { playCardSound, hapticCard } = useCardSoundEffects()

  useEffect(() => {
    overlayRef.current?.measureInWindow((x, y) => {
      containerOffsetX.value = x
      containerOffsetY.value = y
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winWidth, winHeight])

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
              containerOffsetX={containerOffsetX}
              containerOffsetY={containerOffsetY}
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

  const [state, setState] = useState<SpiderState | null>(null)
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

  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
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
   * instant it arrives, exactly like a tableau move's own two-phase completion. */
  const pendingDealRef = useRef<{
    dealt: { card: Card; colIndex: number }[]
    origin: { x: number; y: number } | null
    token: number
    sweeps?: Map<string, { colIndex: number; slotIndex: number; run: Card[] }>
  } | null>(null)
  // runInitialDeal re-reads the dealt tableau straight from `state`, exactly like Klondike's own
  // initial-deal effect does - see useDeferredDeal's own doc comment for the race this guards.
  const scheduleInitialDeal = useDeferredDeal(state, dealTokenRef, runInitialDeal)
  /** An undone stock deal awaiting its post-commit measurement + deal.start() (see runUndoDeal/the
   * effect below) - the mirror image of pendingDealRef: this flight's origins (where the dealt
   * cards currently sit) are measured up front, before the revert below removes them, while its
   * single shared destination (the stock fan's restored packet) can only be measured after, once
   * that packet exists to register itself - the same "measure whichever side hasn't mounted yet"
   * split as every other deferred deal effect here, just with which side is early/late swapped. */
  const pendingUndoDealRef = useRef<{
    entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[]
    destinationPacketIndex: number
    token: number
  } | null>(null)
  const pendingAutoMoveCardIdRef = useRef<string | null>(null)
  /** Set alongside pendingAutoMoveCardIdRef when a tableau move ALSO completes a run - once that
   * normal move-ghost lands (showing the completed run fully assembled in the tableau, exactly as
   * a plain move would), the ghost-landing effect below hands off to sweepRunToFoundation instead
   * of just clearing `flying`, sending the run's cards on to their foundation slot individually. */
  const pendingRunSweepRef = useRef<{ colIndex: number; slotIndex: number; run: Card[] } | null>(null)
  /** Set by startUndoRunCompletion once the run's cards' shared origin (the foundation slot) has
   * been measured - resolved by the effect below once the intermediate state (with those cards
   * freshly restored into the tableau) has actually committed, since each card's own destination
   * fan position can only be measured once it's mounted there. Once every card in that flight has
   * landed, it hands off to finishMoveUndo to run its own second phase: peeling the actively-moved
   * subgroup back to its source column, exactly like a normal move-undo. */
  const pendingRunRestoreRef = useRef<{ run: Card[]; origin: { x: number; y: number }; move: MoveInfo; prevState: SpiderState; token: number } | null>(null)
  // Guards handleUndo against being called again before its own previous invocation has fully
  // settled (visually, not just in state) - see handleUndo/runUndoDeal below for why an overlapping
  // call would otherwise desync `history` or clobber the shared single-flight ghost/deal animation.
  const undoBusyRef = useRef(false)
  // Undoing a stock deal that ALSO completed one or more runs kicks off two independent flight
  // pipelines from one setState: the dealt cards flying back into the stock fan (runUndoDeal) and
  // the completed run(s) flying back into the tableau (undoSequenceCompletions's own effect below).
  // Either can finish before the other, so undoBusyRef must not be released until BOTH have
  // reported done - see decrementUndoStockDealPipelines, set up by handleUndo before either
  // pipeline starts. Only ever touched by those two pipelines (both exclusive to the stock-deal-
  // undo branch of handleUndo), never by the plain move-undo path, which is sequential, not
  // concurrent, and clears undoBusyRef itself once its own single chain finishes.
  const pendingUndoStockDealPipelinesRef = useRef(0)

  // Call from either of the two concurrent stock-deal-undo pipelines once ITS OWN chain has fully
  // landed - see pendingUndoStockDealPipelinesRef's own doc comment above. Only releases
  // undoBusyRef once every pipeline handleUndo started for this action has reported in. Declared
  // up here (rather than nearer handleUndo, where it's set up) since the two effects that call it
  // are themselves declared earlier in this component than handleUndo is.
  function decrementUndoStockDealPipelines() {
    pendingUndoStockDealPipelinesRef.current -= 1
    if (pendingUndoStockDealPipelinesRef.current <= 0) undoBusyRef.current = false
  }
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

  const startNewGame = useCallback(
    (ctrl: ReturnType<typeof createSpiderController>) => {
      const myToken = ++dealTokenRef.current
      const s = ctrl.newGame(randomSeed())
      setHistory([])
      setHint(null)
      hintsUsedRef.current = false
      undoBusyRef.current = false
      session.reset()
      setMessage(null)
      recordedRef.current = false
      winCascade.clear()
      pendingWinCascadeRef.current = null

      const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
      setDealHiddenIds(dealtIds)
      scheduleInitialDeal(myToken)
      setState(s)
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
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    setMessage(null)
    recordedRef.current = false
    setDealHiddenIds(new Set())
    setState(saved.state)
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
  async function runWinCascade(s: SpiderState, gen: number) {
    const origins = await Promise.all(completedSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    s.completedRuns.forEach((run, slot) => {
      const origin = origins[slot]
      if (!origin || run.length === 0) return
      chains.push({ cards: run, origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS }) // already King-first, Ace-last
    })
    winCascade.startChains(chains, cardWidth)
  }

  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  function startSequenceFlight(cards: SequenceFlightCardSpec[], onAllLanded: () => void, onCardLanded?: (cardId: string) => void) {
    const id = ++sequenceFlightIdRef.current
    sequenceFlightPendingRef.current.set(id, cards.length)
    sequenceFlightCallbacksRef.current.set(id, { onCardLanded, onAllLanded })
    setSequenceFlights((flights) => [...flights, { id, cardWidth, cards }])
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
  async function sweepRunToFoundation(colIndex: number, slotIndex: number, run: Card[]) {
    const [origins, destination] = await Promise.all([Promise.all(run.map((c) => ghost.cardRegistry.measure(c.id))), measureView(completedSlotRefs.current[slotIndex])])
    // setFlying(null) always runs regardless of whether `destination` resolves: `state` already
    // shows this run fully assembled in the tableau (see completeMove/handleDrawStock's own
    // displayState), so leaving `flying` set would keep PileView hiding those already-landed real
    // cards behind a stale hiddenCount.
    setFlying(null)
    // FINDING 3: bail out of the whole sweep BEFORE touching tableau state if the foundation slot
    // hasn't been measured yet (not laid out/measured on this render) - removing the run here
    // regardless would make it vanish instantly with the King popping into the slot fully opaque,
    // a hard teleport instead of a flight. Leaving the run untouched in the tableau lets a later
    // render (once the slot is actually measurable) retry it instead.
    if (!destination) return

    const removeRun = (s: SpiderState): SpiderState => ({
      ...s,
      tableau: s.tableau.map((col, i) => (i === colIndex ? col.slice(0, col.length - run.length) : col)),
      completed: [...s.completed, run[0]],
      completedRuns: [...s.completedRuns, run]
    })
    setState((s) => (s ? removeRun(s) : s))

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
  // measure that real position before reverting (the pendingAutoMoveCardIdRef effect above can
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
      // Same react-compiler false positive as handlePressCard's identical block above - see its
      // comment.
      /* eslint-disable-next-line react-hooks/immutability */
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: movingCards, offsetStep, cardWidth })
      setFlying({ to: move.from, count: move.count })
      setState(prevState)
      pendingAutoMoveCardIdRef.current = move.anchorCardId
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }
  }

  // Measuring CardRegistry synchronously right after the setState in commitMove would find the
  // still-mounted SOURCE card (the destination card's own registration effect hasn't run yet), so
  // the ghost would "fly" a near-zero distance back to roughly where it started - indistinguishable
  // from a snap (same race documented for Klondike's deal animation). Deferring to a [state]-keyed
  // effect guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    const cardId = pendingAutoMoveCardIdRef.current
    if (!cardId || !state) return
    pendingAutoMoveCardIdRef.current = null
    const sweep = pendingRunSweepRef.current
    pendingRunSweepRef.current = null
    ;(async () => {
      const landed = await ghost.cardRegistry.measure(cardId)
      // Once this ghost lands, either hand off to phase 2 of a run completion (see
      // completeMove/sweepRunToFoundation) or finish normally.
      const proceed = () => {
        if (sweep) {
          sweepRunToFoundation(sweep.colIndex, sweep.slotIndex, sweep.run)
          return
        }
        setFlying(null)
        undoBusyRef.current = false
      }
      if (landed) {
        ghost.flyTo(landed.x, landed.y, proceed)
      } else {
        ghost.hide()
        proceed()
      }
    })()
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
      // decrement the shared stock-deal-undo pipeline counter once every one of THEM has also
      // landed - a stock deal can complete more than one column at once, each becoming its own
      // flight instance here.
      const startingFlights = perSlot.filter((s) => s.cards.length > 0)
      let remaining = startingFlights.length
      if (remaining === 0) decrementUndoStockDealPipelines()

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
            if (remaining <= 0) decrementUndoStockDealPipelines()
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
  // Same react-compiler false positive as handlePressCard's own ghost.originX.value= block -
  // this effect can call finishMoveUndo, which mutates `ghost`.
  /* eslint-disable-next-line react-hooks/immutability */
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
  async function runDeal(cards: { card: Card; delayMs: number }[], origin: { x: number; y: number } | null, token: number, onEachLanded?: (cardId: string) => void) {
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }
    const destinations = await Promise.all(cards.map((c) => ghost.cardRegistry.measure(c.card.id)))
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
      () => {}
    )
  }

  // Same race as the pending auto-move effect above (and Klondike's identical deal effect):
  // measuring CardRegistry synchronously right after the setState in handleDrawStock would run
  // before the newly-dealt cards' own registration effects have fired. Deferring to this
  // [state]-keyed effect guarantees they've already registered by the time runDeal measures them.
  useEffect(() => {
    const pending = pendingDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingDealRef.current = null
    runDeal(
      pending.dealt.map((d) => ({ card: d.card, delayMs: d.colIndex * DEAL_STAGGER_MS })),
      pending.origin,
      pending.token,
      pending.sweeps
        ? (cardId) => {
            const sweep = pending.sweeps!.get(cardId)
            if (sweep) sweepRunToFoundation(sweep.colIndex, sweep.slotIndex, sweep.run)
          }
        : undefined
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
      sequence.map((step) => ({ card: { ...step.card, faceUp: false }, delayMs: step.visitOrder * DEAL_STAGGER_MS })),
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
    // already superseded this one and reset undoBusyRef/the pipeline counter itself - touching
    // decrementUndoStockDealPipelines here would decrement whatever NEWER action's counter is
    // current instead, corrupting FINDING 1's fix, so this branch bails without touching it.
    if (dealTokenRef.current !== token) return
    if (!destination) {
      decrementUndoStockDealPipelines()
      return
    }

    const dealEntries: DealCardSpec[] = []
    entries.forEach((e) => {
      if (!e.origin) return
      dealEntries.push({ cardId: e.card.id, card: e.card, from: e.origin, to: destination, delayMs: e.delayMs })
    })
    if (dealEntries.length === 0) {
      decrementUndoStockDealPipelines()
      return
    }

    deal.start(
      dealEntries,
      cardWidth,
      () => {},
      () => {
        decrementUndoStockDealPipelines()
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

  if (!ready || !state) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

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

    const origin = await measure()
    const sourcePile = state.tableau[move.from.index] ?? null
    if (!sourcePile) return
    const movingCards = sourcePile.slice(sourcePile.length - move.count)
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0

    // react-hooks/immutability treats `ghost` (from useDragGhost(), a custom hook) as an opaque
    // value - it can't see that originX/originY/dx/dy are Reanimated SharedValues, mutable by
    // design, the same way it can't for the identical pattern in PileView.tsx/DraggableCard.tsx's
    // own worklets (see DragGhostLayer.tsx for the full explanation, including why this isn't
    // fixable via the compiler's own Reanimated-aware config flag).
    /* eslint-disable-next-line react-hooks/immutability */
    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: movingCards, offsetStep, cardWidth })

    if (!(await completeMove(move.from, move.to, move.count, card.id))) {
      ghost.hide()
    }
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual
  // drag's drop) - applies the move, then marks the destination "incoming" and stashes the
  // anchor card id for the pendingAutoMoveCardIdRef effect above to measure and fly the ghost
  // onto, instead of it just vanishing/appearing at the destination instantly.
  //
  // If this move also completes a King->Ace run, resolveCompletedSequence has already swept the
  // whole run out of `next`'s tableau - `displayState` below temporarily restores it so the normal
  // move-ghost still has somewhere real to land, showing the completed run fully assembled in the
  // tableau (Queen through Ace visibly landing on the King) exactly like any other move. Only once
  // that ghost lands does the whole run sweep off to its foundation slot as one consolidated unit
  // (see pendingRunSweepRef/sweepRunToFoundation) - two phases, the same shape a real dealer's
  // "complete the run, then whisk it away" reads as. Skipped when the move also wins the game
  // outright: runWinCascade already takes over immediately once `isWon` becomes true, bouncing
  // every completed run off its slot as one celebratory cascade, and sweeping the winning run on
  // its own right before that would race the cascade's own use of the same slot.
  async function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string): Promise<boolean> {
    const next = controller.tryMove(state!, { from, to, count })
    if (!next) return false

    const justCompleted = next.completedRuns.length > state!.completedRuns.length ? next.completedRuns[next.completedRuns.length - 1] : null
    const slotIndex = justCompleted && !controller.isWon(next) ? next.completed.length - 1 : null
    const displayState = slotIndex !== null ? withRunsRestored(next, [{ colIndex: to.index, run: justCompleted! }]) : next

    pushHistory(state!, { from, to, count, anchorCardId })
    setState(displayState)
    session.registerMove()
    setFlying({ to, count })
    pendingAutoMoveCardIdRef.current = anchorCardId
    if (slotIndex !== null) pendingRunSweepRef.current = { colIndex: to.index, slotIndex, run: justCompleted! }
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
    // A stock draw bumps dealTokenRef below, which would silently orphan a still-in-flight undo of
    // a previous stock deal (runUndoDeal's own effect drops any pending flight once its token no
    // longer matches) - reset eagerly so that race can never leave handleUndo's busy guard stuck.
    undoBusyRef.current = false
    // Captured from the PRE-deal stock - see runDeal's comment on why this can't be re-derived
    // from the post-deal tableau.
    const dealt = state!.stock.slice(0, TABLEAU_COLUMNS).map((card, colIndex) => ({ card, colIndex }))
    const next = controller.drawStock(state!)
    if (!next) {
      setMessage("Can't deal - clear a column first")
      return
    }
    setMessage(null)
    // A deal has no single MoveInfo shape to record (10 cards land across every column at once,
    // not one card landing somewhere new) - handleUndo detects the null move itself and reverses
    // this same flight (see runUndoDeal) rather than needing anything stashed here.
    pushHistory(state!, null)
    session.registerMove()

    const myToken = ++dealTokenRef.current

    // The packet this round is dealt from is the frontmost currently-rendered one (see
    // StockFan/StockPacket) - has to be measured now, before the setState below commits a state
    // with one fewer packet and unmounts (and unregisters) it, unlike the per-card destinations
    // below, which can only be measured AFTER they've mounted.
    const packetIndex = Math.ceil(state!.stock.length / TABLEAU_COLUMNS) - 1
    const origin = await ghost.cardRegistry.measure(stockPacketId(packetIndex))

    // A card can complete (and immediately sweep) a 13-card run the instant it's dealt - see
    // resolveCompletedSequence. Every column unconditionally grows by exactly 1 from the deal
    // itself, so a column whose FINAL length isn't state!.tableau[col].length + 1 is one that had
    // its whole top run swept. drawStock's own sweep loop and this check both iterate columns in
    // ascending order, so the Nth such column pairs with the Nth run appended to
    // next.completedRuns beyond however many existed before this deal. Skipped entirely if this
    // deal also wins the game outright - see completeMove's own comment on why the winning move is
    // left to runWinCascade rather than also getting a solo sequence flight.
    const priorCompletedCount = state!.completedRuns.length
    const completingColumns = controller.isWon(next) ? [] : dealt.filter(({ colIndex }) => next.tableau[colIndex].length !== state!.tableau[colIndex].length + 1).map(({ colIndex }) => colIndex)

    if (completingColumns.length === 0) {
      setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
      pendingDealRef.current = { dealt, origin, token: myToken }
      setState(next)
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
    const sweeps = new Map(completingColumns.map((colIndex, i) => [dealt.find((d) => d.colIndex === colIndex)!.card.id, { colIndex, slotIndex: completingSlotIndexes[i], run: next.completedRuns[completingSlotIndexes[i]] }]))

    setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
    pendingDealRef.current = { dealt, origin, token: myToken, sweeps }
    setState(displayState)
  }

  // Mirrors handlePressCard's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingAutoMoveCardIdRef effect above can only measure a DESTINATION once it's committed
  // and re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would.
  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || history.length === 0 || !state) return
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
      // sequence-restore pipeline (undoSequenceCompletions) - set the outstanding count BEFORE
      // either can possibly report done, so whichever finishes first can't release undoBusyRef
      // alone (see decrementUndoStockDealPipelines).
      pendingUndoStockDealPipelinesRef.current = 1 + (undoneSlots.length > 0 ? 1 : 0)

      if (undoneSlots.length > 0) await undoSequenceCompletions(state, undoneSlots, myToken)

      setHistory((h) => h.slice(0, -1))
      pendingUndoDealRef.current = {
        entries: dealtCards.map((c, i) => ({ card: c, delayMs: dealtColumns[i].colIndex * DEAL_STAGGER_MS, origin: origins[i] })),
        destinationPacketIndex,
        token: myToken
      }
      setState(prevState)
      return
    }

    setHistory((h) => h.slice(0, -1))

    if (undoneSlots.length > 0) {
      // Only ever one slot here - a single tableau move (tryMove) resolves at most one column.
      // Two-phase, the mirror image of completeMove/sweepRunToFoundation: the whole run first
      // lands back in the tableau as one consolidated group (see startUndoRunCompletion), then the
      // actively-moved subgroup peels off back to its own source column (see finishMoveUndo) -
      // exactly like a normal move-undo, since by the time that runs, the moved cards are sitting
      // right there at the top of the newly-restored stack.
      await startUndoRunCompletion(state, prevState, move, undoneSlots[0])
      return
    }

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
      setState(prevState)
      undoBusyRef.current = false
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
    setState(intermediateState)
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
      {/* onUndo={handleUndo} closes over handleUndo, which has its own disabled, justified
      react-hooks/immutability false positive (see handleUndo's own `ghost.originX.value=` block
      above) - the compiler flags this element too since it (indirectly) passes that same closure
      down. */}
      {/* eslint-disable-next-line react-hooks/immutability */}
      <GameChrome title='Spider' subtitle={`${numSuits} Suit${numSuits > 1 ? 's' : ''}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={history.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<SpiderSettingsSection />} rules={SPIDER_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={[styles.completedGroup, { gap }]}>
            {Array.from({ length: 8 }).map((_, i) => {
              // Hidden once won - the win cascade owns these cards now (see runWinCascade), the same
              // way Pyramid's discard-top goes blank once its own chain takes over. Also hidden
              // while this slot's own sequence flight is still en route (see completingSlots) so
              // the King doesn't pop in before the ghost visually lands on top of it.
              const completedCard = won || completingSlots.has(i) ? undefined : state.completed[i]
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
        </View>

        {message ? <Text style={styles.message}>{message}</Text> : null}

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              onDrop: (to, count, anchorCardId) => completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId)
            }
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
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
                <PileView cards={col} maxHeight={420} onPressCard={(card, indexFromTop, measure) => handlePressCard(colIndex, card, indexFromTop, measure)} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    dialog comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it (also backstopped by WinBanner's own explicit zIndex). */}
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <SequenceFlightGhosts flights={sequenceFlights} onCardLanded={handleSequenceFlightLanded} />
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={handleNewGame} />}
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

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    column: {},
    completedGroup: {
      flexDirection: 'row'
    },
    loadingContainer: {
      alignItems: 'center',
      backgroundColor: colors.tableFelt,
      flex: 1,
      justifyContent: 'center'
    },
    loadingText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16
    },
    message: {
      color: '#FFE082',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 12,
      marginBottom: 4,
      textAlign: 'center'
    },
    tableauRow: {
      flexDirection: 'row',
      paddingBottom: 24
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
