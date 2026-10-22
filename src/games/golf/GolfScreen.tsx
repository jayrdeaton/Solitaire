// Golf solitaire screen: a 7-column all-face-up tableau + a single build-pile waste, dealt from a
// real stock. Architecturally the simplest game screen in this app - every move is exactly one
// card, always onto the same fixed destination (the waste/build pile), there's no suit-based
// foundation at all (so no engine/autoFoundation.ts cascade), and there's no multi-card run drag.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { CardSizeProvider } from '@tastic/cards'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { HintRequest } from '@/components/autoHint'
import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { dealStaggerMs, paceFaceUpDeal } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useFittedCardWidth, useFittedGap, useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { PileDragConfig, PileView } from '@/components/PileView'
import { StockWaste } from '@/components/StockWaste'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { PipFireworks } from '@/components/winning/PipFireworks'
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { GOLF_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { parFor } from '@/engine/par'
import { top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { golfVariant } from '@/engine/variants'
import { showNoHintToast } from '@/games/shared/gameToasts'
import { LossBanner } from '@/games/shared/LossBanner'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useDimAfterDeal } from '@/games/shared/useDimAfterDeal'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useHintGlide } from '@/games/shared/useHintGlide'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useStuckLossCheck } from '@/games/shared/useStuckLossCheck'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useUndoStack } from '@/games/shared/useUndoStack'
import { useWinReveal } from '@/games/shared/useWinReveal'
import { sweptWaste, useWinStockSweep } from '@/games/shared/useWinStockSweep'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { useSettings } from '@/hooks/useSettings'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { BOARD_MODEL } from './boardModel'
import { buildGolfDealSequence } from './dealSequence'
import { GolfSettingsSection } from './GolfSettingsSection'
import { createGolfController, GolfState } from './rules'

const TABLEAU_COLUMNS = 7
const WASTE: PileRef = { zone: 'waste', index: 0 }

export default withGameProviders(GolfScreenInner)

function GolfScreenInner() {
  const { styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, recordUndoUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
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
  // The deal's game under the rule it was dealt with: what its stats and par are kept for (engine/variants.ts).
  const variant = golfVariant(golfRankWrap)
  const controller = useMemo(() => createGolfController(golfRankWrap), [golfRankWrap])
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth, isWide } = useGameLayout()
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  // The width-derived size in portrait (unchanged); in the wide layout also shrunk until the whole board
  // (top row + the tallest starting column) fits the window's short axis - see boardModel.ts.
  const cardWidth = useFittedCardWidth(widthCardWidth, BOARD_MODEL)
  const gap = useFittedGap(widthGap, widthCardWidth, cardWidth, contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth)
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/stock-draw can all run concurrently with each other -
  // PATTERN_OVERLAP_GATE, same as Klondike's own KlondikeScreen.tsx). Destructured below so every
  // existing reference to `state`, `commitState`, `flying`, `startFlights`, `settleFlight`,
  // `undoBusyRef`, etc. keeps working unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<GolfState>()
  // Unlike Klondike (whose stock-draw undo entries carry move: null for a recycle - "nothing card-
  // shaped to fly") and Pyramid (same null convention for its pairing moves, which use a totally
  // different removedCards field instead of MoveInfo), every Golf move - a tableau card onto the
  // waste pile, or a stock draw - always has a real origin/destination and a real card to fly.
  // GolfController.drawStock returns null outright when the stock is empty (nothing applied, no
  // undo entry pushed at all) rather than a "successful but nothing moved" recycle result, so no
  // move shape here ever needs move: null. Mirrors FreeCell's/Yukon's own non-nullable
  // UndoEntry<TState, MoveInfo> instantiation instead of Klondike's/Pyramid's nullable default.
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<GolfState, MoveInfo>>()
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
  const playHintGlide = useHintGlide(state, ghost.cardRegistry, dropZones)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  // The waste slot itself (StockWaste's wasteRef) - exactly card-sized, which matters under a rotated
  // (landscape) board: a measured bounding box is only convertible into the overlay's frame when it has
  // the card's own footprint (see overlayFrameMath's toLocal), and wrapping the whole two-card stock/waste
  // pair instead would measure to the wrong corner at +/-90deg. Used as the win cascade's single chain
  // origin (see runWinCascade) - the real waste top card is hidden once the win is revealed
  // (wasteTopCard below), same as every other game's own foundation/discard pile during its cascade.
  const wasteViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  // Nothing is dimmed while the deal is in the air; the whole board dims at once when it has landed (see useDimAfterDeal).
  const dimAfterDeal = useDimAfterDeal()
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // A dead board - no move left and no stock to deal - is a loss here, as in Aces Up, recorded when the player leaves it (see useStuckLossCheck):
  // it used to just sit there with the clock running.
  const { stuck } = useStuckLossCheck(controller, state, variant, recordDealAbandoned, session)
  // Derived from `state` every render (see useDerivedWinCheck) rather than mirrored into its own
  // useState, same as Pyramid/Spider (not Klondike/FreeCell's useFoundationWinCheck) - Golf has no
  // suit-based foundation for a "won" flag to hang off, just "every tableau column is empty".
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(controller, state, variant, session, dealTokenRef, recordDealWon, hintsUsedRef)
  // activeFlightCount covers every ghost flight (tap, drag, stock draw, undo all claim one via startFlights before their first
  // await), dealHiddenIds the initial deal.
  const flightsLanded = activeFlightCount === 0 && dealHiddenIds.size === 0
  // A win with cards still in the stock deals them onto the waste once the winning card has landed, so the cascade takes off
  // with all 52 in one pile (see useWinStockSweep): the board shows its stock and waste through it.
  const winSweep = useWinStockSweep({ state, won, othersSettled: flightsLanded, deal, cardWidth, stockViewRef, wasteViewRef })
  // Nothing animating, the initial deal finished and a won board's leftover stock dealt - what the win celebration waits for
  // (see useWinReveal).
  const settled = flightsLanded && !winSweep.active
  // `won` is game state (clock, stat, save, undo/hint gating) and flips with the winning move; the
  // celebration - the waste pile giving way to the win cascade, fireworks, banner - waits until the
  // last card has flown onto the waste and landed. Hiding the waste top on `won` used to unregister
  // the very card the winning flight was measuring to land on, so that flight could not fly at all
  // and the card simply appeared (see the [state] flight effect below). A longer fallback than the
  // default when a sweep follows the last flight.
  const winRevealed = useWinReveal(won, settled, winSweep.revealMaxWaitMs)
  // The loss banner waits for the last card to land too.
  const lossRevealed = useWinReveal(stuck, settled)
  // The board the win cascade has taken over from (set once its ghosts are on screen - startChains' onShown, see
  // runWinCascade): once it IS the current state, and the win is revealed, the real waste top blanks - not a moment
  // earlier. Blanking on winRevealed alone left the waste slot EMPTY for the few frames it takes runWinCascade to measure
  // and mount the ghosts (the pile teleported away, then the ghosts appeared). Compared by identity (state is replaced
  // wholesale on every change) so an undo or a New Game un-blanks the pile with no reset to remember.
  const [cascadeHandoffFor, setCascadeHandoffFor] = useState<GolfState | null>(null)
  /** Flights awaiting their post-commit measurement + ghost.flyTo, queued by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), and undo - a list (not a single
   * slot), since these can now genuinely overlap (see useFlightConcurrency's own
   * PATTERN_OVERLAP_GATE doc comment, and KlondikeScreen.tsx's identical pendingFlightRef): two
   * entries queued in the same commit would otherwise clobber each other in a single ref slot,
   * permanently stranding whichever one lost. Each entry carries its own already-created
   * DragFlightHandle to fly/hide once measured, and its own flyingId to remove exactly its own
   * `flying` entry once it lands - see the [state]-effect below. `viaStock` measures via
   * stockViewRef (a plain View, not per-card) instead of CardRegistry - only undoing a stock draw
   * flies back toward the stock; a tableau-bound undo flies back to a real per-card-registered
   * pile. `viaWaste` (a forward move or a draw) falls back to wasteViewRef when the card has no
   * registry entry of its own - see the [state]-effect below. `gen` guards against a "New Game"
   * tapped mid-flight replacing the deal this flight was measuring against (card ids are
   * shuffle-independent and reused across deals - see engine/deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; viaWaste?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. Always exactly one card (Golf never drags/taps a run - every move is a
  // single card), unlike Klondike's own shake, which can cover a whole run.
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

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
    resetFlightConcurrency()
    pendingFlightRef.current = []
    session.reset()
    recordedWinRef.current = false
    winCascade.clear()
    winSweep.cancel()
    pendingWinCascadeRef.current = null

    // The starter card's id rides along in the same hidden-until-landed set as every tableau card -
    // harmless for PileView's own hiddenCardIds check (it never appears in a tableau column), and
    // lets wasteHiddenCount below (computed from this same set) reuse one mechanism for both.
    const dealtIds = new Set([...s.tableau.flat().map((c) => c.id), ...s.waste.map((c) => c.id)])
    setDealHiddenIds(dealtIds)
    dimAfterDeal.hold()
    scheduleDeal(myToken)
    commitState(s)
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
    resetFlightConcurrency()
    pendingFlightRef.current = []
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    winSweep.cancel()
    setDealHiddenIds(new Set())
    dimAfterDeal.releaseNow()
    commitState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome only
  // ever calls this after the player has confirmed that, or immediately when there's nothing to lose
  // (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned(variant, { seconds: session.getElapsed(), moves: session.getMoves() })
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
      dimAfterDeal.release()
      return
    }

    const built: DealCardSpec[] = []
    // A card whose destination can't be measured never enters `built`, so it would never reach the
    // onCardLanded callback that clears it from dealHiddenIds - stuck invisible for the whole hand (and
    // holding the win celebration back to its max wait). Unhide it instead, same fallback FreeCell's
    // runDeal/TriPeaks' starter use.
    const unresolvedIds: string[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) {
        unresolvedIds.push(step.cardId)
        return
      }
      built.push({
        cardId: step.cardId,
        card: step.card,
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: step.visitOrder * dealStaggerMs(sequence.length)
      })
    })
    // Every card here flies face-up, so the deal is slowed to a pace where each one can actually be seen (see paceFaceUpDeal).
    const entries = paceFaceUpDeal(built)
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      dimAfterDeal.release()
      return
    }
    if (unresolvedIds.length > 0) {
      setDealHiddenIds((ids) => {
        if (unresolvedIds.every((id) => !ids.has(id))) return ids
        const next = new Set(ids)
        unresolvedIds.forEach((id) => next.delete(id))
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
      },
      () => {
        if (dealTokenRef.current !== token) return
        dimAfterDeal.release()
      }
    )
  }

  // Win cascade: a single chain, every card that ever landed on the waste/build pile (the tableau's
  // whole 35 cards plus the starter, in the order they arrived - the only "foundation-equivalent"
  // pile Golf has), reversed so the most-recently-placed (currently on top of the physical pile)
  // leads the chain, same convention as Pyramid's discard-pile cascade. Origin is wasteViewRef (see
  // its own doc comment above) - always mounted and card-sized whether or not the real top card is
  // drawn - rather than a per-card CardRegistry lookup. The measurement runs while the real waste top
  // is STILL on screen and the pile blanks only afterwards, once the ghosts are on screen
  // (cascadeHandoffFor, set from startChains' onShown - in the commit the ghosts appear, which waits
  // for the parked head's face to paint; see WinCascadeLayer's CascadeChains): blanking first left the
  // waste empty until the ghosts arrived, and blanking in the commit that mounted them showed a
  // blank-faced card there for a frame or two. An undo or New Game before then clears the cascade,
  // which drops the callback (and the hand-off is keyed to `s` anyway). If no chain can start (an
  // unmeasurable slot), the pile simply stays up under the banner instead of vanishing.
  // Same dealTokenRef guard as every other async measurement here.
  // The chain is the waste AFTER the win sweep (sweptWaste: whatever was left in the stock, dealt
  // on top), which has already landed by the reveal; if the reveal's fallback timer fired first, the
  // sweep is cut short here and the chain simply carries every card. Up to 52 cards in one chain at
  // the usual spacing, stringing out across the bounces behind its leader (as in Pyramid).
  async function runWinCascade(s: GolfState, gen: number) {
    winSweep.cancel()
    const origin = await measureView(wasteViewRef.current)
    const cards = sweptWaste(s).slice().reverse()
    if (dealTokenRef.current !== gen || !origin || cards.length === 0) return
    winCascade.startChains([{ cards, origin }], cardWidth, () => setCascadeHandoffFor(s))
  }

  // Same race as the deal effect above: measuring CardRegistry/a view ref synchronously inside
  // checkWin itself would find state from before the winning move's own registration effects have
  // run. Deferring to a [state]-keyed effect guarantees everything has already committed. Also waits
  // for winRevealed (the last card has landed and the finished board has held a beat) - the cascade
  // replaces the waste pile's real cards, so it must not start while the winning card is in the air.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  // Same race documented in this repo's own CLAUDE.md: measuring CardRegistry synchronously right
  // after the setState in applyMove/handleDrawStock would find the still-mounted SOURCE card (the
  // destination card's own registration effect hasn't run yet), so the ghost would "fly" a near-zero
  // distance back to roughly where it started - indistinguishable from a snap. Deferring to a
  // [state]-keyed effect guarantees the destination card has already registered by the time this
  // runs.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        // A forward move's/draw's registered waste top card is the usual landing spot, but a card that
        // is no longer the top by the time it is measured (a second move landed on it in the same
        // commit) has no registry entry - the waste slot itself is card-sized and always there, so fly
        // to that rather than hiding the ghost and letting the card simply appear.
        const landed = p.viaStock ? await measureView(stockViewRef.current) : ((await ghost.cardRegistry.measure(p.cardId)) ?? (p.viaWaste ? await measureView(wasteViewRef.current) : null))
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
  // deal doesn't get checkpointed as still in-progress - since `won` is derived fresh from `state` on
  // every render, undoing back out of a won position re-enables saving again on that same render.
  // Deliberately NOT also keyed on a ticking elapsed-seconds value the way an earlier version of this
  // effect was: `session.getElapsed()` computes the true current elapsed from wall-clock time on demand
  // (see useGameSession.ts), but a save still holds the elapsed time from when it was made, so
  // useSaveInProgressBackstop saves again every 10s, when the screen is left, and when the app is
  // backgrounded.
  useEffect(() => {
    if (state && !won && !stuck) saveGameInProgress('golf', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: golfRankWrap ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, stuck, golfRankWrap, undoStack])
  useSaveInProgressBackstop(!!state && !won && !stuck, () => {
    if (state && !won && !stuck) saveGameInProgress('golf', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: golfRankWrap ? 1 : 0 })
  })

  function pushUndo(prev: GolfState, move: MoveInfo) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

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
      const source = state.tableau[result.move.from.index]
      void playHintGlide({ moving: source.slice(-1), dest: state.waste, destFanned: false, cardWidth })
    }
    // True when pressing Hint again shows a different move: a held Hint button steps on while it is (hintHold.ts).
    return result.kind === 'move' && result.choices > 1
  }

  // Mirrors handleCardTap's/handleDrawStock's forward flight, just in reverse: the card being
  // undone is still sitting on top of the waste pile (every Golf move's `to` is always the waste -
  // see MoveInfo above) - measure that real position before reverting (the pendingFlightRef effect
  // above can only measure a DESTINATION once it's committed and re-rendered, so the ORIGIN has to
  // be captured here, synchronously against the still-current state), then revert and fly the ghost
  // back to `move.from` - a tableau column, or the stock pile for an undone draw (see
  // pendingFlightRef's `viaStock`).
  // One undo per call - see useFlightConcurrency's runUndo.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // Every Golf undo takes the waste's top card back where it came from, and nothing an undo does
  // lands on the waste - so undos never wait for each other here.
  function undoGate(): UndoGate {
    if (undoStackRef.current.length === 0 || !stateRef.current) return null
    return { takesFrom: [WASTE] }
  }

  async function revertTopUndo() {
    // Reads the stack and the board via their refs, not the closure - see applyMove's identical
    // comment: undos (like any two actions) can run back-to-back before React re-renders
    // (PATTERN_OVERLAP_GATE), so this needs whatever they actually are right now.
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    startFlights(1)
    // Undo only ever moves backward into an earlier, necessarily-not-won state (won is a terminal
    // condition), so any undo reachable while won must be undoing the winning move itself - stop the
    // bouncing win cascade immediately instead of leaving it animating over a board that's already
    // reverted underneath it. `won` (derived from state above) clears itself on the very next render
    // once prevState commits below. Likewise the sweep of the leftover stock onto the waste, if it is
    // still dealing: its cards go back to the stock with the board.
    if (won) {
      winCascade.clear()
      winSweep.cancel()
    }
    const { move, state: prevState } = entry
    const movingCard = top(current.waste)
    // Once the win is revealed, the winning card's DraggableCard is deliberately unmounted (see
    // wasteTopCard below), so it has no CardRegistry entry - fall back to the waste slot's plain view
    // ref (the same technique runWinCascade above already uses for this exact reason), rather than a
    // registry lookup that would return null and skip the flight (the card would just reappear).
    const origin = movingCard && movingCard.id === move.anchorCardId ? ((await ghost.cardRegistry.measure(move.anchorCardId)) ?? (await measureView(wasteViewRef.current))) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin && movingCard) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(move.from, 1)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen: dealTokenRef.current, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  function applyMove(from: PileRef, to: PileRef, anchorCardId: string): boolean {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the
    // OTHER's commitState just did, not the same stale board both closures captured.
    const current = stateRef.current
    if (!current) return false
    const result = controller.tryMove(current, { from, to, count: 1 })
    if (!result) return false
    pushUndo(current, { from, to, count: 1, anchorCardId })
    commitState(result)
    session.registerMove()
    return true
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual drag's
  // drop) - applies the move, then marks the waste pile "incoming" and stashes the anchor card id
  // for the pendingFlightRef effect above to measure and fly the ghost onto, instead of it just
  // appearing there instantly.
  function completeMove(from: PileRef, to: PileRef, anchorCardId: string, flight: DragFlightHandle): boolean {
    if (!applyMove(from, to, anchorCardId)) return false
    const flyingId = beginFlying(to, 1)
    pendingFlightRef.current.push({ cardId: anchorCardId, viaWaste: true, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  async function handleDrawStock() {
    if (won) return
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    // Without this, rapid-tapping the stock pile several times before React re-renders would draw
    // against the same stale board each time instead of drawing several different cards in a row.
    const current = stateRef.current
    if (!current) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const result = controller.drawStock!(current)
    if (!result) return
    startFlights(1)
    session.registerMove()

    // drawStock never returns a result with an unchanged waste - Golf has no recycle case (see
    // rules.ts), so a successful draw always means a real drawn card.
    const drawnCard = top(result.waste)!
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(current, move)
      commitState(result)
      settleFlight()
      return
    }

    playCardSound()
    const flight = ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying({ zone: 'waste', index: 0 }, 1)

    pushUndo(current, move)
    commitState(result)
    pendingFlightRef.current.push({ cardId: drawnCard.id, viaWaste: true, gen: dealTokenRef.current, flyingId, flight })
  }

  // Tapping a tableau column's top card sends it to the waste pile if legal - Golf has exactly one
  // possible destination (autoMoveHint either finds that one move or returns null), so unlike
  // Klondike/Yukon's own tap-to-move there's no "best of several destinations" ranking here at all.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
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

    // Claimed synchronously before the await below (see PATTERN_OVERLAP_GATE) - so undo (the only
    // thing that still waits on activeFlightCountRef) sees this tap as in-flight for its whole
    // duration, not just once completeMove lands one.
    startFlights(1)
    const origin = await measure()
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    const current = stateRef.current
    const card = current && ref.zone === 'tableau' ? top(current.tableau[ref.index]) : undefined
    if (!card || undoBusyRef.current) {
      settleFlight()
      return
    }

    // No buzz here: a tap's is its press's own, at touch-down (every card is a feedback-press Pressable).
    playCardSound()
    const flight = ghost.show({ cards: [card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })

    if (!completeMove(move.from, move.to, cardId, flight)) {
      flight.hide()
      settleFlight()
    }
  }

  if (!state) return <GameLoading />

  // Hidden only once the win is REVEALED, not the moment it is won - the winning card is still flying
  // onto this pile until then, and its flight measures the registered waste top to land on - AND the
  // cascade has taken over (cascadeHandoffFor === state): its ghosts are on screen by the commit this
  // blanks, so the pile is never seen empty. Not on winRevealed alone: runWinCascade measures first.
  // The waste as shown: on a won board, with every leftover stock card the win sweep has landed on it.
  const shownWaste = winSweep.waste
  const wasteTopCard = winRevealed && cascadeHandoffFor === state ? undefined : top(shownWaste)
  // Combines two independent reasons the waste top slot might need to stay visually covered by a
  // ghost a beat longer than the real state already shows: the initial deal's starter card (still in
  // dealHiddenIds until its own deal ghost lands - see startNewGame) and an ordinary post-deal flight
  // landing there (a tableau tap/drag move, or a stock draw). The two never overlap in practice (the
  // deal finishes before any real move can happen), but Math.max reads correctly either way.
  const wasteHiddenByDeal = wasteTopCard && dealHiddenIds.has(wasteTopCard.id) ? 1 : 0
  const wasteHiddenByFlight = flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0)
  const wasteHiddenCount = Math.max(wasteHiddenByDeal, wasteHiddenByFlight)

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome onUndoUsed={() => recordUndoUsed(variant)} title='Golf' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} autoHintKey={state} hintShowing={!!activeHint} hintDisabled={won || stuck} won={won} winRevealed={winRevealed} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} pauseClock={session.setPaused} par={parFor(variant)} clockRunning={session.started && !won && !stuck} movesCount={session.moves} settingsContent={<GolfSettingsSection />} rules={GOLF_RULES}>
        {/* No foundation row at all (unlike Klondike/FreeCell/Yukon) - Golf has no suit-based
        foundation, just the stock/waste pair. Narrower than the tableau below, so it's centered
        above it by GameChrome's own content styling rather than stretched/pinned to an edge. */}
        {/* Wide layout: cards shrink to fit the window's height (see boardModel.ts), so the tableau row can
        end up narrower than the content column, and `alignSelf: 'flex-end'` would then pin the stock/waste
        to the column's edge instead of the tableau's. There the row is given the tableau row's exact width
        (centered like it) with the pair right-aligned inside it - portrait keeps the plain flex-end row. */}
        <View style={[styles.topRow, isWide && styles.topRowWide, isWide && { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <StockWaste
            canRecycle={false}
            dropZones={dropZones}
            stockTopCard={winSweep.stockTopCard}
            wasteTop={wasteTopCard}
            wasteUnder={wasteTopCard ? shownWaste[shownWaste.length - 2] : undefined}
            wasteHiddenCount={wasteHiddenCount}
            // While the starter card is still being dealt, the waste is really empty: without this the slot painted its frozen
            // 'card from before the flight' under the ghost - the starter itself on a first deal, the last game's top card on New
            // Game - face up beside the stock for the whole deal.
            settledWasteTop={wasteHiddenByDeal ? null : undefined}
            wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0}
            stockHinted={activeHint?.kind === 'drawStock'}
            cardWidth={cardWidth}
            gap={gap}
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
            wasteRef={wasteViewRef}
          />
        </View>

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              // Golf never drags a run - only a column's true top card (indexFromTop === 0) can ever
              // move, one card at a time. Deliberately not engine/pile.ts's runCountFrom, which is
              // for multi-card-run games (Klondike/FreeCell/Spider) - Golf needs none of that.
              getRunCount: (indexFromTop) => (indexFromTop === 0 ? 1 : 0),
              // PileView's own handleDragEnd already resolves the drop target via dropZones.hitTest
              // before calling this, so - unlike StockWaste's loose DraggableCard onDrop above - no
              // separate hitTest wrapper is needed here. Rejects outright if undo is running (see
              // handleCardTap's identical comment on why undo holds full mutual exclusion, not just
              // a one-way wait).
              onDrop: (to, _count, anchorCardId, flight) => {
                if (undoBusyRef.current) return false
                startFlights(1)
                if (!completeMove({ zone: 'tableau', index: colIndex }, to, anchorCardId, flight)) {
                  settleFlight()
                  return false
                }
                return true
              }
            }
            // Only ever true during an undo flying a card back into this column - a forward Golf
            // move's destination is always the waste pile, never a tableau column.
            const hiddenCount = flying.filter((f) => f.to.zone === 'tableau' && f.to.index === colIndex).reduce((sum, f) => sum + f.count, 0)
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                {/* dimUnplayable: Golf has no multi-card runs at all - getRunCount below is
                unconditionally 1 for the true top card and 0 for everything else, so every buried
                card in a column is permanently unplayable, not just sometimes-stuck like
                FreeCell/Spider's suit/color-broken runs. Still the same "face-up but not a legal
                move source" cue those need. */}
                <PileView cards={col} onPressCard={(card, _indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable && !dimAfterDeal.held} shakeCardId={shake?.cardId} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
      (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
      banner comes last of all three so it's the one thing guaranteed to sit on top of the animation,
      not buried under it. */}
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
    topRow: {
      // Right-aligned to land on the tableau's own right edge below - Klondike/Spider/Canfield
      // all put their stock pile at that same right edge, and Golf's own waste+stock pair (with
      // no foundations to balance against on the left, unlike Klondike) previously just centered
      // under the tableau instead of matching them. Only right while the tableau row spans the whole
      // content column (portrait) - the wide layout overrides it inline, see the topRow JSX.
      alignSelf: 'flex-end',
      flexDirection: 'row',
      marginBottom: 16
    },
    // Wide layout: same row, but centered like the tableau row and given that row's width inline (it
    // depends on the fitted card size), with the stock/waste pair right-aligned inside it.
    topRowWide: {
      alignSelf: 'center',
      justifyContent: 'flex-end'
    }
  })
}
