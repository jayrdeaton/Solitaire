// Forty Thieves solitaire screen: 8 foundations (dynamically assigned, 2 decks x 4 suits), 10
// tableau columns building down by suit, single-card stock/waste (draw-1, no recycle). Closest
// architecturally to Canfield/Klondike (same imperative checkWin-after-applyMove flow, same
// tap-to-move/drag/undo/auto-play shape), simplified by having no reserve pile and no cyclic
// wraparound - see rules.ts for the full rules and for why its own auto-play-to-foundation is a
// scoped reimplementation rather than a reuse of engine/autoFoundation.ts.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { HintRequest } from '@/components/autoHint'
import { cardLayoutForRow, SPLIT_TOP_ROW_MIN_GAP, splitTopRowGroupGap } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { dealStaggerMs, paceFaceUpDeal } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { PileDragConfig, PileView } from '@/components/PileView'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { FORTYTHIEVES_RULES } from '@/constants/gameRules'
import { AutoCompleteStep } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { parFor } from '@/engine/par'
import { isDescendingSameSuit, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { fortyThievesVariant } from '@/engine/variants'
import { useCascadeFeedback } from '@/games/shared/cascadeFeedback'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { LossBanner } from '@/games/shared/LossBanner'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useAutoFinish } from '@/games/shared/useAutoFinish'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDimAfterDeal } from '@/games/shared/useDimAfterDeal'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
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

import { buildFortyThievesDealSequence } from './dealSequence'
import { FortyThievesSettingsSection } from './FortyThievesSettingsSection'
import { canAutoFinish, createFortyThievesController, FortyThievesState, isFullyAutoCompletableWithDraws, nextAutoCompleteMoveWithDraws, nextFinishMove } from './rules'

const TABLEAU_COLUMNS = 10
const NUM_FOUNDATIONS = 8
const WASTE: PileRef = { zone: 'waste', index: 0 }

function makeStyles() {
  return StyleSheet.create({
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row'
    },
    tableauColumn: {},
    tableauRow: {
      flexDirection: 'row',
      paddingBottom: 20
    },
    topRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      justifyContent: 'space-between',
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
  // The deal's game under the rule it was dealt with: what its stats and par are kept for (engine/variants.ts).
  const variant = fortyThievesVariant(runMoves)
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with
  // each other - PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`,
  // `commitState`, `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working
  // unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, isLanding, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<FortyThievesState>()
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<FortyThievesState>>()
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
  const { contentWidth } = useGameLayout()
  // The tableau's gap floor is doubled so the top row can squeeze its foundations and its waste/stock pair to half of it
  // and pool the rest between the two groups - see SPLIT_TOP_ROW_MIN_GAP.
  // Sized by the width alone, in both layouts: in the wide layout a column too long for the ~400pt of height scrolls
  // rather than shrinking every card to fit it (Jay, 2026-10-14: big cards in landscape, and scroll a bit sometimes).
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, SPLIT_TOP_ROW_MIN_GAP)
  const topRowGroupGap = splitTopRowGroupGap(gap)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth)
  const ghost = useDragGhost()
  const playHintGlide = useHintGlide(state, ghost.cardRegistry, dropZones)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  // The waste slot itself (StockWaste's wasteRef) - exactly card-sized, and where the top card sits.
  const wasteViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  // Nothing is dimmed while the deal is in the air; the whole board dims at once when it has landed (see useDimAfterDeal).
  const dimAfterDeal = useDimAfterDeal()
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Same rules as controllerRef.current (runMoves is set beside it everywhere), memoized so isStuck can run during render.
  const stuckController = useMemo(() => createFortyThievesController(runMoves), [runMoves])
  // A dead board - no move left and no stock to deal - is a loss here, as in Aces Up, recorded when the player leaves it (see useStuckLossCheck):
  // it used to just sit there with the clock running.
  const { stuck } = useStuckLossCheck(stuckController, state, variant, recordDealAbandoned)
  // Reads controllerRef.current live inside isWon (rather than passing controllerRef.current
  // directly, which would freeze this render's controller into checkWin's closure) - matches
  // KlondikeScreen's identical fix, so a straggling call from a stale render's closure chain still
  // checks against the CURRENT controller, same as every other controllerRef.current read in this
  // file.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: FortyThievesState) => controllerRef.current.isWon(s) }, variant, session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing animating and the initial deal finished - what the auto-play hook below waits for, and
  // what the win celebration waits for too (see useWinReveal).
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0
  // `won` is game state (clock, stat, save, undo/hint gating) and flips with the winning move; the
  // celebration - foundations giving way to the win cascade, fireworks, banner - waits until the
  // last card has flown in and landed, so it is never hidden mid-flight (which used to make it
  // simply appear) and the finished board reads for a beat first.
  const winRevealed = useWinReveal(won, settled)
  // The loss banner waits for the last card to land too.
  const lossRevealed = useWinReveal(stuck, settled)
  // The board the win cascade has taken over from, and which piles it took over (set once its ghosts are on screen -
  // startChains' onShown, see runWinCascade): once it IS the current state, and the win is revealed, exactly those piles
  // blank their real cards - not a moment earlier. Compared by identity (state is replaced wholesale on every change), so
  // an undo or a New Game un-blanks the piles with no reset to remember.
  const [cascadeHandoff, setCascadeHandoff] = useState<{ state: FortyThievesState; piles: ReadonlySet<number> } | null>(null)
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
   * `gen` is the dealTokenRef value at the moment this flight was
   * queued - re-checked once the async measurement below resolves, so a flight queued against a
   * game that's since been replaced by "New Game" doesn't measure/land against the new deal's DOM
   * (card ids are shuffle-independent and reused across deals - see deck.ts). `to` is the pile the
   * card is headed for, so a foundation landing can fall back to that pile's own slot container when
   * the card itself can't be measured. */
  const pendingFlightRef = useRef<{ cardId: string; to: PileRef; viaStock?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const cascadeFeedback = useCascadeFeedback(playCardSound, hapticCard)
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    // A cascade or finish still running from the old deal must not carry on into this one, and a deal that happens to be
    // solved is not filed away until the player moves (see useAutoFoundationCascade's disarm, useAutoFinish's suppress).
    finish.suppress()
    cascade.disarm()
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
    dimAfterDeal.hold()
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a
  // new deal). Also restores the saved undo stack (falling back to empty for an older save
  // written before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<FortyThievesState>) {
    ++dealTokenRef.current
    // Nothing auto-plays on a resumed board until the player's own next play of a card to a foundation (the cascade, and the
    // finish if the board is solved).
    finish.suppress()
    cascade.disarm()
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
    dimAfterDeal.releaseNow()
    commitState(saved.state)
  }

  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned(variant)
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
      dimAfterDeal.release()
      return
    }

    const built: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) return
      built.push({ cardId: step.cardId, card: step.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: step.visitOrder * dealStaggerMs(sequence.length) })
    })
    // Every card here flies face-up, so the deal is slowed to a pace where each one can actually be seen (see paceFaceUpDeal).
    const entries = paceFaceUpDeal(built)
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      dimAfterDeal.release()
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
      () => {
        if (dealTokenRef.current !== token) return
        dimAfterDeal.release()
      }
    )
  }

  // Foundation piles are guaranteed full (13 cards each) the instant isWon() is true - measures
  // each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef), which is
  // card-sized and always mounted, whether or not the pile's real cards are drawn. Chains each pile
  // top-first (King) down to bottom-last (Ace).
  //
  // The real cards blank only once the ghosts that replace them are on screen (cascadeHandoff, set from startChains'
  // onShown - in the commit the ghosts appear, which waits for their parked faces to paint; see WinCascadeLayer's
  // CascadeChains): blanking them when the win is revealed instead, and starting the chains from the async continuation
  // that follows, left every pile empty for the frames in between, and blanking them in the commit that mounted the
  // ghosts showed blank-faced cards for a frame or two. An undo or New Game before then clears the cascade, which drops
  // the callback (and the hand-off is keyed to `s` anyway). A pile whose chain could not start (no measurable slot) keeps
  // its real cards, and if no chain can start at all the piles simply stay up under the banner instead of vanishing (an
  // empty cascade never calls onShown).
  async function runWinCascade(s: FortyThievesState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    const handedOff = new Set<number>()
    s.foundation.forEach((pile, index) => {
      const origin = origins[index]
      if (!origin || pile.length === 0) return
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
      handedOff.add(index)
    })
    winCascade.startChains(chains, cardWidth, () => setCascadeHandoff({ state: s, piles: handedOff }))
  }

  // Held back until the win is REVEALED (not merely won): the cascade takes over from the
  // foundations' real cards, which must stay put until the last flight has landed on them.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  // Same race documented in this repo's own CLAUDE.md: measuring CardRegistry synchronously right
  // after the setState in applyMove/handleDrawStock would find the still-mounted SOURCE card.
  // Deferring to a [state]-keyed effect guarantees the destination card has already registered.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        // A destination card's registered view is the usual landing spot, but if it can't be found (a
        // foundation card buried under a later arrival, a waste card already covered by the next
        // draw) the pile's own slot container is card-sized and always there - fly to that rather than
        // hiding the ghost and letting the card simply appear. A tableau column has no such container
        // (its card position depends on the fan), so that one still falls through to the hide.
        const landed = p.viaStock ? await measureView(stockViewRef.current) : ((await ghost.cardRegistry.measure(p.cardId)) ?? (p.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[p.to.index]) : p.to.zone === 'waste' ? await measureView(wasteViewRef.current) : null))
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

  // Auto-play-to-foundation has two halves. This one only ever follows the player's own play of a card to a foundation -
  // see useAutoFoundationCascade for the trigger model (afterPlayerMove, called from applyMove below; any
  // other move of theirs and a stock draw stop it), and rules.ts's own header comment on why this game only ever
  // fires once the whole remaining deal is provably clearable (no continuous "safe" heuristic,
  // unlike Klondike/FreeCell/Yukon/Canfield - no computeNextStep fallback to one below either).
  // It steps aside once the board is solved (computeNextStep), where the finish below takes over.
  const cascade = useAutoFoundationCascade<FortyThievesState>({
    state,
    isLanding,
    getState: () => stateRef.current,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep,
    firePlay,
    fireDraw: handleDrawStock,
    fireDrawAndPlay
  })
  // The finish: once the board is solved (the stock and waste empty, every card able to go up - rules.ts's canAutoFinish),
  // the rest files away on its own, at a pace that ramps up - after the player's play of a card to a foundation that leaves it
  // that way, or the cascade that play set off (see useAutoFinish). Both read the live controller (it is replaced every deal).
  const finish = useAutoFinish<FortyThievesState>({
    state,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    getState: () => stateRef.current,
    canFinish: (s) => canAutoFinish(controllerRef.current, s),
    nextMove: (s) => nextFinishMove(controllerRef.current, s),
    isLanding,
    firePlay
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

  // Deliberately not keyed on a ticking elapsed-seconds value: `session.getElapsed()` computes the true
  // current elapsed from wall-clock time on demand (see useGameSession.ts), but a save still holds the
  // elapsed time from when it was made, so useSaveInProgressBackstop saves again every 10s, when the
  // screen is left, and when the app is backgrounded.
  useEffect(() => {
    if (state && !won && !stuck) saveGameInProgress('fortythieves', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: runMoves ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, stuck, runMoves, undoStack])
  useSaveInProgressBackstop(!!state && !won && !stuck, () => {
    if (state && !won && !stuck) saveGameInProgress('fortythieves', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: runMoves ? 1 : 0 })
  })

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint(request?: HintRequest) {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(controllerRef.current, state, skip)
    if (result.kind === 'none') {
      if (!request?.auto) infoToast('No helpful moves right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed(variant)
    if (result.kind === 'move') {
      const { from, to, count } = result.move
      const source = resolvePile(from) ?? []
      void playHintGlide({ moving: source.slice(source.length - count), dest: resolvePile(to) ?? [], destFanned: to.zone === 'tableau', slot: to, cardWidth })
    }
  }

  function pushUndo(prev: FortyThievesState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // One undo per call - see useFlightConcurrency's runUndo.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // Every undo - a draw included - takes its cards back off the pile they went to, so it overlaps the
  // undos before it once nothing is still landing there. One that lands on the waste also waits for
  // the waste to be quiet: its frozen top expects one arrival at a time.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!entry || !stateRef.current) return null
    const { move } = entry
    if (!move) return 'exclusive'
    return { takesFrom: move.from.zone === 'waste' ? [move.to, WASTE] : [move.to] }
  }

  async function revertTopUndo() {
    // The stack and the board are read via their refs, not the closure: undos can run back-to-back
    // before React re-renders (see runUndo).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    if (won) {
      setWon(false)
      winCascade.clear()
    }
    // Every auto-played step is its own entry now (see applyMove), so an undo can land between two
    // steps of a cascade that is still armed: dropped here, or the reverted board - provably
    // finishable again - would set the cascade straight back off with no player move behind it. The
    // same for the finish: undoing a card off a solved board leaves it solved.
    finish.suppress()
    cascade.disarm()
    const { move, state: prevState } = entry
    startFlights(1)

    if (!move) {
      setUndoStack((stack) => stack.slice(0, -1))
      commitState(prevState)
      settleFlight() // nothing to fly, settles immediately
      return
    }

    const sourcePile = resolvePile(move.to, current)
    // A foundation move's own card can sit BURIED under silent auto-plays that landed on the same
    // pile after it in a save written before every auto-play got its own undo entry (see applyMove)
    // - so it is found by id, not assumed to be on top, or the ghost would carry the wrong card.
    const buriedAt = move.to.zone === 'foundation' && sourcePile ? sourcePile.findIndex((c) => c.id === move.anchorCardId) : -1
    const movingCards = sourcePile ? (buriedAt >= 0 ? [sourcePile[buriedAt]] : sourcePile.slice(sourcePile.length - move.count)) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    // A buried card, or any foundation card once the win celebration has hidden the real ones, is not
    // in CardRegistry (only a visible top card is) - the pile's own always-present slot container is
    // where it sits, so it flies from there instead of simply reappearing.
    const origin = movingCards.length > 0 ? ((await ghost.cardRegistry.measure(move.anchorCardId)) ?? (move.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[move.to.index]) : null)) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(move.from, move.count)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, to: move.from, viaStock: move.from.zone === 'stock', gen: dealTokenRef.current, flyingId, flight })
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
    // The card flying is the card the player tapped or grabbed (or the auto-play chose); tryMove only knows positions, so if
    // the board moved on since - an auto-play took that very card between the tap and now - it would move whatever now sits
    // there, under a ghost of a different card. Refuse instead (FreeCell's moveHeadCard check).
    const sourcePile = resolvePile(from, current)
    if (sourcePile?.[sourcePile.length - count]?.id !== anchorCardId) return false
    const result = controllerRef.current.tryMove(current, { from, to, count })
    if (result) {
      // A silent auto-play is still its own undo step (the board right before it), so the player can
      // take a cascade back one card at a time and stop exactly where they want - it just never
      // counts as a move (below) or arms the cascade again.
      pushUndo(current, { from, to, count, anchorCardId })
      commitState(result)
      // Every move counts, the player\'s or an auto-play\'s: Auto-Move only saves taps, never score.
      session.registerMove()
      checkWin(result)
      // Only the player's own play of a card to a foundation starts the cascade; any other move of theirs
      // stops it, so a card it uncovers (the waste's next card, say) is theirs to find and play. The
      // finish follows the same foundation play, once the board is solved (see useAutoFinish).
      if (!opts?.silent) {
        cascade.afterPlayerMove(to)
        finish.afterPlayerMove(to)
      }
      return true
    }
    return false
  }

  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    const flyingId = beginFlying(to, count)
    pendingFlightRef.current.push({ cardId: anchorCardId, to, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  // No Mechanism A fallback here (see rules.ts's own header comment on why this game only
  // reimplements the conservative "whole board provably clearable" mechanism B, draws-aware so it
  // can also reach through the stock) - a step only ever comes from
  // isFullyAutoCompletableWithDraws/nextAutoCompleteMoveWithDraws, never a continuous heuristic.
  function computeNextStep(s: FortyThievesState): AutoCompleteStep | null {
    // A solved board is the finish's: it files the cards away at its own, quicker pace, and the two
    // would otherwise fight over the same cards.
    if (canAutoFinish(controllerRef.current, s)) return null
    if (!isFullyAutoCompletableWithDraws(controllerRef.current, s)) return null
    return nextAutoCompleteMoveWithDraws(controllerRef.current, s)
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to
  // measure the card's current position itself, which is the one place this feature has an await
  // gap before applying its move. Guard against something else changing state during that gap by
  // snapshotting stateRef before the await and bailing if it no longer matches after. `stillWanted`
  // is re-checked there too: whichever automation sent this card - the cascade (its isArmed, the
  // default) or the finish (its isAllowed, which useAutoFinish passes) - may have been ended meanwhile
  // by the player's move elsewhere, an undo or a new deal.
  // Resolves once the move is COMMITTED (true) or refused (false), not when it lands - which is what
  // lets the cascade send the next card while this one is still flying.
  async function firePlay(entry: AccessibleCard, to: PileRef, stillWanted: () => boolean = () => cascade.isArmed()): Promise<boolean> {
    startFlights(1)
    const stateAtStart = stateRef.current
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart || undoBusyRef.current || !stillWanted()) {
      settleFlight()
      return false
    }
    cascadeFeedback()
    const flight = ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    if (!completeMove(entry.ref, to, 1, entry.card.id, flight, { silent: true })) {
      flight.hide()
      settleFlight()
      return false
    }
    return true
  }

  // Only ever called by the win-completing sweep once a stock card is provably about to go straight
  // to its foundation (see engine/autoFoundation.ts's 'drawAndPlay' step) - draws AND plays it in
  // one committed state change, animated as one continuous flight straight from the stock pile,
  // skipping the ordinary "land on waste first" stop entirely (the confirmed sweep visual). It counts
  // as two moves, like every auto-play (see applyMove), and each half is its own undo step: the draw (the board before it) and then the waste-to-foundation play
  // (the board after the draw). Both are kinds handleUndo already flies, so the first Undo sends the
  // card back to the waste and the next one back into the stock.
  async function fireDrawAndPlay(entry: AccessibleCard, to: PileRef) {
    const current = stateRef.current
    if (!current || !controllerRef.current.drawStock) return
    const afterDraw = controllerRef.current.drawStock(current)
    if (!afterDraw) return
    const result = controllerRef.current.tryMove(afterDraw, { from: entry.ref, to, count: 1 })
    if (!result) return
    startFlights(1)

    const origin = await measureView(stockViewRef.current)
    if (!origin || stateRef.current !== current || undoBusyRef.current || !cascade.isArmed()) {
      settleFlight()
      return
    }

    cascadeFeedback()
    const flight = ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying(to, 1)
    pushUndo(current, { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: entry.card.id })
    pushUndo(afterDraw, { from: entry.ref, to, count: 1, anchorCardId: entry.card.id })
    commitState(result)
    // Two moves, the draw and the play, as the player would make them with Auto-Move off.
    session.registerMove()
    session.registerMove()
    checkWin(result)
    pendingFlightRef.current.push({ cardId: entry.card.id, to, gen: dealTokenRef.current, flyingId, flight })
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
  // cascade hook's own fireDraw callback above) rather than a genuine player tap. Like every auto-play (see applyMove)
  // it counts as a move and is its own undo step.
  async function handleDrawStock(opts?: { sweep?: boolean }) {
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    const current = stateRef.current
    if (won || !current || !controllerRef.current.drawStock) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    if (!controllerRef.current.drawStock(current)) return
    startFlights(1)
    // A draw is the player's, but it is not a play: it never sets auto-play off, and it stops a cascade
    // still running from their last play, so a card they just drew is theirs to find and play. Stopped
    // at the tap, before the measurement below, so no auto-played card can go up in between.
    if (!opts?.sweep) cascade.disarm()

    const gen = dealTokenRef.current
    const origin = await measureView(stockViewRef.current)
    // A New Game or restore mid-measurement replaced the board and already dropped this claim
    // (resetFlightConcurrency) - drop the draw too, rather than draw from the new deal.
    if (dealTokenRef.current !== gen) return
    // The cascade's own draw (a sweep) must not commit once the player's move has ended the cascade, or over a board that
    // moved on while it was measuring (its step was worked out for the board it started from).
    if (opts?.sweep && (!cascade.isArmed() || stateRef.current !== current)) {
      settleFlight()
      return
    }
    // What is drawn is worked out from the board as it is now that the measurement is back, and
    // committed in this same synchronous stretch (Pyramid's handleDrawStock does the same): computed
    // before the await and committed after it, two quick taps both drew the SAME card (two moves and
    // two undo entries for it), and a tap-to-move committed meanwhile was undone in state while its
    // ghost flew on. The stock may have run out meanwhile (a tap ahead of this one drew its last card).
    const board = stateRef.current
    const result = board && controllerRef.current.drawStock(board)
    if (!board || !result) {
      settleFlight()
      return
    }
    // Counted here, with the draw that really happens - not at the tap, whose draw may have been dropped.
    session.registerMove() // a sweep\'s own draw counts too, as the player\'s would with Auto-Move off

    const drawnCard = top(result.waste)!
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }
    if (!origin) {
      pushUndo(board, move)
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

    pushUndo(board, move)
    commitState(result)
    pendingFlightRef.current.push({ cardId: drawnCard.id, to: { zone: 'waste', index: 0 }, gen: dealTokenRef.current, flyingId, flight })
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

  if (!state) return <GameLoading />

  const wasteTop = top(state.waste)

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Forty Thieves' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} autoHintKey={state} hintShowing={!!activeHint} hintDisabled={won || stuck} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} pauseClock={session.setPaused} par={parFor(variant)} clockRunning={session.started && !won && !stuck} movesCount={session.moves} settingsContent={<FortyThievesSettingsSection />} rules={FORTYTHIEVES_RULES}>
        {/* As wide as the tableau, the foundations at its left edge and the waste/stock pair at its right. It used to
        put a fixed 18pt between the two in portrait, which made it 16pt wider than the tableau: it ran off both
        edges of a phone. */}
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={[styles.foundationsGroup, { gap: topRowGroupGap }]}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              // Several tap flights can be headed to one pile at once (they overlap), so count the cards still
              // in the air: the pile keeps showing the top card that has already LANDED under the rest instead of
              // reverting to the one from before the whole stream (see FoundationCell's settledCard).
              const flightsInAir = flying.filter((f) => f.to.zone === 'foundation' && f.to.index === i).reduce((sum, f) => sum + f.count, 0)
              const isFlyingHere = flightsInAir > 0
              const cascadeTookOver = winRevealed && cascadeHandoff?.state === state && cascadeHandoff.piles.has(i)
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={cascadeTookOver ? undefined : t}
                    isFlyingHere={isFlyingHere}
                    settledCard={pile[pile.length - 1 - flightsInAir] ?? null}
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

          <StockWaste canRecycle={false} dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteUnder={state.waste[state.waste.length - 2]} wasteHiddenCount={flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0)} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} gap={topRowGroupGap} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y, flight, dragged) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, dragged.id, flight)} stockRef={stockViewRef} wasteRef={wasteViewRef} />
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
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={!dimAfterDeal.held} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {winRevealed && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} par={parFor(variant)} onNewGame={startNewGame} />}
      {lossRevealed && !won && <LossBanner onNewGame={handleNewGame} onUndo={handleUndo} />}
    </CardSizeProvider>
  )
}
