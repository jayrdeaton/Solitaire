// Forty Thieves solitaire screen: 8 foundations (dynamically assigned, 2 decks x 4 suits), 10
// tableau columns building down by suit, single-card stock/waste (draw-1, no recycle). Closest
// architecturally to Canfield/Klondike (same imperative checkWin-after-applyMove flow, same
// tap-to-move/drag/undo/auto-play shape), simplified by having no reserve pile and no cyclic
// wraparound - see rules.ts for the full rules and for why its own auto-play-to-foundation is a
// scoped reimplementation rather than a reuse of engine/autoFoundation.ts.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useFittedCardWidth, useFittedGap, useGameLayout } from '@/components/gameLayout'
import { PileDragConfig, PileView } from '@/components/PileView'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { FORTYTHIEVES_RULES } from '@/constants/gameRules'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { isDescendingSameSuit, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { useCascadeFeedback } from '@/games/shared/cascadeFeedback'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { BOARD_MODEL } from './boardModel'
import { buildFortyThievesDealSequence } from './dealSequence'
import { FortyThievesSettingsSection } from './FortyThievesSettingsSection'
import { createFortyThievesController, findFoundationSlot, FortyThievesState, isFullyAutoCompletableWithDraws, nextAutoCompleteMoveWithDraws } from './rules'

const TABLEAU_COLUMNS = 10
const TABLEAU_MIN_HEIGHT = 360
const NUM_FOUNDATIONS = 8

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 12
    },
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row'
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
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 18,
      marginBottom: 16
    }
  })
}

export default withGameProviders(FortyThievesScreenInner)

function FortyThievesScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // The move-style rule the in-progress deal was actually dealt with - deliberately not
  // re-derived from `settings` every render, same reasoning KlondikeScreen's own `klondikeDraw`
  // state has: a mid-game settings change must never mutate the current deal's own rules.
  const controllerRef = useRef(createFortyThievesController(settings.fortyThievesRunMoves))
  const [runMoves, setRunMoves] = useState(settings.fortyThievesRunMoves)
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with
  // each other - PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`,
  // `commitState`, `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working
  // unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, activeFlightCountRef, startFlights, settleFlight, undoBusyRef, reset: resetFlightConcurrency } = useFlightConcurrency<FortyThievesState>()
  const [undoStack, setUndoStack] = useState<UndoEntry<FortyThievesState>[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: FortyThievesState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useFoundationWinCheck's own hintsUsedRef param),
  // to decide whether this win counts toward the "wins without hint" stat/achievement. Reset
  // alongside the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth, isWide } = useGameLayout()
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  // The width-derived size in portrait (unchanged); in the wide layout also shrunk until the whole board
  // (top row + the tallest starting column) fits the window's short axis - see boardModel.ts.
  const cardWidth = useFittedCardWidth(widthCardWidth, BOARD_MODEL)
  const gap = useFittedGap(widthGap, widthCardWidth, cardWidth, contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Reads controllerRef.current live inside isWon (rather than passing controllerRef.current
  // directly, which would freeze this render's controller into checkWin's closure) - matches
  // KlondikeScreen's identical fix, so a straggling call from a stale render's closure chain still
  // checks against the CURRENT controller, same as every other controllerRef.current read in this
  // file.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: FortyThievesState) => controllerRef.current.isWon(s) }, 'fortythieves', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real top card has been hidden (won-gated, see the foundation row below). */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(NUM_FOUNDATIONS).fill(null))
  /** Flights awaiting their post-commit measurement + flight.flyTo, queued by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), undo, and auto-play (firePlay/
   * fireDrawAndPlay) - a list (not a single slot) since these can now genuinely overlap (see
   * useFlightConcurrency's own doc comment / PATTERN_OVERLAP_GATE): two entries queued in the same
   * commit would otherwise clobber each other in a single ref slot, permanently stranding whichever
   * one lost. Each entry carries its own already-created DragFlightHandle (from whichever call site
   * queued it) to fly/hide once measured, and its own flyingId to remove exactly its own `flying`
   * entry once it lands - see the [state]-effect below. `viaStock` measures via stockViewRef (a
   * plain View, not per-card) instead of CardRegistry - only undoing a stock draw flies back toward
   * the stock (this game has no waste-to-stock recycle at all, unlike Klondike, so that's the only
   * stock-adjacent case there is); every other destination is a real per-card-registered pile.
   * `fast` marks a firePlay-triggered flight, passed on to flight.flyTo for the quicker
   * auto-play-to-foundation timing. `gen` is the dealTokenRef value at the moment this flight was
   * queued - re-checked once the async measurement below resolves, so a flight queued against a
   * game that's since been replaced by "New Game" doesn't measure/land against the new deal's DOM
   * (card ids are shuffle-independent and reused across deals - see deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; fast?: boolean; sweep?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const cascadeFeedback = useCascadeFeedback(playCardSound, hapticCard)
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    controllerRef.current = createFortyThievesController(settings.fortyThievesRunMoves)
    setRunMoves(settings.fortyThievesRunMoves)
    const s = controllerRef.current.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    setDealHiddenIds(new Set(s.tableau.flat().map((c) => c.id)))
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a
  // new deal). Also restores the saved undo stack (falling back to empty for an older save
  // written before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<FortyThievesState>) {
    ++dealTokenRef.current
    // config is persisted as 0/1 (see the save effect below) since SavedGame.config is a plain
    // number - narrowed back to a boolean here, falling back to the live setting only if missing.
    const moves = saved.config === 1 || saved.config === 0 ? saved.config === 1 : settings.fortyThievesRunMoves
    controllerRef.current = createFortyThievesController(moves)
    setRunMoves(moves)
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    commitState(saved.state)
  }

  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned('fortythieves')
    startNewGame()
  }

  // Every card here is genuinely dealt face up (see rules.ts) - flies showing its real face
  // throughout, same as FreeCell's/Golf's own all-face-up deal.
  async function runDeal(s: FortyThievesState, token: number) {
    const sequence = buildFortyThievesDealSequence(s.tableau)
    const [origin, destinations] = await Promise.all([measureView(stockViewRef.current), Promise.all(sequence.map((step) => ghost.cardRegistry.measure(step.cardId)))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }

    const entries: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({ cardId: step.cardId, card: step.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: step.visitOrder * DEAL_STAGGER_MS })
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

  // Foundation piles are guaranteed full (13 cards each) the instant isWon() is true - measures
  // each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef), not the top
  // card via CardRegistry, since the real top card is hidden (and therefore unregistered) the
  // instant `won` flips true. Chains each pile top-first (King) down to bottom-last (Ace).
  async function runWinCascade(s: FortyThievesState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    s.foundation.forEach((pile, index) => {
      const origin = origins[index]
      if (!origin || pile.length === 0) return
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
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
  // after the setState in applyMove/handleDrawStock would find the still-mounted SOURCE card.
  // Deferring to a [state]-keyed effect guarantees the destination card has already registered.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        const landed = p.viaStock ? await measureView(stockViewRef.current) : await ghost.cardRegistry.measure(p.cardId)
        if (dealTokenRef.current !== p.gen || !landed) {
          p.flight.hide()
          endFlying(p.flyingId)
          settleFlight()
          return
        }
        p.flight.flyTo(
          landed.x,
          landed.y,
          () => {
            endFlying(p.flyingId)
            settleFlight()
          },
          { fast: p.fast, sweep: p.sweep }
        )
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Auto-play-to-foundation: only ever fires as a direct consequence of the player's own move - see
  // useAutoFoundationCascade for the trigger model (armFromForwardMove/armFromAceEvent, called from
  // applyMove/handleDrawStock below), and rules.ts's own header comment on why this game only ever
  // fires once the whole remaining deal is provably clearable (no continuous "safe" heuristic,
  // unlike Klondike/FreeCell/Yukon/Canfield - no computeNextStep fallback to one below either).
  const cascade = useAutoFoundationCascade<FortyThievesState>({
    state,
    settled: activeFlightCount === 0 && dealHiddenIds.size === 0,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep,
    firePlay,
    fireDraw: handleDrawStock,
    fireDrawAndPlay
  })

  useEffect(() => {
    loadGameInProgress<FortyThievesState>('fortythieves').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('fortythieves')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deliberately not keyed on a ticking elapsed-seconds value: `session.getElapsed()` computes the
  // true current elapsed from wall-clock time on demand (see useGameSession.ts), so a save made at
  // the last real move is never stale even once the player just sits looking at the board
  // afterward - resuming always recomputes the exact right value instead of depending on whenever
  // this effect last happened to run.
  useEffect(() => {
    if (state && !won) saveGameInProgress('fortythieves', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: runMoves ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, runMoves, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('fortythieves', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: runMoves ? 1 : 0 })
  })

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint() {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(controllerRef.current, state, skip)
    if (result.kind === 'none') {
      infoToast('No moves available right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('fortythieves')
  }

  function pushUndo(prev: FortyThievesState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  async function handleUndo() {
    if (undoBusyRef.current || activeFlightCountRef.current > 0 || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    if (won) {
      setWon(false)
      winCascade.clear()
    }
    const entry = undoStack[undoStack.length - 1]
    const { move, state: prevState } = entry
    startFlights(1)

    if (!move) {
      setUndoStack((stack) => stack.slice(0, -1))
      commitState(prevState)
      settleFlight() // nothing to fly, settles immediately
      return
    }

    const sourcePile = resolvePile(move.to, stateRef.current)
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(move.from, move.count)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen: dealTokenRef.current, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the
    // OTHER's commitState just did, not the same stale board both closures captured.
    const current = stateRef.current
    if (!current) return false
    const result = controllerRef.current.tryMove(current, { from, to, count })
    if (result) {
      if (!opts?.silent) pushUndo(current, { from, to, count, anchorCardId })
      commitState(result)
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      if (!opts?.silent && to.zone === 'foundation') cascade.armFromForwardMove()
      // No reveal check here - this game's tableau is dealt (and only ever receives) already
      // face-up cards (see rules.ts's own header comment), so there is no "reveal the newly-exposed
      // card" event to detect at all, unlike Klondike/Canfield/Yukon.
      return true
    }
    return false
  }

  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean; fast?: boolean; sweep?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    const flyingId = beginFlying(to, count)
    pendingFlightRef.current.push({ cardId: anchorCardId, fast: opts?.fast, sweep: opts?.sweep, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  // No Mechanism A fallback here (see rules.ts's own header comment on why this game only
  // reimplements the conservative "whole board provably clearable" mechanism B, draws-aware so it
  // can also reach through the stock) - a step only ever comes from
  // isFullyAutoCompletableWithDraws/nextAutoCompleteMoveWithDraws, never a continuous heuristic.
  function computeNextStep(s: FortyThievesState): AutoCompleteStep | null {
    if (!isFullyAutoCompletableWithDraws(controllerRef.current, s)) return null
    return nextAutoCompleteMoveWithDraws(controllerRef.current, s)
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to
  // measure the card's current position itself, which is the one place this feature has an await
  // gap before applying its move. Guard against something else changing state during that gap by
  // snapshotting stateRef before the await and bailing if it no longer matches after.
  async function firePlay(entry: AccessibleCard, to: PileRef, opts: { sweep: boolean }) {
    startFlights(1)
    const stateAtStart = stateRef.current
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart || undoBusyRef.current) {
      settleFlight()
      return
    }
    cascadeFeedback()
    const flight = ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    if (!completeMove(entry.ref, to, 1, entry.card.id, flight, { silent: true, fast: !opts.sweep, sweep: opts.sweep })) {
      flight.hide()
      settleFlight()
    }
  }

  // Only ever called by the win-completing sweep once a stock card is provably about to go straight
  // to its foundation (see engine/autoFoundation.ts's 'drawAndPlay' step) - draws AND plays it in
  // one committed state change, animated as one continuous flight straight from the stock pile,
  // skipping the ordinary "land on waste first" stop entirely (the confirmed sweep visual). Not a
  // player decision, so - matching applyMove's own silent branch - this never touches the undo
  // stack at all (this game excludes every silent move from undo, same as Canfield).
  async function fireDrawAndPlay(entry: AccessibleCard, to: PileRef, opts: { sweep: boolean }) {
    const current = stateRef.current
    if (!current || !controllerRef.current.drawStock) return
    const afterDraw = controllerRef.current.drawStock(current)
    if (!afterDraw) return
    const result = controllerRef.current.tryMove(afterDraw, { from: entry.ref, to, count: 1 })
    if (!result) return
    startFlights(1)

    const origin = await measureView(stockViewRef.current)
    if (!origin || stateRef.current !== current || undoBusyRef.current) {
      settleFlight()
      return
    }

    cascadeFeedback()
    const flight = ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying(to, 1)
    commitState(result)
    checkWin(result, session.moves)
    pendingFlightRef.current.push({ cardId: entry.card.id, gen: dealTokenRef.current, flyingId, flight, sweep: opts.sweep })
  }

  async function attemptDrop(from: PileRef, count: number, absoluteX: number, absoluteY: number, anchorCardId: string, flight: DragFlightHandle): Promise<boolean> {
    if (undoBusyRef.current) return false
    startFlights(1)
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target || undoBusyRef.current) {
      settleFlight()
      return false
    }
    if (!completeMove(from, target, count, anchorCardId, flight)) {
      settleFlight()
      return false
    }
    return true
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    if (!runMoves) return indexFromTop === 0 ? 1 : 0
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingSameSuit)
  }

  // `opts.sweep` marks this as an automatic step of the win-completing sweep (see the shared
  // cascade hook's own fireDraw callback above) rather than a genuine player tap - not a player
  // decision, so (matching applyMove's own silent branch) it never touches the undo stack at all,
  // and doesn't count toward moves/score.
  async function handleDrawStock(opts?: { sweep?: boolean }) {
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    const current = stateRef.current
    if (won || !current || !controllerRef.current.drawStock) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const result = controllerRef.current.drawStock(current)
    if (!result) return
    startFlights(1)
    if (!opts?.sweep) session.registerMove()

    const drawnCard = top(result.waste)!
    // Drawing an ace is meant to auto-play it immediately as a reward, regardless of whether this
    // is a genuine player tap or a sweep's own forced draw - see useAutoFoundationCascade's
    // armFromAceEvent. A sweep's own draws only ever reach this point via a plain 'draw' step (see
    // engine/autoFoundation.ts's AutoCompleteStep) - one where the newly drawn card DIDN'T come
    // back as immediately playable - so this can only ever matter for a genuine player tap in
    // practice, but it costs nothing to leave it unconditional rather than special-cased away.
    if (drawnCard.rank === 1) {
      // Never null for an ace: exactly 8 aces exist for exactly 8 slots, an ace can only ever
      // match findFoundationSlot's empty-pile branch (never a non-empty one - see its own logic),
      // and this one hasn't been placed anywhere yet, so at least one slot must still be open.
      const slot = findFoundationSlot(result.foundation, drawnCard)!
      cascade.armFromAceEvent({ ref: { zone: 'waste', index: 0 }, card: drawnCard }, { zone: 'foundation', index: slot })
    }
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      if (!opts?.sweep) pushUndo(current, move)
      commitState(result)
      settleFlight()
      return
    }

    if (opts?.sweep) cascadeFeedback()
    else {
      playCardSound()
      hapticCard()
    }
    const flight = ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying({ zone: 'waste', index: 0 }, 1)

    if (!opts?.sweep) pushUndo(current, move)
    commitState(result)
    pendingFlightRef.current.push({ cardId: drawnCard.id, sweep: opts?.sweep, gen: dealTokenRef.current, flyingId, flight })
  }

  // `s` defaults to the closure's own live `state` (every pre-existing call site) - handleUndo
  // passes an explicit state (stateRef.current) instead, since that call has an await gap before it
  // reads this and can't rely on whichever `state` its own closure happened to capture.
  function resolvePile(ref: PileRef, s: FortyThievesState | null = state): Card[] | null {
    if (!s) return null
    switch (ref.zone) {
      case 'tableau':
        return s.tableau[ref.index] ?? null
      case 'foundation':
        return s.foundation[ref.index] ?? null
      case 'waste':
        return s.waste
      default:
        return null
    }
  }

  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>, indexFromTop?: number) {
    if (!state || !controllerRef.current.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const move = controllerRef.current.autoMoveHint(state, ref, cardId)
    if (!move) {
      const count = ref.zone === 'tableau' && indexFromTop !== undefined ? Math.max(1, tableauRunCount(ref.index, indexFromTop)) : 1
      setShake({ cardId, count, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    startFlights(1)
    const origin = await measure()
    const sourcePile = resolvePile(move.from)
    if (!sourcePile || undoBusyRef.current) {
      settleFlight()
      return
    }
    const movingCards = sourcePile.slice(sourcePile.length - move.count)
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0

    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })

    if (!completeMove(move.from, move.to, move.count, cardId, flight)) {
      flight.hide()
      settleFlight()
    }
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  const wasteTop = top(state.waste)

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Forty Thieves' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<FortyThievesSettingsSection />} rules={FORTYTHIEVES_RULES}>
        {/* Portrait keeps topRow's own fixed 18pt gap between the foundations and the stock/waste pair (as it
        always had); only the wide layout swaps in the card gap, so the row lines up with the fitted (and
        gap-spread) tableau grid below it. */}
        <View style={[styles.topRow, isWide && { gap }]}>
          <View style={[styles.foundationsGroup, { gap }]}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              const isFlyingHere = flying.some((f) => f.to.zone === 'foundation' && f.to.index === i)
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={won ? undefined : t}
                    isFlyingHere={isFlyingHere}
                    suit={SUITS[i % 4]}
                    highlighted={hintCountFor(activeHint, { zone: 'foundation', index: i }) > 0}
                    slotRef={(el) => {
                      foundationSlotRefs.current[i] = el
                    }}
                  />
                </DropZone>
              )
            })}
          </View>

          <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteHiddenCount={flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0)} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} gap={gap} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y, flight) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, wasteTop!.id, flight)} stockRef={stockViewRef} />
        </View>

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              // Claims a flight slot (see activeFlightCountRef's doc comment above) purely so undo
              // sees this drop as in-flight for its whole duration, not just once completeMove
              // lands one - PileView.tsx (shared, not ours to edit) already ran its own hitTest
              // await before invoking this callback, so this is the earliest point this screen gets
              // a look-in. Rejects outright if undo is running (see attemptDrop's identical comment
              // on why undo holds full mutual exclusion, not just a one-way wait).
              onDrop: (to, count, anchorCardId, flight) => {
                if (undoBusyRef.current) return false
                startFlights(1)
                if (!completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId, flight)) {
                  settleFlight()
                  return false
                }
                return true
              }
            }
            const hiddenCount = flying.filter((f) => f.to.zone === 'tableau' && f.to.index === colIndex).reduce((sum, f) => sum + f.count, 0)
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                {/* dimUnplayable: the whole tableau is always face-up (like FreeCell/Canfield), so
                a face-up card that isn't currently the head of a movable run (every card but the
                true top, while runMoves is off) needs its own dimmed cue to read as temporarily
                stuck rather than pickable. */}
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}
