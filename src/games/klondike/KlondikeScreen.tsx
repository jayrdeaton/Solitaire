import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { HintRequest } from '@/components/autoHint'
import { isGhostPending, subscribeGhostPending } from '@/components/cardFacePaint'
import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS, dealStaggerMs } from '@/components/dealing/dealSpring'
import { measureView, ScreenPoint } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { FLIGHT_SPRING } from '@/components/dragdrop/dragSpring'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { wasteFanScreenShift } from '@/components/overlayFrame'
import { PileDragConfig, PileView } from '@/components/PileView'
import type { StockRequestOptions } from '@/components/stockHold'
import { StockWaste } from '@/components/StockWaste'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { wasteFanStepFor } from '@/components/wasteFan'
import { PipFireworks } from '@/components/winning/PipFireworks'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { KLONDIKE_RULES } from '@/constants/gameRules'
import { AutoCompleteStep, findSafeAutoPlay, isFullyAutoCompletableWithDraws, nextAutoCompleteMoveWithDraws } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { parFor } from '@/engine/par'
import { isDescendingAltColor, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { klondikeVariant } from '@/engine/variants'
import { useCascadeFeedback } from '@/games/shared/cascadeFeedback'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { showNoHintToast } from '@/games/shared/gameToasts'
import { liftTappedRun, peelInAir } from '@/games/shared/inAirRun'
import { createStockQueue, startStockWait, stockWaitTick } from '@/games/shared/stockWait'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useAutoFinish } from '@/games/shared/useAutoFinish'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useHintGlide } from '@/games/shared/useHintGlide'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useUndoStack } from '@/games/shared/useUndoStack'
import { useWinReveal } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { useSettings } from '@/hooks/useSettings'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { buildKlondikeDealSequence } from './dealSequence'
import { KlondikeSettingsSection } from './KlondikeSettingsSection'
import { canAutoFinish, createKlondikeController, KlondikeState, nextFinishMove } from './rules'
const TABLEAU_COLUMNS = 7
const WASTE: PileRef = { zone: 'waste', index: 0 }
const STOCK: PileRef = { zone: 'stock', index: 0 }

/** This game's own undo-move shape (see undoTypes.ts's TMove generic): `primary` is the move that
 * produced the very next state (same as every other game's plain MoveInfo|null). Every step, an
 * auto-played one included (a silent auto-play-to-foundation move, see applyMove's `opts.silent`,
 * and each draw/recycle/draw-and-play of the win-completing sweep), now pushes its own entry, so
 * `cascaded` is always empty for a new entry. It is kept only for saves written before that, when
 * those steps were folded into the entry of the move that set them off, in the order they happened,
 * and one Undo press took them all back (see handleUndo and runCascadeReturn, which still fly those
 * back). */
interface KlondikeUndoMove {
  primary: MoveInfo | null
  cascaded: MoveInfo[]
}

/** Every container-ref position a legacy cascaded move's (see KlondikeUndoMove) reverse flight might
 * need as its origin or destination, pre-measured once up front in handleUndo (all three are cheap,
 * content-independent refs). A cascaded move's own `to`/`from` zone picks which of these applies
 * (see originForCascadedMove/isStockDestinedMove below) - an ordinary auto-played card still uses
 * `foundation` exactly as before; only the newer stock-cycling-during-a-win moves ever reach for
 * `stock`/`waste` instead. */
interface CascadeOrigins {
  foundation: ({ x: number; y: number } | null)[]
  stock: { x: number; y: number } | null
  waste: { x: number; y: number } | null
}

/** Where a cascaded move's reverse flight starts FROM - wherever the card currently sits, i.e.
 * `m.to` (the pile the forward move landed it in). Every ordinary auto-played card's `to` is a
 * foundation slot, unchanged from before this move's own draws-aware extension; a stock-cycling
 * move's `to` can also be 'stock' (reversing a recycle) or 'waste' (reversing a plain draw). */
function originForCascadedMove(m: MoveInfo, origins: CascadeOrigins): { x: number; y: number } | null {
  if (m.to.zone === 'stock') return origins.stock
  if (m.to.zone === 'waste') return origins.waste
  return origins.foundation[m.to.index] ?? null
}
type KlondikeUndoEntry = UndoEntry<KlondikeState, KlondikeUndoMove>
// A save written before this shape existed stored `move` as a bare MoveInfo | null (see
// normalizeUndoEntry below) - restoreGame accepts either shape from disk.
type LegacyKlondikeUndoEntry = UndoEntry<KlondikeState>

function normalizeUndoEntry(e: KlondikeUndoEntry | LegacyKlondikeUndoEntry): KlondikeUndoEntry {
  const m = e.move as KlondikeUndoMove | MoveInfo | null
  if (m && typeof m === 'object' && 'cascaded' in m) return { state: e.state, move: m }
  return { state: e.state, move: { primary: m, cascaded: [] } }
}

export default withGameProviders(KlondikeScreenInner)

function KlondikeScreenInner() {
  const { styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  const controllerRef = useRef(createKlondikeController(settings.klondikeDraw))
  // The draw count of the game currently in progress - only updated when a new game actually
  // starts (mount, or the New Game button below), always reading the live `settings.klondikeDraw`
  // at that moment. Deliberately NOT derived directly from `settings.klondikeDraw` on every
  // render: the in-progress game's own controller/rules must stay fixed to whatever draw count it
  // was dealt with, even if the player changes the setting mid-game without starting a new deal.
  const [klondikeDraw, setKlondikeDraw] = useState<1 | 3>(settings.klondikeDraw)
  // The deal's game under the rule it was dealt with: what its stats and par are kept for (engine/variants.ts).
  const variant = klondikeVariant(klondikeDraw)
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with
  // each other - PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`,
  // `commitState`, `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working
  // unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, isLanding, shrinkFlying, shrinkLanding, landingCount, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<KlondikeState>()
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<KlondikeUndoEntry>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: KlondikeState; skip: number } | null>(null)
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
  // Sized by the width alone, in both layouts: in the wide layout a column too long for the ~400pt of height scrolls
  // rather than shrinking every card to fit it (Jay, 2026-10-14: big cards in landscape, and scroll a bit sometimes).
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth)
  const ghost = useDragGhost()
  const playHintGlide = useHintGlide(state, ghost.cardRegistry, dropZones)
  const rotation = useRotation()
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  /** Waste slot's own wrapping View, for measuring its screen position as a group-ghost flight's
   * shared origin/destination - a stock recycle moves the whole waste back to stock (or, on undo,
   * back the other way) as one clump, not per-card (see PATTERN_RECYCLE in this fix batch's
   * notes). */
  const wasteViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  // True while the stock slot's own real content is mid-recycle-flight elsewhere and should stay
  // frozen on its outgoing look rather than reveal the incoming one early - see StockWaste's own
  // `stockHidden` prop doc comment.
  const [stockHidden, setStockHidden] = useState(false)
  // Paces the stock taps that had to wait for a flight (see createStockQueue and handleDrawStock).
  const [stockQueue] = useState(createStockQueue)
  // The waste's top card while a turn-over's clump of landed cards takes off with others still in the air (holdWasteTop) - the
  // waste keeps drawing it until the clump's ghost is on screen. Null the rest of the time.
  const [wasteTakeOff, setWasteTakeOff] = useState<Card | null>(null)
  // Extra waste-slot hidden count contributed by a legacy save's cascaded auto-play cards flying
  // back onto the waste during an undo (see PATTERN_CASCADE_UNDO) - added on top of `flying`'s own
  // waste count in the StockWaste wasteHiddenCount prop below, since the two can be simultaneously
  // true (the primary move undoing back to a foundation/tableau slot while a cascaded card
  // independently returns to waste).
  const [cascadeWasteHiddenCount, setCascadeWasteHiddenCount] = useState(0)
  // Suits whose win-cascade origin measurement failed (see runWinCascade) - that suit's real
  // foundation card un-hides immediately instead of staying hidden forever with no ghost ever
  // covering for it (mirrors Pyramid's own fallback for the same rare failure mode).
  const [winCascadeFallbackSuits, setWinCascadeFallbackSuits] = useState<Set<number>>(new Set())
  // The board the win cascade has taken over from (set once its ghosts are on screen - startChains' onShown, see
  // runWinCascade): once it IS the current state, and the win is revealed, the real foundation cards blank - not a moment
  // earlier, or the piles would sit empty (or under blank ghosts) until the cascade's ghosts can be seen. Compared by
  // identity (state is replaced wholesale on every change) so an undo or a New Game un-blanks the piles with nothing
  // to reset, and a re-win after an undo (which never relaunches the cascade) can never blank piles with no ghosts.
  const [cascadeHandoffFor, setCascadeHandoffFor] = useState<KlondikeState | null>(null)
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Reads controllerRef.current live inside isWon (rather than passing controllerRef.current
  // directly, which would freeze this render's controller into checkWin's closure) - matches the
  // original inline checkWin, which re-dereferenced controllerRef.current at call time so a
  // straggling call from a stale render's closure chain still checks against the CURRENT
  // controller, same as every other controllerRef.current read in this file.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: KlondikeState) => controllerRef.current.isWon(s) }, variant, session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing animating and the initial deal finished - what the auto-play cascade below waits for, and
  // what the win celebration waits for too (see useWinReveal). activeFlightCount is claimed before
  // every flight's own async measurement (tap, drop, auto-play, stock draw, undo) and released only
  // once it has landed, so it covers the winning card's flight too.
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0
  // `won` is game state (clock, stat, save, undo/hint gating) and flips with the winning move; the
  // celebration - foundations giving way to the win cascade, fireworks, banner - waits until the
  // last card has flown in and landed, so it is never hidden mid-flight (which used to make it
  // simply appear) and the finished board reads for a beat first.
  const winRevealed = useWinReveal(won, settled)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can find each pile's screen position whether
   * or not its real King is drawn (the container is card-sized and always mounted; the piles only
   * blank once the cascade has taken over, see cascadeHandoffFor in runWinCascade). */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  /** Flights awaiting their post-commit measurement + flight.flyTo, queued by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), undo, and auto-play (fireAutoMove) -
   * a list (not a single slot) since these can now genuinely overlap (see PATTERN_OVERLAP_GATE):
   * two entries queued in the same commit would otherwise clobber each other in a single ref slot,
   * permanently stranding whichever one lost. Each entry carries its own already-created
   * DragFlightHandle (from whichever call site queued it - or, for a drag's own drop, handed in via
   * PileDragConfig.onDrop/DraggableCard's onDrop) to fly/hide once measured, and its own flyingId to
   * remove exactly its own `flying` entry once it lands - see the [state]-effect below. `viaStock`
   * measures via stockViewRef (a plain View, not per-card) instead of CardRegistry - only undoing a
   * stock draw flies back toward the stock; every other destination is a real per-card-registered
   * pile. `gen` is the `dealTokenRef` value at the moment this flight was queued - re-checked once the async
   * measurement below resolves, so a flight queued against a game that's since been replaced by
   * "New Game" doesn't measure/land against the new deal's DOM (card ids are shuffle-independent
   * and reused across deals - see deck.ts). Mirrors exactly how runDeal below already guards itself
   * with dealTokenRef/pendingDealTokenRef. `to` is the pile the flight is headed to, so a failed
   * per-card lookup can still land on that pile's own container (see the [state]-effect below). */
  const pendingFlightRef = useRef<{ cardId: string; to: PileRef; viaStock?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  /** Draw-3 stock draws awaiting their post-commit measurement + deal.start() - a list for the same
   * overlapping-actions reason as pendingFlightRef above. Analogous shape, for the multi-card
   * deal-style flight (see the [state]-effect below and handleDrawStock) - drawnCards is
   * oldest-first, ending with the new top/frontmost card. `gen`/`flyingId` guard the same races
   * pendingFlightRef's do, above. */
  const pendingDealDrawRef = useRef<{ topCardId: string; drawnCards: Card[]; gen: number; flyingId: number }[]>([])
  /** A legacy save's cascade-return flight (see KlondikeUndoMove/PATTERN_CASCADE_UNDO) awaiting its
   * post-commit destination measurement + deal.start(), analogous to pendingDealDrawRef above -
   * `origins` is each foundation slot's own measured position (index-aligned with
   * foundationSlotRefs/SUITS), captured synchronously in handleUndo (a container ref,
   * content-independent, safe to measure before the state revert commits) since the cascaded cards
   * themselves have no CardRegistry entry once buried under a later foundation arrival. Stays a
   * single slot (not a list) - an entry with a cascade is an 'exclusive' undo (see undoGate: it
   * starts only once nothing is in the air, and no other undo starts until it has landed), so at most
   * one of these is ever pending at a time. */
  const pendingCascadeUndoRef = useRef<{ moves: MoveInfo[]; origins: CascadeOrigins; gen: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const cascadeFeedback = useCascadeFeedback(playCardSound, hapticCard)
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    // A cascade or finish still running from the old deal must not carry on into this one, and a new deal that happens to be
    // solved is not filed away until the player's own first move (see useAutoFoundationCascade's disarm, useAutoFinish's suppress).
    finish.suppress()
    cascade.disarm()
    controllerRef.current = createKlondikeController(settings.klondikeDraw)
    setKlondikeDraw(settings.klondikeDraw)
    const s = controllerRef.current.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingDealDrawRef.current = []
    pendingCascadeUndoRef.current = null
    setStockHidden(false)
    setWasteTakeOff(null)
    setCascadeWasteHiddenCount(0)
    setWinCascadeFallbackSuits(new Set())
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
    setDealHiddenIds(dealtIds)
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment). `saved.config` is the draw
  // count the game was actually dealt under (see settings.klondikeDraw's own doc comment above for
  // why that can differ from the live setting) - falls back to the live setting only if the saved
  // value is somehow missing/invalid.
  function restoreGame(saved: SavedGame<KlondikeState, KlondikeUndoEntry | LegacyKlondikeUndoEntry>) {
    ++dealTokenRef.current
    // Nothing auto-plays on a resumed board until the player's own next play of a card to a foundation (the cascade, and the
    // finish if the board is solved).
    finish.suppress()
    cascade.disarm()
    const draw = saved.config === 1 || saved.config === 3 ? saved.config : settings.klondikeDraw
    controllerRef.current = createKlondikeController(draw)
    setKlondikeDraw(draw)
    // A save written before the cascade-undo fix stored `move` as a bare MoveInfo | null, not this
    // game's now-richer { primary, cascaded } shape - normalize rather than crash the first time
    // handleUndo reads `.primary`/`.cascaded` off something that's actually just a MoveInfo.
    setUndoStack((saved.undoStack ?? []).map(normalizeUndoEntry))
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingDealDrawRef.current = []
    pendingCascadeUndoRef.current = null
    setStockHidden(false)
    setWasteTakeOff(null)
    setCascadeWasteHiddenCount(0)
    setWinCascadeFallbackSuits(new Set())
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    commitState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned(variant)
    startNewGame()
  }

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using.
  async function runDeal(s: KlondikeState, token: number) {
    const sequence = buildKlondikeDealSequence(s.tableau)
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
        // Flies face-down regardless of step.card's real faceUp - a real dealer lays every card
        // down blind and only turns the top one face-up after it's placed, not while it's still
        // sliding across the table. The real card underneath (revealed the instant this ghost
        // lands - see dealHiddenIds above) already carries the correct true faceUp, so forcing it
        // here only affects this flight's own appearance, never the card actually dealt.
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

  // Foundation piles are guaranteed full (13 cards each, Ace..King) the instant isWon() is true -
  // measures each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef),
  // not the King via CardRegistry (a container is measurable whether or not the pile's real card
  // is drawn). Chains that whole pile King-first/head down to Ace-last/tail (foundation arrays are
  // built bottom-up, Ace pushed first, so reversing gives the right order).
  //
  // This runs while the real foundation cards are STILL on screen: the piles blank only afterwards,
  // once the cascade's ghosts are on screen (cascadeHandoffFor, set from startChains' onShown - in the
  // commit the ghosts appear, which waits for their parked faces to paint; see WinCascadeLayer's
  // CascadeChains). Blanking on winRevealed alone left every pile empty for the frames this
  // measurement takes (~140ms in a dev bundle) before the ghosts appeared; blanking in the commit
  // that mounted them showed four blank-faced Kings for a frame or two. An undo or New Game before
  // then clears the cascade, which drops the callback (and the hand-off is keyed to `s` anyway).
  // Same dealTokenRef guard as every other async measurement here, for the same "New Game tapped
  // mid-measurement" reason.
  async function runWinCascade(s: KlondikeState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    // A suit whose slot measurement failed (rare) can't get a bounce chain at all - rather than
    // silently omit it (leaving a bare empty placeholder for the rest of the win screen, since
    // the hand-off otherwise blanks every foundation's real card unconditionally below), keep that
    // suit's real top card showing, mirroring Pyramid's own "unhide on failed measurement"
    // fallback for the same rare failure mode.
    const fallbackSuits = new Set<number>()
    s.foundation.forEach((pile, suit) => {
      if (pile.length === 0) return
      const origin = origins[suit]
      if (!origin) {
        fallbackSuits.add(suit)
        return
      }
      chains.push({ cards: pile.slice().reverse(), origin })
    })
    if (fallbackSuits.size > 0) setWinCascadeFallbackSuits(fallbackSuits)
    // A pile with no chain to take over from it is in fallbackSuits above and stays up regardless, so this hand-off
    // never blanks a pile for a chain that did not start (with every suit failed there is no cascade to show, onShown never
    // runs, and all four just stay up under the banner).
    winCascade.startChains(chains, cardWidth, () => setCascadeHandoffFor(s))
  }

  // Same race as the deal effect above: measuring CardRegistry synchronously right after the
  // setState in applyMove/handleDrawStock would find the still-mounted SOURCE card (the
  // destination card's own registration effect hasn't run yet), so the ghost would "fly" a
  // near-zero distance back to roughly where it started - indistinguishable from a snap. Deferring
  // to a [state]-keyed effect guarantees the destination card has already registered by the time
  // this runs.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        // A destination card's registered view is the usual landing spot, but if it can't be found
        // (a foundation card buried under a later arrival, a waste card already covered by the next
        // draw) the pile's own slot container is card-sized and always there - fly to that rather than
        // hiding the ghost and letting the card simply appear. A tableau column has no such container
        // (its card position depends on the fan), so that one still falls through to the hide.
        const landed = p.viaStock ? await measureView(stockViewRef.current) : ((await ghost.cardRegistry.measure(p.cardId)) ?? (p.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[p.to.index]) : p.to.zone === 'waste' ? await measureView(wasteViewRef.current) : null))
        // A new game can start while the measurement above is in flight (e.g. tapping "New Game"
        // mid auto-play-cascade - see maybeAutoPlay). `landed`, if it resolved at all, would then
        // be measuring an unrelated card in the NEW deal (ids are shuffle-independent and reused
        // across deals - see deck.ts), so drop this flight instead of landing on a nonsensical
        // position.
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

  // Same deferral reasoning as the deal/flight effects above - never measure CardRegistry
  // synchronously inside checkWin itself, since the winning foundation cards' own registration
  // effects haven't necessarily run yet in that same commit. Also waits for winRevealed: `won`
  // flips with the winning move, but the cascade must only take over once that move's flight has
  // landed (see useWinReveal), so the pending token is kept until then.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  // Draw-3's own version of the deal effect above: handleDrawStock already committed the new
  // state (so the real top waste card is mounted/registered) but kept the whole fan hidden via
  // `flying`, so this measures where that top card actually landed once it's really there, derives
  // the other drawn cards' fan positions from it (only the true top registers in CardRegistry - see
  // StockWaste), and kicks off a real multi-card deal flight - each newly drawn card flies
  // independently in quick staggered succession, like a mini re-run of the initial deal, instead of
  // one card flying while the rest silently popped in behind it.
  useEffect(() => {
    if (pendingDealDrawRef.current.length === 0 || !state) return
    const pending = pendingDealDrawRef.current
    pendingDealDrawRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        const [origin, topPos] = await Promise.all([measureView(stockViewRef.current), ghost.cardRegistry.measure(p.topCardId)])
        // Same New-Game-mid-flight race as the pendingFlightRef effect above - a game that's since
        // been replaced makes `topPos` (if it resolves at all) measure an unrelated card in the
        // new deal, so bail out rather than fly a deal-style flight toward it.
        if (dealTokenRef.current !== p.gen || !origin || !topPos) {
          endFlying(p.flyingId)
          settleFlight()
          return
        }
        const fanOffset = wasteFanStepFor(cardWidth)
        const n = p.drawnCards.length
        const entries: DealCardSpec[] = p.drawnCards.map((card, i) => {
          const distanceFromTop = n - 1 - i // i=0 is the oldest/farthest card, i=n-1 is the new top
          const shift = wasteFanScreenShift(fanOffset * distanceFromTop, rotation)
          return {
            cardId: card.id,
            card: { ...card, faceUp: true },
            from: origin,
            to: { x: topPos.x + shift.x, y: topPos.y + shift.y },
            delayMs: i * DEAL_STAGGER_MS
          }
        })
        deal.start(
          entries,
          cardWidth,
          () => {
            // Each landed ghost reveals its own slot immediately (see StockWaste's per-slot
            // freezing) - farthest-from-top lands first (smallest delay), so the count shrinks
            // outside-in, front slot last.
            shrinkFlying(p.flyingId)
          },
          () => {
            endFlying(p.flyingId)
            settleFlight()
          },
          undefined,
          FLIGHT_SPRING // every card move's flight time, not the deal's (see DealAnimator.start)
        )
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Declared here, before the effect below that calls it, purely so the effect's reference to it
  // isn't "accessed before declared" (react-hooks/immutability) - function declarations hoist at
  // runtime regardless of source position, so this reorder is a no-op behaviorally.
  async function runCascadeReturn(moves: MoveInfo[], origins: CascadeOrigins, gen: number) {
    // A move whose card is headed back to the stock (reversing a plain draw or a drawAndPlay - see
    // fireDraw/fireDrawAndPlay) has no per-card CardRegistry entry to measure once it lands there -
    // the stock only ever renders as a generic pile, never per-card - so its destination is the
    // same container ref a normal forward draw's ORIGIN already uses instead.
    const destinations = await Promise.all(moves.map((m) => (m.from.zone === 'stock' ? measureView(stockViewRef.current) : ghost.cardRegistry.measure(m.anchorCardId))))
    if (dealTokenRef.current !== gen) {
      settleFlight()
      return
    }
    const s = stateRef.current
    const entries: DealCardSpec[] = []
    const strandedTableauIds: string[] = []
    let strandedWasteCount = 0
    let entryIndex = 0
    moves.forEach((m, i) => {
      const dest = destinations[i]
      const origin = originForCascadedMove(m, origins)
      const pile = s ? resolvePile(m.from, s) : null
      // A single-card move (every ORIGINAL cascaded auto-play) just flies its own anchor. A
      // multi-card one (a cascaded recycle/draw-3 sweep-draw reversal) needs its own recorded
      // m.cardIds - unlike the PRIMARY move's own draw-3/recycle undo branches, this move isn't
      // necessarily the most recent thing that happened to `to`'s pile, so "peek at the current top
      // N cards" can't reliably reconstruct which cards were actually its own. Reversed so the
      // newest/top card leads the reverse flight, same convention those primary-move branches use.
      const ids = m.count > 1 && m.cardIds ? m.cardIds.slice().reverse() : [m.anchorCardId]
      const cards = ids.map((id) => pile?.find((c) => c.id === id)).filter((c): c is Card => !!c)
      if (dest && origin && cards.length === ids.length) {
        cards.forEach((card) => {
          entries.push({ cardId: card.id, card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: entryIndex * DEAL_STAGGER_MS })
          entryIndex += 1
        })
      } else if (m.from.zone === 'tableau') {
        strandedTableauIds.push(m.anchorCardId)
      } else if (m.from.zone === 'waste') {
        strandedWasteCount += m.count
      }
      // m.from.zone === 'stock' needs no stranded-fallback handling - see hideCascadeCards' own
      // comment on why there's nothing to unhide for a card headed back to the stock.
    })
    // A card whose destination measurement failed (a rare edge case) un-hides immediately rather
    // than staying stuck invisible forever - mirrors runDeal's/runWinCascade's own fallback for
    // the same failure mode.
    if (strandedTableauIds.length > 0) {
      setDealHiddenIds((ids) => {
        const next = new Set(ids)
        strandedTableauIds.forEach((id) => next.delete(id))
        return next
      })
    }
    if (strandedWasteCount > 0) setCascadeWasteHiddenCount((n) => Math.max(0, n - strandedWasteCount))

    if (entries.length === 0) {
      settleFlight()
      return
    }
    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        const m = moves.find((mv) => mv.anchorCardId === cardId || mv.cardIds?.includes(cardId))
        if (m?.from.zone === 'tableau') {
          setDealHiddenIds((ids) => {
            if (!ids.has(cardId)) return ids
            const next = new Set(ids)
            next.delete(cardId)
            return next
          })
        } else if (m?.from.zone === 'waste') {
          setCascadeWasteHiddenCount((n) => Math.max(0, n - 1))
        }
      },
      () => settleFlight()
    )
  }

  // Cascade-return effect (see PATTERN_CASCADE_UNDO), only for an entry restored from a save
  // written before auto-plays became their own undo steps (see KlondikeUndoMove): once an undo's
  // revert has committed, fly every cascaded (silently auto-played) card back from the foundation
  // slot it left to wherever it now really sits (a tableau column or the waste), independently and
  // concurrently with the primary move's own DragGhostLayer flight (see the pendingFlightRef effect
  // above - independent providers, so both animating at once is correct). Deferred to [state] for
  // the same registration-race reason as every other post-commit measurement in this file.
  useEffect(() => {
    const pending = pendingCascadeUndoRef.current
    if (!pending || !state) return
    pendingCascadeUndoRef.current = null
    runCascadeReturn(pending.moves, pending.origins, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Auto-play-to-foundation: the cascade only ever follows the player's own play of a card to a
  // foundation - see useAutoFoundationCascade for the trigger model (afterPlayerMove, called from
  // applyMove below; any other move of theirs and a stock draw stop it), and engine/autoFoundation.ts
  // for the two mechanisms computeNextStep composes. Its cards follow the player's own one on a short
  // stagger, overlapping each other's flights (see the hook for the one thing a card still waits for:
  // its own pile to stop landing).
  const cascade = useAutoFoundationCascade<KlondikeState>({
    state,
    isLanding,
    getState: () => stateRef.current,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep,
    firePlay,
    fireDraw: handleDrawStock,
    fireDrawAndPlay,
    beat: cascadeFeedback
  })
  // The finish: once the board is solved (nothing face-down, the stock and waste empty, every card able
  // to go up), the rest files away on its own, at a pace that ramps up - after the player's play of a
  // card to a foundation that leaves the board that way, or the cascade that play set off (see
  // useAutoFinish and rules.ts's canAutoFinish). Both read the live controller: New Game and restore replace it.
  const finish = useAutoFinish<KlondikeState>({
    state,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    getState: () => stateRef.current,
    canFinish: (s) => canAutoFinish(controllerRef.current, s),
    nextMove: (s) => nextFinishMove(controllerRef.current, s),
    isLanding,
    firePlay,
    beat: cascadeFeedback
  })

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<KlondikeState, KlondikeUndoEntry | LegacyKlondikeUndoEntry>('klondike').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('klondike')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won: Undo is
  // never disabled post-win (a pre-existing gap, out of scope here), so without this guard, winning and
  // then tapping the still-enabled Undo would resurrect a save for an already-resolved deal right after
  // checkWin below just cleared it. Deliberately NOT also keyed on a ticking elapsed-seconds value the
  // way an earlier version of this effect was: `session.getElapsed()` computes the true current elapsed
  // from wall-clock time on demand (see useGameSession.ts), but a save still holds the elapsed time
  // from when it was made, so useSaveInProgressBackstop saves again every 10s, when the screen is left,
  // and when the app is backgrounded.
  useEffect(() => {
    if (state && !won) {
      saveGameInProgress<KlondikeState, KlondikeUndoEntry>('klondike', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: klondikeDraw })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, klondikeDraw, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress<KlondikeState, KlondikeUndoEntry>('klondike', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: klondikeDraw })
  })

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint(request?: HintRequest): boolean {
    if (!state) return false
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(controllerRef.current, state, skip)
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
      const source = resolvePile(from) ?? []
      void playHintGlide({ moving: source.slice(source.length - count), dest: resolvePile(to) ?? [], destFanned: to.zone === 'tableau', slot: to, cardWidth })
    }
    // True when pressing Hint again shows a different move: a held Hint button steps on while it is (hintHold.ts).
    return result.kind === 'move' && result.choices > 1
  }

  // Every step gets its own undo entry, an auto-played one included (a silent foundation play, a
  // sweep's draw/recycle, each half of a draw-and-play), so one Undo press takes back exactly one
  // step and the player can stop exactly where they want. An auto-played step used to be folded
  // into the entry of the move that set it off instead (see KlondikeUndoMove's `cascaded`).
  function pushUndo(prev: KlondikeState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move: { primary: move, cascaded: [] } }])
  }

  // Legacy (a save's folded `cascaded` list, see KlondikeUndoMove). Marks cascaded cards hidden at
  // their real (about-to-be-revealed-by-revert) destination - reuses dealHiddenIds for a tableau
  // destination (conceptually identical to the initial deal: a card mid-flight into a pile) and a
  // dedicated counter for a waste destination (StockWaste has no per-id hide, only a
  // frontmost-N-slots count - see cascadeWasteHiddenCount above). Must be called in the SAME commit
  // as the setState that reverts to prevState (see PATTERN_CASCADE_UNDO) so the returning cards
  // never flash fully visible before their ghosts arrive to cover them.
  function hideCascadeCards(moves: MoveInfo[]) {
    if (moves.length === 0) return
    const tableauIds = moves.filter((m) => m.from.zone === 'tableau').map((m) => m.anchorCardId)
    // Summed by each move's own `count`, not "1 per move" - every ORIGINAL cascaded move (an
    // ordinary single-card auto-play) had count === 1 anyway, so this was equivalent before, but a
    // cascaded recycle reversal (see the stock-cycling sweep) can carry a real multi-card count.
    // Nothing analogous is needed for a from.zone === 'stock' cascaded move (reversing a plain draw
    // or a drawAndPlay) - the stock pile never shows individual card identity, only a generic
    // face-down pile, so there's nothing there to flash/hide in the first place.
    const wasteCount = moves.filter((m) => m.from.zone === 'waste').reduce((sum, m) => sum + m.count, 0)
    if (tableauIds.length > 0) setDealHiddenIds((ids) => new Set([...ids, ...tableauIds]))
    if (wasteCount > 0) setCascadeWasteHiddenCount((n) => n + wasteCount)
  }

  // Flies every cascaded card back from the foundation slot it left (`origins`, index-aligned with
  // foundationSlotRefs/SUITS - a container ref, measured once up front in handleUndo, since the
  // cards themselves have no CardRegistry entry once buried under a later foundation arrival) to
  // wherever it now really sits, once that position is actually measurable - called either from
  // the pendingCascadeUndoRef effect (the common case, running concurrently with the primary
  // move's own flight) or directly after a primary flight that itself needed the `deal` provider
  // (the draw-3-undo branch below can't run both at once - see its own comment). Always ends in
  // exactly one settleFlight() call, matching the one completion this cascade was counted as in
  // activeFlightCountRef.
  // Pre-measures every container ref a cascaded move's reverse flight might need (see
  // CascadeOrigins) - called once, up front in handleUndo, before anything reverts, since all
  // three are cheap content-independent refs safe to measure synchronously.
  async function measureCascadeOrigins(): Promise<CascadeOrigins> {
    const [foundation, stock, waste] = await Promise.all([Promise.all(foundationSlotRefs.current.map((view) => measureView(view))), measureView(stockViewRef.current), measureView(wasteViewRef.current)])
    return { foundation, stock, waste }
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would. Undoing a stock draw flies back toward the stock instead of a
  // per-card pile - see pendingFlightRef's `viaStock`. Each auto-played step is its own entry (see
  // pushUndo), taken back by the same branch as the player's own move of that kind. An entry from a
  // save written before that can still carry a `cascaded` list (see PATTERN_CASCADE_UNDO): it rides
  // along, animating back to its own origins concurrently with whichever branch below handles the
  // primary move.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // A plain move's undo - a draw-1 included - takes its cards back off the pile it went to, so it
  // overlaps the undos before it once nothing is still landing there. One that lands on or leaves
  // the waste also waits for the waste to be quiet: its frozen top and fan expect one arrival at a
  // time. A draw-3 fan flies back through the deal layer (one batch at a time), a recycle moves the
  // whole waste, and a legacy entry's cascade flies from several foundations through a single slot -
  // each of those one at a time.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    const current = stateRef.current
    if (!entry || !current) return null
    const { primary: move, cascaded } = entry.move
    if (!move || cascaded.length > 0) return 'exclusive'
    if (move.from.zone === 'waste' && move.to.zone === 'stock') return 'exclusive'
    if (move.from.zone === 'stock' && move.to.zone === 'waste' && move.count > 1) return 'exclusive'
    const lands = move.from.zone === 'waste' ? [WASTE] : []
    // Cards still flying in to a column or a foundation turn back in mid-air (revertTopUndo's peel):
    // nothing to wait for there. The waste takes one arrival at a time, so a card flying back to it
    // is still waited for.
    if (move.to.zone !== 'waste' && ghost.canPeel(undoGhost(move, current))) return { takesFrom: lands }
    return { takesFrom: [move.to, ...lands] }
  }

  // The ghost a plain undo of `move` flies back: the cards it takes off `move.to` as `current` has them.
  // A foundation pile stacks in place, so an undone foundation move's card is not necessarily its
  // top in a legacy entry: auto-play cascaded more cards on top of it (they ride along in
  // `cascaded`, flying back on their own). Look the card up by id then, instead of ghosting
  // whatever now sits on top.
  function undoGhost(move: MoveInfo, current: KlondikeState) {
    const sourcePile = resolvePile(move.to, current)
    const foundationAt = move.to.zone === 'foundation' && sourcePile ? sourcePile.findIndex((c) => c.id === move.anchorCardId) : -1
    const cards = sourcePile ? (foundationAt >= 0 ? sourcePile.slice(foundationAt, foundationAt + move.count) : sourcePile.slice(sourcePile.length - move.count)) : []
    return { cards, offsetStep: move.count > 1 ? faceUpFanOffset(cardWidth) : 0, cardWidth }
  }

  async function revertTopUndo() {
    // The stack and the board are read via their refs, not the closure: undos can run back-to-back
    // before React re-renders (see runUndo).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    // An undo is not the player's own move, so it must never set auto-play off again: an undone auto-play would otherwise fly
    // straight back up the moment the reverted board settles (undoing a card off a solved board leaves it solved).
    finish.suppress()
    cascade.disarm()
    // Undo only ever moves backward into an earlier, necessarily-not-won state (won is a terminal
    // condition - the only move available once it's true is New Game), so any undo reachable while
    // won must be undoing the winning move itself. Clears the "You Won!" banner and stops the
    // bouncing win cascade immediately instead of leaving both stuck on screen over a board that's
    // already reverted underneath them. Deliberately does NOT reset recordedWinRef - this deal was
    // genuinely won at some point, and recordedWinRef staying true is what stops both a later re-win
    // in this same deal from double-recording the stat, and a later "New Game" (without re-winning)
    // from wrongly recording this already-won deal as abandoned too (see handleNewGame's own !won
    // guard on recordDealAbandoned).
    if (won) {
      setWon(false)
      winCascade.clear()
      setWinCascadeFallbackSuits(new Set())
    }
    const { move: moveWrap, state: prevState } = entry
    const move = moveWrap.primary
    const cascaded = moveWrap.cascaded
    // Captured once, up front - every stash this call makes uses this same token, so a "New Game"
    // that fires mid-await consistently invalidates every one of this undo's pending flights
    // rather than some using a token read before the race and some after.
    const gen = dealTokenRef.current
    startFlights(cascaded.length > 0 ? 2 : 1)

    // Container-ref origins for the cascade - measured up front regardless of which branch below
    // ends up handling the primary move.
    const cascadeOrigins = cascaded.length > 0 ? await measureCascadeOrigins() : null

    if (!move) {
      hideCascadeCards(cascaded)
      setUndoStack((stack) => stack.slice(0, -1))
      commitState(prevState)
      settleFlight() // primary: nothing to fly, settles immediately
      // Deferred via pendingCascadeUndoRef (resolved by the [state]-effect above), not called
      // directly - the reverted state hasn't committed/re-rendered yet at this point, so a
      // cascaded card's NEW position wouldn't be CardRegistry-registered until after that commit.
      if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }
      return
    }

    // Reverse of the forward stock-recycle flight (see PATTERN_RECYCLE): the whole reverted waste
    // flies back as one clump from the stock slot to the waste slot - both slots are
    // content-independent container refs, so no post-commit deferral is needed for either end.
    if (move.from.zone === 'waste' && move.to.zone === 'stock') {
      const stockOrigin = await measureView(stockViewRef.current)
      const wasteDest = await measureView(wasteViewRef.current)
      const recycledCards = prevState.waste.slice()

      setUndoStack((stack) => stack.slice(0, -1))
      hideCascadeCards(cascaded)

      if (stockOrigin && wasteDest && recycledCards.length > 0) {
        playCardSound()
        hapticCard()
        // The stock is the pile these cards LEAVE, so it empties as they take off (no stockHidden: freezing it kept a back
        // on the stock for the whole flight). The ghost is the stock as it looked, face down - drawn in the commit it
        // mounts, so the stock never empties under a ghost not on screen yet - and it turns up on the waste as it lands,
        // the mirror image of the recycle. One back stands for the pile (a stack only shows its top, and every back is an
        // SVG), carrying the id of the card that ends on top of the waste, so the landed ghost stays until that face has
        // painted.
        const flight = ghost.show({ cards: [{ ...recycledCards[recycledCards.length - 1], faceUp: false }], offsetStep: 0, cardWidth }, { x: stockOrigin.x, y: stockOrigin.y })
        const flyingId = beginFlying({ zone: 'waste', index: 0 }, recycledCards.length)
        commitState(prevState)
        flight.flyTo(wasteDest.x, wasteDest.y, () => {
          endFlying(flyingId)
          settleFlight()
        })
      } else {
        commitState(prevState)
        settleFlight()
      }
      // Deferred (not called directly) for the same registration-race reason as the `!move`
      // branch above - the primary flight here uses `ghost` (a container-ref-to-container-ref
      // flight, needing no deferral of its own), but the cascade's own destinations are per-card
      // CardRegistry lookups that only resolve once this commit's registration effects have run.
      if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }
      return
    }

    // Reverse of the deal-style draw-3 flight above: fly each drawn card back toward the stock
    // independently, staggered newest-first (the last one dealt is the first one un-dealt) - no
    // hide/freeze needed on the waste side (unlike the forward draw), since the state reverting
    // instantly underneath just reveals whatever was already there before this draw, which is
    // exactly what a card lifting off should uncover. Any cascade rides the SAME `deal` provider
    // as this primary flight (only one can be active at a time), so it's sequenced to start once
    // this one fully lands rather than run concurrently with it - the cascaded cards are hidden
    // immediately either way (hideCascadeCards, below), so there's no visible gap.
    if (move.from.zone === 'stock' && move.to.zone === 'waste' && move.count > 1) {
      const sourcePile = resolvePile(move.to, current)
      const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : [] // oldest -> newest/top
      const topPos = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null
      const stockDest = topPos ? await measureView(stockViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))
      hideCascadeCards(cascaded)

      if (topPos && stockDest) {
        const fanOffset = wasteFanStepFor(cardWidth)
        const entries: DealCardSpec[] = movingCards
          .slice()
          .reverse() // newest/top (last dealt) first
          .map((card, i) => {
            const shift = wasteFanScreenShift(fanOffset * i, rotation)
            return {
              cardId: card.id,
              card: { ...card, faceUp: true },
              from: { x: topPos.x + shift.x, y: topPos.y + shift.y },
              to: stockDest,
              delayMs: i * DEAL_STAGGER_MS
            }
          })
        commitState(prevState)
        deal.start(
          entries,
          cardWidth,
          () => {},
          () => {
            settleFlight()
            // Called directly here (not deferred via pendingCascadeUndoRef) - this callback fires
            // well after the revert's own render already committed (the whole primary flight's
            // duration has elapsed), so every cascaded card's new-position registration effect has
            // long since run. Safe, and necessary: this primary flight already occupies the shared
            // `deal` provider, so the cascade can't start until it's fully landed anyway.
            if (cascadeOrigins) runCascadeReturn(cascaded, cascadeOrigins, gen)
          },
          undefined,
          FLIGHT_SPRING // the fan flies back on the same flight it came on
        )
      } else {
        // No primary flight actually started (measurement failed) - settles immediately. The
        // cascade (if any) still needs the normal post-commit deferral, since the revert commits
        // this tick.
        commitState(prevState)
        settleFlight()
        if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }
      }
      return
    }

    const ghostContent = undoGhost(move, current)
    const movingCards = ghostContent.cards
    // Cards the undo before this one is still flying in (a held Undo, where that undo's move put them
    // on this pile): they turn back in mid-air, the rest of that flight landing as before, instead of
    // the undo waiting for them to land and then sending them off again. Taken here, before any await,
    // in the same task the gate saw them (undoGate).
    const peeled = move.to.zone !== 'waste' && movingCards.length > 0 ? ghost.peel(ghostContent) : null
    // A buried card (and the winning move's own card once the celebration has hidden the real
    // foundation cards) has no CardRegistry entry, so without a fallback the undo had no origin, took
    // the `else` branch below and the card simply appeared back home. Every card in a foundation pile
    // sits exactly where the pile's own always-present container is, so fly out of that.
    const origin = peeled || movingCards.length === 0 ? null : ((await ghost.cardRegistry.measure(move.anchorCardId)) ?? (move.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[move.to.index]) : null))

    setUndoStack((stack) => stack.slice(0, -1))
    hideCascadeCards(cascaded)

    // Deferred via pendingCascadeUndoRef when present (not called directly) - the primary flight
    // here (via pendingFlightRef, `ghost`) and the cascade flight (via `deal`) are independent
    // providers that can run concurrently, but both need the SAME post-commit deferral: neither
    // the primary's own destination nor a cascaded card's new position is CardRegistry-registered
    // until after this revert's render actually commits. The primary's own completion (below) is
    // entirely independent of whether a cascade exists.
    if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }

    const flight = peeled ?? (origin ? ghost.show(ghostContent, { x: origin.x, y: origin.y }) : null)
    if (flight) {
      playCardSound()
      hapticCard()
      // The flight they were taken out of now reveals only what it still carries when it lands.
      if (peeled) shrinkLanding(move.to, movingCards.length)
      const flyingId = beginFlying(move.from, move.count)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, to: move.from, viaStock: move.from.zone === 'stock', gen, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // `silent` is for the auto-play-to-foundation feature (the cascade's and the finish's cards, see
  // firePlay below): an auto-played card isn't a player decision, so it doesn't arm the cascade or
  // start the finish, but it counts as a move like any other (so Auto-Move only saves taps) and is its own
  // undo step (see pushUndo).
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
      pushUndo(current, { from, to, count, anchorCardId })
      commitState(result)
      // Every move counts, the player\'s or an auto-play\'s: Auto-Move only saves taps, never score.
      session.registerMove()
      checkWin(result)
      // Only the player's own play of a card to a foundation starts the cascade; any other move of theirs
      // stops it, so a card it uncovers (an ace flipped up on the tableau, say) is theirs to find and play.
      // The finish follows the same foundation play, once the board is solved (see useAutoFinish).
      if (!opts?.silent) {
        cascade.afterPlayerMove(to)
        finish.afterPlayerMove(to)
      }
      return true
    }
    return false
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move, a manual drag's
  // drop, or an auto-play) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto,
  // instead of it just vanishing/appearing at the destination instantly.
  //
  // `inAir`: a tapped run's cards still flying in to `from` (inAirRun.ts) - `flight` carries only the cards on the board, and each piece
  // goes on from mid-air in a flight of its own, landing on top of them.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean; inAir?: Card[][] }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    const gen = dealTokenRef.current
    const inAirCount = (opts?.inAir ?? []).reduce((n, piece) => n + piece.length, 0)
    pendingFlightRef.current.push({ cardId: anchorCardId, to, gen, flyingId: beginFlying(to, count - inAirCount), flight })
    if (inAirCount > 0) {
      // Out of `from`'s landing count, so the cards left there show at once.
      shrinkLanding(from, inAirCount)
      const pieces = peelInAir(ghost, opts?.inAir ?? [], cardWidth)
      startFlights(pieces.length)
      for (const p of pieces) pendingFlightRef.current.push({ cardId: p.anchorCardId, to, gen, flyingId: beginFlying(to, p.count), flight: p.flight })
    }
    return true
  }

  // Composes engine/autoFoundation.ts's two mechanisms into the shared cascade hook's step shape -
  // mechanism B (a guaranteed full clear, draws-aware so it can also reach through the stock) takes
  // priority and, once true, ignores mechanism A's caution entirely since there's no longer any
  // player decision left to protect. Once the board is solved (nothing hidden, nothing left to draw)
  // the cascade steps aside and the finish takes over at its own quicker pace - otherwise the two
  // would stream the same cards, racing each other for every one.
  function computeNextStep(s: KlondikeState): AutoCompleteStep | null {
    const controller = controllerRef.current
    if (!controller.accessibleCards || canAutoFinish(controller, s)) return null
    if (isFullyAutoCompletableWithDraws(controller, s)) return nextAutoCompleteMoveWithDraws(controller, s)
    const entry = findSafeAutoPlay(controller.accessibleCards(s), s.foundation)
    return entry ? { kind: 'play', entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } } : null
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move (every other mutator here either has no await at all, or - like
  // handleUndo - captures everything it needs from the pre-move state synchronously first). Guard
  // against something else changing state during that gap by snapshotting stateRef before the
  // await and bailing if it no longer matches after. `stillWanted` is re-checked there too: whichever
  // automation sent this card - the cascade (its isArmed, the default) or the finish (its isAllowed,
  // which useAutoFinish passes) - may have been ended meanwhile by the player's move elsewhere, an
  // undo or a new deal.
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
  // skipping the ordinary "land on waste first" stop entirely (the confirmed sweep visual). Reuses
  // the exact same pendingFlightRef/[state]-effect mechanism an ordinary draw-to-waste already uses
  // (a card's own post-commit CardRegistry registration, wherever it lands) - the only differences
  // are committing the FINAL (post-play) state directly (counted as two moves, the draw and the
  // play, like any auto-play), and passing sweep through for the quicker spring.
  //
  // It is recorded as TWO undo steps, the draw and then the play from the waste, each against the
  // board right before it, so each Undo press takes back a kind of move handleUndo already flies:
  // the card drops from its foundation onto the waste, then the draw goes back into the stock. As
  // one stock-to-foundation step, undoing a draw-3 drawAndPlay would put the other drawn cards back
  // into the stock with no flight at all (they would just vanish off the waste).
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

    const flight = ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying(to, 1)

    // The draw's own record mirrors handleDrawStock's (the drawn top card is the anchor, and a
    // multi-card draw keeps its cards' ids for the deal-style undo flight).
    const drawnCount = afterDraw.waste.length - current.waste.length
    const drawnCards = afterDraw.waste.slice(afterDraw.waste.length - drawnCount) // oldest -> newest/top
    pushUndo(current, { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: drawnCount, anchorCardId: entry.card.id, ...(drawnCount > 1 ? { cardIds: drawnCards.map((c) => c.id) } : {}) })
    pushUndo(afterDraw, { from: entry.ref, to, count: 1, anchorCardId: entry.card.id })
    commitState(result)
    // Two moves, the draw and the play, as the player would make them with Auto-Move off.
    session.registerMove()
    session.registerMove()
    checkWin(result)
    pendingFlightRef.current.push({ cardId: entry.card.id, to, gen: dealTokenRef.current, flyingId, flight })
  }

  // Drag-and-drop's own entry point into flight bookkeeping (see activeFlightCountRef's doc
  // comment above) - claimed synchronously here, before the `hitTest` await, purely so undo (the
  // only thing that still waits for activeFlightCountRef to hit 0 - see PATTERN_OVERLAP_GATE) sees
  // this drop as in-flight for its whole duration, not just once completeMove lands one. Also
  // rejects outright if undo is currently running (undo holds full mutual exclusion, not just a
  // one-way wait - see undoBusyRef's own doc comment) - the drag's own ghost (already shown by
  // PileView/DraggableCard well before this runs) just snaps back, same as "no legal target".
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
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingAltColor)
  }

  // Draw-1 mirrors handleCardTap's own flight (see the pendingFlightRef effect above), just with a
  // fixed origin (the stock pile) instead of a tapped card's position. Draw-3 instead
  // hands off to the deal-style multi-card flight (see the [state]-effect above) - every newly
  // drawn card flies, not just the new top one.
  // `opts.sweep` marks this as an automatic step of the win-completing sweep (see fireDraw, passed
  // as the shared cascade hook's own fireDraw callback) rather than a genuine player tap. It counts as a
  // move and is its own undo step, like a player's draw (see pushUndo); only the feedback and the
  // cascade's disarm differ. `repeat`/`cancelled` come from a held stock (StockWaste's useStockHold).
  // Resolves true once a draw or turn-over has committed.
  async function handleDrawStock(opts?: { sweep?: boolean } & StockRequestOptions): Promise<boolean> {
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    // Without this, rapid-clicking the stock pile several times before React re-renders drew the
    // SAME card repeatedly (every call computing drawStock() against the same stale board) instead
    // of drawing several different ones in a row.
    const current = stateRef.current
    if (!current || !controllerRef.current.drawStock) return false
    if (undoBusyRef.current) return false // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    if (heldAtEmptyStock(current, opts) || !controllerRef.current.drawStock(current)) return false
    startFlights(1)
    // A draw is the player's, but it is not a play: it never sets auto-play off, and it stops a cascade
    // still running from their last play, so a card they just drew is theirs to find and play. Stopped
    // at the tap, before the measurement below, so no auto-played card can go up in between.
    if (!opts?.sweep) cascade.disarm()

    // What the tap draws - a card, a draw-3 fan or a turn-over - is worked out from the board as it is once the measurements
    // (and any wait, below) are over, and committed in the same synchronous stretch (Pyramid's handleDrawStock does the same):
    // computed at the tap and committed after an await, two quick taps both drew the SAME card (two moves and two undo entries
    // for it), and a tap-to-move committed meanwhile was undone in state while its ghost flew on. Both containers are always
    // mounted and card-sized, so both are measured whichever it turns out to be (a fan measures again once it has committed -
    // see the [state]-effect above).
    const gen = dealTokenRef.current
    const [stockPos, wastePos] = await Promise.all([measureView(stockViewRef.current), measureView(wasteViewRef.current)])
    // A flight in the way (drawCanGo) makes the tap wait rather than dropping it - every tap is one draw - and taps that waited go
    // one after another at a held stock's pace (createStockQueue). A LOOP, re-checked in the same synchronous stretch as the commit
    // below (see stockWait.ts).
    const wait = startStockWait()
    let waited = false
    while (dealTokenRef.current === gen && !(drawCanGo() && (!waited || stockQueue.ready())) && wait.left() > 0 && !opts?.cancelled?.()) {
      waited = true
      await stockWaitTick()
    }
    // A New Game or restore mid-measurement replaced the board and already dropped this claim
    // (resetFlightConcurrency) - drop the draw too, rather than draw from the new deal.
    if (dealTokenRef.current !== gen) return false
    // Re-read and committed below in one synchronous stretch, so nothing can commit in between. Dropped when the wait ran out or
    // a hold let go (opts.cancelled) - and the cascade's own draw (a sweep) once the player's move has ended the cascade, or over a
    // board that moved on while it was measuring (its step was worked out for the board it started from).
    const board = stateRef.current
    const stale = opts?.cancelled?.() || !drawCanGo() || (waited && !stockQueue.ready()) || (opts?.sweep && (!cascade.isArmed() || board !== current))
    const result = board && !stale && !heldAtEmptyStock(board, opts) ? controllerRef.current.drawStock(board) : null
    if (!board || !result) {
      settleFlight()
      return false
    }
    // Counted here, with the draw that really happens - not at the tap, whose draw may have been dropped.
    session.registerMove() // a sweep\'s own draw counts too, as the player\'s would with Auto-Move off
    if (waited) stockQueue.went()

    const drawnCard = top(result.waste)
    if (!drawnCard) {
      recycleWaste(board, result, stockPos, wastePos, opts?.sweep)
      return true
    }

    // How many cards this draw actually added - normally klondikeDraw, but fewer once the stock
    // runs low (rules.ts's drawStock clamps to what's left).
    const drawnCount = result.waste.length - board.waste.length
    const move: MoveInfo = { from: STOCK, to: WASTE, count: drawnCount, anchorCardId: drawnCard.id }

    if (drawnCount > 1) {
      const drawnCards = result.waste.slice(result.waste.length - drawnCount) // oldest -> newest/top
      const moveWithIds: MoveInfo = { ...move, cardIds: drawnCards.map((c) => c.id) }
      pushUndo(board, moveWithIds)
      const flyingId = beginFlying(WASTE, drawnCount)
      pendingDealDrawRef.current.push({ topCardId: drawnCard.id, drawnCards, gen: dealTokenRef.current, flyingId })
      commitState(result)
      return true
    }

    if (!stockPos) {
      pushUndo(board, move)
      commitState(result)
      settleFlight()
      return true
    }

    if (opts?.sweep) cascadeFeedback()
    else {
      // A tap's buzz is its press's own, at touch-down; a held stock's repeat draws have no press of their own.
      playCardSound()
      if (opts?.repeat) hapticCard()
    }
    const flight = ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth }, { x: stockPos.x, y: stockPos.y })
    const flyingId = beginFlying(WASTE, 1)

    pushUndo(board, move)
    commitState(result)
    pendingFlightRef.current.push({ cardId: drawnCard.id, to: WASTE, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  // A held stock's repeat at an empty stock: the hold never turns the waste over (see StockRequestOptions).
  function heldAtEmptyStock(board: KlondikeState, opts?: StockRequestOptions): boolean {
    return !!opts?.repeat && board.stock.length === 0
  }

  // Whether a stock tap can go right now - the board as it is now decides what it will draw. Otherwise it waits (handleDrawStock):
  //   - anything, while a turn-over's cards are still flying into the stock: the stock is drawn as it was before them (empty,
  //     stockHidden) until they land, so a card drawn now would come out of an empty slot (Pyramid's draws wait the same way);
  //   - a draw-3 draw, while anything is still landing on the waste: the deal layer flies one fan at a time - a second start()
  //     cancelled the first, whose cards then never reported landing, so two quick taps left the waste frozen and Undo waiting for
  //     good - and the waste freezes its fan slot by slot for one fan;
  //   - a turn-over, while a card it would take is still flying to the waste, unless every such card can turn back toward the
  //     stock in mid-air (wasteInAirToTurnBack): taken as they were, each was drawn twice - flying in to the waste, and on top of
  //     the clump flying out.
  // Draw-1 draws overlap each other freely.
  function drawCanGo(): boolean {
    const board = stateRef.current
    if (!board) return true
    if (isLanding(STOCK)) return false
    const inAir = landingCount(WASTE)
    if (inAir === 0) return true
    if (board.stock.length === 0) return wasteInAirToTurnBack(board, inAir) !== null
    return klondikeDraw === 1
  }

  // The waste's top `inAir` cards - still flying in to it - when every one of them can turn back in mid-air: a draw-1 card whose
  // ghost is on screen (DragGhostController.canPeel). Null when any can't (a draw-3 fan flies through the deal layer, which can't
  // hand a card over; a ghost not shown yet): the turn-over then waits for them to land.
  function wasteInAirToTurnBack(board: KlondikeState, inAir: number): Card[] | null {
    if (inAir > board.waste.length) return null
    const cards = board.waste.slice(board.waste.length - inAir)
    return cards.every((c) => ghost.canPeel({ cards: [c], offsetStep: 0, cardWidth })) ? cards : null
  }

  // Turning the waste back over into the stock (see PATTERN_RECYCLE) - the whole waste flies as one clump, from the waste slot to
  // the stock slot, both content-independent container refs (no post-commit deferral needed for either end). cardIds records the
  // full group (oldest-to-newest) - a legacy save's cascaded-undo reversal needed it to reconstruct exactly this move's own cards
  // even after other moves happened on top of it (see undoTypes.ts).
  //
  // A card a quick player drew last that is still flying in to the waste (drawCanGo lets the turn-over go only if it can) turns
  // back in mid-air instead, like a held Undo's cards (DragGhostController.peel): the clump is the cards that have landed, and each
  // card in the air goes to the stock from wherever it is, in a flight of its own. Until the clump's ghost is on screen the waste
  // keeps drawing its top card (holdWasteTop): its own take-off hold is for the card it drew last - the one in the air.
  function recycleWaste(board: KlondikeState, result: KlondikeState, stockPos: ScreenPoint | null, wastePos: ScreenPoint | null, sweep: boolean | undefined) {
    const recycledCards = board.waste.slice()
    const move: MoveInfo = { from: WASTE, to: STOCK, count: recycledCards.length, anchorCardId: recycledCards[0]?.id ?? '', cardIds: recycledCards.map((c) => c.id) }
    pushUndo(board, move)
    if (!wastePos || !stockPos || recycledCards.length === 0) {
      commitState(result)
      settleFlight()
      return
    }
    // drawCanGo found them all able to turn back, in this same synchronous stretch.
    const inAir = wasteInAirToTurnBack(board, landingCount(WASTE)) ?? []
    const landed = recycledCards.slice(0, recycledCards.length - inAir.length)
    if (sweep) cascadeFeedback()
    else {
      playCardSound()
    }
    const gen = dealTokenRef.current
    // Landing on the STOCK (Pyramid's recycle too). Counted as landing on the waste, it froze the waste on the card that
    // had just left it, so that card showed twice for the whole flight: on the waste and as the ghost.
    const flyingId = beginFlying(STOCK, recycledCards.length)
    setStockHidden(true)
    const clump = landed.length > 0 ? ghost.show({ cards: landed, offsetStep: 0, cardWidth }, { x: wastePos.x, y: wastePos.y }) : null
    // After the clump's ghost, bottom to top, so they start - and, every flight taking the same time, land - in stacking order.
    const turnedBack = peelInAir(
      ghost,
      inAir.map((c) => [c]),
      cardWidth
    )
    if (turnedBack.length > 0) {
      // Out of the waste's landing count: they aren't coming.
      shrinkLanding(WASTE, turnedBack.length)
      if (clump) holdWasteTop(landed[landed.length - 1])
    }
    commitState(result)
    let flightsLeft = (clump ? 1 : 0) + turnedBack.length
    const onLanded = () => {
      flightsLeft -= 1
      // A New Game or restore meanwhile already reset all of this.
      if (flightsLeft > 0 || dealTokenRef.current !== gen) return
      endFlying(flyingId)
      setStockHidden(false)
      settleFlight()
    }
    clump?.flyTo(stockPos.x, stockPos.y, onLanded)
    turnedBack.forEach((p) => p.flight.flyTo(stockPos.x, stockPos.y, onLanded))
  }

  // The waste's top card, drawn by the waste (over its own empty slot) while a turn-over's clump has not shown its ghost yet (see
  // recycleWaste): held until that card's ghost is on screen - cardFacePaint.ts's ghost pending, which the clump's show() marked
  // (and lets go of by itself after GHOST_PENDING_MAX_MS). A clump that took over a ghost already on screen marks nothing: no hold.
  function holdWasteTop(card: Card) {
    if (!isGhostPending(card.id)) return
    setWasteTakeOff(card)
    let unsubscribe = () => {}
    unsubscribe = subscribeGhostPending(() => {
      if (isGhostPending(card.id)) return
      unsubscribe()
      setWasteTakeOff((held) => (held === card ? null : held))
    })
  }

  // `s` defaults to the closure's own live `state` (every pre-existing call site) - runCascadeReturn
  // passes an explicit state (the just-reverted board, read off stateRef inside an effect) instead,
  // since that call doesn't want "whatever render this function happens to close over" but "the
  // exact state the cascade is returning cards into".
  function resolvePile(ref: PileRef, s: KlondikeState | null = state): Card[] | null {
    if (!s) return null
    switch (ref.zone) {
      case 'tableau':
        return s.tableau[ref.index] ?? null
      case 'foundation':
        return s.foundation[ref.index] ?? null
      case 'waste':
        return s.waste
      case 'stock':
        return s.stock
      default:
        return null
    }
  }

  // Tapping any movable card sends it to its best legal destination: a foundation if one exists,
  // otherwise the tableau pile that buries the fewest cards (see engine/autoMove.ts). Tapping the
  // same card again re-evaluates from its new position, so a card cycles through its alternatives
  // one tap at a time rather than needing a separate destination tap.
  //
  // The move applies immediately (so game logic/undo never wait on an animation), but the card
  // that just moved stays hidden at its destination until a ghost copy - shown at the tapped
  // origin - flies there and lands. cardRegistry.measure() finds that destination position by
  // measuring the real (already re-rendered) card rather than recomputing pile fan math here,
  // so the ghost always lands exactly on top of it with no seam.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>, indexFromTop?: number) {
    if (!state || !controllerRef.current.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const move = controllerRef.current.autoMoveHint(state, ref, cardId)
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather
      // than a dead press, with a short haptic tap alongside (see shakeAnimation.ts). Tapping mid-
      // stack (indexFromTop > 0) with a valid run below shakes that whole run, not just the one
      // card under the finger - it's the same "stuck" outcome for all of them. Deliberately never
      // calls measure() - this branch has no use for the tapped card's position, so it skips
      // paying for the measurement at all (see PileView.tsx's onPress doc comment).
      const count = ref.zone === 'tableau' && indexFromTop !== undefined ? Math.max(1, tableauRunCount(ref.index, indexFromTop)) : 1
      setShake({ cardId, count, token: ++shakeTokenRef.current })
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
    const takeOff = await liftTappedRun({ ghost, from: move.from, count: move.count, measure, pile: () => resolvePile(move.from, stateRef.current), landingCount, cancelled: () => undoBusyRef.current, cardWidth })
    if (!takeOff) {
      settleFlight()
      return
    }

    // No buzz here: a tap's is its press's own, at touch-down (every card is a feedback-press Pressable).
    playCardSound()
    if (!completeMove(move.from, move.to, move.count, cardId, takeOff.flight, { inAir: takeOff.inAir })) {
      takeOff.flight.hide()
      settleFlight()
    }
  }

  if (!state) return <GameLoading />

  const wasteTop = top(state.waste)
  // Draw-3 keeps the last 3 drawn cards visible, fanned - draw-1 never shows more than the one
  // real top card. wasteBehind excludes wasteTop itself and is ordered nearest-to-top first (see
  // StockWaste), so the slice below (oldest-visible -> wasteTop) is reversed.
  const visibleWasteCount = klondikeDraw === 3 ? Math.min(3, state.waste.length) : Math.min(1, state.waste.length)
  const wasteBehind = state.waste.slice(Math.max(0, state.waste.length - visibleWasteCount), state.waste.length - 1).reverse()
  // The waste's top cards still flying in to it. A quick player's draw-1 cards overlap, and the waste shows the top card that has
  // LANDED under them (StockWaste's settledWasteTop, as Pyramid's does): its frozen copy of the top from before the whole stream
  // was never refreshed while they kept coming, so each landing card vanished onto that older card until the next one landed. A
  // draw-3 fan keeps its slot-by-slot freeze.
  const wasteLanding = flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0) + cascadeWasteHiddenCount
  const settledWasteTop = wasteTakeOff ?? (klondikeDraw === 1 && wasteLanding > 0 ? (state.waste[state.waste.length - 1 - wasteLanding] ?? null) : undefined)

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Klondike' subtitle={`Draw ${klondikeDraw}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} autoHintKey={state} hintShowing={!!activeHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} pauseClock={session.setPaused} par={parFor(variant)} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<KlondikeSettingsSection />} rules={KLONDIKE_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={[styles.foundationsGroup, { gap }]}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              // Several tap flights can be headed to one pile at once (they overlap), so count the cards still
              // in the air: the pile keeps showing the top card that has already LANDED under the rest instead of
              // reverting to the one from before the whole stream (see FoundationCell's settledCard).
              const flightsInAir = flying.filter((f) => f.to.zone === 'foundation' && f.to.index === i).reduce((sum, f) => sum + f.count, 0)
              const isFlyingHere = flightsInAir > 0
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={winRevealed && cascadeHandoffFor === state && !winCascadeFallbackSuits.has(i) ? undefined : t}
                    isFlyingHere={isFlyingHere}
                    settledCard={pile[pile.length - 1 - flightsInAir] ?? null}
                    suit={SUITS[i]}
                    highlighted={hintCountFor(activeHint, { zone: 'foundation', index: i }) > 0}
                    slotRef={(el) => {
                      foundationSlotRefs.current[i] = el
                    }}
                    // A foundation card may come back down to the tableau (rules.ts's tryMove) - by drag only, and never
                    // once the deal is won. A move off a foundation stops a running cascade or finish, and starts neither
                    // (applyMove), so it isn't sent straight back up: the player chose to take it back.
                    under={pile[pile.length - 2] ?? null}
                    onDrop={won ? undefined : (x, y, flight, dragged) => attemptDrop({ zone: 'foundation', index: i }, 1, x, y, dragged.id, flight)}
                  />
                </DropZone>
              )
            })}
          </View>

          <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteBehind={wasteBehind} wasteUnder={state.waste[state.waste.length - 2]} wasteHiddenCount={wasteLanding + (wasteTakeOff ? 1 : 0)} settledWasteTop={settledWasteTop} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} gap={gap} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y, flight, dragged) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, dragged.id, flight)} stockRef={stockViewRef} wasteRef={wasteViewRef} stockHidden={stockHidden} />
        </View>

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              // Claims a flight slot (see activeFlightCountRef's doc comment above) purely so undo
              // sees this drop as in-flight for its whole duration, not just once completeMove
              // lands one - PileView.tsx (shared, not ours to edit) already ran its own hitTest
              // await before invoking this callback, so this is the earliest point KlondikeScreen
              // gets a look-in. Rejects outright if undo is running (see attemptDrop's identical
              // comment on why undo holds full mutual exclusion, not just a one-way wait).
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
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
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
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} par={parFor(variant)} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

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
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16
    }
  })
}
