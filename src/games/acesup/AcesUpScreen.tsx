// Aces Up solitaire screen: 4 piles, tap OR drag (PileView only treats a card as tappable at all
// once drag.getRunCount reports it as a legal move source - see this file's own hasLegalMove - so
// every game here needs a real drag config even where dragging itself is secondary to tapping), a
// single stock pile dealt in rounds of 4. The one screen in this app with a genuine loss condition
// (see games/shared/useStuckLossCheck.ts) alongside the usual win check.
//
// Dragging only ever resolves to "move onto an empty pile" (the only real drop target that
// exists) - dragging a discard-only card and releasing it over nothing just snaps back, same as
// any other illegal drop elsewhere in this app; tapping still handles the discard case via
// autoMoveHint's own priority (see rules.ts).
//
// A discard now has a real destination: rules.ts's `discard` field, displayed via the shared
// DiscardCell (see games/shared/DiscardCell.tsx - the same component Pyramid uses for its own
// discard pile). A tapped card flies there exactly like a tap-to-move-to-empty-pile does -
// handleCardTap shows a ghost at the tapped origin, applies the move immediately, then the
// pendingFlightRef effect below measures the discard pile's real position (a plain view ref,
// same idiom as stockViewRef - there's only ever one discard pile, not a per-card registration)
// and flies the ghost the rest of the way. Undoing a discard is the mirror image: fly a ghost
// from the discard pile back to the tapped card's original pile.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider } from '@tastic/cards'
import { useEffect, useRef, useState } from 'react'
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
import { fitCardWidthToHeight, fittedGap, useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { PileDragConfig, PileView } from '@/components/PileView'
import { PlayingCard } from '@/components/PlayingCard'
import { fireworksColors } from '@/components/theme'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { ACESUP_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { DiscardCell } from '@/games/shared/DiscardCell'
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
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { BOARD_MODEL } from './boardModel'
import { buildAcesUpDealSequence } from './dealSequence'
import { AcesUpController, AcesUpState } from './rules'

const NUM_PILES = 4

// A plain face-down placeholder for the stock pile display - id/suit/rank are never shown
// (faceUp: false always renders CardBack instead), so any valid values work here.
const STOCK_DISPLAY_CARD: Card = { id: 'acesup-stock', suit: 'spades', rank: 1, faceUp: false }

export default withGameProviders(AcesUpScreenInner)

function AcesUpScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth, availableHeight } = useGameLayout()
  const rowWidth = contentWidth - GAME_CONTENT_PADDING * 2
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(rowWidth, NUM_PILES)
  // Capped so a pile as long as real games make it still fits the height (see boardModel.ts) - in BOTH layouts, unlike
  // the other games: with only four piles, the width-derived card on a short phone (88pt on a 640pt Android) ran a
  // pile past the bottom by its sixth card, in most games. Tall phones stay width-bound, so their cards are unchanged.
  const cardWidth = fitCardWidthToHeight(widthCardWidth, availableHeight, BOARD_MODEL)
  const gap = cardWidth < widthCardWidth ? fittedGap(rowWidth, cardWidth, NUM_PILES) : widthGap
  // Spans the same width as pilesRow below (4 piles + 3 gaps) so topRow's own space-between can
  // put the discard pile and stock at its two ends, mirroring Pyramid's controlRow/triangle.
  const pilesWidth = cardWidth * NUM_PILES + gap * (NUM_PILES - 1)
  // Adapts to the real window height the same way every other PileView-using game does (see
  // useTableauMaxHeight's own doc comment).
  const tableauMaxHeight = useTableauMaxHeight(cardWidth)
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/stock-draw can all run concurrently with each other -
  // PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`, `commitState`,
  // `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working unchanged. Aces Up
  // has no foundation-by-suit auto-play, so (unlike Klondike) nothing here ever needs
  // shrinkFlying - only runUndo for handleUndo, and activeFlightCount (the state mirror) for the win
  // reveal's `settled` below.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<AcesUpState>()
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<AcesUpState>>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: AcesUpState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button was pressed (and actually produced a hint) at any point during the
  // CURRENT deal - read once, at the exact instant a win is recorded (see useDerivedWinCheck's own
  // hintsUsedRef param), to decide whether this win counts toward the "wins without hint"
  // stat/achievement. Reset alongside the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const ghost = useDragGhost()
  const playHintGlide = useHintGlide(state, ghost.cardRegistry, dropZones)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  const discardViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // No suit-based foundation, no separate "completed sequence" slot - won is a pure function of
  // state (every pile down to a single Ace, stock empty), same shape Golf/Spider/Scorpion use.
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(AcesUpController, state, 'acesup', session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing in the air (every discard/move/round-deal/undo flight is counted by startFlights/
  // settleFlight) and no card still waiting on a deal - what the win celebration waits for (see
  // useWinReveal).
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0
  // `won` is game state (clock, stat, save, hint/undo gating) and flips with the winning discard; the
  // celebration - the piles giving way to the win cascade, fireworks, banner - waits until that last
  // card has flown to the discard pile and landed, so the finished board (the four Aces) reads for a
  // beat first instead of the cascade starting over a card still in the air.
  const winRevealed = useWinReveal(won, settled)
  // The board the win cascade has taken over from, and WHICH piles it took over (set together with startChains, see the
  // pendingWinCascadeRef effect below): once state IS the current state, and the win is revealed, exactly those piles'
  // real Aces blank - not a moment earlier. Blanking on winRevealed alone left the four piles EMPTY for the few frames
  // it takes the effect to measure and mount the ghosts (the Aces teleported away, then the ghosts appeared). Compared
  // by identity (state is replaced wholesale on every change) so an undo or a New Game un-blanks the piles with no
  // reset to remember; per pile so a pile whose chain could not start stays up instead of vanishing.
  const [cascadeHandoff, setCascadeHandoff] = useState<{ state: AcesUpState; piles: ReadonlySet<number> } | null>(null)
  // A dead board is a loss, recorded when the player leaves it (see useStuckLossCheck). AcesUpController.isStuck's own
  // `!isWon(state)` guard keeps a won board from also reading as dead.
  const { stuck } = useStuckLossCheck(AcesUpController, state, 'acesup', recordDealAbandoned)
  /** Flights (each carrying the DragFlightHandle already returned by the ghost.show() that started
   * it) awaiting their own post-commit measurement + flyTo, queued by tap-to-move-to-empty,
   * tap-to-discard, and undo of either - a list (not a single slot), since these can now genuinely
   * overlap (see PATTERN_OVERLAP_GATE): two entries queued in the same commit would otherwise
   * clobber each other in a single ref slot, permanently stranding whichever one lost. Each entry
   * carries its own already-created flight to fly/hide once measured, and its own flyingId to
   * remove exactly its own `flying` entry once it lands - see the [state]-effect below. `viaStock`
   * measures via stockViewRef (a plain View, not per-card) instead of CardRegistry - only undoing a
   * round deal flies back toward the stock. `viaDiscard` similarly measures via discardViewRef - a
   * forward discard's card is no longer registered anywhere once it lands (DiscardCell doesn't
   * register in CardRegistry - see its own doc comment), so its destination has to be the pile's
   * own fixed position, not a per-card lookup. `gen` guards against a "New Game" tapped mid-flight
   * replacing the deal this flight was measuring against (card ids are shuffle-independent and
   * reused across deals - see engine/deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; viaDiscard?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  /** A round deal (4 cards, one per pile) awaiting its post-commit measurement + deal.start() -
   * mirrors Spider's/Scorpion's own stock-deal pattern, fixed at exactly NUM_PILES destinations. A
   * list (not a single slot), same reasoning as Klondike's own pendingDealDrawRef: handleDrawStock
   * isn't gated on "no round deal already pending" (only on undoBusyRef), so a rapid double-tap of
   * the stock pile before the first round deal's own [state]-effect has drained can genuinely queue
   * a second entry here before the first is read - a single slot would let the second overwrite the
   * first outright. Each entry carries its own `token`, so a stale one (dealTokenRef bumped by a
   * "New Game" mid-flight) is simply dropped rather than clobbering a fresher one. */
  const pendingRoundDealRef = useRef<{ dealt: { card: Card; pileIndex: number }[]; origin: { x: number; y: number } | null; token: number }[]>([])
  /** An undone round deal awaiting its post-commit measurement + deal.start() - the mirror image
   * of pendingRoundDealRef, same idea as Scorpion's own runUndoStockDeal. Stays a single slot (not a
   * list), unlike pendingRoundDealRef above - a round-deal undo is 'exclusive' (see undoGate: it
   * starts only once nothing is in the air, and no other undo starts until it has landed), so at most
   * one of these can ever be pending at a time. Mirrors Klondike's own pendingCascadeUndoRef for the
   * identical reasoning. */
  const pendingUndoRoundDealRef = useRef<{ entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null; releasePending: () => void }[]; token: number } | null>(null)
  /** Every take-off hold (cardFacePaint.ts) the latest round-deal undo took on the cards it flies back (handleUndo). Each one
   * also travels with its own card - pendingUndoRoundDealRef, runUndoRoundDeal, then deal.start, which gives it back at that
   * card's take-off - and is kept here too so New Game/restore can give back, ahead of their own commit, whatever is still out
   * at whichever of those stages: the deal's own cancel only comes with the fresh game's initial deal, a commit and a
   * measurement later, and until then each card still held would be drawn by its pile over the fresh board. A release is
   * safe to run twice (markGhostPending), so this is never pruned, only replaced by the next round-deal undo - which waits for
   * every flight to settle, so the previous one's holds have all been given back by then. Same as Spider's undoDealHoldsRef. */
  const undoRoundDealHoldsRef = useRef<(() => void)[]>([])
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    const s = AcesUpController.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingRoundDealRef.current = []
    pendingUndoRoundDealRef.current = null
    // Before the fresh board commits: a card a round-deal undo still holds would be drawn over it (see undoRoundDealHoldsRef).
    undoRoundDealHoldsRef.current.forEach((release) => release())
    session.reset()
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    setDealHiddenIds(new Set(s.piles.flat().map((c) => c.id)))
    scheduleDeal(myToken)
    commitState(s)
  }

  function restoreGame(saved: SavedGame<AcesUpState>) {
    ++dealTokenRef.current
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingRoundDealRef.current = []
    pendingUndoRoundDealRef.current = null
    undoRoundDealHoldsRef.current.forEach((release) => release()) // see startNewGame
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    // Optional for backward compatibility: a save written before the discard pile existed has no
    // `discard` field at all - same reasoning as SavedGame's own optional undoStack.
    commitState({ ...saved.state, discard: saved.state.discard ?? [] })
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss, same as every
  // other game's own "left mid-game" path) - GameChrome only ever calls this after the player has
  // confirmed that, or immediately when there's nothing to lose. The LossBanner's New Game comes
  // here too: a dead board's loss is recorded when the player leaves it (see useStuckLossCheck).
  function handleNewGame() {
    if (session.moves > 0 && !won) recordDealAbandoned('acesup')
    startNewGame()
  }

  async function runDeal(s: AcesUpState, token: number) {
    const sequence = buildAcesUpDealSequence(s.piles)
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
      entries.push({ cardId: step.cardId, card: step.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: step.visitOrder * dealStaggerMs(sequence.length) })
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
    const pending = pendingWinCascadeRef.current
    // Only once the win is REVEALED (winRevealed - which waits for the winning discard's flight to land,
    // then holds a beat, see useWinReveal), not on the winning commit: that discard is still travelling
    // to the discard pile then.
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    // The win cascade needs a real chain of cards - the 4 remaining Aces, one per pile, each launching from
    // the spot its own real Ace stands on. That spot is the Ace's own registered rect (CardRegistry): the
    // pile's plain container is NOT usable - with a card in it PileView's container is as tall as the whole
    // column (maxHeight), and a chain origin must be card-sized (the ghost overlay converts it through the card's
    // centre when the board is rotated). The registry only knows cards that are still rendered, so this runs
    // while the piles are STILL on screen and they blank only afterwards, once the ghosts are on screen
    // (cascadeHandoff, set from startChains' onShown - in the commit the ghosts appear, which waits for the
    // parked Aces' faces to paint; see WinCascadeLayer's CascadeChains): blanking first left the four piles empty
    // until the ghosts arrived, and blanking in the commit that mounted them showed four blank-faced Aces for a
    // frame or two. An undo or New Game before then clears the cascade, which drops the callback (and the
    // hand-off is keyed to this `state` anyway). A pile whose Ace cannot be measured starts no chain and simply
    // stays up under the banner instead of vanishing (an empty cascade never calls onShown).
    ;(async () => {
      const origins = await Promise.all(state.piles.map((pile) => (pile.length > 0 ? ghost.cardRegistry.measure(pile[0].id) : null)))
      if (dealTokenRef.current !== pending.gen) return
      const started = new Set<number>()
      const chains: ChainSpec[] = []
      state.piles.forEach((pile, i) => {
        const origin = origins[i]
        if (pile.length === 0 || !origin) return
        started.add(i)
        chains.push({ cards: pile, origin: { x: origin.x, y: origin.y }, entranceDelayMs: 0 })
      })
      winCascade.startChains(chains, cardWidth, () => setCascadeHandoff({ state, piles: started }))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        const landed = p.viaStock ? await measureView(stockViewRef.current) : p.viaDiscard ? await measureView(discardViewRef.current) : await ghost.cardRegistry.measure(p.cardId)
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

  // A round deal counts as exactly ONE flight-completion for startFlights/settleFlight purposes
  // (claimed once by handleDrawStock, settled once here) - mirrors how Klondike's own draw-3/
  // recycle multi-card deals count as one completion, not N (see handleDrawStock's own
  // beginFlying(..., drawnCount) - one flying ENTRY covering several cards - and its matching single
  // settleFlight() call once the whole deal.start() lands). This round deal doesn't touch the
  // `flying` array at all (unlike a drag/tap flight) - its cards hide/reveal via dealHiddenIds, the
  // same mechanism the initial deal uses - so settleFlight() here exists purely to release
  // handleDrawStock's own startFlights(1) claim once this deal is genuinely done (landed, or
  // abandoned because a measurement failed or a newer deal replaced it).
  async function runRoundDeal(dealt: { card: Card; pileIndex: number }[], origin: { x: number; y: number } | null, token: number) {
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
    if (pendingRoundDealRef.current.length === 0 || !state) return
    const pending = pendingRoundDealRef.current
    pendingRoundDealRef.current = []
    pending.forEach((p) => runRoundDeal(p.dealt, p.origin, p.token))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Same one-completion accounting as runRoundDeal above - settleFlight() here releases the single
  // startFlights(1) claim handleUndo made for this whole round-deal-undo branch, whichever of the
  // three exits below is actually taken. Likewise each card's take-off hold (handleUndo marks it, so its pile keeps drawing
  // it where it was): it goes to deal.start with its card, which gives it back at that card's take-off, and every way out of
  // here without a flight for a card gives its hold back at once, so a pile never keeps drawing a card that is not leaving.
  async function runUndoRoundDeal(entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null; releasePending: () => void }[], token: number) {
    const releaseAll = () => entries.forEach((e) => e.releasePending())
    const destination = await measureView(stockViewRef.current)
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
    const pending = pendingUndoRoundDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingUndoRoundDealRef.current = null
    runUndoRoundDeal(pending.entries, pending.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    loadGameInProgress<AcesUpState>('acesup').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('acesup')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deliberately not keyed on a ticking elapsed-seconds value the way an earlier version of this effect
  // was: `session.getElapsed()` computes the true current elapsed from wall-clock time on demand (see
  // useGameSession.ts), but a save still holds the elapsed time from when it was made, so
  // useSaveInProgressBackstop saves again every 10s, when the screen is left, and when the app is
  // backgrounded.
  useEffect(() => {
    if (state && !won && !stuck) saveGameInProgress('acesup', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, stuck, undoStack])
  useSaveInProgressBackstop(!!state && !won && !stuck, () => {
    if (state && !won && !stuck) saveGameInProgress('acesup', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() rules.ts already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint(request?: HintRequest) {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(AcesUpController, state, skip)
    if (result.kind === 'none') {
      if (!request?.auto) infoToast('No helpful moves right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('acesup')
    if (result.kind === 'move') {
      const { from, to } = result.move
      const source = state.piles[from.index]
      // The discard isn't a drop zone (and its top isn't a registered card): land on its own card-sized container.
      const toDiscard = to.zone === 'discard'
      void playHintGlide({ moving: source.slice(-1), dest: toDiscard ? [] : state.piles[to.index], destFanned: true, slot: toDiscard ? undefined : to, measureSlot: toDiscard ? () => measureView(discardViewRef.current) : undefined, cardWidth })
    }
  }

  function pushUndo(prev: AcesUpState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // One undo per call - see useFlightConcurrency's runUndo.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // A discard's or a move's undo takes its card back off the pile it went to (the discard, or the
  // empty pile it was moved into), so it overlaps the undos before it once nothing is still landing
  // there. A round deal's flies four cards back through the deal layer - one at a time, and only
  // once nothing else is in the air: the deal layer never touches the `flying` array (see
  // runRoundDeal's own doc comment), so only the flight count reports it as in-flight.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!entry || !stateRef.current) return null
    return entry.move ? { takesFrom: [entry.move.to] } : 'exclusive'
  }

  // Every branch below claims exactly one flight (startFlights(1)) and settles it exactly once -
  // Aces Up has no cascaded/auto-played moves riding along (unlike Klondike's undo, which can claim
  // 2), so a single claim always covers the whole call.
  async function revertTopUndo() {
    // The stack and the board are read via their refs, not the closure: undos can run back-to-back
    // before React re-renders (see runUndo).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    startFlights(1)
    if (won) winCascade.clear()
    const { move, state: prevState } = entry

    if (!move) {
      const myToken = ++dealTokenRef.current
      const dealtCards = current.piles.map((pile) => top(pile)!)
      const origins = await Promise.all(dealtCards.map((c) => ghost.cardRegistry.measure(c.id)))
      // New Game/restore replaced the game while these were measured (Spider's handleUndo has the same guard): `prevState` is
      // the old game's board, and every claim (this undo's included) was reset with it - so nothing is committed, marked or
      // settled. (A draw, the only other thing that bumps the token, is refused while undo is busy.)
      if (dealTokenRef.current !== myToken) return

      setUndoStack((stack) => stack.slice(0, -1))
      // Taking off from their piles: the commit below takes these cards out of them, but each card's ghost only shows once
      // the stock has been measured (the commit after this one), the deal pool has mounted and the card's own stagger has run
      // out (up to 3 x DEAL_STAGGER_MS) - and the piles used to drop them at once, so the round vanished from the board and
      // came back as ghosts one by one. Each is marked here, in the same synchronous stretch as the commit, with a mark of its
      // own (cardFacePaint.ts), so its pile keeps drawing the very card it had (PileView's held cards) until that card's own
      // ghost takes off over it - DealLayer gives each back then (releasePending), and runUndoRoundDeal/New Game give back any
      // that will never fly. A card that could not be measured gets no ghost, so it holds nothing.
      const entries = dealtCards.map((c, i) => ({ card: c, delayMs: i * DEAL_STAGGER_MS, origin: origins[i], releasePending: origins[i] ? markGhostPending([c.id]) : () => {} }))
      undoRoundDealHoldsRef.current = entries.map((e) => e.releasePending)
      pendingUndoRoundDealRef.current = {
        entries,
        token: myToken
      }
      commitState(prevState)
      return
    }

    // Undoing a discard: the mirror image of the forward flight - a ghost shown at the discard
    // pile's own (fixed) position flies back to the card's original pile, landing via the same
    // pendingFlightRef effect every other "fly to a tableau destination" flight already uses
    // (CardRegistry, keyed on the card's id, since prevState's own re-render re-registers it there).
    if (move.to.zone === 'discard') {
      const discardCard = current.discard[current.discard.length - 1]
      const origin = discardCard && discardCard.id === move.anchorCardId ? await measureView(discardViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))

      if (origin && discardCard) {
        playCardSound()
        hapticCard()
        const flight = ghost.show({ cards: [discardCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
        const flyingId = beginFlying(move.from, 1)
        commitState(prevState)
        pendingFlightRef.current.push({ cardId: move.anchorCardId, gen: dealTokenRef.current, flyingId, flight })
      } else {
        commitState(prevState)
        settleFlight()
      }
      return
    }

    const movingCard = top(current.piles[move.to.index])
    const origin = movingCard && movingCard.id === move.anchorCardId ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin && movingCard) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(move.from, 1)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, gen: dealTokenRef.current, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // Shared tail for both tap-to-move (handleCardTap) and a manual drag's drop (handleDrop below) -
  // applies the move, pushes undo, and sets up the post-commit flight measurement. The flight is
  // already showing by the time this runs (handleCardTap's own ghost.show() for a tap, or the drag
  // gesture's own pickup-time ghost.show() for a drop, handed in as `flight`) - this only ever
  // decides where it flies to: a discard lands via discardViewRef's fixed position (see
  // pendingFlightRef's viaDiscard), a move to an empty pile via the destination pile's own
  // CardRegistry registration, same as every other tap-to-move flight in this app.
  function applyMove(from: PileRef, to: PileRef, card: Card, flight: DragFlightHandle): boolean {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - handleCardTap/handleDrop are both allowed to overlap each other (see
    // PATTERN_OVERLAP_GATE), so each must build its own tryMove on top of whatever the OTHER's
    // commitState just did, not the same stale board both closures captured. Their own hint/card
    // lookups upstream of this can stay closure-based (see handleCardTap) - tryMove re-validates the
    // move against the real current board here regardless, so a slightly stale hint just fails
    // cleanly instead of corrupting anything.
    const current = stateRef.current
    if (!current) return false
    const result = AcesUpController.tryMove(current, { from, to, count: 1 })
    if (!result) return false
    pushUndo(current, { from, to, count: 1, anchorCardId: card.id })
    commitState(result)
    session.registerMove()
    const flyingId = beginFlying(to, 1)
    pendingFlightRef.current.push({ cardId: card.id, viaDiscard: to.zone === 'discard', gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  // True if `pileIndex`'s own top card has ANY legal move (discard or move-to-empty) - the signal
  // PileView needs (via drag.getRunCount below) to treat a card as tappable/draggable at all; see
  // this file's own header comment for why even a tap-only interaction still needs a real drag
  // config wired up.
  function hasLegalMove(pileIndex: number): boolean {
    if (!state || !AcesUpController.autoMoveHint) return false
    const card = top(state.piles[pileIndex])
    if (!card) return false
    return !!AcesUpController.autoMoveHint(state, { zone: 'tableau', index: pileIndex }, card.id)
  }

  // Tapping a pile's top card discards it if legal, otherwise moves it to fill an empty pile if
  // one exists, otherwise shakes to say "nowhere to go" - see rules.ts's autoMoveHint for the
  // exact priority. The move applies immediately (game logic never waits on an animation); a
  // ghost copy shown at the tapped origin then flies to wherever it actually landed, mirroring
  // every other tap-to-move handler in this app (e.g. KlondikeScreen's own handleCardTap).
  async function handleCardTap(pileIndex: number, card: Card, measure: () => Promise<{ x: number; y: number }>) {
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    if (won || stuck || !state) return
    const move = AcesUpController.autoMoveHint!(state, { zone: 'tableau', index: pileIndex }, card.id)
    if (!move) {
      setShake({ cardId: card.id, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }
    // Claimed synchronously before the await below (see PATTERN_OVERLAP_GATE) - so undo (the only
    // thing that still waits on activeFlightCountRef) sees this tap as in-flight for its whole
    // duration, not just once applyMove lands one.
    startFlights(1)
    const origin = await measure()
    if (undoBusyRef.current) {
      settleFlight()
      return
    }
    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: [card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    if (!applyMove(move.from, move.to, card, flight)) {
      flight.hide()
      settleFlight()
    }
  }

  // A manual drag's drop - PileView's own handleDragEnd already resolves the drop target via
  // dropZones.hitTest before calling this (see PileDragConfig's own doc comment), so this only
  // ever needs to apply the move. Only ever resolves for "move onto an empty pile" in practice -
  // there's no registered drop zone for a discard (see this file's header comment).
  function handleDrop(pileIndex: number, to: PileRef, anchorCardId: string, flight: DragFlightHandle): boolean {
    if (undoBusyRef.current) return false // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    if (won || stuck || !state) return false
    const card = top(state.piles[pileIndex])
    if (!card || card.id !== anchorCardId) return false
    // Claims a flight slot (see activeFlightCountRef's doc comment) purely so undo sees this drop
    // as in-flight for its whole duration, not just once applyMove lands one - mirrors Klondike's
    // own tableau onDrop.
    startFlights(1)
    if (!applyMove({ zone: 'tableau', index: pileIndex }, to, card, flight)) {
      settleFlight()
      return false
    }
    return true
  }

  async function handleDrawStock() {
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    // Without this, rapid-tapping the stock pile several times before React re-renders would deal
    // the SAME round repeatedly (every call computing drawStock() against the same stale board)
    // instead of dealing several different rounds in a row.
    const current = stateRef.current
    if (won || stuck || !current || !AcesUpController.drawStock) return
    const result = AcesUpController.drawStock(current)
    if (!result) return
    // Read the dealt cards off the POST-deal state (rules.ts's drawStock already sets faceUp:
    // true on each) rather than the pre-deal stock, so the flight below shows each card's real,
    // revealed face throughout - the same "a stock draw flies showing what it really is" precedent
    // Golf/Klondike's own single-card stock draws already establish, not a face-down mystery card.
    const dealt = result.piles.map((pile, pileIndex) => ({ card: top(pile)!, pileIndex }))
    session.registerMove()
    pushUndo(current, null)
    // A round deal counts as one flight-completion (see runRoundDeal's own doc comment) - claimed
    // here, settled once inside runRoundDeal regardless of which of its exits is actually taken.
    startFlights(1)

    const myToken = ++dealTokenRef.current
    const origin = await measureView(stockViewRef.current)

    setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
    pendingRoundDealRef.current.push({ dealt, origin, token: myToken })
    commitState(result)
  }

  if (!state) return <GameLoading />

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Aces Up' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} autoHintKey={state} hintShowing={!!activeHint} hintDisabled={won || stuck} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} pauseClock={session.setPaused} clockRunning={session.started && !won && !stuck} movesCount={session.moves} rules={ACESUP_RULES}>
        <View style={[styles.topRow, { width: pilesWidth }]}>
          <DiscardCell card={state.discard[state.discard.length - 1]} isFlyingHere={flying.some((f) => f.to.zone === 'discard')} viewRef={discardViewRef} />
          <View ref={stockViewRef} collapsable={false}>
            <PlayingCard card={STOCK_DISPLAY_CARD} onPress={handleDrawStock} disabled={state.stock.length === 0} hinted={activeHint?.kind === 'drawStock'} />
          </View>
        </View>

        <View style={[styles.pilesRow, { gap }]}>
          {state.piles.map((pile, pileIndex) => {
            const hiddenCount = flying.filter((f) => f.to.zone === 'tableau' && f.to.index === pileIndex).reduce((sum, f) => sum + f.count, 0)
            // Hidden entirely once the win is revealed AND the cascade has taken this pile over (see the
            // pendingWinCascadeRef effect above) - the same way every other game's own final pile display
            // goes blank once its cascade takes over. NOT on `won` itself: that flips with the winning
            // discard, whose card is still flying, and the finished board should read for a beat first. And
            // not on `winRevealed` alone either: the effect measures the still-rendered Aces first, and the
            // piles blank only once the ghosts are on screen with their faces painted (cascadeHandoff, set from
            // startChains' onShown).
            const cards = winRevealed && cascadeHandoff?.state === state && cascadeHandoff.piles.has(pileIndex) ? [] : pile
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              // Only ever the true top card (indexFromTop === 0) - Aces Up never moves more than
              // one card at a time. Gated on hasLegalMove so PileView only treats this card as
              // tappable/draggable when rules.ts's autoMoveHint would actually find it a move (see
              // this file's own header comment on why a real drag config is required either way).
              getRunCount: (indexFromTop) => (indexFromTop === 0 && hasLegalMove(pileIndex) ? 1 : 0),
              onDrop: (to, _count, anchorCardId, flight) => handleDrop(pileIndex, to, anchorCardId, flight)
            }
            return (
              <DropZone key={pileIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: pileIndex }} style={[styles.pile, { width: cardWidth }]}>
                <PileView cards={cards} onPressCard={(card, _indexFromTop, measure) => handleCardTap(pileIndex, card, measure)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} shakeCardId={shake?.cardId} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: pileIndex })} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {winRevealed && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
      {stuck && !won && <LossBanner onNewGame={handleNewGame} onUndo={handleUndo} />}
    </CardSizeProvider>
  )
}

function makeStyles() {
  return StyleSheet.create({
    pile: {},
    pilesRow: {
      flexDirection: 'row',
      paddingBottom: 20
    },
    topRow: {
      // Spans pilesRow's own width (set inline via pilesWidth) and spaces its two children apart -
      // discard on the left, stock on the right - mirroring Pyramid's controlRow.
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16
    }
  })
}
