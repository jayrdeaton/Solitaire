// Golf solitaire screen: a 7-column all-face-up tableau + a single build-pile waste, dealt from a
// real stock. Architecturally the simplest game screen in this app - every move is exactly one
// card, always onto the same fixed destination (the waste/build pile), there's no suit-based
// foundation at all (so no engine/autoFoundation.ts cascade), and there's no multi-card run drag.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, cardWidthForRow, type TableColors } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { GOLF_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { buildGolfDealSequence } from './dealSequence'
import { GolfSettingsSection } from './GolfSettingsSection'
import { createGolfController, GolfState } from './rules'

const TABLEAU_COLUMNS = 7
const TABLEAU_GAP = 10
// Every column starts at (and never exceeds) 5 cards, all dealt face up - Golf's tableau only ever
// shrinks as cards leave for the waste pile, unlike Klondike/FreeCell/Spider, whose columns can grow
// well past their dealt depth during play. At cardWidthForRow's own max (96px), 5 face-up cards
// fanned at FACE_UP_OFFSET_RATIO (0.26 of card height, ~139.5px at that width) total 4*36.27 +
// 139.5 ≈ 285px - 300 leaves comfortable headroom so PileView's own compression never kicks in at
// any real card size, the same "round number safely above the true worst case" choice
// Klondike/FreeCell made for their own much taller columns. Now a floor for useTableauMaxHeight
// below rather than a fixed height - compression already never fired at this size, so this floor
// is mostly moot in practice, but keeps the guarantee explicit rather than implicit.
const TABLEAU_MIN_HEIGHT = 300

export default withGameProviders(GolfScreenInner)

function GolfScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // The rank-wrap rule the in-progress deal was actually dealt with - deliberately not re-derived
  // from `settings` every render, same reasoning SpiderScreen's own `numSuits` state has: a
  // mid-game settings change must never mutate the current deal's own rules. A useMemo (not a
  // useRef the way Klondike/Canfield's own draw-count settings use) - useDerivedWinCheck below
  // calls controller.isWon(state) synchronously during render, which react-hooks/refs correctly
  // flags for a ref-sourced controller (a genuine "invoked during render" case, not a false
  // positive) but not for a memoized one, same as Spider's own identical setup already proves
  // lint-clean.
  const [golfRankWrap, setGolfRankWrap] = useState(settings.golfRankWrap)
  const controller = useMemo(() => createGolfController(golfRankWrap), [golfRankWrap])
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, TABLEAU_GAP)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const [state, setState] = useState<GolfState | null>(null)
  // Unlike Klondike (whose stock-draw undo entries carry move: null for a recycle - "nothing card-
  // shaped to fly") and Pyramid (same null convention for its pairing moves, which use a totally
  // different removedCards field instead of MoveInfo), every Golf move - a tableau card onto the
  // waste pile, or a stock draw - always has a real origin/destination and a real card to fly.
  // GolfController.drawStock returns null outright when the stock is empty (nothing applied, no
  // undo entry pushed at all) rather than a "successful but nothing moved" recycle result, so no
  // move shape here ever needs move: null. Mirrors FreeCell's/Yukon's own non-nullable
  // UndoEntry<TState, MoveInfo> instantiation instead of Klondike's/Pyramid's nullable default.
  const [undoStack, setUndoStack] = useState<UndoEntry<GolfState, MoveInfo>[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: GolfState; skip: number } | null>(null)
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
  // components/StockWaste.tsx is used unmodified and exposes no ref for the waste zone specifically
  // (only stockRef, for the deal's stock-side origin below) - but wasteArea is StockWaste's own
  // first, unpadded/unmargined flex child within its row layout, so wrapping the whole component in
  // a plain view measures to the same top-left corner as the waste slot itself. Used as the win
  // cascade's single chain origin (see runWinCascade) - the real waste top card is hidden once won
  // (wasteTopCard below), same as every other game's own foundation/discard pile during its cascade.
  const wasteViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Derived from `state` every render (see useDerivedWinCheck) rather than mirrored into its own
  // useState, same as Pyramid/Spider (not Klondike/FreeCell's useFoundationWinCheck) - Golf has no
  // suit-based foundation for a "won" flag to hang off, just "every tableau column is empty".
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(controller, state, 'golf', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** A flight awaiting its post-commit measurement + ghost.flyTo, shared by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), and undo - only one is ever in
   * flight at a time. `viaStock` measures via stockViewRef (a plain View, not per-card) instead of
   * CardRegistry - only undoing a stock draw flies back toward the stock; a tableau-bound undo
   * flies back to a real per-card-registered pile. `gen` guards against a "New Game" tapped mid-
   * flight replacing the deal this flight was measuring against (card ids are shuffle-independent
   * and reused across deals - see engine/deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; gen: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. Always exactly one card (Golf never drags/taps a run - every move is a
  // single card), unlike Klondike's own shake, which can cover a whole run.
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  // Guards handleUndo against being re-entered before its own previous invocation has fully settled
  // (visually, not just in state) - see handleUndo below for why an overlapping call would otherwise
  // desync the undo stack or clobber the shared single-flight ghost.
  const undoBusyRef = useRef(false)

  // Takes the controller to deal with explicitly, rather than reading the outer `controller`
  // memo directly - `setGolfRankWrap` below only takes effect on the NEXT render, so a caller
  // whose own setting just changed (handleNewGame) must build and pass the new controller itself
  // instead of dealing with the current render's now-stale memoized one. Same shape Spider's own
  // startNewGame uses for its identical numSuits setting.
  function startNewGame(ctrl: ReturnType<typeof createGolfController>) {
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

    // The starter card's id rides along in the same hidden-until-landed set as every tableau card -
    // harmless for PileView's own hiddenCardIds check (it never appears in a tableau column), and
    // lets wasteHiddenCount below (computed from this same set) reuse one mechanism for both.
    const dealtIds = new Set([...s.tableau.flat().map((c) => c.id), ...s.waste.map((c) => c.id)])
    setDealHiddenIds(dealtIds)
    scheduleDeal(myToken)
    setState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<GolfState, UndoEntry<GolfState, MoveInfo>>) {
    ++dealTokenRef.current
    // config is persisted as 0/1 (see the save effect below) since SavedGame.config is a plain
    // number - narrowed back to a boolean here, falling back to the live setting only if missing.
    const wrap = saved.config === 1 || saved.config === 0 ? saved.config === 1 : settings.golfRankWrap
    // Setting golfRankWrap here is enough to bring `controller` (a useMemo keyed on it) back in
    // sync by the same render that commits `state` below - both setters run inside the same batch,
    // same reasoning SpiderScreen's own restoreGame documents for its identical numSuits setting.
    setGolfRankWrap(wrap)
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome only
  // ever calls this after the player has confirmed that, or immediately when there's nothing to lose
  // (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned('golf')
    setGolfRankWrap(settings.golfRankWrap)
    startNewGame(createGolfController(settings.golfRankWrap))
  }

  // Golf has no placeholder-deck trick (unlike FreeCell/Yukon) - it deals from a real stock pile,
  // so stockViewRef works exactly like Klondike's own stockViewRef. The one destination that isn't
  // a tableau column (buildGolfDealSequence's colIndex === -1 step, the starter card headed for the
  // waste pile) still resolves through the same ghost.cardRegistry.measure() call as every tableau
  // destination: StockWaste renders its wasteTop card via DraggableCard (see StockWaste.tsx), which
  // registers into this same shared CardRegistry on mount exactly like a tableau card does - so
  // there's no need for a dedicated view ref the way Pyramid's discard pile needed one (that one's a
  // plain, non-draggable PlayingCard, never CardRegistry-registered). Flies face-up throughout
  // (unlike Klondike's forced face-down flight) - every Golf card, tableau or starter, is genuinely
  // dealt face up (see rules.ts), matching how FreeCell's own face-up deal leaves step.card as-is.
  // Same dealTokenRef guard as every other async measurement here, for the same "New Game tapped
  // mid-measurement" reason.
  async function runDeal(s: GolfState, token: number) {
    const starter = s.waste[0]
    const sequence = buildGolfDealSequence(s.tableau, starter)
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
      entries.push({
        cardId: step.cardId,
        card: step.card,
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

  // Win cascade: a single chain, every card that ever landed on the waste/build pile (the tableau's
  // whole 35 cards plus the starter, in the order they arrived - the only "foundation-equivalent"
  // pile Golf has), reversed so the most-recently-placed (currently on top of the physical pile)
  // leads the chain, same convention as Pyramid's discard-pile cascade. Origin is wasteViewRef (see
  // its own doc comment above) rather than a per-card CardRegistry lookup, since the real waste top
  // card is hidden the instant `won` flips true (wasteTopCard below) and therefore unregistered.
  // Same dealTokenRef guard as every other async measurement here.
  async function runWinCascade(s: GolfState, gen: number) {
    const origin = await measureView(wasteViewRef.current)
    if (dealTokenRef.current !== gen || !origin || s.waste.length === 0) return
    winCascade.startChains([{ cards: s.waste.slice().reverse(), origin, entranceDelayMs: 0 }], cardWidth)
  }

  // Same race as the deal effect above: measuring CardRegistry/a view ref synchronously inside
  // checkWin itself would find state from before the winning move's own registration effects have
  // run. Deferring to a [state]-keyed effect guarantees everything has already committed.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Same race documented in this repo's own CLAUDE.md: measuring CardRegistry synchronously right
  // after the setState in applyMove/handleDrawStock would find the still-mounted SOURCE card (the
  // destination card's own registration effect hasn't run yet), so the ghost would "fly" a near-zero
  // distance back to roughly where it started - indistinguishable from a snap. Deferring to a
  // [state]-keyed effect guarantees the destination card has already registered by the time this
  // runs.
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
  // "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it the
  // instant the player actually backs out.
  useEffect(() => {
    loadGameInProgress<GolfState, UndoEntry<GolfState, MoveInfo>>('golf').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame(controller)
      setLastActiveGame('golf')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/fresh-deal (all flow through setState). Gated on !won so a just-won
  // deal doesn't get checkpointed as still in-progress - since `won` is derived fresh from `state`
  // on every render, undoing back out of a won position re-enables saving again on that same render.
  // `session.elapsed` is also a dependency, not just `state` - it ticks up once a second on its own
  // timer (see useGameSession.ts), independent of any move, so a save made at the last real move
  // goes stale the moment the player just sits looking at the board and then leaves; resuming would
  // silently roll the clock back to whatever it read at that last move instead of how long they
  // actually had the deal open.
  useEffect(() => {
    if (state && !won) saveGameInProgress('golf', { state, undoStack, moves: session.moves, elapsedSeconds: session.elapsed, config: golfRankWrap ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, golfRankWrap, session.elapsed, undoStack])

  function pushUndo(prev: GolfState, move: MoveInfo) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
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
    recordHintUsed('golf')
  }

  // Mirrors handleCardTap's/handleDrawStock's forward flight, just in reverse: the card being
  // undone is still sitting on top of the waste pile (every Golf move's `to` is always the waste -
  // see MoveInfo above) - measure that real position before reverting (the pendingFlightRef effect
  // above can only measure a DESTINATION once it's committed and re-rendered, so the ORIGIN has to
  // be captured here, synchronously against the still-current state), then revert and fly the ghost
  // back to `move.from` - a tableau column, or the stock pile for an undone draw (see
  // pendingFlightRef's `viaStock`).
  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    // Undo only ever moves backward into an earlier, necessarily-not-won state (won is a terminal
    // condition), so any undo reachable while won must be undoing the winning move itself - stop the
    // bouncing win cascade immediately instead of leaving it animating over a board that's already
    // reverted underneath it. `won` (derived from state above) clears itself on the very next render
    // once prevState commits below.
    if (won) winCascade.clear()
    const entry = undoStack[undoStack.length - 1]
    const { move, state: prevState } = entry

    const movingCard = top(state.waste)
    // While won, the winning card's DraggableCard is deliberately unmounted (see wasteTopCard
    // below), so it has no CardRegistry entry - measure the waste slot's plain view ref instead
    // (the same technique runWinCascade above already uses for this exact reason), rather than a
    // per-card CardRegistry lookup that would silently return null and skip the flight.
    const origin = movingCard && movingCard.id === move.anchorCardId ? (won ? await measureView(wasteViewRef.current) : await ghost.cardRegistry.measure(move.anchorCardId)) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin && movingCard) {
      // react-hooks/immutability misfires here: originX/originY/dx/dy are Reanimated SharedValues
      // (see DragGhostController's own interface doc comment - "settable directly from a gesture
      // worklet with no JS hop") that useDragGhost() deliberately exposes as public mutable fields,
      // not opaque hook-owned state - assigning `.value` is the correct, intended Reanimated API,
      // not a React-purity violation. Klondike/Pyramid/Spider/FreeCell all mutate these same fields
      // the same way and lint clean; this file alone doesn't, for reasons that trace back to
      // whole-component static analysis quirks in this specific rule rather than anything about this
      // call site - confirmed directly: an unmodified copy of KlondikeScreen.tsx/PyramidScreen.tsx
      // relocated into this same directory stays lint-clean, while even a 10-line file containing
      // nothing but useDragGhost() plus one JSX-reachable `ghost.originX.value = ...` assignment
      // reproduces this exact warning in isolation. Same root cause (a known false-positive class
      // for this rule on Reanimated SharedValues reached through a custom hook) DraggableCard.tsx/
      // PileView.tsx/DragGhostLayer.tsx already document and disable for their own worklet-closure
      // mutations of this same `ghost` object - see those files for the fuller writeup, including
      // the config flag (enableCustomTypeDefinitionForReanimated) that was tried there and confirmed
      // not to help.
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
  // for the pendingFlightRef effect above to measure and fly the ghost onto, instead of it just
  // appearing there instantly.
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

    // drawStock never returns a result with an unchanged waste - Golf has no recycle case (see
    // rules.ts), so a successful draw always means a real drawn card.
    const drawnCard = top(result.waste)!
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(state, move)
      setState(result)
      return
    }

    // See handleUndo's identical block above for why react-hooks/immutability is disabled here -
    // this is the same safe SharedValue.value assignment, on the same `ghost`.
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

  // Tapping a tableau column's top card sends it to the waste pile if legal - Golf has exactly one
  // possible destination (autoMoveHint either finds that one move or returns null), so unlike
  // Klondike/Yukon's own tap-to-move there's no "best of several destinations" ranking here at all.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    const move = controller.autoMoveHint(state, ref, cardId)
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather than
      // a dead press, with a short haptic tap alongside. Deliberately never calls measure() - this
      // branch has no use for the tapped card's position (see PileView.tsx's onPress doc comment).
      setShake({ cardId, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    const card = ref.zone === 'tableau' ? top(state.tableau[ref.index]) : undefined
    if (!card) return
    const origin = await measure()

    // See handleUndo's identical block above for why react-hooks/immutability is disabled here -
    // this is the same safe SharedValue.value assignment, on the same `ghost`.
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

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  const wasteTopCard = won ? undefined : top(state.waste)
  // Combines two independent reasons the waste top slot might need to stay visually covered by a
  // ghost a beat longer than the real state already shows: the initial deal's starter card (still in
  // dealHiddenIds until its own deal ghost lands - see startNewGame) and an ordinary post-deal flight
  // landing there (a tableau tap/drag move, or a stock draw). The two never overlap in practice (the
  // deal finishes before any real move can happen), but Math.max reads correctly either way.
  const wasteHiddenByDeal = wasteTopCard && dealHiddenIds.has(wasteTopCard.id) ? 1 : 0
  const wasteHiddenByFlight = flying && flying.to.zone === 'waste' ? flying.count : 0
  const wasteHiddenCount = Math.max(wasteHiddenByDeal, wasteHiddenByFlight)

  return (
    <CardSizeProvider width={cardWidth}>
      {/* react-hooks/immutability flags onUndo={handleUndo} as "may indirectly mutate ghost after
      render" - handleUndo does assign ghost.originX/Y.value etc, which is the intended, correct
      Reanimated SharedValue API (see handleUndo's own doc comment above). Same false-positive class
      as the disables inside handleUndo/handleDrawStock/handleCardTap above. */}
      {/* eslint-disable-next-line react-hooks/immutability */}
      <GameChrome title='Golf' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} hasProgress={session.moves > 0} elapsedSeconds={session.elapsed} movesCount={session.moves} settingsContent={<GolfSettingsSection />} rules={GOLF_RULES}>
        {/* No foundation row at all (unlike Klondike/FreeCell/Yukon) - Golf has no suit-based
        foundation, just the stock/waste pair. Narrower than the tableau below, so it's centered
        above it by GameChrome's own content styling rather than stretched/pinned to an edge. */}
        <View ref={wasteViewRef} collapsable={false} style={styles.topRow}>
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
            // The waste top card is never draggable or tappable on its own in Golf - it's a passive
            // drop target for the tableau's top cards, never a move source. onWastePress/onWasteDrop
            // are required props on StockWaste (no optional variant exists - confirmed from its own
            // prop types), so these are genuine no-ops rather than omitted: a tap does nothing, and a
            // "drop" of the waste-top card onto itself always fails, snapping any accidental pick-up
            // right back into place instead of ever applying a move.
            onWastePress={() => {}}
            onWasteDrop={() => false}
            stockRef={stockViewRef}
          />
        </View>

        <View style={styles.tableauRow}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              // Golf never drags a run - only a column's true top card (indexFromTop === 0) can ever
              // move, one card at a time. Deliberately not engine/pile.ts's runCountFrom, which is
              // for multi-card-run games (Klondike/FreeCell/Spider) - Golf needs none of that.
              getRunCount: (indexFromTop) => (indexFromTop === 0 ? 1 : 0),
              // PileView's own handleDragEnd already resolves the drop target via dropZones.hitTest
              // before calling this, so - unlike StockWaste's loose DraggableCard onDrop above - no
              // separate hitTest wrapper is needed here.
              onDrop: (to, _count, anchorCardId) => completeMove({ zone: 'tableau', index: colIndex }, to, anchorCardId)
            }
            // Only ever true during an undo flying a card back into this column - a forward Golf
            // move's destination is always the waste pile, never a tableau column.
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                {/* dimUnplayable: Golf has no multi-card runs at all - getRunCount below is
                unconditionally 1 for the true top card and 0 for everything else, so every buried
                card in a column is permanently unplayable, not just sometimes-stuck like
                FreeCell/Spider's suit/color-broken runs. Still the same "face-up but not a legal
                move source" cue those need. */}
                <PileView cards={col} onPressCard={(card, _indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable} shakeCardId={shake?.cardId} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
      (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
      banner comes last of all three so it's the one thing guaranteed to sit on top of the animation,
      not buried under it. */}
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.elapsed} moves={session.moves} score={computeScore(session.moves, session.elapsed)} onNewGame={handleNewGame} />}
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
      gap: TABLEAU_GAP,
      paddingBottom: 20
    },
    topRow: {
      // Right-aligned to land on the tableau's own right edge below - Klondike/Spider/Canfield
      // all put their stock pile at that same right edge, and Golf's own waste+stock pair (with
      // no foundations to balance against on the left, unlike Klondike) previously just centered
      // under the tableau instead of matching them.
      alignSelf: 'flex-end',
      flexDirection: 'row',
      marginBottom: 16
    }
  })
}
