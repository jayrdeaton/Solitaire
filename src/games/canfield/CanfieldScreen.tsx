// Canfield solitaire screen: 4 foundations (variable starting rank, wrapping King -> Ace), one
// 4-column tableau with cyclic alternating-color runs (a King may land on an Ace), a 13-card
// reserve (a second, passive single-card-at-a-time source alongside waste), and a draw-3/unlimited
// -recycle stock+waste pair - see rules.ts for the full rules. Architecturally closest to Klondike
// (same imperative checkWin-after-applyMove flow, same tap-to-move/drag/undo/auto-play shape) -
// see this file's own comments for exactly where Canfield's rules force real deviations.

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
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { FLIGHT_SPRING } from '@/components/dragdrop/dragSpring'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useFittedCardWidth, useFittedGap, useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { wasteFanScreenShift } from '@/components/overlayFrame'
import { PileOverlay } from '@/components/PileOverlay'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { useGameSession } from '@/components/useGameSession'
import { useTakeOffHold } from '@/components/useTakeOffHold'
import { wasteFanStepFor } from '@/components/wasteFan'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { CANFIELD_RULES } from '@/constants/gameRules'
import { AutoCompleteStep, isFullyAutoCompletableWithDraws, nextAutoCompleteMoveWithDraws } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { useCascadeFeedback } from '@/games/shared/cascadeFeedback'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useAutoFinish } from '@/games/shared/useAutoFinish'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useUndoStack } from '@/games/shared/useUndoStack'
import { useWinReveal } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { useSettings } from '@/hooks/useSettings'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { BOARD_MODEL } from './boardModel'
import { CanfieldSettingsSection } from './CanfieldSettingsSection'
import { buildCanfieldDealSequence } from './dealSequence'
import { canAutoFinish, CanfieldState, createCanfieldController, findSafeAutoPlay, isDescendingAltColorCyclic, nextFinishMove } from './rules'
// LAYOUT DECISION: the board is a grid of 7 card slots - Klondike's. The top row IS Klondike's: the 4
// foundations at the left, an open slot, then the waste and the stock, with the draw-3 waste fan spreading
// left into the open slot. The row under it puts the 4 tableau columns under the foundations, leaves the
// open slot open, and puts the reserve under the waste (a slot clear of the last column, so it doesn't
// read as a fifth one). cardWidth is sized off those 7 slots, not the 4 tableau columns: sized off the
// tableau (Klondike's approach - see its own TABLEAU_COLUMNS-based cardLayoutForRow call) the top row
// would overflow anything narrower than a very wide window. Both rows are exactly 7 slots wide (`rowWidth`)
// and share the one `gap`, so every column lines up even once cards hit CARD_WIDTH_MAX and
// cardLayoutForRow starts growing the gap past CARD_GAP_MIN.
//
// The reserve used to sit in the top row, between the foundations and the waste: the fan covered all but
// ~11pt of it, and had to stay at the plain face-up strip (a covered 10's '0' clipped) so as not to bury it
// further. In the tableau row it has a slot to itself, and the fan widens like Klondike's (its far card
// stays ~1pt clear of the last foundation on a phone - the same as Klondike's).
const TOP_ROW_UNITS = 7

const WASTE: PileRef = { zone: 'waste', index: 0 }

/** The one card that seeds every foundation's starting rank - rules.ts's newGame cuts it from the
 * very top of the deck and pushes it onto its own suit's foundation pile before anything else, so
 * it's the only non-empty (length-1) foundation pile immediately after a fresh deal. Needed here
 * (not just inside rules.ts) to rebuild the same 6-step sequence buildCanfieldDealSequence expects
 * - both for the initial dealHiddenIds set (startNewGame) and the real flight (runDeal). */
function foundationStarter(s: CanfieldState): Card | undefined {
  return s.foundation.find((pile) => pile.length > 0)?.[0]
}

/** The reserve pile's own single-slot display - a second, passive single-card source alongside
 * waste (see rules.ts's own doc comment on the reserve field). Mirrors Klondike's own waste-top
 * card exactly: a loose DraggableCard inside a DropZone, no PileView/multi-card drag config needed
 * (the reserve only ever moves 1 card at a time, like waste) - not FoundationCell/FreecellCell's
 * shape, even though the "hide while flying, show a frozen copy of whatever was on top before"
 * need is identical to those two: the reserve is a SOURCE the player drags/taps away from, the
 * same as waste, not a destination slot a move lands into from elsewhere.
 *
 * `dealHidden` is a SEPARATE flag from `isFlyingHere`, deliberately kept out of
 * useFrozenWhileHidden's frozen-overlay branch below: this cell's very first-ever render (state
 * goes from null to the freshly dealt game in one commit - see the `if (!state)` early return
 * above) already has the reserve's top card present AND hidden at once, with no earlier "what was
 * there before" render for useFrozenWhileHidden to have captured - its `frozen` state would
 * initialize to that same incoming card (not an empty slot), so folding `dealHidden` into
 * `isFlyingHere` would show that frozen copy at full opacity behind the real (opacity-0) card,
 * defeating the hide entirely. `isFlyingHere` (real moves onto the reserve, i.e. only ever an
 * undo - see its own doc comment below) is never true on a component's first render, so it has a
 * genuine prior frame for useFrozenWhileHidden to freeze and keeps using that overlay untouched. */
export function ReserveCell({ card, under, isFlyingHere, dealHidden, shakeToken, highlighted, onPress, onDrop }: { card: Card | undefined; under?: Card; isFlyingHere: boolean; dealHidden?: boolean; shakeToken?: number; highlighted?: boolean; onPress: (measure: () => Promise<{ x: number; y: number }>) => void; onDrop: (x: number, y: number, flight: DragFlightHandle, dragged: Card) => Promise<boolean> | boolean }) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere)
  const underlay = isFlyingHere ? frozen : card
  // Take-off hold: keeps drawing a card that has just left while its ghost is not on screen yet (useTakeOffHold).
  const { shown, holding, revealing } = useTakeOffHold(card)
  // An undo landing here hides the real card under the overlay - but never a held card (the painted copy of the card that
  // just left, which must stay drawn until its ghost shows), the same gate as every other single-card pile. (An undo
  // can't start while a reserve card is still taking off - undo waits out every flight - so this is for consistency.)
  const flyingHere = isFlyingHere && !holding
  // While the card a take-off uncovered is revealed (useTakeOffHold), the overlay - showing `card` since the move's own
  // commit - stands in for the real card, whose Image has just been re-sourced from the departed card. Not while the deal
  // still hides that card (`dealHidden`: nothing may show here until its deal flight lands - card ids repeat across deals).
  const overlayVisible = flyingHere || (revealing && !dealHidden)
  return (
    <View>
      {/* A held card is inert - no drag, no tap, even with a card under it: the same call as StockWaste's waste top (a tap
      there is a repeat tap on what still looks like the card that left; passing it on would send a card never seen, and
      drawn nowhere until its own ghost painted). */}
      {shown ? <DraggableCard card={shown} hidden={flyingHere || dealHidden || revealing} disabled={holding} registryId={holding ? (card?.id ?? null) : undefined} shakeToken={holding ? undefined : shakeToken} hinted={highlighted && !holding} underCard={holding ? card : under} emptyFallback={<EmptySlot />} onPress={holding ? undefined : onPress} onDrop={holding ? undefined : onDrop} testID='reserve-top' /> : <EmptySlot testID='reserve-top' hinted={highlighted} />}
      {/* Mounted (invisible) whenever there is a card, not just while an undo is landing here - see PileOverlay. */}
      {(isFlyingHere || card) && <PileOverlay visible={overlayVisible}>{underlay ? <PlayingCard card={underlay} disabled /> : <EmptySlot />}</PileOverlay>}
    </View>
  )
}

export default withGameProviders(CanfieldScreenInner)

function CanfieldScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // The draw count the in-progress deal was actually dealt with - deliberately not re-derived from
  // `settings` every render, same reasoning KlondikeScreen's own `klondikeDraw` state has: a
  // mid-game settings change must never mutate the current deal's own rules.
  const controllerRef = useRef(createCanfieldController(settings.canfieldDraw))
  const [canfieldDraw, setCanfieldDraw] = useState<1 | 3>(settings.canfieldDraw)
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play/stock-draw can all run concurrently with
  // each other - PATTERN_OVERLAP_GATE, mirrors KlondikeScreen's identical adoption of this hook).
  // Destructured below so every existing reference to `state`, `commitState`, `flying`,
  // `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, isLanding, shrinkFlying, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<CanfieldState>()
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<CanfieldState>>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: CanfieldState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useFoundationWinCheck's own hintsUsedRef param), to
  // decide whether this win counts toward the "wins without hint" stat/achievement. Reset alongside
  // the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth } = useGameLayout()
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TOP_ROW_UNITS)
  // Portrait keeps the width-derived size untouched; the wide layout is only ~400pt tall, so there the
  // cards shrink until a tableau column with room to grow fits (see boardModel.ts).
  const cardWidth = useFittedCardWidth(widthCardWidth, BOARD_MODEL)
  const gap = useFittedGap(widthGap, widthCardWidth, cardWidth, contentWidth - GAME_CONTENT_PADDING * 2, TOP_ROW_UNITS)
  // Both rows' width: the 7 slots and the 6 gaps between them.
  const rowWidth = cardWidth * TOP_ROW_UNITS + gap * (TOP_ROW_UNITS - 1)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth)
  const ghost = useDragGhost()
  const rotation = useRotation()
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  // The waste slot itself (StockWaste's wasteRef) - exactly card-sized, and where the top card sits.
  const wasteViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Reads controllerRef.current live inside isWon (rather than passing controllerRef.current
  // directly, which would freeze this render's controller into checkWin's closure) - matches
  // KlondikeScreen's identical fix, so a straggling call from a stale render's closure chain still
  // checks against the CURRENT controller, same as every other controllerRef.current read in this
  // file. Canfield's draw count is a per-deal config (see controllerRef's own doc comment above),
  // the same reasoning KlondikeScreen's own controllerRef exists for.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: CanfieldState) => controllerRef.current.isWon(s) }, 'canfield', session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing animating and the initial deal finished - what the auto-play hook below waits for, and
  // what the win celebration waits for too (see useWinReveal).
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0
  // `won` is game state (clock, stat, save, undo/hint gating) and flips with the winning move; the
  // celebration - foundations giving way to the win cascade, fireworks, banner - waits until the
  // last card has flown in and landed, so it is never hidden mid-flight (which used to make it
  // simply appear) and the finished board reads for a beat first.
  const winRevealed = useWinReveal(won, settled)
  // The board the win cascade has taken over from, and which piles it took over (set once its ghosts are on screen -
  // startChains' onShown, see runWinCascade): once it IS the current state, and the win is revealed, exactly those piles
  // blank their real cards - not a moment earlier. Compared by identity (state is replaced wholesale on every change), so
  // an undo or a New Game un-blanks the piles with no reset to remember.
  const [cascadeHandoff, setCascadeHandoff] = useState<{ state: CanfieldState; piles: ReadonlySet<number> } | null>(null)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real top card has been hidden (won-gated, see the foundation row below), at which
   * point that card is no longer CardRegistry-registered at all. */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  /** Flights awaiting their post-commit measurement + flight.flyTo, queued by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), undo, and auto-play (firePlay/
   * fireDrawAndPlay) - a list (not a single slot) since these can now genuinely overlap (see
   * useFlightConcurrency's own PATTERN_OVERLAP_GATE doc comment, mirrors KlondikeScreen's identical
   * field): two entries queued in the same commit would otherwise clobber each other in a single
   * ref slot, permanently stranding whichever one lost. Each entry carries its own already-created
   * DragFlightHandle (from whichever call site queued it - or, for a drag's own drop, handed in via
   * PileDragConfig.onDrop/DraggableCard's onDrop) to fly/hide once measured, and its own flyingId to
   * remove exactly its own `flying` entry once it lands - see the [state]-effect below. `viaStock`
   * measures via stockViewRef (a plain View, not per-card) instead of CardRegistry - only undoing a
   * stock draw flies back toward the stock; every other destination (including the reserve, on an
   * undo) is a real per-card-registered pile. `gen` is the dealTokenRef
   * value at the moment this flight was queued - re-checked once the async measurement below
   * resolves, so a flight queued against a game that's since been replaced by "New Game" doesn't
   * measure/land against the new deal's DOM (card ids are shuffle-independent and reused across
   * deals - see deck.ts). `to` is the pile the card is headed for, so a foundation landing can fall
   * back to that pile's own slot container when the card itself can't be measured. */
  const pendingFlightRef = useRef<{ cardId: string; to: PileRef; viaStock?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  /** Draw-3 stock draws awaiting their post-commit measurement + deal.start() - a list for the same
   * overlapping-actions reason as pendingFlightRef above. Analogous shape, for the multi-card
   * deal-style flight (see the [state]-effect below and handleDrawStock) - drawnCards is
   * oldest-first, ending with the new top/frontmost card. `gen`/`flyingId` guard the same races
   * pendingFlightRef's do, above. */
  const pendingDealDrawRef = useRef<{ topCardId: string; drawnCards: Card[]; gen: number; flyingId: number }[]>([])
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const cascadeFeedback = useCascadeFeedback(playCardSound, hapticCard)
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    controllerRef.current = createCanfieldController(settings.canfieldDraw)
    setCanfieldDraw(settings.canfieldDraw)
    const s = controllerRef.current.newGame(randomSeed())
    // A still-armed cascade must not fire on the new deal (see useAutoFoundationCascade's disarm), nor a finish start on one
    // that happens to be solved: only the player's own move does that (see useAutoFinish's suppress).
    cascade.disarm()
    finish.suppress()
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingDealDrawRef.current = []
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const starter = foundationStarter(s)
    const sequence = starter ? buildCanfieldDealSequence(starter, s.tableau, s.reserve) : []
    setDealHiddenIds(new Set(sequence.map((step) => step.cardId)))
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<CanfieldState>) {
    ++dealTokenRef.current
    const draw = saved.config === 1 || saved.config === 3 ? saved.config : settings.canfieldDraw
    controllerRef.current = createCanfieldController(draw)
    setCanfieldDraw(draw)
    // A resumed board sits until the player moves, even a solved one.
    cascade.disarm()
    finish.suppress()
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingDealDrawRef.current = []
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
    if (session.moves > 0 && !won) recordDealAbandoned('canfield')
    startNewGame()
  }

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using. Unlike Klondike's runDeal, the
  // flying cards aren't forced face-down: the foundation starter, each tableau column's single
  // starting card, and the reserve's own top card are genuinely dealt face up in real Canfield
  // (rules.ts's newGame already sets faceUp: true on all three) - same reasoning FreeCellScreen's
  // own runDeal documents for its own all-face-up deal. The 34-card stock is deliberately excluded
  // from the sequence entirely (see dealSequence.ts) and just appears as a pile, the same treatment
  // every other game's own leftover stock gets. The reserve's other 12 (face-down) cards DO fly too
  // - own step, own delayMs, own landed callback, same as any other dealt card - but since
  // ReserveCell never registers a view for them (it only ever renders the pile's top card), there's
  // nothing for CardRegistry to measure a destination from: ownDestinations below only asks it for
  // the steps that have a real view (reserveTop, foundation, tableau), and every hidden reserve
  // card's entry reuses the reserve top's own measured destination instead - they land stacked
  // exactly where it does, a beat before it arrives on top of them, matching how a real dealer lays
  // a pile down before flipping its top card. This also means dealHiddenIds correctly covers the
  // whole 13-card pile from the start (see dealSequence.ts's reserveTop doc comment), not just its
  // visible top card, so a future depth visual for the reserve pile can't skip past this animation.
  async function runDeal(s: CanfieldState, token: number) {
    const starter = foundationStarter(s)
    const sequence = starter ? buildCanfieldDealSequence(starter, s.tableau, s.reserve) : []
    const [origin, ownDestinations] = await Promise.all([measureView(stockViewRef.current), Promise.all(sequence.map((step) => (step.zone !== 'reserve' || step.reserveTop ? ghost.cardRegistry.measure(step.cardId) : Promise.resolve(null))))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }

    const reserveTopIndex = sequence.findIndex((step) => step.reserveTop)
    const reserveTopDest = reserveTopIndex >= 0 ? ownDestinations[reserveTopIndex] : null

    const entries: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = ownDestinations[i] ?? (step.zone === 'reserve' && !step.reserveTop ? reserveTopDest : null)
      if (!dest) return
      entries.push({
        cardId: step.cardId,
        card: step.card,
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

  // Foundation piles are guaranteed full (13 cards each, starting at foundationRank and wrapping
  // all the way back around through a full cycle) the instant isWon() is true - measures each
  // pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef), which is card-sized
  // and always mounted, whether or not the pile's real cards are drawn. Chains that whole pile
  // top-first down to bottom-last (foundation arrays are built bottom-up, foundationRank's card
  // pushed first, so reversing gives the right order - true regardless of which rank a given pile
  // actually started/ended at). Same dealTokenRef guard as every other async measurement here.
  //
  // The real cards blank only once the ghosts that replace them are on screen (cascadeHandoff, set from startChains'
  // onShown - in the commit the ghosts appear, which waits for their parked faces to paint; see WinCascadeLayer's
  // CascadeChains): blanking them when the win is revealed instead, and starting the chains from the async continuation
  // that follows, left every pile empty for the frames in between, and blanking them in the commit that mounted the
  // ghosts showed blank-faced cards for a frame or two. An undo or New Game before then clears the cascade, which drops
  // the callback (and the hand-off is keyed to `s` anyway). A pile whose chain could not start (no measurable slot) keeps
  // its real cards, and if no chain can start at all the piles simply stay up under the banner instead of vanishing (an
  // empty cascade never calls onShown).
  async function runWinCascade(s: CanfieldState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    const handedOff = new Set<number>()
    s.foundation.forEach((pile, suit) => {
      const origin = origins[suit]
      if (!origin || pile.length === 0) return
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
      handedOff.add(suit)
    })
    winCascade.startChains(chains, cardWidth, () => setCascadeHandoff({ state: s, piles: handedOff }))
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

  // Same deferral reasoning as the deal/flight effects above - never measure CardRegistry
  // synchronously inside checkWin itself, since the winning foundation cards' own registration
  // effects haven't necessarily run yet in that same commit. Held back until the win is REVEALED
  // (not merely won): the cascade takes over from the foundations' real cards, which must stay put
  // until the last flight has landed on them.
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
        // The waste slot (where the top card sits) stands in if the top card itself can't be found, so
        // the fan still flies out instead of every drawn card just appearing.
        const [origin, topPos] = await Promise.all([measureView(stockViewRef.current), ghost.cardRegistry.measure(p.topCardId).then((rect) => rect ?? measureView(wasteViewRef.current))])
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

  // Auto-play-to-foundation has two independent halves (applyMove's afterPlayerMove calls). This one, the cascade, only
  // ever follows the player's own play of a card to a foundation - see useAutoFoundationCascade for the trigger model (any
  // other move of theirs and a stock draw stop it), and engine/autoFoundation.ts for the two mechanisms computeNextStep
  // composes.
  const cascade = useAutoFoundationCascade<CanfieldState>({
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
  // The finish: once the board is solved (rules.ts's canAutoFinish - reserve, stock and waste empty, nothing hidden, no
  // choice left), every remaining card files away on its own at the finish's quicker pace - after ANY move of the
  // player's that leaves it so, or the cascade a foundation play set off (see useAutoFinish). Both read the live
  // controller: it is replaced on every New Game/restore.
  const finish = useAutoFinish<CanfieldState>({
    state,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    getState: () => stateRef.current,
    canFinish: (s) => canAutoFinish(controllerRef.current, s),
    nextMove: (s) => nextFinishMove(controllerRef.current, s),
    isLanding,
    firePlay
  })

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out.
  useEffect(() => {
    loadGameInProgress<CanfieldState>('canfield').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('canfield')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after checkWin above just cleared it. Deliberately NOT also keyed on a ticking
  // elapsed-seconds value the way an earlier version of this effect was: `session.getElapsed()`
  // computes the true current elapsed from wall-clock time on demand (see useGameSession.ts), so a
  // save made at the last real move is never stale even once the player just sits looking at the
  // board afterward - resuming always recomputes the exact right value instead of depending on
  // whenever this effect last happened to run.
  useEffect(() => {
    if (state && !won) saveGameInProgress('canfield', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: canfieldDraw })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, canfieldDraw, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('canfield', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: canfieldDraw })
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
    recordHintUsed('canfield')
  }

  function pushUndo(prev: CanfieldState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // Mirrors handleCardTap's forward flight, just in reverse - see KlondikeScreen's identical
  // function for the full reasoning. Canfield's stock draw behaves exactly like Klondike's draw-3
  // (fixed at 3, unlimited recycling - rules.ts's DRAW_COUNT), so the multi-card-draw-undo branch
  // below applies here the same way it does there.
  // One undo per call - see useFlightConcurrency's runUndo.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // A plain move's undo - a draw-1 included - takes its cards back off the pile it went to, so it
  // overlaps the undos before it once nothing is still landing there. One that lands on or leaves
  // the waste also waits for the waste to be quiet: its frozen top expects one arrival at a time. A
  // draw-3 fan flies back through the deal layer (one batch at a time) and a recycle (no move: it
  // just reverts) moves the whole waste - each of those one at a time.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!entry || !stateRef.current) return null
    const { move } = entry
    if (!move) return 'exclusive'
    if (move.from.zone === 'stock' && move.to.zone === 'waste' && move.count > 1) return 'exclusive'
    return { takesFrom: move.from.zone === 'waste' ? [move.to, WASTE] : [move.to] }
  }

  async function revertTopUndo() {
    // The stack and the board are read via their refs, not the closure: undos can run back-to-back
    // before React re-renders (see runUndo).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    // Every auto-played step is its own undo entry, so an undo can land on a board with a safe card
    // (or a whole sweep) waiting - a still-armed cascade must not play straight back what the player
    // just took back, and undoing a card off a solved board leaves it solved, so the finish must not
    // send it straight back up either. Nothing re-arms the cascade until the player's next foundation
    // play, nor starts the finish until their next move.
    cascade.disarm()
    finish.suppress()
    if (won) {
      setWon(false)
      winCascade.clear()
    }
    const { move, state: prevState } = entry
    // Captured once, up front - every stash this call makes uses this same token, so a "New Game"
    // that fires mid-await consistently invalidates every one of this undo's pending flights rather
    // than some using a token read before the race and some after (mirrors KlondikeScreen's
    // identical `gen` capture in its own handleUndo).
    const gen = dealTokenRef.current
    startFlights(1)

    if (!move) {
      setUndoStack((stack) => stack.slice(0, -1))
      commitState(prevState)
      settleFlight()
      return
    }

    // Reverse of the deal-style draw-3 flight above: fly each drawn card back toward the stock
    // independently, staggered newest-first.
    if (move.from.zone === 'stock' && move.to.zone === 'waste' && move.count > 1) {
      const sourcePile = resolvePile(move.to, current)
      const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : [] // oldest -> newest/top
      const topPos = movingCards.length > 0 ? ((await ghost.cardRegistry.measure(move.anchorCardId)) ?? (await measureView(wasteViewRef.current))) : null
      const stockDest = topPos ? await measureView(stockViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))

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
          },
          undefined,
          FLIGHT_SPRING // the fan flies back on the same flight it came on
        )
      } else {
        commitState(prevState)
        settleFlight()
      }
      return
    }

    const sourcePile = resolvePile(move.to, current)
    // A foundation move's own card can sit BURIED under silent auto-plays that landed on the same
    // pile after it, in an entry from a save written before auto-plays became their own undo steps
    // (see applyMove) - so it is found by id, not assumed to be on top, or the ghost would carry the
    // wrong card.
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
      pendingFlightRef.current.push({ cardId: move.anchorCardId, to: move.from, viaStock: move.from.zone === 'stock', gen, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see firePlay below): an auto-played card
  // isn't a player decision, so it doesn't count toward the moves/score the player is judged on, arm
  // the cascade or start the finish itself. It still pushes its OWN undo entry (the board right
  // before it), like every other automatic step here (handleDrawStock's sweep draws/recycles,
  // fireDrawAndPlay), so one Undo takes back exactly one step, with that step's own flight, and the
  // player can stop anywhere between the move that set a cascade off and its last auto-played card.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
    // commitState just did, not the same stale board both closures captured (mirrors
    // KlondikeScreen's identical applyMove).
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
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      // Only the player's own play of a card to a foundation starts the cascade; any other move of theirs
      // stops it, so a card it uncovers (the reserve's next card, say) is theirs to find and play. The
      // finish follows ANY move of theirs that leaves the board solved, except one that takes a card back
      // off a foundation, which stops it (see useAutoFinish).
      if (!opts?.silent) {
        cascade.afterPlayerMove(to)
        finish.afterPlayerMove(from)
      }
      return true
    }
    return false
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move, a manual drag's
  // drop, or an auto-play) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    const flyingId = beginFlying(to, count)
    pendingFlightRef.current.push({ cardId: anchorCardId, to, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  // Composes engine/autoFoundation.ts's two mechanisms into the shared cascade hook's step shape.
  //
  // Mechanism B (isFullyAutoCompletableWithDraws/nextAutoCompleteMoveWithDraws) is reused as-is
  // from the SHARED engine/autoFoundation.ts: both operate purely through the generic
  // GameController interface (they call controller.tryMove/drawStock themselves, never touching raw
  // rank comparisons), so Canfield's own cyclic tryMove generalizes correctly there with zero
  // changes needed.
  //
  // Mechanism A (findSafeAutoPlay) is Canfield's OWN reimplementation, imported from ./rules (NOT
  // engine/autoFoundation.ts) - the shared version hardcodes an Ace-starting, linearly-building
  // foundation via raw rank comparisons (card.rank - 1), which is simply wrong for Canfield's
  // variable-starting-rank, wrapping foundations: it would silently misjudge which cards are safe
  // to auto-play. rules.ts's own findSafeAutoPlay is a cyclic-position-aware reimplementation of
  // the identical idea, scoped to this game only (see its own doc comment there). Note the
  // argument order is reversed from the shared version: rules.ts's findSafeAutoPlay takes
  // (state, accessible), not engine/autoFoundation.ts's (accessible, foundation).
  //
  // Nothing at all once the board is solved (rules.ts's canAutoFinish): the finish takes over there,
  // at its own pace - otherwise the cascade and the finish fight over the same cards. A sweep through
  // the stock that empties the stock and waste before the win hands its last cards over the same way.
  function computeNextStep(s: CanfieldState): AutoCompleteStep | null {
    if (!controllerRef.current.accessibleCards) return null
    if (canAutoFinish(controllerRef.current, s)) return null
    if (isFullyAutoCompletableWithDraws(controllerRef.current, s)) return nextAutoCompleteMoveWithDraws(controllerRef.current, s)
    const entry = findSafeAutoPlay(s, controllerRef.current.accessibleCards(s))
    return entry ? { kind: 'play', entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } } : null
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move. Guard against something else changing state during that gap by
  // snapshotting stateRef before the await and bailing if it no longer matches after. `stillWanted`
  // is re-checked there too: whichever automation sent this card - the cascade (its isArmed, the
  // default) or the finish (its isAllowed, which useAutoFinish passes) - may have been ended meanwhile
  // by the player's move elsewhere, an undo or a new deal.
  // Resolves once the move is COMMITTED (true) or refused (false), not when it lands - which is what
  // lets the cascade and the finish send the next card while this one is still flying.
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
  // skipping the ordinary "land on waste first" stop entirely (the confirmed sweep visual). Not a
  // player decision, so it doesn't count toward moves/score - but, like every automatic step (see
  // applyMove's `silent`), it is undoable on its own. As TWO entries, the draw and then the play,
  // each an ordinary kind handleUndo already flies: the first Undo sends the card from the
  // foundation back to the waste, the next flies the draw back into the stock. One entry for the
  // combined step would have no flight that fits it (stock -> foundation is no move kind).
  async function fireDrawAndPlay(entry: AccessibleCard, to: PileRef) {
    const current = stateRef.current
    if (!current || !controllerRef.current.drawStock) return
    const afterDraw = controllerRef.current.drawStock(current)
    if (!afterDraw) return
    const result = controllerRef.current.tryMove(afterDraw, { from: entry.ref, to, count: 1 })
    if (!result) return
    const drawnTop = top(afterDraw.waste)
    if (!drawnTop) return
    startFlights(1)

    const origin = await measureView(stockViewRef.current)
    if (!origin || stateRef.current !== current || undoBusyRef.current || !cascade.isArmed()) {
      settleFlight()
      return
    }

    cascadeFeedback()
    const flight = ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying(to, 1)
    pushUndo(current, { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: afterDraw.waste.length - current.waste.length, anchorCardId: drawnTop.id })
    pushUndo(afterDraw, { from: entry.ref, to, count: 1, anchorCardId: entry.card.id })
    commitState(result)
    checkWin(result, session.moves)
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
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingAltColorCyclic)
  }

  // Mirrors KlondikeScreen's own draw-3 handleDrawStock exactly (both the >1 deal-style-flight
  // branch and the ===1 single-ghost branch, for when the stock has fewer than 3 cards left) -
  // Canfield's own draw count is settings.canfieldDraw (see controllerRef above), the same
  // per-deal-config shape Klondike's own draw setting already has.
  // `opts.sweep` marks this as an automatic step of the win-completing sweep (see the shared
  // cascade hook's own fireDraw callback above) rather than a genuine player tap - not a player
  // decision, so it doesn't count toward moves/score, but (like applyMove's own silent branch) it
  // still pushes its own undo entry, so the sweep can be taken back one draw/recycle at a time.
  async function handleDrawStock(opts?: { sweep?: boolean }) {
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    // Without this, rapid-tapping the stock pile several times before React re-renders drew the
    // SAME card repeatedly (every call computing drawStock() against the same stale board) instead
    // of drawing several different ones in a row.
    const current = stateRef.current
    if (!current || !controllerRef.current.drawStock) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const result = controllerRef.current.drawStock(current)
    if (!result) return
    startFlights(1)
    // A draw is the player's, but it is not a play: it never sets auto-play off, and it stops a cascade
    // still running from their last play, so a card they just drew is theirs to find and play. The
    // finish needs nothing here: a draw or a recycle never leaves the board solved (the waste or the
    // stock still holds a card).
    if (!opts?.sweep) {
      session.registerMove()
      cascade.disarm()
    }

    const drawnCard = top(result.waste)
    if (!drawnCard) {
      // Recycling the waste back into the stock, not a single card being drawn - nothing
      // card-shaped to fly, so undo just reverts this instantly (see MoveInfo | null above).
      pushUndo(current, null)
      commitState(result)
      settleFlight()
      return
    }

    const drawnCount = result.waste.length - current.waste.length
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: drawnCount, anchorCardId: drawnCard.id }

    if (drawnCount > 1) {
      const drawnCards = result.waste.slice(result.waste.length - drawnCount) // oldest -> newest/top
      pushUndo(current, move)
      const flyingId = beginFlying({ zone: 'waste', index: 0 }, drawnCount)
      pendingDealDrawRef.current.push({ topCardId: drawnCard.id, drawnCards, gen: dealTokenRef.current, flyingId })
      commitState(result)
      return
    }

    const origin = await measureView(stockViewRef.current)
    // The cascade's own draw (a sweep) must not commit once the player's move has ended the cascade, or over a board that
    // moved on while it was measuring (committing `result` would undo whatever landed meanwhile).
    if (opts?.sweep && (!cascade.isArmed() || stateRef.current !== current)) {
      settleFlight()
      return
    }
    if (!origin) {
      pushUndo(current, move)
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

    pushUndo(current, move)
    commitState(result)
    pendingFlightRef.current.push({ cardId: drawnCard.id, to: { zone: 'waste', index: 0 }, gen: dealTokenRef.current, flyingId, flight })
  }

  // `s` defaults to the render closure's `state`; handleUndo passes stateRef.current (the board as of
  // right now - another undo may have committed since this render).
  function resolvePile(ref: PileRef, s: CanfieldState | null = state): Card[] | null {
    if (!s) return null
    switch (ref.zone) {
      case 'tableau':
        return s.tableau[ref.index] ?? null
      case 'foundation':
        return s.foundation[ref.index] ?? null
      case 'reserve':
        return s.reserve
      case 'waste':
        return s.waste
      default:
        return null
    }
  }

  // Tapping any movable card sends it to its best legal destination - a foundation if one exists,
  // otherwise the tableau pile that buries the fewest cards. Works identically for a reserve-top
  // tap and a waste-top tap (both resolve via resolvePile's 'reserve'/'waste' cases above) - the
  // reserve's own empty-tableau-column priority rule is enforced entirely inside rules.ts's
  // tryMove/autoMoveHint, so this handler never needs to special-case which of the two a card came
  // from.
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
  // Draw-3 keeps the last 3 drawn cards visible, fanned - draw-1 never shows more than the one real top card (as Klondike):
  // a draw-1 fan buried the reserve card beside it for nothing, and showed the old top twice during every draw's flight.
  // wasteBehind excludes wasteTop itself and is ordered nearest-to-top first (see StockWaste), so the slice below
  // (oldest-visible -> wasteTop) is reversed.
  const visibleWasteCount = canfieldDraw === 3 ? Math.min(3, state.waste.length) : Math.min(1, state.waste.length)
  const wasteBehind = state.waste.slice(Math.max(0, state.waste.length - visibleWasteCount), state.waste.length - 1).reverse()
  const reserveTop = top(state.reserve)
  // The reserve can only ever be a flight DESTINATION on an undo (tryMove itself never sends a
  // card back onto the reserve - see rules.ts) - mirrors the foundation/waste/tableau `isFlyingHere`
  // checks below exactly.
  const reserveFlyingHere = flying.some((f) => f.to.zone === 'reserve')
  // The reserve's own top (13th) card is part of the initial deal sequence now (see
  // dealSequence.ts) - kept as its own separate flag rather than folded into reserveFlyingHere,
  // since ReserveCell needs to tell the two hidden-reasons apart (see its own doc comment).
  const reserveDealHidden = !!reserveTop && dealHiddenIds.has(reserveTop.id)

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Canfield' subtitle={`Draw ${canfieldDraw}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<CanfieldSettingsSection />} rules={CANFIELD_RULES}>
        <View style={[styles.topRow, { width: rowWidth }]}>
          <View style={[styles.foundationsGroup, { gap }]}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              // The foundation-starter card is part of the initial deal sequence too (see
              // dealSequence.ts's 'foundation' step) - widen the regular flying.to check with the
              // same dealHiddenIds membership the reserve's own top card uses, so the starter stays
              // hidden until its own deal flight lands instead of showing at full opacity from the
              // very first frame of a fresh deal.
              //
              // Several tap flights can also be headed to one pile at once (they overlap): count the cards
              // still in the air so the pile keeps showing the top card that has already LANDED under the
              // rest (see FoundationCell's settledCard). A card still hidden by the deal has not landed,
              // whatever the pile says, so it never counts: that slot shows empty until its own flight arrives
              // (the starter is the pile's bottom card, so there is nothing beneath it to show instead).
              const flightsInAir = flying.filter((f) => f.to.zone === 'foundation' && f.to.index === i).reduce((sum, f) => sum + f.count, 0)
              const isFlyingHere = flightsInAir > 0 || (!!t && dealHiddenIds.has(t.id))
              const landed = pile[pile.length - 1 - flightsInAir]
              const cascadeTookOver = winRevealed && cascadeHandoff?.state === state && cascadeHandoff.piles.has(i)
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={cascadeTookOver ? undefined : t}
                    isFlyingHere={isFlyingHere}
                    settledCard={landed && !dealHiddenIds.has(landed.id) ? landed : null}
                    suit={SUITS[i]}
                    rank={state.foundationRank}
                    highlighted={hintCountFor(activeHint, { zone: 'foundation', index: i }) > 0}
                    slotRef={(el) => {
                      foundationSlotRefs.current[i] = el
                    }}
                    // A foundation card may come back down to the tableau (rules.ts's tryMove) - by drag only, and never
                    // once the deal is won. A move off a foundation stops a running cascade and finish alike (applyMove), so
                    // it isn't sent straight back up, even on a solved board.
                    under={pile[pile.length - 2] ?? null}
                    onDrop={won ? undefined : (x, y, flight, dragged) => attemptDrop({ zone: 'foundation', index: i }, 1, x, y, dragged.id, flight)}
                  />
                </DropZone>
              )
            })}
          </View>

          <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteBehind={wasteBehind} wasteUnder={state.waste[state.waste.length - 2]} wasteHiddenCount={flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0)} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} gap={gap} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y, flight, dragged) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, dragged.id, flight)} stockRef={stockViewRef} wasteRef={wasteViewRef} />
        </View>

        <View style={[styles.tableauRow, { gap, width: rowWidth }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              // Claims a flight slot (see activeFlightCountRef's doc comment above) purely so undo
              // sees this drop as in-flight for its whole duration, not just once completeMove
              // lands one - PileView.tsx (shared, not ours to edit) already ran its own hitTest
              // await before invoking this callback, so this is the earliest point CanfieldScreen
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
                {/* dimUnplayable: unlike Klondike (genuine face-down burial reads as unavailable
                via the card back alone), Canfield's tableau - like FreeCell's - is always
                entirely face-up (every card that ever lands here, from waste/reserve/another
                tableau run, is already face-up per rules.ts), so a face-up card that isn't
                currently the head of a movable run needs its own dimmed cue to read as
                temporarily stuck rather than pickable. */}
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
              </DropZone>
            )
          })}
          {/* The open slot (the waste fan's, in the row above), then the reserve under the waste - see LAYOUT DECISION. */}
          <View style={[styles.openSlot, { width: cardWidth }]} />
          <DropZone registry={dropZones} pileRef={{ zone: 'reserve', index: 0 }} style={[styles.reserveSlot, { width: cardWidth }]}>
            <ReserveCell card={reserveTop} under={state.reserve[state.reserve.length - 2]} isFlyingHere={reserveFlyingHere} dealHidden={reserveDealHidden} shakeToken={reserveTop && shake?.cardId === reserveTop.id ? shake.token : undefined} highlighted={hintCountFor(activeHint, { zone: 'reserve', index: 0 }) > 0} onPress={(measure) => handleCardTap({ zone: 'reserve', index: 0 }, reserveTop!.id, measure)} onDrop={(x, y, flight, dragged) => attemptDrop({ zone: 'reserve', index: 0 }, 1, x, y, dragged.id, flight)} />
          </DropZone>
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
      (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
      banner comes last of all three so it's the one thing guaranteed to sit on top of the
      animation, not buried under it. */}
      {winRevealed && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles() {
  return StyleSheet.create({
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row'
    },
    // Card-tall, not stretched to the tallest tableau column like the columns beside them (whose height is
    // their drop target).
    openSlot: {
      alignSelf: 'flex-start'
    },
    reserveSlot: {
      alignSelf: 'flex-start'
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
