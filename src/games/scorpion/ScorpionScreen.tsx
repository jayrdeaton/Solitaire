// Scorpion solitaire screen: 7 tableau columns, multi-card same-suit-destination runs (any face-up
// group is liftable, regardless of internal validity - see rules.ts), no foundation at all. Closest
// architecturally to Spider (no foundation, derived win check, real multi-card tableau drag) but
// with two genuine differences: (1) a completed King-to-Ace run stays sitting in its own tableau
// column instead of being swept into a separate "completed sequences" row - isWon simply checks
// each column's own shape directly (see rules.ts), so there's no resolveCompletedSequence-style
// bookkeeping here at all; (2) the assisted-stock variant's stock is a single one-shot 3-card deal
// (one card onto each of the last 3 columns, whenever the player likes) rather than Spider's
// repeated 10-card-per-round stock, so its own UI is a single tappable packet, not a fan.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { HintRequest } from '@/components/autoHint'
import { markGhostPending } from '@/components/cardFacePaint'
import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS, dealStaggerMs } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { hiddenUntilDealt } from '@/components/reducedMotionFlag'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { PipFireworks } from '@/components/winning/PipFireworks'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { SCORPION_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { parFor } from '@/engine/par'
import { alwaysValidRun, runCountFrom } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { scorpionVariant } from '@/engine/variants'
import { showNoHintToast } from '@/games/shared/gameToasts'
import { liftTappedRun, peelInAir } from '@/games/shared/inAirRun'
import { LossBanner } from '@/games/shared/LossBanner'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useHintGlide } from '@/games/shared/useHintGlide'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useStuckLossCheck } from '@/games/shared/useStuckLossCheck'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useUndoStack } from '@/games/shared/useUndoStack'
import { useWinReveal } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { useSettings } from '@/hooks/useSettings'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { buildScorpionDealSequence } from './dealSequence'
import { createScorpionController, ScorpionState } from './rules'
import { ScorpionSettingsSection } from './ScorpionSettingsSection'

const TABLEAU_COLUMNS = 7
const FRONT_COLUMNS = 4

const STOCK_PACKET_ID = 'scorpion-stock-packet'
// A placeholder face-down card for the one-shot stock packet - id/suit/rank are never shown
// (faceUp: false always renders CardBack instead), so any valid values work here (same idea as
// Spider's own STOCK_PACKET_CARD).
const STOCK_PACKET_CARD: Card = { id: STOCK_PACKET_ID, suit: 'spades', rank: 1, faceUp: false }

/** Every card in the whole tableau, dealt-order flattened - used once, for the initial deal's
 * hidden-until-landed set. */
function allTableauCardIds(tableau: Card[][]): Set<string> {
  return new Set(tableau.flat().map((c) => c.id))
}

/** The one-shot assisted stock packet - registered into CardRegistry so handleDrawStock can
 * measure exactly where it sits before dealing it out, the same idea as Spider's own StockPacket
 * (see SpiderScreen.tsx), just a single packet instead of a fan of up to 5. */
function StockPacket({ onPress, highlighted }: { onPress: () => void; highlighted?: boolean }) {
  const ghost = useDragGhost()
  const viewRef = useRef<View>(null)

  useEffect(() => {
    ghost.cardRegistry.register(STOCK_PACKET_ID, viewRef)
    return () => ghost.cardRegistry.unregister(STOCK_PACKET_ID, viewRef)
  }, [ghost.cardRegistry])

  return (
    <View ref={viewRef} collapsable={false}>
      <PlayingCard card={STOCK_PACKET_CARD} onPress={onPress} hinted={highlighted} />
    </View>
  )
}

export default withGameProviders(ScorpionScreenInner)

function ScorpionScreenInner() {
  const { styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // The stock variant the in-progress deal was actually dealt with - deliberately not re-derived
  // from `settings` every render, same reasoning SpiderScreen's own `numSuits` state has: a
  // mid-game settings change must never mutate the current deal's own rules. A useMemo (not a
  // useRef the way Klondike/Canfield's own draw-count settings use) - useDerivedWinCheck below
  // calls controller.isWon(state) synchronously during render, which react-hooks/refs correctly
  // flags for a ref-sourced controller but not for a memoized one, same as Spider's own identical
  // setup already proves lint-clean.
  const [assistedStock, setAssistedStock] = useState(settings.scorpionAssistedStock)
  // The deal's game under the rule it was dealt with: what its stats and par are kept for (engine/variants.ts).
  const variant = scorpionVariant(assistedStock)
  const controller = useMemo(() => createScorpionController(assistedStock), [assistedStock])
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth, isWide } = useGameLayout()
  // Wide layout: the stock packet sits one gap past column 7 while the tableau stays centred on its own,
  // so the row must have room for a packet-sized column on BOTH sides of it: the width-derived size/gap
  // budget 7 + 2 columns there. Portrait keeps its 7 (the packet is in the top row).
  const widthColumns = isWide ? TABLEAU_COLUMNS + 2 : TABLEAU_COLUMNS
  // Sized by the width alone, in both layouts: in the wide layout a column too long for the ~400pt of height scrolls
  // rather than shrinking every card to fit it (Jay, 2026-10-14: big cards in landscape, and scroll a bit sometimes).
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, widthColumns)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, { topRowCards: isWide ? 0 : 1 })
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCountRef, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/stock-draw can all run concurrently with each other -
  // PATTERN_OVERLAP_GATE, same as Klondike). `shrinkFlying`/`activeFlightCount` (the hook's state
  // mirror of the ref) is NOT destructured - Scorpion has no per-card-landing fan flown via `ghost`
  // (the assisted stock's multi-card burst uses `dealHiddenIds`, not `flying`, same as the initial
  // deal - see runStockDeal below), so it would have no read site. `activeFlightCount` (the hook's
  // state mirror of the ref) is, though: it is what the win celebration waits on (see `settled`).
  const { state, stateRef, commitState, flying, beginFlying, endFlying, shrinkLanding, landingCount, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<ScorpionState>()
  // Nullable move (Spider's default): an ordinary tableau move always has one, but the assisted
  // stock's one-shot deal lands 3 cards across 3 different columns at once - no single MoveInfo
  // shape for that, so it's recorded as `move: null` and handleUndo detects that case itself (see
  // runUndoStockDeal), same convention as Spider's own stock deal.
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<ScorpionState>>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: ScorpionState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useDerivedWinCheck's own hintsUsedRef param), to
  // decide whether this win counts toward the "wins without hint" stat/achievement. Reset alongside
  // the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const ghost = useDragGhost()
  const playHintGlide = useHintGlide(state, ghost.cardRegistry, dropZones)
  const deal = useDealAnimator()
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // A dead board - no move left and no stock to deal - is a loss here, as in Aces Up, recorded when the player leaves it (see useStuckLossCheck):
  // it used to just sit there with the clock running.
  const { stuck } = useStuckLossCheck(controller, state, variant, recordDealAbandoned)
  // Derived from `state` every render (see useDerivedWinCheck), same as Spider/Golf - Scorpion has
  // no suit-based foundation for a "won" flag to hang off; isWon (rules.ts) checks each column's
  // own shape directly instead.
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(controller, state, variant, session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing animating and no deal still landing - every ghost flight (tap, drag, undo, the stock deal) holds an
  // activeFlightCount claim until it lands, and the initial deal holds dealHiddenIds until its last card does.
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0
  // `won` is game state (clock, stat, save, undo/hint gating) and flips with the winning move; the celebration
  // waits until the last card has flown in and landed. The columns used to blank the instant `won` flipped,
  // which unregistered the very card the winning move's ghost was measuring to land on - it could not fly, and
  // simply vanished, along with every completed run on the board - so those visuals use winRevealed instead.
  const winRevealed = useWinReveal(won, settled)
  // The loss banner waits for the last card to land too.
  const lossRevealed = useWinReveal(stuck, settled)
  // The board the win cascade has taken over from (set together with startChains, see runWinCascade): once it IS the
  // current state, and the win is revealed, the real columns blank - not a moment earlier. Compared by identity (state is
  // replaced wholesale on every change) so an undo or a New Game un-blanks the columns with no reset to remember.
  const [cascadeHandoffFor, setCascadeHandoffFor] = useState<ScorpionState | null>(null)
  /** One ref per tableau column's own container, measured independently of CardRegistry: the win cascade's chain
   * origin (a completed run's King slot - the top of its fan). Mirrors Canfield's own foundationSlotRefs/Spider's own
   * completedSlotRefs - Scorpion's own "foundation-equivalent" is just each tableau column. */
  const tableauColumnRefs = useRef<(View | null)[]>(new Array(TABLEAU_COLUMNS).fill(null))
  /** Flights awaiting their post-commit measurement + their own flyTo, queued by tap-to-move
   * (handleCardTap), a drag drop (the tableau onDrop below), and undo of an ordinary tableau move -
   * a real list now (not a single slot), since these can genuinely overlap once nothing serializes
   * them behind a single busy-gate anymore (see useFlightConcurrency's own PATTERN_OVERLAP_GATE doc
   * comment) - two entries queued in the same commit would otherwise clobber each other in a single
   * ref slot, permanently stranding whichever one lost. Each entry carries its own already-created
   * DragFlightHandle to fly/hide once measured, and its own beginFlying-issued flyingId to remove
   * exactly its own `flying` entry (and settle exactly its own activeFlightCount claim) once it
   * lands - see the [state]-effect below. `gen` is the `dealTokenRef` value at the moment this
   * flight was queued - re-checked once the async measurement below resolves, so a flight queued
   * against a game that's since been replaced by "New Game" doesn't measure/land against the new
   * deal's DOM (card ids are shuffle-independent and reused across deals - see engine/deck.ts).
   * Mirrors Klondike's own pendingFlightRef, minus the viaStock/fast/sweep flight variants Scorpion
   * has no equivalent of (no foundation auto-play, and the assisted stock's own multi-card burst
   * flies via the separate DealLayer-based pendingStockDealRef below, not through `ghost`). */
  const pendingFlightRef = useRef<{ cardId: string; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  /** The assisted stock's one-shot deal(s) awaiting their post-commit measurement + deal.start()
   * (see runStockDeal/the effect below) - mirrors Spider's own pendingDealRef for its stock deal,
   * just fixed at exactly 3 destinations (columns FRONT_COLUMNS..FRONT_COLUMNS+2) instead of
   * Spider's variable "however many columns are non-empty." A real array (not a single slot),
   * even though there's only ever one stock packet per deal: `state.stock.length === 0` only
   * closes the gate AFTER handleDrawStock's own async measurement + commitState resolve, so a fast
   * double-tap on the packet could still race two concurrent handleDrawStock calls into this queue
   * before the first one's commit lands (same overlapping-actions reasoning as pendingFlightRef
   * above, applied defensively here even though the realistic case is a single entry) - a
   * single-slot ref would silently drop the first call's dealt/origin/token, permanently stranding
   * those 3 cards hidden forever (dealHiddenIds set but nothing to ever clear it), exactly the
   * "measure raced the commit" failure mode this repo's CLAUDE.md documents for the initial deal. */
  const pendingStockDealRef = useRef<{ dealt: { card: Card; colIndex: number }[]; origin: { x: number; y: number } | null; token: number }[]>([])
  /** An undone stock deal awaiting its post-commit measurement + deal.start() (see
   * runUndoStockDeal/the effect below) - the mirror image of pendingStockDealRef: origins (where
   * the 3 dealt cards currently sit) are measured up front, before the revert removes them, while
   * the shared destination (the restored stock packet) can only be measured after, once it exists
   * to register itself. Stays a single slot (not a list), unlike pendingFlightRef/pendingStockDealRef
   * above - a stock-deal undo is 'exclusive' (see undoGate: it starts only once nothing is in the
   * air, and no other undo starts until it has landed), so at most one of these is ever pending at a
   * time, mirroring Klondike's own pendingCascadeUndoRef for the identical reason. */
  const pendingUndoStockDealRef = useRef<{ entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null; releasePending: () => void }[]; token: number } | null>(null)
  /** Every take-off hold (cardFacePaint.ts) the latest stock-deal undo took on the cards it flies back (handleUndo). Each one
   * also travels with its own card - pendingUndoStockDealRef, runUndoStockDeal, then deal.start, which gives it back at that
   * card's take-off - and is kept here too so New Game/restore can give back, ahead of their own commit, whatever is still out
   * at whichever of those stages: the deal's own cancel only comes with the fresh game's initial deal, a commit and a
   * measurement later, and until then each card still held would be drawn by its column over the fresh board. A release is
   * safe to run twice (markGhostPending), so this is never pruned, only replaced by the next stock-deal undo - which waits for
   * every flight to settle, so the previous one's holds have all been given back by then. Same as Spider's undoDealHoldsRef. */
  const undoStockDealHoldsRef = useRef<(() => void)[]>([])
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  // Takes the controller to deal with explicitly, rather than reading the outer `controller`
  // memo directly - `setAssistedStock` below only takes effect on the NEXT render, so a caller
  // whose own setting just changed (handleNewGame) must build and pass the new controller itself
  // instead of dealing with the current render's now-stale memoized one. Same shape Spider's own
  // startNewGame uses for its identical numSuits setting.
  function startNewGame(ctrl: ReturnType<typeof createScorpionController>) {
    const myToken = ++dealTokenRef.current
    const s = ctrl.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingStockDealRef.current = []
    pendingUndoStockDealRef.current = null
    // Before the fresh board commits: a card a stock-deal undo still holds would be drawn over it (see undoStockDealHoldsRef).
    undoStockDealHoldsRef.current.forEach((release) => release())
    session.reset()
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    setDealHiddenIds(allTableauCardIds(s.tableau))
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<ScorpionState>) {
    ++dealTokenRef.current
    // config is persisted as 0/1 (see the save effect below) since SavedGame.config is a plain
    // number - narrowed back to a boolean here, falling back to the live setting only if missing.
    const assisted = saved.config === 1 || saved.config === 0 ? saved.config === 1 : settings.scorpionAssistedStock
    // Setting assistedStock here is enough to bring `controller` (a useMemo keyed on it) back in
    // sync by the same render that commits `state` below - both setters run inside the same
    // batch, same reasoning SpiderScreen's own restoreGame documents for its identical numSuits
    // setting.
    setAssistedStock(assisted)
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingStockDealRef.current = []
    pendingUndoStockDealRef.current = null
    undoStockDealHoldsRef.current.forEach((release) => release()) // see startNewGame
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    commitState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned(variant)
    setAssistedStock(settings.scorpionAssistedStock)
    startNewGame(createScorpionController(settings.scorpionAssistedStock))
  }

  // Every card in the initial deal flies face-down regardless of its real final state (columns
  // 0-3's top 4 and all of columns 4-6 are genuinely dealt face up - see rules.ts), matching
  // Klondike's own forced face-down flight for a mixed-face-state deal: a real dealer lays every
  // card down blind and only turns the revealed ones face-up after placing, not while still
  // sliding across the table. The real card underneath (revealed the instant this ghost lands -
  // see dealHiddenIds) already carries the correct true faceUp. Since there's no single starter
  // card (unlike Golf/Canfield), the deal's own origin is measured off the stock packet when the
  // assisted variant has one, or - for the classic variant, which has no stock pile at all - off
  // the first tableau column's own container as a stand-in origin point.
  async function runDeal(s: ScorpionState, token: number) {
    const sequence = buildScorpionDealSequence(s.tableau)
    const originPromise = assistedStock ? ghost.cardRegistry.measure(STOCK_PACKET_ID) : measureView(tableauColumnRefs.current[0])
    const [origin, destinations] = await Promise.all([originPromise, Promise.all(sequence.map((step) => ghost.cardRegistry.measure(step.cardId)))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }

    const entries: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({
        cardId: step.cardId,
        card: { ...step.card, faceUp: false },
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: step.visitOrder * dealStaggerMs(sequence.length)
      })
    })
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      return
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
      },
      () => {}
    )
  }

  // Win cascade: one chain per completed column (up to 4 - see rules.ts's isWon), each chained
  // top-first (Ace) down to bottom-last (King) - tableau arrays are stored bottom-up (index 0 =
  // King, the first card of the run), same convention Canfield's own foundation piles use, so
  // reversing gives the right cascade order.
  //
  // Unlike a foundation pile (one card showing), a completed run stands FANNED: 13 cards, each in its own place. A
  // chain with only a shared origin would collapse the whole fan onto the King's slot - twelve cards jumping with no
  // ghost - so every card also carries the spot it really stands on (`cardOrigins`), and its ghost waits there, then
  // converges onto the racked chain. Those spots come from CardRegistry (the real, measured positions - including
  // PileView's height compression - rather than a copy of its fan math that could drift), which only knows cards that
  // are still rendered. So this runs while the columns are still on screen and the columns blank only afterwards, once the
  // ghosts are on screen (cascadeHandoffFor, set from startChains' onShown - in the commit the ghosts appear, which waits for
  // every parked face, here each card of each run, to paint; see WinCascadeLayer's CascadeChains): measuring after the reveal
  // blanked them finds nothing, blanking first leaves the fan empty until the ghosts arrive, and blanking in the commit that
  // mounted them showed a fan of blank-faced cards for a frame or two. An undo or New Game before then clears the cascade,
  // which drops the callback (and the hand-off is keyed to `s` anyway). A card whose position cannot be measured falls back
  // to the King's slot (the chain origin) - correct, just collapsed - and if no chain can start at all the columns simply
  // stay up under the banner instead of vanishing (an empty cascade never calls onShown).
  async function runWinCascade(s: ScorpionState, gen: number) {
    const completed = s.tableau.map((col, index) => ({ col, index })).filter(({ col }) => col.length === 13)
    const [origins, cardRects] = await Promise.all([Promise.all(completed.map(({ index }) => measureView(tableauColumnRefs.current[index]))), Promise.all(completed.map(({ col }) => Promise.all(col.map((card) => ghost.cardRegistry.measure(card.id)))))])
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    completed.forEach(({ col }, i) => {
      const origin = origins[i]
      if (!origin) return
      const rects = cardRects[i].slice().reverse()
      chains.push({ cards: col.slice().reverse(), origin, cardOrigins: rects.map((rect) => (rect ? { x: rect.x, y: rect.y } : origin)) })
    })
    winCascade.startChains(chains, cardWidth, () => setCascadeHandoffFor(s))
  }

  // Held back until the win is revealed (see winRevealed): the pending token is set the moment the winning move
  // commits, but the cascade takes over from the columns, so it must not start while the last card is in the air.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  // Same race documented in this repo's own CLAUDE.md: measuring CardRegistry synchronously right
  // after the setState in applyMove would find the still-mounted SOURCE card (the destination
  // card's own registration effect hasn't run yet). Deferring to a [state]-keyed effect guarantees
  // the destination card has already registered by the time this runs.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        const landed = await ghost.cardRegistry.measure(p.cardId)
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

  // Assisted stock's one-shot deal: mirrors Spider's own stock-deal effect (runDeal's shared tail,
  // just fixed at 3 destinations instead of Spider's 10).
  // Every exit path settles exactly one activeFlightCount claim (the one handleDrawStock claimed
  // via startFlights(1) before queueing this) - see PATTERN_OVERLAP_GATE / the pendingStockDealRef
  // effect below, which settles on behalf of an entry that's already stale by the time this even
  // gets called.
  async function runStockDeal(dealt: { card: Card; colIndex: number }[], origin: { x: number; y: number } | null, token: number) {
    if (!origin) {
      setDealHiddenIds(new Set())
      settleFlight()
      return
    }
    const destinations = await Promise.all(dealt.map((d) => ghost.cardRegistry.measure(d.card.id)))
    if (dealTokenRef.current !== token) {
      settleFlight()
      return
    }

    const entries: DealCardSpec[] = []
    dealt.forEach((d, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({ cardId: d.card.id, card: d.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: i * DEAL_STAGGER_MS })
    })
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      settleFlight()
      return
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
      },
      () => settleFlight()
    )
  }

  useEffect(() => {
    if (pendingStockDealRef.current.length === 0 || !state) return
    const pending = pendingStockDealRef.current
    pendingStockDealRef.current = []
    pending.forEach((p) => {
      if (p.token !== dealTokenRef.current) {
        settleFlight()
        return
      }
      runStockDeal(p.dealt, p.origin, p.token)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Reverses the stock deal's own forward flight: the 3 cards it dealt fly from their current
  // tableau spots (measured by handleUndo before its own revert removes them) back to the
  // restored stock packet, converging on that one shared point - the mirror image of
  // runStockDeal, same idea as Spider's own runUndoDeal.
  // Every exit path calls settleFlight() exactly once (retiring the ad hoc scattered
  // undoBusyRef-clearing this used to have across its own two early bails plus handleUndo's own
  // measurement-failure bail) - consolidated so the one startFlights(1) claim handleUndo made up
  // front for this branch is always settled exactly once, regardless of which path gets taken.
  // Likewise each card's take-off hold (handleUndo marks it, so its column keeps drawing it where it was): it goes to
  // deal.start with its card, which gives it back at that card's take-off, and every way out of here without a flight for
  // a card gives its hold back at once, so a column never keeps drawing a card that is not going to leave it.
  async function runUndoStockDeal(entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null; releasePending: () => void }[], token: number) {
    const releaseAll = () => entries.forEach((e) => e.releasePending())
    const destination = await ghost.cardRegistry.measure(STOCK_PACKET_ID)
    if (dealTokenRef.current !== token || !destination) {
      releaseAll()
      settleFlight()
      return
    }
    const dealEntries: DealCardSpec[] = []
    entries.forEach((e) => {
      if (!e.origin) return
      dealEntries.push({ cardId: e.card.id, card: e.card, from: e.origin, to: destination, delayMs: e.delayMs, releasePending: e.releasePending })
    })
    if (dealEntries.length === 0) {
      releaseAll()
      settleFlight()
      return
    }
    deal.start(
      dealEntries,
      cardWidth,
      () => {},
      () => settleFlight()
    )
  }

  useEffect(() => {
    const pending = pendingUndoStockDealRef.current
    if (!pending || !state) return
    pendingUndoStockDealRef.current = null
    // A stray token mismatch here (e.g. a "New Game" that fired between handleUndo queuing this and
    // this effect running) settles directly rather than falling into runUndoStockDeal, which would
    // otherwise never get called at all for this entry - previously this just left the ref (and its
    // startFlights claim) stranded. Its cards' take-off holds go back with it.
    if (pending.token !== dealTokenRef.current) {
      pending.entries.forEach((e) => e.releasePending())
      settleFlight()
      return
    }
    runUndoStockDeal(pending.entries, pending.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out.
  useEffect(() => {
    loadGameInProgress<ScorpionState>('scorpion').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame(controller)
      setLastActiveGame('scorpion')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/fresh-deal (all flow through setState). Gated on !won so a just-won
  // deal doesn't get checkpointed as still in-progress. Deliberately NOT also keyed on a ticking
  // elapsed-seconds value the way an earlier version of this effect was: `session.getElapsed()`
  // computes the true current elapsed from wall-clock time on demand (see useGameSession.ts), but a
  // save still holds the elapsed time from when it was made, so useSaveInProgressBackstop saves again
  // every 10s, when the screen is left, and when the app is backgrounded.
  useEffect(() => {
    if (state && !won && !stuck) saveGameInProgress('scorpion', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: assistedStock ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, stuck, assistedStock, undoStack])
  useSaveInProgressBackstop(!!state && !won && !stuck, () => {
    if (state && !won && !stuck) saveGameInProgress('scorpion', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: assistedStock ? 1 : 0 })
  })

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint(request?: HintRequest): boolean {
    if (!state) return false
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(controller, state, skip)
    if (result.kind === 'none') {
      if (!request?.auto) showNoHintToast(infoToast)
      return false
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed(variant)
    // The glide is the Hint button's alone: Auto Hint only rings the cards.
    if (result.kind === 'move' && !request?.auto) {
      const { from, to, count } = result.move
      const source = state.tableau[from.index]
      void playHintGlide({ moving: source.slice(source.length - count), dest: state.tableau[to.index], destFanned: true, slot: to, cardWidth })
    }
    // True when pressing Hint again shows a different move: a held Hint button steps on while it is (hintHold.ts).
    return result.kind === 'move' && result.choices > 1
  }

  function pushUndo(prev: ScorpionState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    // alwaysValidRun: any face-up card and everything on top of it is liftable regardless of
    // internal order (see rules.ts's own header comment) - same helper Yukon's own drag config
    // uses for its identical "no run-validity requirement" rule.
    return runCountFrom(state.tableau[colIndex], indexFromTop, alwaysValidRun)
  }

  // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
  // closure's `state` - tap and drag can now both be mid-flight at once (see
  // PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
  // commitState just did, not the same stale board both closures captured.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string): boolean {
    const current = stateRef.current
    if (!current) return false
    const result = controller.tryMove(current, { from, to, count })
    if (!result) return false
    pushUndo(current, { from, to, count, anchorCardId })
    commitState(result)
    session.registerMove()
    return true
  }

  // Shared tail for every successful ordinary tableau move, whichever triggered it (tap-to-move or
  // a manual drag's drop) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto. The
  // caller (handleCardTap, the tableau onDrop below) is the one that claims the activeFlightCount
  // slot via startFlights(1) before calling this, and settles it either immediately on failure or
  // via the pendingFlightRef effect once this entry's flight actually lands.
  //
  // `inAir`: a tapped run's cards still flying in to `from` (inAirRun.ts) - `flight` carries only the cards on the board, and each piece
  // goes on from mid-air in a flight of its own, landing on top of them.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { inAir?: Card[][] }): boolean {
    if (!applyMove(from, to, count, anchorCardId)) return false
    const gen = dealTokenRef.current
    const inAirCount = (opts?.inAir ?? []).reduce((n, piece) => n + piece.length, 0)
    pendingFlightRef.current.push({ cardId: anchorCardId, gen, flyingId: beginFlying(to, count - inAirCount), flight })
    if (inAirCount > 0) {
      // Out of `from`'s landing count, so the cards left there show at once.
      shrinkLanding(from, inAirCount)
      const pieces = peelInAir(ghost, opts?.inAir ?? [], cardWidth)
      startFlights(pieces.length)
      for (const p of pieces) pendingFlightRef.current.push({ cardId: p.anchorCardId, gen, flyingId: beginFlying(to, p.count), flight: p.flight })
    }
    return true
  }

  // Deals the assisted stock's held-back 3 cards, one onto each of the last 3 columns - see
  // rules.ts's drawStock. Mirrors Spider's own handleDrawStock: capture the pre-deal stock/measure
  // the (still-mounted) packet BEFORE the state update removes it, push a null-move undo entry
  // (no single MoveInfo shape covers "3 cards landed in 3 different columns at once"), then let
  // the pendingStockDealRef effect above fly each card once its own destination has registered.
  async function handleDrawStock() {
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    const current = stateRef.current
    if (won || !current || current.stock.length === 0 || !controller.drawStock) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const dealt = current.stock.map((card, i) => ({ card: { ...card, faceUp: true }, colIndex: FRONT_COLUMNS + i }))
    const result = controller.drawStock(current)
    if (!result) return
    startFlights(1)
    session.registerMove()
    pushUndo(current, null)

    const myToken = ++dealTokenRef.current
    const origin = await ghost.cardRegistry.measure(STOCK_PACKET_ID)

    setDealHiddenIds(hiddenUntilDealt(dealt.map((d) => d.card.id)))
    pendingStockDealRef.current.push({ dealt, origin, token: myToken })
    commitState(result)
  }

  // Mirrors handleCardTap's/handleDrop's forward flight, just in reverse, for an ordinary tableau
  // move: the card(s) being undone are still sitting wherever the move left them (`move.to`) -
  // measure that real position before reverting, then revert and mark `move.from` as incoming so
  // it flies the rest of the way there. A null move (the assisted stock's one-shot deal) instead
  // reverses via runUndoStockDeal above, mirroring Spider's own null-move undo branch.
  // One undo per call - see useFlightConcurrency's runUndo.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // A move's undo takes its run back off the column it went to, so it overlaps the undos before it
  // once nothing is still landing there. A stock deal's flies back through the deal layer, three
  // columns at once - one at a time.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    const current = stateRef.current
    if (!entry || !current) return null
    if (!entry.move) return 'exclusive'
    // A run still flying in to that column turns back in mid-air (revertTopUndo's peel): nothing to wait for.
    if (ghost.canPeel(undoGhost(entry.move, current))) return { takesFrom: [] }
    return { takesFrom: [entry.move.to] }
  }

  // The ghost a plain undo of `move` flies back: the run it takes off `move.to` as `current` has it.
  function undoGhost(move: MoveInfo, current: ScorpionState) {
    const sourcePile = current.tableau[move.to.index] ?? null
    const cards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    return { cards, offsetStep: move.count > 1 ? faceUpFanOffset(cardWidth) : 0, cardWidth }
  }

  async function revertTopUndo() {
    // Reads the stack and the board via their refs, not the closure - see applyMove's identical
    // comment (undos, too, can run back-to-back before React re-renders).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    if (won) winCascade.clear()
    const { move, state: prevState } = entry
    // Claimed synchronously here (see activeFlightCountRef's doc comment) - one call always
    // resolves to exactly one completion below (a landed flight, a landed deal, or an immediate
    // "nothing to fly" settle), whichever branch handles it.
    startFlights(1)

    if (!move) {
      const myToken = ++dealTokenRef.current
      const dealtColumns = current.tableau.map((col, colIndex) => ({ col, colIndex })).filter(({ col, colIndex }) => col.length === prevState.tableau[colIndex].length + 1)
      const dealtCards = dealtColumns.map(({ col }) => col[col.length - 1])
      const origins = await Promise.all(dealtCards.map((c) => ghost.cardRegistry.measure(c.id)))
      // New Game/restore replaced the game while these were measured (Spider's handleUndo has the same guard): `prevState` is
      // the old game's board, and every claim (this undo's included) was reset with it - so nothing is committed, marked or
      // settled. (A draw, the only other thing that bumps the token, is refused while undo is busy.)
      if (dealTokenRef.current !== myToken) return

      setUndoStack((stack) => stack.slice(0, -1))
      // Taking off from their columns: the commit below takes these cards out of them, but each card's ghost only shows once
      // the packet has been measured (the commit after this one), the deal pool has mounted and the card's own stagger has run
      // out (its column x DEAL_STAGGER_MS: 140-210ms for columns 4-6) - and the columns used to drop them at once, so the
      // dealt cards vanished from the board and came back as ghosts one by one. Each is marked here, in the same synchronous
      // stretch as the commit, with a mark of its own (cardFacePaint.ts), so its column keeps drawing the very card it had
      // (PileView's held cards) until that card's own ghost takes off over it - DealLayer gives each back then
      // (releasePending), and runUndoStockDeal/its effect/New Game give back any that will never fly. A card that could not
      // be measured gets no ghost, so it holds nothing.
      const entries = dealtCards.map((c, i) => ({ card: c, delayMs: dealtColumns[i].colIndex * DEAL_STAGGER_MS, origin: origins[i], releasePending: origins[i] ? markGhostPending([c.id]) : () => {} }))
      undoStockDealHoldsRef.current = entries.map((e) => e.releasePending)
      pendingUndoStockDealRef.current = {
        entries,
        token: myToken
      }
      commitState(prevState)
      return
    }

    const ghostContent = undoGhost(move, current)
    const movingCards = ghostContent.cards
    // Cards the undo before this one is still flying in (a held Undo, where that undo's move put them
    // on this pile): they turn back in mid-air, the rest of that flight landing as before, instead of
    // the undo waiting for them to land and then sending them off again. Taken here, before any await,
    // in the same task the gate saw them (undoGate).
    const peeled = movingCards.length > 0 ? ghost.peel(ghostContent) : null
    const origin = peeled || movingCards.length === 0 ? null : await ghost.cardRegistry.measure(move.anchorCardId)

    setUndoStack((stack) => stack.slice(0, -1))

    const flight = peeled ?? (origin ? ghost.show(ghostContent, { x: origin.x, y: origin.y }) : null)
    if (flight) {
      playCardSound()
      hapticCard()
      // The flight they were taken out of now reveals only what it still carries when it lands.
      if (peeled) shrinkLanding(move.to, movingCards.length)
      const flyingId = beginFlying(move.from, move.count)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, gen: dealTokenRef.current, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // Tapping any movable card sends it to the tableau pile that buries the fewest cards (see
  // engine/autoMove.ts) - Scorpion has no foundation, so unlike Klondike/FreeCell this only ever
  // considers other tableau columns, same as Spider/Yukon.
  async function handleCardTap(colIndex: number, card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const move = controller.autoMoveHint(state, { zone: 'tableau', index: colIndex }, card.id)
    if (!move) {
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
    // Part of the run may still be flying in to this column (a quick tap right after a move put it there): it goes on from mid-air
    // (inAirRun.ts).
    const takeOff = await liftTappedRun({ ghost, from: move.from, count: move.count, measure, pile: () => stateRef.current?.tableau[move.from.index] ?? null, landingCount, cancelled: () => undoBusyRef.current, cardWidth })
    if (!takeOff) {
      settleFlight()
      return
    }

    // No buzz here: a tap's is its press's own, at touch-down (every card is a feedback-press Pressable).
    playCardSound()
    if (!completeMove(move.from, move.to, move.count, card.id, takeOff.flight, { inAir: takeOff.inAir })) {
      takeOff.flight.hide()
      settleFlight()
    }
  }

  if (!state) return <GameLoading />

  // The classic deal has no stock at all, so nothing to show; the assisted one keeps its slot after the deal.
  const stockSlot = state.stock.length > 0 ? <StockPacket onPress={handleDrawStock} highlighted={activeHint?.kind === 'drawStock'} /> : assistedStock ? <EmptySlot /> : null

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Scorpion' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} autoHintKey={state} hintShowing={!!activeHint} hintDisabled={won || stuck} won={won} winRevealed={winRevealed} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} pauseClock={session.setPaused} par={parFor(variant)} clockRunning={session.started && !won && !stuck} movesCount={session.moves} settingsContent={<ScorpionSettingsSection />} rules={SCORPION_RULES}>
        {/* Portrait: the stock packet lives in a card-tall top row at the right, as always. Wide layout: no
        top row (zero height, no margin) - the packet is absolutely positioned beside the tableau below.
        Once the assisted stock has been dealt, an empty slot stays in its place: the packet was the top row's
        only content, so the row (and the whole tableau with it) used to collapse upward the moment it went. */}
        <View style={[styles.topRow, isWide && styles.topRowWide]}>{!isWide && stockSlot}</View>

        {/* Full-width wrapper (a tap outside a parent's bounds never reaches an absolutely positioned child
        on iOS, so the packet must stay inside it): the tableau centres itself, the packet hangs one gap
        past its last column (left 50% + half the tableau + gap) and is top-aligned with it. */}
        <View style={isWide ? styles.wideBoard : undefined}>
          {isWide && stockSlot && <View style={[styles.widePacket, { marginLeft: (cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1)) / 2 + gap }]}>{stockSlot}</View>}
          <View style={[styles.tableauRow, { gap }, isWide && styles.tableauRowWide]}>
            {state.tableau.map((col, colIndex) => {
              const dragConfig: PileDragConfig = {
                registry: dropZones,
                getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
                // Claims a flight slot (see activeFlightCountRef's doc comment) purely so undo sees
                // this drop as in-flight for its whole duration, not just once completeMove lands one
                // - PileView.tsx (shared, not ours to edit) already ran its own hitTest await before
                // invoking this callback, so this is the earliest point ScorpionScreen gets a look-in.
                // Rejects outright if undo is currently running (undo holds full mutual exclusion, not
                // just a one-way wait - see undoBusyRef's own doc comment) - and once the game is won, like
                // handleCardTap/handleDrawStock/handleHint: the completed runs stay on the board (and
                // draggable) until the win is revealed, and a drop in that hold would register a move, fly a
                // ghost that delays the reveal, and could split a run so the win flips back.
                onDrop: (to, count, anchorCardId, flight) => {
                  if (won || undoBusyRef.current) return false
                  startFlights(1)
                  if (!completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId, flight)) {
                    settleFlight()
                    return false
                  }
                  return true
                }
              }
              const hiddenCount = flying.filter((f) => f.to.zone === 'tableau' && f.to.index === colIndex).reduce((sum, f) => sum + f.count, 0)
              // Hidden entirely once the win cascade takes over - at that point every column is either
              // already empty or a complete run (see rules.ts's isWon), and the win cascade owns displaying
              // those cards now (see runWinCascade), the same way Spider's own completed-sequence slots
              // go blank once their cascade takes over. NOT keyed on `won`: that flips with the winning
              // move, and blanking the columns then would unregister the card its ghost is flying to. And
              // not on `winRevealed` alone either: runWinCascade measures the still-rendered cards first, and
              // the columns blank only once the ghosts are on screen with their faces painted (cascadeHandoffFor,
              // set from startChains' onShown).
              const cards = winRevealed && cascadeHandoffFor === state ? [] : col
              return (
                <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                  <View
                    ref={(el) => {
                      tableauColumnRefs.current[colIndex] = el
                    }}
                    collapsable={false}
                  >
                    <PileView cards={cards} onPressCard={(card, indexFromTop, measure) => handleCardTap(colIndex, card, indexFromTop, measure)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
                  </View>
                </DropZone>
              )
            })}
          </View>
        </View>
      </GameChrome>
      {winRevealed && <PipFireworks />}
      <WinCascadeGhosts />
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} variant={variant} onNewGame={handleNewGame} />}
      {lossRevealed && !won && <LossBanner onNewGame={handleNewGame} onUndo={handleUndo} />}
    </CardSizeProvider>
  )
}

function makeStyles() {
  return StyleSheet.create({
    tableauColumn: {},
    tableauRow: {
      flexDirection: 'row',
      paddingBottom: 20
    },
    tableauRowWide: {
      alignSelf: 'center'
    },
    topRow: {
      alignSelf: 'flex-end',
      marginBottom: 16
    },
    topRowWide: {
      marginBottom: 0
    },
    wideBoard: {
      alignSelf: 'stretch'
    },
    widePacket: {
      left: '50%',
      position: 'absolute',
      top: 0,
      zIndex: 1
    }
  })
}
