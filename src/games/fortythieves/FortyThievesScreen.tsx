// Forty Thieves solitaire screen: 8 foundations (dynamically assigned, 2 decks x 4 suits), 10
// tableau columns building down by suit, single-card stock/waste (draw-1, no recycle). Closest
// architecturally to Canfield/Klondike (same imperative checkWin-after-applyMove flow, same
// tap-to-move/drag/undo/auto-play shape), simplified by having no reserve pile and no cyclic
// wraparound - see rules.ts for the full rules and for why its own auto-play-to-foundation is a
// scoped reimplementation rather than a reuse of engine/autoFoundation.ts.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, cardWidthForRow, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'

import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PileDragConfig, PileView } from '@/components/PileView'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { FORTYTHIEVES_RULES } from '@/constants/gameRules'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { isDescendingSameSuit, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { buildFortyThievesDealSequence } from './dealSequence'
import { FortyThievesSettingsSection } from './FortyThievesSettingsSection'
import { createFortyThievesController, findFoundationSlot, FortyThievesState, isFullyAutoCompletable, nextAutoCompleteMove } from './rules'

const TABLEAU_COLUMNS = 10
const TABLEAU_GAP = 6
const TABLEAU_MIN_HEIGHT = 360
const NUM_FOUNDATIONS = 8
const TOP_ROW_GAP = 6

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 12
    },
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row',
      gap: TOP_ROW_GAP
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
      gap: TABLEAU_GAP,
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
  const [state, setState] = useState<FortyThievesState | null>(null)
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
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, TABLEAU_GAP)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck(controllerRef.current, 'fortythieves', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real top card has been hidden (won-gated, see the foundation row below). */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(NUM_FOUNDATIONS).fill(null))
  /** A flight awaiting its post-commit measurement + ghost.flyTo, shared by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), undo, and auto-play (fireAutoMove) -
   * only one is ever in flight at a time. `gen` is the dealTokenRef value at the moment this
   * flight was queued - see KlondikeScreen's identical field for the full race-guard reasoning. */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; fast?: boolean; gen: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  // Mirrors `state` synchronously so fireAutoMove - which has an await gap before it applies its
  // move, unlike every other mutator here - can tell if some other action already changed state
  // underneath it and bail instead of applying against a stale snapshot.
  const stateRef = useRef(state)
  stateRef.current = state
  const justUndidRef = useRef(false)
  const undoBusyRef = useRef(false)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    controllerRef.current = createFortyThievesController(settings.fortyThievesRunMoves)
    setRunMoves(settings.fortyThievesRunMoves)
    const s = controllerRef.current.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    setDealHiddenIds(new Set(s.tableau.flat().map((c) => c.id)))
    scheduleDeal(myToken)
    setState(s)
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
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setState(saved.state)
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
    const pending = pendingFlightRef.current
    if (!pending || !state) return
    pendingFlightRef.current = null
    ;(async () => {
      const landed = pending.viaStock ? await measureView(stockViewRef.current) : await ghost.cardRegistry.measure(pending.cardId)
      if (dealTokenRef.current !== pending.gen || !landed) {
        ghost.hide()
        setFlying(null)
        undoBusyRef.current = false
        return
      }
      ghost.flyTo(
        landed.x,
        landed.y,
        () => {
          setFlying(null)
          undoBusyRef.current = false
        },
        { fast: pending.fast }
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Drives the auto-complete-to-foundation cascade - see rules.ts's own header comment on why
  // this only ever fires once the whole remaining deal is provably clearable (no continuous
  // "safe" heuristic, unlike Klondike/FreeCell/Yukon/Canfield).
  useEffect(() => {
    if (!settings.autoMoveToFoundation || !state || flying !== null || dealHiddenIds.size > 0 || session.moves === 0) return
    if (justUndidRef.current) {
      justUndidRef.current = false
      return
    }
    maybeAutoPlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, flying, dealHiddenIds, session.moves, settings.autoMoveToFoundation])

  useEffect(() => {
    loadGameInProgress<FortyThievesState>('fortythieves').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('fortythieves')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (state && !won) saveGameInProgress('fortythieves', { state, undoStack, moves: session.moves, elapsedSeconds: session.elapsed, config: runMoves ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, runMoves, session.elapsed, undoStack])

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
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    justUndidRef.current = true
    if (won) {
      setWon(false)
      winCascade.clear()
    }
    const entry = undoStack[undoStack.length - 1]
    const { move, state: prevState } = entry
    if (!move) {
      setUndoStack((stack) => stack.slice(0, -1))
      setState(prevState)
      undoBusyRef.current = false
      return
    }

    const sourcePile = resolvePile(move.to)
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin) {
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: movingCards, offsetStep, cardWidth })
      setFlying({ to: move.from, count: move.count })
      setState(prevState)
      pendingFlightRef.current = { cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen: dealTokenRef.current }
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }
  }

  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    if (!state) return false
    const result = controllerRef.current.tryMove(state, { from, to, count })
    if (result) {
      if (!opts?.silent) pushUndo(state, { from, to, count, anchorCardId })
      setState(result)
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      return true
    }
    return false
  }

  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean; fast?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    setFlying({ to, count })
    pendingFlightRef.current = { cardId: anchorCardId, fast: opts?.fast, gen: dealTokenRef.current }
    return true
  }

  function maybeAutoPlay() {
    if (!state) return
    if (!isFullyAutoCompletable(controllerRef.current, state)) return
    const entry = nextAutoCompleteMove(controllerRef.current, state)
    if (entry) fireAutoMove(entry)
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to
  // measure the card's current position itself, which is the one place this feature has an await
  // gap before applying its move. Guard against something else changing state during that gap by
  // snapshotting stateRef before the await and bailing if it no longer matches after.
  async function fireAutoMove(entry: AccessibleCard) {
    const stateAtStart = stateRef.current
    if (!stateAtStart) return
    const slot = findFoundationSlot(stateAtStart.foundation, entry.card)
    if (slot === null) return
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart) return
    const to: PileRef = { zone: 'foundation', index: slot }
    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth })
    if (!completeMove(entry.ref, to, 1, entry.card.id, { silent: true, fast: true })) {
      ghost.hide()
    }
  }

  async function attemptDrop(from: PileRef, count: number, absoluteX: number, absoluteY: number, anchorCardId: string): Promise<boolean> {
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target) return false
    return completeMove(from, target, count, anchorCardId)
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    if (!runMoves) return indexFromTop === 0 ? 1 : 0
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingSameSuit)
  }

  async function handleDrawStock() {
    if (won || !state || !controllerRef.current.drawStock) return
    const result = controllerRef.current.drawStock(state)
    if (!result) return
    session.registerMove()

    const drawnCard = top(result.waste)!
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(state, move)
      setState(result)
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
    pendingFlightRef.current = { cardId: drawnCard.id, gen: dealTokenRef.current }
  }

  function resolvePile(ref: PileRef): Card[] | null {
    if (!state) return null
    switch (ref.zone) {
      case 'tableau':
        return state.tableau[ref.index] ?? null
      case 'foundation':
        return state.foundation[ref.index] ?? null
      case 'waste':
        return state.waste
      default:
        return null
    }
  }

  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>, indexFromTop?: number) {
    if (!state || !controllerRef.current.autoMoveHint) return
    const move = controllerRef.current.autoMoveHint(state, ref, cardId)
    if (!move) {
      const count = ref.zone === 'tableau' && indexFromTop !== undefined ? Math.max(1, tableauRunCount(ref.index, indexFromTop)) : 1
      setShake({ cardId, count, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    const origin = await measure()
    const sourcePile = resolvePile(move.from)
    if (!sourcePile) return
    const movingCards = sourcePile.slice(sourcePile.length - move.count)
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0

    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: movingCards, offsetStep, cardWidth })

    if (!completeMove(move.from, move.to, move.count, cardId)) {
      ghost.hide()
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
      <GameChrome title='Forty Thieves' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} hasProgress={session.moves > 0} elapsedSeconds={session.elapsed} movesCount={session.moves} settingsContent={<FortyThievesSettingsSection />} rules={FORTYTHIEVES_RULES}>
        <View style={styles.topRow}>
          <View style={styles.foundationsGroup}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              const isFlyingHere = !!flying && flying.to.zone === 'foundation' && flying.to.index === i
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

          <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteHiddenCount={flying && flying.to.zone === 'waste' ? flying.count : 0} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, wasteTop!.id)} stockRef={stockViewRef} />
        </View>

        <View style={styles.tableauRow}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              onDrop: (to, count, anchorCardId) => completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId)
            }
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
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
      {won && <WinBanner colors={colors} elapsedSeconds={session.elapsed} moves={session.moves} score={computeScore(session.moves, session.elapsed)} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}
