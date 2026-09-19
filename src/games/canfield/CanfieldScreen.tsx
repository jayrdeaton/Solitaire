// Canfield solitaire screen: 4 foundations (variable starting rank, wrapping King -> Ace), one
// 4-column tableau with cyclic alternating-color runs (a King may land on an Ace), a 13-card
// reserve (a second, passive single-card-at-a-time source alongside waste), and a draw-3/unlimited
// -recycle stock+waste pair - see rules.ts for the full rules. Architecturally closest to Klondike
// (same imperative checkWin-after-applyMove flow, same tap-to-move/drag/undo/auto-play shape) -
// see this file's own comments for exactly where Canfield's rules force real deviations.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useFittedCardWidth, useFittedGap, useGameLayout } from '@/components/gameLayout'
import { wasteFanScreenShift } from '@/components/overlayFrame'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { CANFIELD_RULES } from '@/constants/gameRules'
import { AutoCompleteStep, isFullyAutoCompletableWithDraws, nextAutoCompleteMoveWithDraws } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { detectRevealedCard, runCountFrom, top } from '@/engine/pile'
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
import { CanfieldSettingsSection } from './CanfieldSettingsSection'
import { buildCanfieldDealSequence } from './dealSequence'
import { CanfieldState, createCanfieldController, findSafeAutoPlay, isDescendingAltColorCyclic, isFoundationStarterCard } from './rules'

// Floor for useTableauMaxHeight below, not a fixed height anymore - a short screen never fans out
// less generously than this, but a screen with real headroom to spare now gets more of it.
const TABLEAU_MIN_HEIGHT = 460
// LAYOUT DECISION: the top row needs 7 card-slots (4 foundations + 1 reserve + stock/waste), but
// the tableau below is only 4 columns wide - the opposite of every other game here, where the top
// row and tableau are similar widths. Sizing cardWidth off the tableau's own 4 columns (Klondike's
// approach - see its own TABLEAU_COLUMNS-based cardLayoutForRow call) would let the top row's 7
// slots overflow the screen on anything narrower than a very wide window. Instead, cardWidth is
// sized off this TOP row's own 7 slots - the widest row on screen - the same "widest row sets the
// scale, narrower rows center underneath" idiom Pyramid already uses (its 7-card triangle base
// sets cardWidth via its own TRIANGLE_WIDTH_UNITS, while the narrower stock/discard control row
// centers under it - see PyramidScreen.tsx). The 4-column tableau then renders smaller and centers
// underneath the top row (see `board`'s alignItems: 'center' below).
//
// The `gap` returned alongside cardWidth by the one cardLayoutForRow call below is deliberately
// reused as EVERY real gap inside the top row (its own inter-group `gap`, foundationsGroup's
// internal `gap`, and StockWaste's own internal CARD_GAP_MIN gap all stay equal), which makes this
// reservation pixel-exact rather than a rough guess: 4 foundations + 1 reserve + 2 (stock/waste) =
// 7 card-widths, with 6 gaps between them (2 between the 3 groups + 3 inside foundationsGroup + 1
// inside StockWaste) - exactly matching cardLayoutForRow's own `7*cardWidth + gap*6` reservation
// formula, so the top row's real rendered width never exceeds (or falls meaningfully short of)
// what was reserved for it. The narrower 4-column tableau row underneath breathes by that same
// `gap` too (see TABLEAU_GAP's old declaration, now gone - it and TOP_ROW_GAP have collapsed into
// this one shared runtime value), so the two rows always match even once cards hit CARD_WIDTH_MAX
// and cardLayoutForRow starts growing the gap past CARD_GAP_MIN.
const TOP_ROW_UNITS = 7

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
function ReserveCell({ card, isFlyingHere, dealHidden, shakeToken, highlighted, onPress, onDrop }: { card: Card | undefined; isFlyingHere: boolean; dealHidden?: boolean; shakeToken?: number; highlighted?: boolean; onPress: (measure: () => Promise<{ x: number; y: number }>) => void; onDrop: (x: number, y: number, flight: DragFlightHandle) => Promise<boolean> | boolean }) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere)
  return (
    <View>
      {card ? <DraggableCard card={card} hidden={isFlyingHere || dealHidden} shakeToken={shakeToken} hinted={highlighted} emptyFallback={<EmptySlot />} onPress={onPress} onDrop={onDrop} testID='reserve-top' /> : <EmptySlot testID='reserve-top' hinted={highlighted} />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {frozen ? <PlayingCard card={frozen} /> : <EmptySlot />}
        </View>
      )}
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
  const { state, stateRef, commitState, flying, beginFlying, endFlying, shrinkFlying, activeFlightCount, activeFlightCountRef, startFlights, settleFlight, undoBusyRef, reset: resetFlightConcurrency } = useFlightConcurrency<CanfieldState>()
  const [undoStack, setUndoStack] = useState<UndoEntry<CanfieldState>[]>([])
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
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  const rotation = useRotation()
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
  // file. Canfield's draw count is a per-deal config (see controllerRef's own doc comment above),
  // the same reasoning KlondikeScreen's own controllerRef exists for.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: CanfieldState) => controllerRef.current.isWon(s) }, 'canfield', session, dealTokenRef, recordDealWon, hintsUsedRef)
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
   * undo) is a real per-card-registered pile. `fast` marks a fireAutoMove-triggered flight, passed
   * on to flight.flyTo for the quicker auto-play-to-foundation timing. `gen` is the dealTokenRef
   * value at the moment this flight was queued - re-checked once the async measurement below
   * resolves, so a flight queued against a game that's since been replaced by "New Game" doesn't
   * measure/land against the new deal's DOM (card ids are shuffle-independent and reused across
   * deals - see deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; fast?: boolean; sweep?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
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

  // Foundation piles are guaranteed full (13 cards each, starting at foundationRank and wrapping
  // all the way back around through a full cycle) the instant isWon() is true - measures each
  // pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef), not the top card
  // via CardRegistry, since the real top card is hidden (and therefore unregistered) the instant
  // `won` flips true, in the same commit this effect reacts to. Chains that whole pile top-first
  // down to bottom-last (foundation arrays are built bottom-up, foundationRank's card pushed
  // first, so reversing gives the right order - true regardless of which rank a given pile
  // actually started/ended at). Same dealTokenRef guard as every other async measurement here.
  async function runWinCascade(s: CanfieldState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    s.foundation.forEach((pile, suit) => {
      const origin = origins[suit]
      if (!origin || pile.length === 0) return
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
    })
    winCascade.startChains(chains, cardWidth)
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

  // Same deferral reasoning as the deal/flight effects above - never measure CardRegistry
  // synchronously inside checkWin itself, since the winning foundation cards' own registration
  // effects haven't necessarily run yet in that same commit.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

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

  // Auto-play-to-foundation: only ever fires as a direct consequence of the player's own move - see
  // useAutoFoundationCascade for the trigger model (armFromForwardMove/armFromAceEvent, called from
  // applyMove/handleDrawStock below), and engine/autoFoundation.ts for the two mechanisms
  // computeNextStep composes.
  const cascade = useAutoFoundationCascade<CanfieldState>({
    state,
    settled: activeFlightCount === 0 && dealHiddenIds.size === 0,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep,
    firePlay,
    fireDraw: handleDrawStock,
    fireDrawAndPlay
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
  async function handleUndo() {
    if (undoBusyRef.current || activeFlightCountRef.current > 0 || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    if (won) {
      setWon(false)
      winCascade.clear()
    }
    const entry = undoStack[undoStack.length - 1]
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
      const sourcePile = resolvePile(move.to)
      const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : [] // oldest -> newest/top
      const topPos = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null
      const stockDest = topPos ? await measureView(stockViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))

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
          }
        )
      } else {
        commitState(prevState)
        settleFlight()
      }
      return
    }

    const sourcePile = resolvePile(move.to)
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
      pendingFlightRef.current.push({ cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so it skips the undo stack entirely and doesn't
  // count toward the moves/score the player is judged on.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
    // commitState just did, not the same stale board both closures captured (mirrors
    // KlondikeScreen's identical applyMove).
    const current = stateRef.current
    if (!current) return false
    const result = controllerRef.current.tryMove(current, { from, to, count })
    if (result) {
      if (!opts?.silent) pushUndo(current, { from, to, count, anchorCardId })
      commitState(result)
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      if (!opts?.silent && to.zone === 'foundation') cascade.armFromForwardMove()
      // Reveals a foundation-starter card off the RESERVE (not the tableau - Canfield's tableau is
      // always dealt face-up, so there's no tableau reveal event here at all): auto-play it
      // immediately as a reward for the move that uncovered it, regardless of whether THIS move was
      // itself silent - see useAutoFoundationCascade's armFromAceEvent.
      if (from.zone === 'reserve') {
        const revealed = detectRevealedCard(current.reserve, result.reserve, count)
        if (revealed && isFoundationStarterCard(revealed, result.foundationRank)) {
          cascade.armFromAceEvent({ ref: from, card: revealed }, { zone: 'foundation', index: SUITS.indexOf(revealed.suit) })
        }
      }
      return true
    }
    return false
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move, a manual drag's
  // drop, or an auto-play) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean; fast?: boolean; sweep?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    const flyingId = beginFlying(to, count)
    pendingFlightRef.current.push({ cardId: anchorCardId, fast: opts?.fast, sweep: opts?.sweep, gen: dealTokenRef.current, flyingId, flight })
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
  function computeNextStep(s: CanfieldState): AutoCompleteStep | null {
    if (!controllerRef.current.accessibleCards) return null
    if (isFullyAutoCompletableWithDraws(controllerRef.current, s)) return nextAutoCompleteMoveWithDraws(controllerRef.current, s)
    const entry = findSafeAutoPlay(s, controllerRef.current.accessibleCards(s))
    return entry ? { kind: 'play', entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } } : null
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move. Guard against something else changing state during that gap by
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
  // stack at all (Canfield excludes every silent move from undo, unlike Klondike's cascaded-entry
  // approach).
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
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingAltColorCyclic)
  }

  // Mirrors KlondikeScreen's own draw-3 handleDrawStock exactly (both the >1 deal-style-flight
  // branch and the ===1 single-ghost branch, for when the stock has fewer than 3 cards left) -
  // Canfield's own draw count is settings.canfieldDraw (see controllerRef above), the same
  // per-deal-config shape Klondike's own draw setting already has.
  // `opts.sweep` marks this as an automatic step of the win-completing sweep (see the shared
  // cascade hook's own fireDraw callback above) rather than a genuine player tap - not a player
  // decision, so (matching applyMove's own silent branch) it never touches the undo stack at all,
  // and doesn't count toward moves/score.
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
    if (!opts?.sweep) session.registerMove()

    const drawnCard = top(result.waste)
    if (!drawnCard) {
      // Recycling the waste back into the stock, not a single card being drawn - nothing
      // card-shaped to fly, so undo just reverts this instantly (see MoveInfo | null above).
      if (!opts?.sweep) pushUndo(current, null)
      commitState(result)
      settleFlight()
      return
    }

    // Drawing (or revealing) a foundation-starter card is meant to auto-play it immediately as a
    // reward, regardless of whether this is a genuine player tap or a sweep's own forced draw - see
    // useAutoFoundationCascade's armFromAceEvent. Canfield's "ace" is whatever rank the foundation
    // actually starts from (isFoundationStarterCard), not always rank 1.
    if (isFoundationStarterCard(drawnCard, result.foundationRank)) {
      cascade.armFromAceEvent({ ref: { zone: 'waste', index: 0 }, card: drawnCard }, { zone: 'foundation', index: SUITS.indexOf(drawnCard.suit) })
    }

    const drawnCount = result.waste.length - current.waste.length
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: drawnCount, anchorCardId: drawnCard.id }

    if (drawnCount > 1) {
      const drawnCards = result.waste.slice(result.waste.length - drawnCount) // oldest -> newest/top
      if (!opts?.sweep) pushUndo(current, move)
      const flyingId = beginFlying({ zone: 'waste', index: 0 }, drawnCount)
      pendingDealDrawRef.current.push({ topCardId: drawnCard.id, drawnCards, gen: dealTokenRef.current, flyingId })
      commitState(result)
      return
    }

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

  function resolvePile(ref: PileRef): Card[] | null {
    if (!state) return null
    switch (ref.zone) {
      case 'tableau':
        return state.tableau[ref.index] ?? null
      case 'foundation':
        return state.foundation[ref.index] ?? null
      case 'reserve':
        return state.reserve
      case 'waste':
        return state.waste
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

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  const wasteTop = top(state.waste)
  // Fixed draw-3, so the waste always fans up to the last 3 drawn cards, same as Klondike's own
  // draw-3 mode. wasteBehind excludes wasteTop itself and is ordered nearest-to-top first (see
  // StockWaste), so the slice below (oldest-visible -> wasteTop) is reversed.
  const visibleWasteCount = Math.min(3, state.waste.length)
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
      <GameChrome title='Canfield' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<CanfieldSettingsSection />} rules={CANFIELD_RULES}>
        <View style={styles.board}>
          <View style={[styles.topRow, { gap }]}>
            <View style={[styles.foundationsGroup, { gap }]}>
              {state.foundation.map((pile, i) => {
                const t = top(pile)
                // The foundation-starter card is part of the initial deal sequence too (see
                // dealSequence.ts's 'foundation' step) - widen the regular flying.to check with the
                // same dealHiddenIds membership the reserve's own top card uses, so the starter stays
                // hidden until its own deal flight lands instead of showing at full opacity from the
                // very first frame of a fresh deal.
                const isFlyingHere = flying.some((f) => f.to.zone === 'foundation' && f.to.index === i) || (!!t && dealHiddenIds.has(t.id))
                return (
                  <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                    <FoundationCell
                      card={won ? undefined : t}
                      isFlyingHere={isFlyingHere}
                      suit={SUITS[i]}
                      rank={state.foundationRank}
                      highlighted={hintCountFor(activeHint, { zone: 'foundation', index: i }) > 0}
                      slotRef={(el) => {
                        foundationSlotRefs.current[i] = el
                      }}
                    />
                  </DropZone>
                )
              })}
            </View>

            <DropZone registry={dropZones} pileRef={{ zone: 'reserve', index: 0 }} style={[styles.reserveSlot, { width: cardWidth }]}>
              <ReserveCell card={reserveTop} isFlyingHere={reserveFlyingHere} dealHidden={reserveDealHidden} shakeToken={reserveTop && shake?.cardId === reserveTop.id ? shake.token : undefined} highlighted={hintCountFor(activeHint, { zone: 'reserve', index: 0 }) > 0} onPress={(measure) => handleCardTap({ zone: 'reserve', index: 0 }, reserveTop!.id, measure)} onDrop={(x, y, flight) => attemptDrop({ zone: 'reserve', index: 0 }, 1, x, y, reserveTop!.id, flight)} />
            </DropZone>

            <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteBehind={wasteBehind} wasteHiddenCount={flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0)} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} gap={gap} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y, flight) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, wasteTop!.id, flight)} stockRef={stockViewRef} />
          </View>

          <View style={[styles.tableauRow, { gap }]}>
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
          </View>
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
      (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
      banner comes last of all three so it's the one thing guaranteed to sit on top of the
      animation, not buried under it. */}
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    // Centers the narrower 4-column tableauRow underneath the wider 7-slot topRow - see this
    // file's own LAYOUT DECISION comment near TOP_ROW_UNITS above.
    board: {
      alignItems: 'center'
    },
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
    reserveSlot: {},
    tableauColumn: {},
    tableauRow: {
      flexDirection: 'row',
      paddingBottom: 20
    },
    topRow: {
      flexDirection: 'row',
      marginBottom: 16
    }
  })
}
