// TriPeaks solitaire screen: 3 peaks sharing one 10-wide base row, tap/drag single cards onto a
// Golf-style build pile, dealt from a real stock. Combines two things this app already has
// separately - Golf's move mechanic (single exposed card onto the one build pile, draw-1 no
// recycle, no suit foundation) and Pyramid's triangle-tap-to-select rendering shape (28
// individually-positioned board cells rather than PileView's linear columns) - but TriPeaks' own
// board is 3 separate peaks, not one uniform triangle, so its own card-position math (below) is
// derived fresh from rules.ts's childIndices adjacency rather than reusing Pyramid's cardPosition.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CARD_ASPECT, CardSizeProvider, cardWidthForRow, type TableColors } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'

import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PlayingCard } from '@/components/PlayingCard'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { TRIPEAKS_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { buildTriPeaksDealSequence } from './dealSequence'
import { cardAt, childIndices, createTriPeaksController, flatIndex, isExposed, ROW_WIDTHS, rowColOf, TriPeaksState } from './rules'
import { TriPeaksSettingsSection } from './TriPeaksSettingsSection'

// The base row (rules.ts's ROW_WIDTHS[3]) is the board's widest row and sets its overall width
// unit - same idea as Pyramid's own TRIANGLE_WIDTH_UNITS = ROWS.
const BASE_WIDTH = ROW_WIDTHS[3]
const COL_GAP = 6 // horizontal gap between cards within the base row - no overlap, so corner pips stay visible

function boardWidth(cardWidth: number): number {
  return cardWidth * BASE_WIDTH + COL_GAP * (BASE_WIDTH - 1)
}

function boardHeight(cardHeight: number): number {
  // 3 = the deepest row index (rows 0-3) - same cascading-rows idea as Pyramid's own triangle height.
  return 3 * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight
}

/**
 * One {left, top} position per flat tableau index (see rules.ts's flatIndex/rowColOf), relative to
 * the board container's own top-left corner. Computed bottom-up:
 *   - Row 3 (the base, 10 cards): fixed, non-overlapping slots spanning the full board width - same
 *     idea as Pyramid's own bottom row.
 *   - Rows 2, 1, 0: each card's horizontal center is the exact midpoint between its own two
 *     childIndices cards' centers (already computed one row down) - reusing rules.ts's childIndices
 *     directly (not a second, independently-derived copy of the same peak adjacency) guarantees
 *     every card visually sits centered on the two cards it actually rests on, which is what makes
 *     the 3-peak shape read correctly instead of collapsing into one flat triangle.
 * Vertical offset cascades the same way Pyramid's own cardPosition does (row * cardHeight *
 * FACE_UP_OFFSET_RATIO), so each row peeks out from under the row above it.
 */
function buildCardPositions(cardWidth: number, cardHeight: number): { left: number; top: number }[] {
  const positions: { left: number; top: number }[] = new Array(28)
  for (let col = 0; col < ROW_WIDTHS[3]; col++) {
    positions[flatIndex(3, col)] = { left: col * (cardWidth + COL_GAP), top: 3 * cardHeight * FACE_UP_OFFSET_RATIO }
  }
  for (let row = 2; row >= 0; row--) {
    for (let col = 0; col < ROW_WIDTHS[row]; col++) {
      const [a, b] = childIndices(row, col)!
      const center = (positions[a].left + positions[b].left) / 2 + cardWidth / 2
      positions[flatIndex(row, col)] = { left: center - cardWidth / 2, top: row * cardHeight * FACE_UP_OFFSET_RATIO }
    }
  }
  return positions
}

export default withGameProviders(TriPeaksScreenInner)

function TriPeaksScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // The rank-wrap rule the in-progress deal was actually dealt with - deliberately not re-derived
  // from `settings` every render, same reasoning SpiderScreen's own `numSuits` state has: a
  // mid-game settings change must never mutate the current deal's own rules. A useMemo (not a
  // useRef the way Klondike/Canfield's own draw-count settings use) - useDerivedWinCheck below
  // calls controller.isWon(state) synchronously during render, which react-hooks/refs correctly
  // flags for a ref-sourced controller but not for a memoized one, same as Spider's own identical
  // setup already proves lint-clean.
  const [tripeaksRankWrap, setTripeaksRankWrap] = useState(settings.tripeaksRankWrap)
  const controller = useMemo(() => createTriPeaksController(tripeaksRankWrap), [tripeaksRankWrap])
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, BASE_WIDTH, COL_GAP)
  const cardHeight = cardWidth / CARD_ASPECT
  const [state, setState] = useState<TriPeaksState | null>(null)
  // Every TriPeaks move (a tableau card onto the waste, or a stock draw) always has a real
  // origin/destination and a real card to fly - same reasoning as Golf's own non-nullable
  // UndoEntry<TState, MoveInfo> instantiation (unlike Klondike's/Pyramid's nullable default).
  const [undoStack, setUndoStack] = useState<UndoEntry<TriPeaksState, MoveInfo>[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: TriPeaksState; skip: number } | null>(null)
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
  const stockViewRef = useRef<View>(null)
  // Wraps the whole StockWaste component (not just its wasteArea child) - StockWaste's wasteArea is
  // its own first, unpadded/unmargined flex child, so this measures to the same top-left corner as
  // the waste slot itself (see Golf's own wasteViewRef doc comment). Used as the win cascade's single
  // chain origin, since the waste/build pile is TriPeaks' only "foundation-equivalent" pile, same as
  // Golf - the real waste top card is hidden once won (wasteTopCard below).
  const wasteViewRef = useRef<View>(null)
  // The 28-cell board container - tableau destinations resolve as pure math against this origin
  // (see buildCardPositions), not per-card CardRegistry measurement, since most of the 28 slots
  // start covered and therefore never register into CardRegistry at all (only exposed cards render
  // as DraggableCard - see the JSX below). Same reasoning Pyramid's own triangleViewRef/cardPosition
  // combination uses for its own deal, generalized here to 3 peaks instead of 1 uniform triangle.
  const peaksViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(controller, state, 'tripeaks', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** A flight awaiting its post-commit measurement + ghost.flyTo, shared by tap-to-move
   * (handleCardTap), a drag drop (handleDrop), drawing from the stock (handleDrawStock), and undo -
   * only one is ever in flight at a time. `viaStock` measures via stockViewRef (a plain View, not
   * per-card) instead of CardRegistry - only undoing a stock draw flies back toward the stock; every
   * other flight targets the waste (always CardRegistry-backed, via StockWaste's DraggableCard
   * wasteTop) or a tableau slot an undo is restoring a card into (always exposed once restored -
   * see handleUndo - so it's freshly CardRegistry-registered too). `gen` guards against a "New Game"
   * tapped mid-flight replacing the deal this flight was measuring against (card ids are
   * shuffle-independent and reused across deals - see engine/deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; gen: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - always exactly one card,
  // same as Golf (TriPeaks never drags/taps more than a single card at a time).
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  const undoBusyRef = useRef(false)

  // Takes the controller to deal with explicitly, rather than reading the outer `controller`
  // memo directly - `setTripeaksRankWrap` below only takes effect on the NEXT render, so a caller
  // whose own setting just changed (handleNewGame) must build and pass the new controller itself
  // instead of dealing with the current render's now-stale memoized one. Same shape Spider's own
  // startNewGame uses for its identical numSuits setting.
  function startNewGame(ctrl: ReturnType<typeof createTriPeaksController>) {
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

    const dealtIds = new Set([...s.tableau.filter((c): c is Card => !!c).map((c) => c.id), ...s.waste.map((c) => c.id)])
    setDealHiddenIds(dealtIds)
    scheduleDeal(myToken)
    setState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation. Also restores
  // the saved undo stack (falling back to empty for an older save written before undo persistence
  // existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<TriPeaksState, UndoEntry<TriPeaksState, MoveInfo>>) {
    ++dealTokenRef.current
    // config is persisted as 0/1 (see the save effect below) since SavedGame.config is a plain
    // number - narrowed back to a boolean here, falling back to the live setting only if missing.
    const wrap = saved.config === 1 || saved.config === 0 ? saved.config === 1 : settings.tripeaksRankWrap
    // Setting tripeaksRankWrap here is enough to bring `controller` (a useMemo keyed on it) back
    // in sync by the same render that commits `state` below - both setters run inside the same
    // batch, same reasoning SpiderScreen's own restoreGame documents for its identical numSuits
    // setting.
    setTripeaksRankWrap(wrap)
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setState(saved.state)
  }

  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned('tripeaks')
    setTripeaksRankWrap(settings.tripeaksRankWrap)
    startNewGame(createTriPeaksController(settings.tripeaksRankWrap))
  }

  // Deals from a real stock pile (stockViewRef), same as Golf/Klondike. The 28 tableau destinations
  // resolve as pure math (buildCardPositions against peaksViewRef's own origin) rather than
  // CardRegistry, since most start covered and never register at all - only the one starter card
  // (index === -1, destined for the waste) resolves via CardRegistry, exactly like Golf's own
  // starter: StockWaste renders wasteTop through DraggableCard, which registers on mount just like
  // any other draggable card. Same dealTokenRef guard as every other async measurement here.
  async function runDeal(s: TriPeaksState, token: number) {
    const starter = s.waste[0]
    const sequence = buildTriPeaksDealSequence(s.tableau, starter)
    const [stockOrigin, boardOrigin, starterDest] = await Promise.all([measureView(stockViewRef.current), measureView(peaksViewRef.current), ghost.cardRegistry.measure(starter.id)])
    if (dealTokenRef.current !== token) return
    if (!stockOrigin || !boardOrigin) {
      setDealHiddenIds(new Set())
      return
    }

    const positions = buildCardPositions(cardWidth, cardHeight)
    const entries: DealCardSpec[] = []
    sequence.forEach((step) => {
      if (step.index === -1) {
        if (!starterDest) {
          // Destination measurement failed - unhide the starter card right away instead of leaving
          // it stuck at opacity:0 for the rest of the hand (it never enters `entries`, so it would
          // otherwise never reach the onCardLanded callback that normally clears it from
          // dealHiddenIds). Mirrors this file's own top-level entries.length===0 fallback and
          // Pyramid's runDeal/undoRemoval fallback for the same failure mode (see this repo's
          // .claude/CLAUDE.md).
          setDealHiddenIds((ids) => {
            if (!ids.has(step.cardId)) return ids
            const next = new Set(ids)
            next.delete(step.cardId)
            return next
          })
          return
        }
        entries.push({ cardId: step.cardId, card: step.card, from: stockOrigin, to: starterDest, delayMs: step.visitOrder * DEAL_STAGGER_MS })
        return
      }
      const { row } = rowColOf(step.index)
      const { left, top: cardTop } = positions[step.index]
      // Rows 0-2 aren't genuinely exposed/face-up at deal time (they start covered under the rows
      // below them - see rules.ts) - fly those face-down, matching Klondike/Yukon's forced
      // face-down flight for a card whose real state isn't face-up-from-the-start. Row 3 (the base)
      // is exposed from the start, so it flies showing its real face.
      const card = row === 3 ? step.card : { ...step.card, faceUp: false }
      entries.push({ cardId: step.cardId, card, from: stockOrigin, to: { x: boardOrigin.x + left, y: boardOrigin.y + cardTop }, delayMs: step.visitOrder * DEAL_STAGGER_MS })
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

  // Win cascade: a single chain, every card that ever landed on the waste/build pile (the tableau's
  // whole 28 cards plus the starter, in the order they arrived), reversed so the most-recently-
  // placed (currently on top of the physical pile) leads the chain - same convention as Golf's own
  // waste cascade (TriPeaks has no suit-based foundation either). Origin is wasteViewRef rather than
  // a per-card CardRegistry lookup, since the real waste top card is hidden the instant `won` flips
  // true (wasteTopCard below) and therefore unregistered.
  async function runWinCascade(s: TriPeaksState, gen: number) {
    const origin = await measureView(wasteViewRef.current)
    if (dealTokenRef.current !== gen || !origin || s.waste.length === 0) return
    winCascade.startChains([{ cards: s.waste.slice().reverse(), origin, entranceDelayMs: 0 }], cardWidth)
  }

  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Same race documented in this repo's own CLAUDE.md: measuring CardRegistry/a view ref
  // synchronously right after the setState in applyMove/handleDrawStock/handleUndo would find stale
  // pre-commit state. Deferring to a [state]-keyed effect guarantees the destination has already
  // registered by the time this runs.
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
      ghost.flyTo(landed.x, landed.y, () => {
        setFlying(null)
        undoBusyRef.current = false
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes the
  // "last active game" for as long as it stays mounted, and stops being it the instant the player
  // actually backs out.
  useEffect(() => {
    loadGameInProgress<TriPeaksState, UndoEntry<TriPeaksState, MoveInfo>>('tripeaks').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame(controller)
      setLastActiveGame('tripeaks')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/fresh-deal (all flow through setState). Gated on !won so a
  // just-won deal doesn't get checkpointed as still in-progress. `session.elapsed` is also a
  // dependency, not just `state` - it ticks up once a second on its own timer (see
  // useGameSession.ts), independent of any move, so a save made at the last real move goes stale
  // the moment the player just sits looking at the board and then leaves; resuming would silently
  // roll the clock back to whatever it read at that last move instead of how long they actually
  // had the deal open.
  useEffect(() => {
    if (state && !won) saveGameInProgress('tripeaks', { state, undoStack, moves: session.moves, elapsedSeconds: session.elapsed, config: tripeaksRankWrap ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, tripeaksRankWrap, session.elapsed, undoStack])

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
    recordHintUsed('tripeaks')
  }

  function pushUndo(prev: TriPeaksState, move: MoveInfo) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // Mirrors handleCardTap's/handleDrop's/handleDrawStock's forward flight, just in reverse: the
  // card being undone is still sitting on top of the waste pile (every TriPeaks move's `to` is
  // always the waste), so measure that real position before reverting, then fly the ghost back to
  // `move.from` - a tableau slot (always exposed once restored, since its children were already
  // gone before it was ever moved out - see rules.ts's isExposed), or the stock pile for an undone
  // draw (see pendingFlightRef's `viaStock`).
  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    if (won) winCascade.clear()
    const entry = undoStack[undoStack.length - 1]
    const { move, state: prevState } = entry

    const movingCard = top(state.waste)
    const origin = movingCard && movingCard.id === move.anchorCardId ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin && movingCard) {
      // react-hooks/immutability misfires here - see Golf's/Pyramid's own identical disables and
      // their doc comments: originX/originY/dx/dy are Reanimated SharedValues useDragGhost()
      // deliberately exposes as public mutable fields, not opaque hook-owned state.
      /* eslint-disable-next-line react-hooks/immutability */
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth })
      setFlying({ to: move.from, count: 1 })
      setState(prevState)
      pendingFlightRef.current = { cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen: dealTokenRef.current }
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }
  }

  function applyMove(from: PileRef, to: PileRef, anchorCardId: string): boolean {
    if (!state) return false
    const result = controller.tryMove(state, { from, to, count: 1 })
    if (!result) return false
    pushUndo(state, { from, to, count: 1, anchorCardId })
    setState(result)
    session.registerMove()
    return true
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual drag's
  // drop) - applies the move, then marks the waste pile "incoming" and stashes the anchor card id
  // for the pendingFlightRef effect above to measure and fly the ghost onto.
  function completeMove(from: PileRef, to: PileRef, anchorCardId: string): boolean {
    if (!applyMove(from, to, anchorCardId)) return false
    setFlying({ to, count: 1 })
    pendingFlightRef.current = { cardId: anchorCardId, gen: dealTokenRef.current }
    return true
  }

  async function handleDrawStock() {
    if (won || !state) return
    const result = controller.drawStock!(state)
    if (!result) return
    session.registerMove()

    // drawStock never returns a result with an unchanged waste - TriPeaks has no recycle case (see
    // rules.ts), so a successful draw always means a real drawn card.
    const drawnCard = top(result.waste)!
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(state, move)
      setState(result)
      return
    }

    /* eslint-disable-next-line react-hooks/immutability */
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

  // Tapping an exposed tableau card sends it to the waste pile if legal - TriPeaks has exactly one
  // possible destination (autoMoveHint either finds that one move or returns null), same as Golf.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    const move = controller.autoMoveHint(state, ref, cardId)
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather than
      // a dead press. Deliberately never calls measure() - this branch has no use for the tapped
      // card's position (see PileView.tsx's onPress doc comment).
      setShake({ cardId, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    const card = cardAt(state, ref)
    if (!card) return
    const origin = await measure()

    /* eslint-disable-next-line react-hooks/immutability */
    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: [card], offsetStep: 0, cardWidth })

    if (!completeMove(move.from, move.to, cardId)) {
      ghost.hide()
    }
  }

  // Drag-completed move: DraggableCard's own pan gesture already showed the ghost at drag start, so
  // this only needs to hit-test the release point (the waste is the only registered drop target a
  // tableau card could ever legally land on) and hand off to the same completeMove tail as a tap.
  async function handleDrop(from: PileRef, absoluteX: number, absoluteY: number): Promise<boolean> {
    if (!state) return false
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target) return false
    const card = cardAt(state, from)
    if (!card) return false
    return completeMove(from, target, card.id)
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  const width = boardWidth(cardWidth)
  const height = boardHeight(cardHeight)
  const positions = buildCardPositions(cardWidth, cardHeight)
  const wasteTopCard = won ? undefined : top(state.waste)
  const wasteHiddenByDeal = wasteTopCard && dealHiddenIds.has(wasteTopCard.id) ? 1 : 0
  const wasteHiddenByFlight = flying && flying.to.zone === 'waste' ? flying.count : 0
  const wasteHiddenCount = Math.max(wasteHiddenByDeal, wasteHiddenByFlight)

  // A tableau slot's card is hidden while its own deal ghost hasn't landed yet, or while an undo's
  // ghost is mid-flight restoring it here - both conditions the same shape Golf/Pyramid already use
  // (dealHiddenIds, and `flying` pointed at this exact destination). Only ever one card at a time
  // (TriPeaks moves are always single-card), so a plain per-slot boolean is enough - no separate
  // hidden-ids set is needed the way Pyramid's pyramidHiddenIds tracks a King/pair's fan-out.
  function isTableauHidden(cardId: string, index: number): boolean {
    if (dealHiddenIds.has(cardId)) return true
    return !!flying && flying.to.zone === 'tableau' && flying.to.index === index
  }

  return (
    <CardSizeProvider width={cardWidth}>
      {/* react-hooks/immutability flags onUndo={handleUndo} as "may indirectly mutate ghost after
      render" - handleUndo does assign ghost.originX/Y.value etc, the intended, correct Reanimated
      SharedValue API (see handleUndo's own doc comment above). Same false-positive class as the
      disables inside handleUndo/handleDrawStock/handleCardTap above. */}
      {/* eslint-disable-next-line react-hooks/immutability */}
      <GameChrome title='TriPeaks' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} hasProgress={session.moves > 0} elapsedSeconds={session.elapsed} movesCount={session.moves} settingsContent={<TriPeaksSettingsSection />} rules={TRIPEAKS_RULES}>
        <View style={styles.board}>
          <View ref={wasteViewRef} collapsable={false} style={styles.controlRow}>
            <StockWaste
              dropZones={dropZones}
              stockTopCard={top(state.stock)}
              wasteTop={wasteTopCard}
              wasteHiddenCount={wasteHiddenCount}
              wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0}
              stockHinted={activeHint?.kind === 'drawStock'}
              cardWidth={cardWidth}
              // Same react-hooks/immutability false positive as onUndo above - handleDrawStock also
              // assigns ghost.originX/Y.value etc.
              // eslint-disable-next-line react-hooks/immutability
              onDrawStock={handleDrawStock}
              // The waste top card is never draggable or tappable on its own in TriPeaks - it's a
              // passive drop target for exposed tableau cards only, never a move source itself (same
              // reasoning Golf's own StockWaste usage documents).
              onWastePress={() => {}}
              onWasteDrop={() => false}
              stockRef={stockViewRef}
              // Undoing a stock draw flies a ghost back from the waste toward the stock slot (see
              // handleUndo's `viaStock` branch) - freeze the stock slot's prior look (the
              // empty/recycle-hint placeholder, if the stock was empty) until that ghost actually
              // lands, instead of letting the real face-down card pop in a beat early. Mirrors how
              // wasteHiddenCount above is derived from this same `flying` state.
              stockHidden={flying?.to.zone === 'stock'}
            />
          </View>

          <View ref={peaksViewRef} collapsable={false} style={[styles.peaks, { width, height }]}>
            {state.tableau.map((card, index) => {
              if (!card) return null
              const { row, col } = rowColOf(index)
              const { left, top: cardTop } = positions[index]
              const exposed = isExposed(state.tableau, row, col)
              const hidden = isTableauHidden(card.id, index)
              const pileRef: PileRef = { zone: 'tableau', index }
              const cardStyle = [styles.tableauCard, { left, top: cardTop, zIndex: row }]

              if (!exposed) {
                // Genuinely covered, not just "not yet playable" - rendered face-down and
                // non-interactive, never CardRegistry-registered, same as Pyramid's own DiscardCell
                // template for a plain non-draggable pile display (see this file's own header
                // comment). Unlike Pyramid's covered pyramid cells (already face-up in real life,
                // just dimmed), TriPeaks' covered cards are literal face-down cards nobody has
                // uncovered yet - rules.ts keeps `faceUp: true` on the stored card for game-logic
                // purposes only, so the override here is purely visual.
                return <PlayingCard key={card.id} card={{ ...card, faceUp: false }} disabled style={[cardStyle, hidden && styles.hiddenCard]} testID={`tripeaks-${index}`} />
              }

              return (
                <DropZone key={card.id} registry={dropZones} pileRef={pileRef} style={cardStyle}>
                  <DraggableCard card={card} hidden={hidden} hinted={hintCountFor(activeHint, pileRef) > 0} onPress={(measure) => handleCardTap(pileRef, card.id, measure)} onDrop={(x, y) => handleDrop(pileRef, x, y)} shakeToken={shake?.cardId === card.id ? shake.token : undefined} testID={`tripeaks-${index}`} />
                </DropZone>
              )
            })}
          </View>
        </View>
      </GameChrome>
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.elapsed} moves={session.moves} score={computeScore(session.moves, session.elapsed)} onNewGame={handleNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    board: {
      alignItems: 'center'
    },
    container: {
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 12
    },
    controlRow: {
      // Right-aligned to the peaks' own right edge below, matching where every other game's stock
      // pile lands (Klondike/Spider/Canfield's right edge, Golf's right-aligned topRow, Pyramid's
      // matching controlRow) - this used to sit centered below the peaks instead. Now first in
      // the board (see the JSX above), so the gap is a marginBottom, not marginTop.
      alignSelf: 'flex-end',
      marginBottom: 20
    },
    hiddenCard: {
      opacity: 0
    },
    loadingText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      marginTop: 40,
      textAlign: 'center'
    },
    // zIndex below only stays scoped to this container if the container itself establishes a
    // stacking context - position:relative alone doesn't, without its own zIndex (see PileView's/
    // Pyramid's identical fix). Without this, a card's per-row zIndex leaks out to compete with the
    // screen-level drag/deal ghost overlays.
    peaks: {
      position: 'relative',
      zIndex: 0
    },
    tableauCard: {
      position: 'absolute'
    }
  })
}
