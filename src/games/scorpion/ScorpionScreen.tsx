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
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { computeContentBounds, useRotatedWindowDimensions } from '@tastic/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PileDragConfig, PileView } from '@/components/PileView'
import { PlayingCard } from '@/components/PlayingCard'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { SCORPION_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { alwaysValidRun, runCountFrom } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { buildScorpionDealSequence } from './dealSequence'
import { createScorpionController, ScorpionState } from './rules'
import { ScorpionSettingsSection } from './ScorpionSettingsSection'

const TABLEAU_COLUMNS = 7
const FRONT_COLUMNS = 4
// Deepest column at deal is 8 cards (classic variant's columns 4-6); a completed run stacks a full
// 13 - matching Klondike/FreeCell's own generous floor for a similarly deep tableau.
const TABLEAU_MIN_HEIGHT = 420

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
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
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
  const controller = useMemo(() => createScorpionController(assistedStock), [assistedStock])
  // Rotation-aware (swaps width/height when rendered inside a rotated wrapper) - exact identity
  // with plain useWindowDimensions() otherwise, see the rotation plan.
  const { width: winWidth } = useRotatedWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const [state, setState] = useState<ScorpionState | null>(null)
  // Nullable move (Spider's default): an ordinary tableau move always has one, but the assisted
  // stock's one-shot deal lands 3 cards across 3 different columns at once - no single MoveInfo
  // shape for that, so it's recorded as `move: null` and handleUndo detects that case itself (see
  // runUndoStockDeal), same convention as Spider's own stock deal.
  const [undoStack, setUndoStack] = useState<UndoEntry<ScorpionState>[]>([])
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
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Derived from `state` every render (see useDerivedWinCheck), same as Spider/Golf - Scorpion has
  // no suit-based foundation for a "won" flag to hang off; isWon (rules.ts) checks each column's
  // own shape directly instead.
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(controller, state, 'scorpion', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** One ref per tableau column's own container - measured independently of CardRegistry so the
   * win cascade can still find a completed run's screen position after its real cards have been
   * hidden (won-gated, see the tableau row below), at which point they're no longer
   * CardRegistry-registered at all. Mirrors Canfield's own foundationSlotRefs/Spider's own
   * completedSlotRefs - Scorpion's own "foundation-equivalent" is just each tableau column. */
  const tableauColumnRefs = useRef<(View | null)[]>(new Array(TABLEAU_COLUMNS).fill(null))
  /** A flight awaiting its post-commit measurement + its own flyTo, shared by tap-to-move
   * (handleCardTap), a drag drop, and undo of an ordinary tableau move - only one is ever in
   * flight at a time. `gen` guards against a "New Game" tapped mid-flight replacing the deal this
   * flight was measuring against (card ids are shuffle-independent and reused across deals - see
   * engine/deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; gen: number; flight: DragFlightHandle } | null>(null)
  /** The assisted stock's one-shot deal awaiting its post-commit measurement + deal.start() (see
   * runStockDeal/the effect below) - mirrors Spider's own pendingDealRef for its stock deal, just
   * fixed at exactly 3 destinations (columns FRONT_COLUMNS..FRONT_COLUMNS+2) instead of Spider's
   * variable "however many columns are non-empty." */
  const pendingStockDealRef = useRef<{ dealt: { card: Card; colIndex: number }[]; origin: { x: number; y: number } | null; token: number } | null>(null)
  /** An undone stock deal awaiting its post-commit measurement + deal.start() (see
   * runUndoStockDeal/the effect below) - the mirror image of pendingStockDealRef: origins (where
   * the 3 dealt cards currently sit) are measured up front, before the revert removes them, while
   * the shared destination (the restored stock packet) can only be measured after, once it exists
   * to register itself. */
  const pendingUndoStockDealRef = useRef<{ entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[]; token: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  const undoBusyRef = useRef(false)

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
    undoBusyRef.current = false
    session.reset()
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    setDealHiddenIds(allTableauCardIds(s.tableau))
    scheduleDeal(myToken)
    setState(s)
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
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned('scorpion')
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
        delayMs: step.visitOrder * DEAL_STAGGER_MS
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
  // reversing gives the right cascade order. Origin is each column's own tableauColumnRefs slot
  // (not CardRegistry) since every column's real cards are hidden the instant `won` flips true
  // (see the tableau row below) and therefore unregistered.
  async function runWinCascade(s: ScorpionState, gen: number) {
    const completed = s.tableau.map((col, index) => ({ col, index })).filter(({ col }) => col.length === 13)
    const origins = await Promise.all(completed.map(({ index }) => measureView(tableauColumnRefs.current[index])))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    completed.forEach(({ col }, i) => {
      const origin = origins[i]
      if (!origin) return
      chains.push({ cards: col.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
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

  // Same race documented in this repo's own CLAUDE.md: measuring CardRegistry synchronously right
  // after the setState in applyMove would find the still-mounted SOURCE card (the destination
  // card's own registration effect hasn't run yet). Deferring to a [state]-keyed effect guarantees
  // the destination card has already registered by the time this runs.
  useEffect(() => {
    const pending = pendingFlightRef.current
    if (!pending || !state) return
    pendingFlightRef.current = null
    ;(async () => {
      const landed = await ghost.cardRegistry.measure(pending.cardId)
      if (dealTokenRef.current !== pending.gen || !landed) {
        pending.flight.hide()
        setFlying(null)
        undoBusyRef.current = false
        return
      }
      pending.flight.flyTo(landed.x, landed.y, () => {
        setFlying(null)
        undoBusyRef.current = false
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Assisted stock's one-shot deal: mirrors Spider's own stock-deal effect (runDeal's shared tail,
  // just fixed at 3 destinations instead of Spider's 10).
  async function runStockDeal(dealt: { card: Card; colIndex: number }[], origin: { x: number; y: number } | null, token: number) {
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }
    const destinations = await Promise.all(dealt.map((d) => ghost.cardRegistry.measure(d.card.id)))
    if (dealTokenRef.current !== token) return

    const entries: DealCardSpec[] = []
    dealt.forEach((d, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({ cardId: d.card.id, card: d.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: i * DEAL_STAGGER_MS })
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

  useEffect(() => {
    const pending = pendingStockDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingStockDealRef.current = null
    runStockDeal(pending.dealt, pending.origin, pending.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Reverses the stock deal's own forward flight: the 3 cards it dealt fly from their current
  // tableau spots (measured by handleUndo before its own revert removes them) back to the
  // restored stock packet, converging on that one shared point - the mirror image of
  // runStockDeal, same idea as Spider's own runUndoDeal.
  async function runUndoStockDeal(entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[], token: number) {
    const destination = await ghost.cardRegistry.measure(STOCK_PACKET_ID)
    if (dealTokenRef.current !== token || !destination) {
      undoBusyRef.current = false
      return
    }
    const dealEntries: DealCardSpec[] = []
    entries.forEach((e) => {
      if (!e.origin) return
      dealEntries.push({ cardId: e.card.id, card: e.card, from: e.origin, to: destination, delayMs: e.delayMs })
    })
    if (dealEntries.length === 0) {
      undoBusyRef.current = false
      return
    }
    deal.start(
      dealEntries,
      cardWidth,
      () => {},
      () => {
        undoBusyRef.current = false
      }
    )
  }

  useEffect(() => {
    const pending = pendingUndoStockDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingUndoStockDealRef.current = null
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

  // Saves after every move/undo/fresh-deal (all flow through setState). Gated on !won so a
  // just-won deal doesn't get checkpointed as still in-progress. Deliberately NOT also keyed on a
  // ticking elapsed-seconds value the way an earlier version of this effect was:
  // `session.getElapsed()` computes the true current elapsed from wall-clock time on demand (see
  // useGameSession.ts), so a save made at the last real move is never stale even once the player
  // just sits looking at the board afterward - resuming always recomputes the exact right value
  // instead of depending on whenever this effect last happened to run.
  useEffect(() => {
    if (state && !won) saveGameInProgress('scorpion', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: assistedStock ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, assistedStock, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('scorpion', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: assistedStock ? 1 : 0 })
  })

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
    recordHintUsed('scorpion')
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

  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string): boolean {
    if (!state) return false
    const result = controller.tryMove(state, { from, to, count })
    if (!result) return false
    pushUndo(state, { from, to, count, anchorCardId })
    setState(result)
    session.registerMove()
    return true
  }

  // Shared tail for every successful ordinary tableau move, whichever triggered it (tap-to-move or
  // a manual drag's drop) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle): boolean {
    if (!applyMove(from, to, count, anchorCardId)) return false
    setFlying({ to, count })
    pendingFlightRef.current = { cardId: anchorCardId, gen: dealTokenRef.current, flight }
    return true
  }

  // Deals the assisted stock's held-back 3 cards, one onto each of the last 3 columns - see
  // rules.ts's drawStock. Mirrors Spider's own handleDrawStock: capture the pre-deal stock/measure
  // the (still-mounted) packet BEFORE the state update removes it, push a null-move undo entry
  // (no single MoveInfo shape covers "3 cards landed in 3 different columns at once"), then let
  // the pendingStockDealRef effect above fly each card once its own destination has registered.
  async function handleDrawStock() {
    if (won || !state || state.stock.length === 0 || !controller.drawStock) return
    const dealt = state.stock.map((card, i) => ({ card: { ...card, faceUp: true }, colIndex: FRONT_COLUMNS + i }))
    const result = controller.drawStock(state)
    if (!result) return
    session.registerMove()
    pushUndo(state, null)

    const myToken = ++dealTokenRef.current
    const origin = await ghost.cardRegistry.measure(STOCK_PACKET_ID)

    setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
    pendingStockDealRef.current = { dealt, origin, token: myToken }
    setState(result)
  }

  // Mirrors handleCardTap's/handleDrop's forward flight, just in reverse, for an ordinary tableau
  // move: the card(s) being undone are still sitting wherever the move left them (`move.to`) -
  // measure that real position before reverting, then revert and mark `move.from` as incoming so
  // it flies the rest of the way there. A null move (the assisted stock's one-shot deal) instead
  // reverses via runUndoStockDeal above, mirroring Spider's own null-move undo branch.
  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    if (won) winCascade.clear()
    const entry = undoStack[undoStack.length - 1]
    const { move, state: prevState } = entry

    if (!move) {
      const myToken = ++dealTokenRef.current
      const dealtColumns = state.tableau.map((col, colIndex) => ({ col, colIndex })).filter(({ col, colIndex }) => col.length === prevState.tableau[colIndex].length + 1)
      const dealtCards = dealtColumns.map(({ col }) => col[col.length - 1])
      const origins = await Promise.all(dealtCards.map((c) => ghost.cardRegistry.measure(c.id)))

      setUndoStack((stack) => stack.slice(0, -1))
      pendingUndoStockDealRef.current = {
        entries: dealtCards.map((c, i) => ({ card: c, delayMs: dealtColumns[i].colIndex * DEAL_STAGGER_MS, origin: origins[i] })),
        token: myToken
      }
      setState(prevState)
      return
    }

    const sourcePile = state.tableau[move.to.index] ?? null
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })
      setFlying({ to: move.from, count: move.count })
      setState(prevState)
      pendingFlightRef.current = { cardId: move.anchorCardId, gen: dealTokenRef.current, flight }
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }
  }

  // Tapping any movable card sends it to the tableau pile that buries the fewest cards (see
  // engine/autoMove.ts) - Scorpion has no foundation, so unlike Klondike/FreeCell this only ever
  // considers other tableau columns, same as Spider/Yukon.
  async function handleCardTap(colIndex: number, card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    const move = controller.autoMoveHint(state, { zone: 'tableau', index: colIndex }, card.id)
    if (!move) {
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

    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })

    if (!completeMove(move.from, move.to, move.count, card.id, flight)) {
      flight.hide()
    }
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Scorpion' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<ScorpionSettingsSection />} rules={SCORPION_RULES}>
        <View style={styles.topRow}>{state.stock.length > 0 && <StockPacket onPress={handleDrawStock} highlighted={activeHint?.kind === 'drawStock'} />}</View>

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              onDrop: (to, count, anchorCardId, flight) => completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId, flight)
            }
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
            // Hidden entirely once won - at that point every column is either already empty or a
            // complete run (see rules.ts's isWon), and the win cascade owns displaying those cards
            // now (see runWinCascade), the same way Spider's own completed-sequence slots go blank
            // once their cascade takes over.
            const cards = won ? [] : col
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
      </GameChrome>
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={handleNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 12
    },
    loadingText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      marginTop: 40,
      textAlign: 'center'
    },
    tableauColumn: {},
    tableauRow: {
      flexDirection: 'row',
      paddingBottom: 20
    },
    topRow: {
      alignSelf: 'flex-end',
      marginBottom: 16
    }
  })
}
