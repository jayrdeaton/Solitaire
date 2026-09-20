import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS, dealStaggerMs } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useFittedCardWidth, useFittedGap, useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { wasteFanScreenShift } from '@/components/overlayFrame'
import { PileDragConfig, PileView } from '@/components/PileView'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { KLONDIKE_RULES } from '@/constants/gameRules'
import { AutoCompleteStep, findSafeAutoPlay, isFullyAutoCompletableWithDraws, nextAutoCompleteMoveWithDraws } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { detectRevealedCard, isDescendingAltColor, runCountFrom, top } from '@/engine/pile'
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
import { useWinReveal } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { BOARD_MODEL } from './boardModel'
import { buildKlondikeDealSequence } from './dealSequence'
import { KlondikeSettingsSection } from './KlondikeSettingsSection'
import { createKlondikeController, KlondikeState } from './rules'

// Floor for useTableauMaxHeight below, not a fixed height anymore - a short screen never fans out
// less generously than this, but a screen with real headroom to spare now gets more of it.
const TABLEAU_MIN_HEIGHT = 420
const TABLEAU_COLUMNS = 7

/** This game's own undo-move shape (see undoTypes.ts's TMove generic): `primary` is the move that
 * produced the very next state (same as every other game's plain MoveInfo|null), and `cascaded`
 * collects any silent auto-play-to-foundation moves (see applyMove's `opts.silent`) that happened
 * afterward, before the player's next real action - so one Undo press reverses the whole burst,
 * animating every card it touched instead of only the primary one. */
interface KlondikeUndoMove {
  primary: MoveInfo | null
  cascaded: MoveInfo[]
}

/** Every container-ref position a cascaded move's reverse flight might need as its origin or
 * destination, pre-measured once up front in handleUndo (all three are cheap, content-independent
 * refs). A cascaded move's own `to`/`from` zone picks which of these applies (see
 * originForCascadedMove/isStockDestinedMove below) - an ordinary auto-played card still uses
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
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  const controllerRef = useRef(createKlondikeController(settings.klondikeDraw))
  // The draw count of the game currently in progress - only updated when a new game actually
  // starts (mount, or the New Game button below), always reading the live `settings.klondikeDraw`
  // at that moment. Deliberately NOT derived directly from `settings.klondikeDraw` on every
  // render: the in-progress game's own controller/rules must stay fixed to whatever draw count it
  // was dealt with, even if the player changes the setting mid-game without starting a new deal.
  const [klondikeDraw, setKlondikeDraw] = useState<1 | 3>(settings.klondikeDraw)
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with
  // each other - PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`,
  // `commitState`, `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working
  // unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, shrinkFlying, activeFlightCount, activeFlightCountRef, startFlights, settleFlight, undoBusyRef, reset: resetFlightConcurrency } = useFlightConcurrency<KlondikeState>()
  const [undoStack, setUndoStack] = useState<KlondikeUndoEntry[]>([])
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
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  // Portrait keeps the width-derived size untouched; the wide layout is only ~400pt tall, so there the
  // cards shrink until the deal's tallest column fits (see boardModel.ts).
  const cardWidth = useFittedCardWidth(widthCardWidth, BOARD_MODEL)
  const gap = useFittedGap(widthGap, widthCardWidth, cardWidth, contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
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
  // Extra waste-slot hidden count contributed by cascaded auto-play cards flying back onto the
  // waste during an undo (see PATTERN_CASCADE_UNDO) - added on top of `flying`'s own waste count
  // in the StockWaste wasteHiddenCount prop below, since the two can be simultaneously true (the
  // primary move undoing back to a foundation/tableau slot while a cascaded card independently
  // returns to waste).
  const [cascadeWasteHiddenCount, setCascadeWasteHiddenCount] = useState(0)
  // Suits whose win-cascade origin measurement failed (see runWinCascade) - that suit's real
  // foundation card un-hides immediately instead of staying hidden forever with no ghost ever
  // covering for it (mirrors Pyramid's own fallback for the same rare failure mode).
  const [winCascadeFallbackSuits, setWinCascadeFallbackSuits] = useState<Set<number>>(new Set())
  // The board the win cascade has taken over from (set together with startChains, see runWinCascade): once it IS the
  // current state, and the win is revealed, the real foundation cards blank - not a moment earlier, or the piles would
  // sit empty for the frames between the reveal commit and the commit that mounts the cascade's ghosts. Compared by
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
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: KlondikeState) => controllerRef.current.isWon(s) }, 'klondike', session, dealTokenRef, recordDealWon, hintsUsedRef)
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
   * pile. `fast` marks a fireAutoMove-triggered flight, passed on to flight.flyTo for the quicker
   * auto-play-to-foundation timing (see dragSpring.ts's autoPlaySpringFor). `gen` is the
   * `dealTokenRef` value at the moment this flight was queued - re-checked once the async
   * measurement below resolves, so a flight queued against a game that's since been replaced by
   * "New Game" doesn't measure/land against the new deal's DOM (card ids are shuffle-independent
   * and reused across deals - see deck.ts). Mirrors exactly how runDeal below already guards itself
   * with dealTokenRef/pendingDealTokenRef. `to` is the pile the flight is headed to, so a failed
   * per-card lookup can still land on that pile's own container (see the [state]-effect below). */
  const pendingFlightRef = useRef<{ cardId: string; to: PileRef; viaStock?: boolean; fast?: boolean; sweep?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  /** Draw-3 stock draws awaiting their post-commit measurement + deal.start() - a list for the same
   * overlapping-actions reason as pendingFlightRef above. Analogous shape, for the multi-card
   * deal-style flight (see the [state]-effect below and handleDrawStock) - drawnCards is
   * oldest-first, ending with the new top/frontmost card. `gen`/`flyingId` guard the same races
   * pendingFlightRef's do, above. */
  const pendingDealDrawRef = useRef<{ topCardId: string; drawnCards: Card[]; gen: number; flyingId: number }[]>([])
  /** A cascade-return flight (see PATTERN_CASCADE_UNDO) awaiting its post-commit destination
   * measurement + deal.start(), analogous to pendingDealDrawRef above - `origins` is each
   * foundation slot's own measured position (index-aligned with foundationSlotRefs/SUITS),
   * captured synchronously in handleUndo (a container ref, content-independent, safe to measure
   * before the state revert commits) since the cascaded cards themselves have no CardRegistry
   * entry once buried under a later foundation arrival. Stays a single slot (not a list) - undo
   * itself is still fully serialized (see useFlightConcurrency's undoBusyRef/activeFlightCountRef), so at most one
   * of these is ever pending at a time. */
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
    if (session.moves > 0 && !won) recordDealAbandoned('klondike')
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
  // in the SAME commit that mounts the cascade's ghosts (cascadeHandoffFor, set right beside
  // startChains - React batches the two, being one async continuation). Blanking on winRevealed
  // alone left every pile empty for the frames this measurement takes (~140ms in a dev bundle)
  // before the ghosts appeared. Same dealTokenRef guard as every other async measurement here, for
  // the same "New Game tapped mid-measurement" reason.
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
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
    })
    if (fallbackSuits.size > 0) setWinCascadeFallbackSuits(fallbackSuits)
    winCascade.startChains(chains, cardWidth)
    // A pile with no chain to take over from it is in fallbackSuits above and stays up regardless, so this hand-off
    // never blanks a pile for a chain that did not start (with every suit failed, all four just stay up under the banner).
    setCascadeHandoffFor(s)
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
        const fanOffset = faceUpFanOffset(cardWidth)
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
          }
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

  // Cascade-return effect (see PATTERN_CASCADE_UNDO): once an undo's revert has committed, fly
  // every cascaded (silently auto-played) card back from the foundation slot it left to wherever
  // it now really sits (a tableau column or the waste), independently and concurrently with the
  // primary move's own DragGhostLayer flight (see the pendingFlightRef effect above - independent
  // providers, so both animating at once is correct). Deferred to [state] for the same
  // registration-race reason as every other post-commit measurement in this file.
  useEffect(() => {
    const pending = pendingCascadeUndoRef.current
    if (!pending || !state) return
    pendingCascadeUndoRef.current = null
    runCascadeReturn(pending.moves, pending.origins, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Auto-play-to-foundation: only ever fires as a direct consequence of the player's own move - see
  // useAutoFoundationCascade for the trigger model (armFromForwardMove/armFromAceEvent, called from
  // applyMove/handleDrawStock below), and engine/autoFoundation.ts for the two mechanisms
  // computeNextStep composes. `activeFlightCount > 0` guards against firing while the player's own
  // tap/drag/stock-draw (allowed to overlap each other - see PATTERN_OVERLAP_GATE) is still in the
  // air; `dealHiddenIds.size > 0` guards against firing mid-deal.
  const cascade = useAutoFoundationCascade<KlondikeState>({
    state,
    settled,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep,
    firePlay,
    fireDraw: handleDrawStock,
    fireDrawAndPlay
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

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after checkWin below just cleared it. Deliberately NOT also keyed on a ticking
  // elapsed-seconds value the way an earlier version of this effect was: `session.getElapsed()`
  // computes the true current elapsed from wall-clock time on demand (see useGameSession.ts), so a
  // save made at the last real move is never stale even once the player just sits looking at the
  // board afterward - resuming always recomputes the exact right value instead of depending on
  // whenever this effect last happened to run.
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
    recordHintUsed('klondike')
  }

  function pushUndo(prev: KlondikeState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move: { primary: move, cascaded: [] } }])
  }

  // Appends a silently-auto-played move (see applyMove's `opts.silent`) to the CURRENT
  // top-of-stack entry's own cascade list instead of pushing a new stack entry - see
  // PATTERN_CASCADE_UNDO. A cascaded move arriving with an empty stack is dropped (shouldn't
  // happen - a silent move only ever follows a real player move, which always pushes an entry
  // first), matching this game's pre-fix behavior for that edge case rather than inventing new
  // behavior for it.
  function pushCascadedMove(move: MoveInfo) {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack
      const last = stack[stack.length - 1]
      return [...stack.slice(0, -1), { state: last.state, move: { primary: last.move.primary, cascaded: [...last.move.cascaded, move] } }]
    })
  }

  // Marks cascaded cards hidden at their real (about-to-be-revealed-by-revert) destination -
  // reuses dealHiddenIds for a tableau destination (conceptually identical to the initial deal:
  // a card mid-flight into a pile) and a dedicated counter for a waste destination (StockWaste has
  // no per-id hide, only a frontmost-N-slots count - see cascadeWasteHiddenCount above). Must be
  // called in the SAME commit as the setState that reverts to prevState (see PATTERN_CASCADE_UNDO)
  // so the returning cards never flash fully visible before their ghosts arrive to cover them.
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
  // per-card pile - see pendingFlightRef's `viaStock`. A recorded cascade (see PATTERN_CASCADE_UNDO)
  // rides along, animating back to its own origins concurrently with whichever branch below
  // handles the primary move.
  async function handleUndo() {
    if (undoBusyRef.current || activeFlightCountRef.current > 0 || flying.length > 0 || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
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
    const entry = undoStack[undoStack.length - 1]
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
        const flight = ghost.show({ cards: recycledCards, offsetStep: 0, cardWidth }, { x: stockOrigin.x, y: stockOrigin.y })
        const flyingId = beginFlying({ zone: 'waste', index: 0 }, recycledCards.length)
        setStockHidden(true)
        commitState(prevState)
        flight.flyTo(wasteDest.x, wasteDest.y, () => {
          endFlying(flyingId)
          setStockHidden(false)
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
      const sourcePile = resolvePile(move.to)
      const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : [] // oldest -> newest/top
      const topPos = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null
      const stockDest = topPos ? await measureView(stockViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))
      hideCascadeCards(cascaded)

      if (topPos && stockDest) {
        const fanOffset = faceUpFanOffset(cardWidth)
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
          }
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

    const sourcePile = resolvePile(move.to)
    // A foundation pile stacks in place, so an undone foundation move's card is not necessarily its
    // top: auto-play cascaded more cards on top of it (they ride along in `cascaded`, flying back on
    // their own). Look the card up by id then, instead of ghosting whatever now sits on top.
    const foundationAt = move.to.zone === 'foundation' && sourcePile ? sourcePile.findIndex((c) => c.id === move.anchorCardId) : -1
    const movingCards = sourcePile ? (foundationAt >= 0 ? sourcePile.slice(foundationAt, foundationAt + move.count) : sourcePile.slice(sourcePile.length - move.count)) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    // That buried card (and the winning move's own card once the celebration has hidden the real
    // foundation cards) has no CardRegistry entry, so without a fallback the undo had no origin, took
    // the `else` branch below and the card simply appeared back home. Every card in a foundation pile
    // sits exactly where the pile's own always-present container is, so fly out of that.
    const origin = movingCards.length > 0 ? ((await ghost.cardRegistry.measure(move.anchorCardId)) ?? (move.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[move.to.index]) : null)) : null

    setUndoStack((stack) => stack.slice(0, -1))
    hideCascadeCards(cascaded)

    // Deferred via pendingCascadeUndoRef when present (not called directly) - the primary flight
    // here (via pendingFlightRef, `ghost`) and the cascade flight (via `deal`) are independent
    // providers that can run concurrently, but both need the SAME post-commit deferral: neither
    // the primary's own destination nor a cascaded card's new position is CardRegistry-registered
    // until after this revert's render actually commits. The primary's own completion (below) is
    // entirely independent of whether a cascade exists.
    if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }

    if (origin) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(move.from, move.count)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, to: move.from, viaStock: move.from.zone === 'stock', gen, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so instead of pushing its own undo entry, it's
  // appended to the CURRENT top entry's own cascade list (see PATTERN_CASCADE_UNDO/pushCascadedMove)
  // - one Undo press reverts the whole triggering move plus any cascade it set off, animating every
  // card it touched - and it doesn't count toward the moves/score the player is judged on.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the
    // OTHER's commitState just did, not the same stale board both closures captured.
    const current = stateRef.current
    if (!current) return false
    const result = controllerRef.current.tryMove(current, { from, to, count })
    if (result) {
      const moveInfo: MoveInfo = { from, to, count, anchorCardId }
      if (opts?.silent) pushCascadedMove(moveInfo)
      else pushUndo(current, moveInfo)
      commitState(result)
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      if (!opts?.silent && to.zone === 'foundation') cascade.armFromForwardMove()
      // Reveals an ace: auto-play it immediately as a reward for the move that uncovered it (see
      // useAutoFoundationCascade's armFromAceEvent), regardless of whether THIS move was itself
      // silent - a cascaded tableau-to-foundation play can just as well reveal a fresh ace
      // underneath as a manual one can, and that ace deserves the same instant payoff either way.
      if (from.zone === 'tableau') {
        const revealed = detectRevealedCard(current.tableau[from.index], result.tableau[from.index], count)
        if (revealed && revealed.rank === 1) {
          cascade.armFromAceEvent({ ref: from, card: revealed }, { zone: 'foundation', index: SUITS.indexOf(revealed.suit) })
        }
      }
      return true
    }
    return false
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move, a manual drag's
  // drop, or an auto-play) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto,
  // instead of it just vanishing/appearing at the destination instantly.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean; fast?: boolean; sweep?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    const flyingId = beginFlying(to, count)
    pendingFlightRef.current.push({ cardId: anchorCardId, to, fast: opts?.fast, sweep: opts?.sweep, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  // Composes engine/autoFoundation.ts's two mechanisms into the shared cascade hook's step shape -
  // mechanism B (a guaranteed full clear, draws-aware so it can also reach through the stock) takes
  // priority and, once true, ignores mechanism A's caution entirely since there's no longer any
  // player decision left to protect.
  function computeNextStep(s: KlondikeState): AutoCompleteStep | null {
    const controller = controllerRef.current
    if (!controller.accessibleCards) return null
    if (isFullyAutoCompletableWithDraws(controller, s)) return nextAutoCompleteMoveWithDraws(controller, s)
    const entry = findSafeAutoPlay(controller.accessibleCards(s), s.foundation)
    return entry ? { kind: 'play', entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } } : null
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move (every other mutator here either has no await at all, or - like
  // handleUndo - captures everything it needs from the pre-move state synchronously first). Guard
  // against something else changing state during that gap by snapshotting stateRef before the
  // await and bailing if it no longer matches after.
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
  // skipping the ordinary "land on waste first" stop entirely (the confirmed sweep visual). Reuses
  // the exact same pendingFlightRef/[state]-effect mechanism an ordinary draw-to-waste already uses
  // (a card's own post-commit CardRegistry registration, wherever it lands) - the only differences
  // are committing the FINAL (post-play) state directly, recording the undo as a cascaded move
  // (this isn't a player decision), and passing sweep through for the quicker spring.
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

    pushCascadedMove({ from: { zone: 'stock', index: 0 }, to, count: 1, anchorCardId: entry.card.id })
    commitState(result)
    checkWin(result, session.moves)
    pendingFlightRef.current.push({ cardId: entry.card.id, to, gen: dealTokenRef.current, flyingId, flight, sweep: opts.sweep })
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
  // as the shared cascade hook's own fireDraw callback) rather than a genuine player tap - not a
  // player decision, so its undo entry folds into the current cascade (pushCascadedMove) instead of
  // pushing its own stack entry, and it doesn't count toward moves/score. Every other branch below
  // (the actual draw/recycle logic, the flight animation) is identical either way; only the
  // undo-push and the flight's spring config differ.
  async function handleDrawStock(opts?: { sweep?: boolean }) {
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    // Without this, rapid-clicking the stock pile several times before React re-renders drew the
    // SAME card repeatedly (every call computing drawStock() against the same stale board) instead
    // of drawing several different ones in a row.
    const current = stateRef.current
    if (!current || !controllerRef.current.drawStock) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const result = controllerRef.current.drawStock(current)
    if (!result) return
    startFlights(1)
    if (!opts?.sweep) session.registerMove()

    const drawnCard = top(result.waste)
    if (!drawnCard) {
      // Recycling the waste back into the stock (see PATTERN_RECYCLE) - the whole waste flies as
      // one clump, from the waste slot to the stock slot, both content-independent container refs
      // measurable synchronously (no post-commit deferral needed for either end). cardIds records
      // the full group (oldest-to-newest) for a later cascaded-undo reversal to reconstruct exactly
      // this move's own cards even after other moves happen on top of it - see undoTypes.ts.
      const wasteOrigin = await measureView(wasteViewRef.current)
      const stockDest = await measureView(stockViewRef.current)
      const recycledCards = current.waste.slice()
      const move: MoveInfo = { from: { zone: 'waste', index: 0 }, to: { zone: 'stock', index: 0 }, count: recycledCards.length, anchorCardId: recycledCards[0]?.id ?? '', cardIds: recycledCards.map((c) => c.id) }
      if (opts?.sweep) pushCascadedMove(move)
      else pushUndo(current, move)

      if (wasteOrigin && stockDest && recycledCards.length > 0) {
        if (opts?.sweep) cascadeFeedback()
        else {
          playCardSound()
          hapticCard()
        }
        const flight = ghost.show({ cards: recycledCards, offsetStep: 0, cardWidth }, { x: wasteOrigin.x, y: wasteOrigin.y })
        const flyingId = beginFlying({ zone: 'waste', index: 0 }, recycledCards.length)
        setStockHidden(true)
        commitState(result)
        flight.flyTo(
          stockDest.x,
          stockDest.y,
          () => {
            endFlying(flyingId)
            setStockHidden(false)
            settleFlight()
          },
          { sweep: opts?.sweep }
        )
      } else {
        commitState(result)
        settleFlight()
      }
      return
    }

    // Drawing (or revealing) an ace is meant to auto-play it immediately as a reward, regardless of
    // whether this is a genuine player tap or a sweep's own forced draw - see
    // useAutoFoundationCascade's armFromAceEvent. A sweep's own draws only ever reach this point via
    // a plain 'draw' step (see engine/autoFoundation.ts's AutoCompleteStep) - one where the newly
    // drawn top card DIDN'T come back as immediately playable - so armFromAceEvent here can only
    // ever matter for a genuine player tap in practice, but it costs nothing to leave it
    // unconditional rather than special-cased away.
    if (drawnCard.rank === 1) {
      cascade.armFromAceEvent({ ref: { zone: 'waste', index: 0 }, card: drawnCard }, { zone: 'foundation', index: SUITS.indexOf(drawnCard.suit) })
    }

    // How many cards this draw actually added - normally klondikeDraw, but fewer once the stock
    // runs low (rules.ts's drawStock clamps to what's left).
    const drawnCount = result.waste.length - current.waste.length
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: drawnCount, anchorCardId: drawnCard.id }

    if (drawnCount > 1) {
      const drawnCards = result.waste.slice(result.waste.length - drawnCount) // oldest -> newest/top
      const moveWithIds: MoveInfo = { ...move, cardIds: drawnCards.map((c) => c.id) }
      if (opts?.sweep) pushCascadedMove(moveWithIds)
      else pushUndo(current, moveWithIds)
      const flyingId = beginFlying({ zone: 'waste', index: 0 }, drawnCount)
      pendingDealDrawRef.current.push({ topCardId: drawnCard.id, drawnCards, gen: dealTokenRef.current, flyingId })
      commitState(result)
      return
    }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      if (opts?.sweep) pushCascadedMove(move)
      else pushUndo(current, move)
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

    if (opts?.sweep) pushCascadedMove(move)
    else pushUndo(current, move)
    commitState(result)
    pendingFlightRef.current.push({ cardId: drawnCard.id, to: { zone: 'waste', index: 0 }, sweep: opts?.sweep, gen: dealTokenRef.current, flyingId, flight })
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
  // Draw-3 keeps the last 3 drawn cards visible, fanned - draw-1 never shows more than the one
  // real top card. wasteBehind excludes wasteTop itself and is ordered nearest-to-top first (see
  // StockWaste), so the slice below (oldest-visible -> wasteTop) is reversed.
  const visibleWasteCount = klondikeDraw === 3 ? Math.min(3, state.waste.length) : Math.min(1, state.waste.length)
  const wasteBehind = state.waste.slice(Math.max(0, state.waste.length - visibleWasteCount), state.waste.length - 1).reverse()

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Klondike' subtitle={`Draw ${klondikeDraw}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<KlondikeSettingsSection />} rules={KLONDIKE_RULES}>
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
                  />
                </DropZone>
              )
            })}
          </View>

          <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteBehind={wasteBehind} wasteHiddenCount={flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0) + cascadeWasteHiddenCount} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} gap={gap} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y, flight) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, wasteTop!.id, flight)} stockRef={stockViewRef} wasteRef={wasteViewRef} stockHidden={stockHidden} />
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
      {winRevealed && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {winRevealed && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
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
