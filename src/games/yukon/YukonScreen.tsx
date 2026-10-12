import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

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
import { PlayingCard } from '@/components/PlayingCard'
import { fireworksColors } from '@/components/theme'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { YUKON_RULES } from '@/constants/gameRules'
import { AutoCompleteStep, findSafeAutoPlay, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { alwaysValidRun, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { useCascadeFeedback } from '@/games/shared/cascadeFeedback'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
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
import { buildYukonDealSequence } from './dealSequence'
import { createYukonController, YukonState } from './rules'

// Floor for useTableauMaxHeight below, not a fixed height anymore - a short screen never fans out
// less generously than this, but a screen with real headroom to spare now gets more of it.
const TABLEAU_MIN_HEIGHT = 420
const TABLEAU_COLUMNS = 7
// Yukon has no stock pile of its own to visually deal from (rules.ts's newGame deals straight into
// the tableau) and no freecells or other permanent zone to repurpose as one either (unlike
// FreeCell, which borrows its far-right freecell). This standalone slot exists only for the deal -
// shown near the foundations while dealing (see the top row below), gone from the layout entirely
// once it's not. Never a real card - just needs to be Card-shaped, since a face-down PlayingCard
// never reads rank/suit.
const DECK_PLACEHOLDER_CARD: Card = { id: 'yukon-deck-origin', suit: 'spades', rank: 1, faceUp: false }

// Widens the default MoveInfo|null undo-entry shape (see undoTypes.ts): `primary` is the move this
// entry takes back. Every real Yukon move (unlike Klondike's stock draws) has a genuine card to fly,
// so - mirroring this file's pre-existing non-nullable UndoEntry<YukonState, MoveInfo> choice -
// `primary` stays non-nullable; applyMove always has a real MoveInfo in hand. Every move, an
// auto-played one included, now pushes its own entry, so `cascaded` is always empty for a new entry.
// It is kept only for saves written before that, when each SILENT auto-play-to-foundation move (see
// applyMove's `opts.silent`) was folded into the entry of the move that set it off, in the order
// they happened, and one Undo took them all back - undoing such a legacy `primary` still reverse-
// animates every one of them (see groupCascadedByFoundation and the pendingCascadeUndoRef effect),
// or they'd just silently snap back along with the rest of the board.
interface YukonUndoMove {
  primary: MoveInfo
  cascaded: MoveInfo[]
}

// One returning card, resolved from the pre-revert state (see groupCascadedByFoundation) so the
// deferred cascade-undo effect has the real Card to render on its ghost without needing to re-look
// it up later (once state has reverted, this card may no longer be on that foundation pile at all).
interface CascadeReturnCard {
  anchorCardId: string
  card: Card
}

interface CascadeUndoGroup {
  foundationIndex: number
  cards: CascadeReturnCard[]
}

// Legacy saves only (see YukonUndoMove). Every cascaded move is a single-card tableau->foundation auto-play (the only kind
// engine/autoFoundation.ts ever produces - see firePlay) - grouped by which foundation pile
// each landed on, since that's the one shared, content-independent origin (measureView on that
// pile's own slot container) every returning card in the group flies FROM; the cards themselves
// have no CardRegistry entry once buried under a later foundation arrival. `s` must be the state
// from BEFORE the undo reverts it - each move's card is still findable on its foundation pile
// there, matching how handleUndo's own primary-flight measurement above also reads pre-revert
// state.
function groupCascadedByFoundation(s: YukonState, moves: MoveInfo[]): CascadeUndoGroup[] {
  const map = new Map<number, CascadeReturnCard[]>()
  moves.forEach((m) => {
    if (m.to.zone !== 'foundation') return
    const card = s.foundation[m.to.index]?.find((c) => c.id === m.anchorCardId)
    if (!card) return
    const list = map.get(m.to.index) ?? []
    list.push({ anchorCardId: m.anchorCardId, card })
    map.set(m.to.index, list)
  })
  return Array.from(map.entries()).map(([foundationIndex, cards]) => ({ foundationIndex, cards }))
}

export default withGameProviders(YukonScreenInner)

function YukonScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // No draw-count/suit-count-style config to lock at deal time (unlike Klondike/Spider) - a single
  // stable controller for the lifetime of this screen.
  const controller = useMemo(() => createYukonController(), [])
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play can all run concurrently with each other -
  // PATTERN_OVERLAP_GATE, same as Klondike's own extraction of this bookkeeping). Destructured
  // below so every existing reference to `state`, `commitState`, `flying`, `startFlights`,
  // `settleFlight`, `undoBusyRef`, etc. keeps working unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, isLanding, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<YukonState>()
  // Every Yukon move (tableau->tableau, tableau->foundation) has a real origin/destination to fly -
  // no stock-draw-shaped move that would need a null MoveInfo, unlike Klondike's undo stack. Mirrors
  // FreeCell's own non-nullable UndoEntry<FreeCellState, MoveInfo>.
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<YukonState, YukonUndoMove>>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: YukonState; skip: number } | null>(null)
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
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  // Portrait keeps the width-derived size untouched; the wide layout is only ~400pt tall, so there the
  // cards shrink until the deal's tallest column fits (see boardModel.ts).
  const cardWidth = useFittedCardWidth(widthCardWidth, BOARD_MODEL)
  const gap = useFittedGap(widthGap, widthCardWidth, cardWidth, contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  const deal = useDealAnimator()
  const dealOriginRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  // Separate from dealHiddenIds (which tracks each tableau card's own landing) - the deck
  // placeholder should read as exhausted the moment the LAST card actually leaves it, not once
  // every card has finished landing. See runDeal's setTimeout for the timing.
  const [deckVisible, setDeckVisible] = useState(false)
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck(controller, 'yukon', session, dealTokenRef, recordDealWon, hintsUsedRef)
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
  const [cascadeHandoff, setCascadeHandoff] = useState<{ state: YukonState; piles: ReadonlySet<number> } | null>(null)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real King has been hidden (won-gated, see the foundation row below), at which point
   * that card is no longer CardRegistry-registered at all. */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  /** Flights awaiting their post-commit measurement + ghost.flyTo, queued by tap-to-move
   * (handleCardTap), a tableau drag's own onDrop, undo, and auto-play (firePlay) - a list (not a
   * single slot), since these can now genuinely overlap (see PATTERN_OVERLAP_GATE, same as
   * Klondike's own pendingFlightRef): two entries queued in the same commit would otherwise
   * clobber each other in a single ref slot, permanently stranding whichever one lost. Each entry
   * carries its own already-created DragFlightHandle (from whichever call site queued it) to
   * fly/hide once measured, and its own flyingId to remove exactly its own `flying` entry once it
   * lands - see the [state]-effect below. `gen` is the `dealTokenRef` value
   * at the moment this flight was queued - re-checked once the async measurement below resolves, so
   * a flight queued against a game that's since been replaced by "New Game" doesn't measure/land
   * against the new deal's DOM (card ids are shuffle-independent and reused across deals - see
   * deck.ts). `to` is the pile the card is headed for, so a foundation landing can fall back to that
   * pile's own slot container when the card itself can't be measured. */
  const pendingFlightRef = useRef<{ cardId: string; to: PileRef; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  /** A cascade-undo return flight awaiting its post-commit per-card measurement, mirroring
   * pendingFlightRef's own deferral reasoning - see the [state]-effect below and
   * groupCascadedByFoundation's doc comment. Independent of pendingFlightRef: the primary card's
   * flight and any cascaded cards' return flights animate concurrently (separate providers -
   * DragGhostLayer for the primary, DealLayer's N-independent ghosts for the cascade), not
   * sequentially - each counts as its own completion against activeFlightCountRef (see handleUndo's
   * `startFlights(cascadeGroups.length > 0 ? 2 : 1)`). Stays a single slot (not a list, unlike
   * pendingFlightRef) - an entry with a cascade is an 'exclusive' undo (see undoGate: it starts only
   * once nothing is in the air, and no other undo starts until it has landed), so at most one
   * cascade-undo op is ever pending at a time; it already
   * carries multiple cards per op via `groups`, which is a different axis (several cards within ONE
   * pending op) from several concurrent ops, so there's nothing here for a list to buy. Mirrors
   * Klondike's own pendingCascadeUndoRef, which stays single-slot for the identical reason. */
  const pendingCascadeUndoRef = useRef<{ groups: CascadeUndoGroup[]; gen: number } | null>(null)
  // Which foundation piles currently have a card mid-flight back into them via cascade undo - kept
  // as its own separate mechanism rather than folded into `flying` (per Klondike's own precedent,
  // its cascadeWasteHiddenCount, for the identical "one cascade-undo can touch several destinations
  // at once" problem): FoundationCell's own isFlyingHere (see the foundation row below) ORs this
  // together with `flying`'s own per-entry aggregation, since a cascade-undo can be returning cards
  // to MULTIPLE foundations at once as ITS OWN single flying entry wouldn't distinguish.
  const [cascadeFlyingFoundations, setCascadeFlyingFoundations] = useState<Set<number>>(new Set())
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
    // An arm left over from the old deal must not fire on this one (see useAutoFoundationCascade's disarm).
    cascade.disarm()
    const s = controller.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingCascadeUndoRef.current = null
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
    setDealHiddenIds(dealtIds)
    setDeckVisible(true)
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal) and no deck placeholder (deckVisible stays false - nothing is dealing). Also restores
  // the saved undo stack (falling back to empty for an older save written before undo persistence
  // existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<YukonState, UndoEntry<YukonState, YukonUndoMove>>) {
    ++dealTokenRef.current
    // Nothing auto-plays on a resumed board until the player's own next foundation move arms it.
    cascade.disarm()
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    pendingCascadeUndoRef.current = null
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setDeckVisible(false)
    commitState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('yukon')
    startNewGame()
  }

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using. Origin is the standalone deck
  // placeholder (see dealOriginRef/DECK_PLACEHOLDER_CARD above), measured only once it's actually
  // mounted (deckVisible is flipped true synchronously in startNewGame, in the same commit as the
  // state that mounts this deal - see useDeferredDeal's own doc comment for why the destination
  // measurements below must also wait for that same commit's registration effects to run).
  async function runDeal(s: YukonState, token: number) {
    const sequence = buildYukonDealSequence(s.tableau)
    const [origin, destinations] = await Promise.all([measureView(dealOriginRef.current), Promise.all(sequence.map((step) => ghost.cardRegistry.measure(step.cardId)))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      setDeckVisible(false)
      return
    }

    const built: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) return
      built.push({
        cardId: step.cardId,
        // Phase 1 (the Klondike-shaped base triangle - rowIndex <= colIndex, see rules.ts's
        // newGame) flies face-down regardless of step.card's real faceUp, same reasoning as
        // Klondike's own runDeal: a real dealer lays these down blind and only turns each column's
        // one true face-up card over after it's placed, not while it's still sliding. Phase 2's 24
        // extra cards (rowIndex > colIndex) are dealt face-up from the start in real Yukon - same
        // as FreeCell's whole deal - so those fly showing their real (already-true) faceUp as-is.
        card: step.rowIndex <= step.colIndex ? { ...step.card, faceUp: false } : step.card,
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: step.visitOrder * dealStaggerMs(sequence.length)
      })
    })
    // Phase 1 flies face-down and keeps its compressed pace; phase 2's face-up cards are slowed to where each can be seen
    // (see paceFaceUpDeal - it reads the FLOWN face, so the forced face-down flights above are left alone).
    const entries = paceFaceUpDeal(built)
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      setDeckVisible(false)
      return
    }

    // The deck should look exhausted the instant its last card actually leaves it (starts its own
    // flight), not once every card has finished landing - those are DEAL_SPRING.duration apart, and
    // waiting for the latter would show the placeholder still sitting there with its last card
    // already visibly flying away. Driven by the deal layer's own take-off signal (onCardDealt)
    // rather than a timer armed here: the deal's clock only starts once its ghosts have mounted, so
    // a timer set from the scheduled delays ran ahead of it and emptied the deck before the last
    // cards had really left. A skip reports every not-yet-taken-off card through onCardDealt too.
    // Same dealTokenRef guard as every other async step here.
    const lastCardId = entries.reduce((a, b) => (b.delayMs > a.delayMs ? b : a)).cardId

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
        // Safety net: guarantees the deck is gone by the time the deal has actually finished, whatever
        // route the last take-off report took (a skip reports every remaining card at once).
        if (dealTokenRef.current !== token) return
        setDeckVisible(false)
      },
      (cardId) => {
        if (dealTokenRef.current !== token) return
        if (cardId === lastCardId) setDeckVisible(false)
      }
    )
  }

  // Foundation piles are guaranteed full (13 cards each, Ace..King) the instant isWon() is true -
  // measures each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef), which is
  // card-sized and always mounted, whether or not the pile's real cards are drawn. Chains that whole pile
  // King-first/head down to Ace-last/tail (foundation arrays are built bottom-up, Ace pushed first,
  // so reversing gives the right order). Same dealTokenRef guard as every other async measurement
  // here, for the same "New Game tapped mid-measurement" reason.
  //
  // The real cards blank only once the ghosts that replace them are on screen (cascadeHandoff, set from startChains'
  // onShown - in the commit the ghosts appear, which waits for their parked faces to paint; see WinCascadeLayer's
  // CascadeChains): blanking them when the win is revealed instead, and starting the chains from the async continuation
  // that follows, left every pile empty for the frames in between, and blanking them in the commit that mounted the
  // ghosts showed blank-faced cards for a frame or two. An undo or New Game before then clears the cascade, which drops
  // the callback (and the hand-off is keyed to `s` anyway). A pile whose chain could not start (no measurable slot) keeps
  // its real cards, and if no chain can start at all the piles simply stay up under the banner instead of vanishing (an
  // empty cascade never calls onShown).
  async function runWinCascade(s: YukonState, gen: number) {
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
  // setState in applyMove would find the still-mounted SOURCE card (the destination card's own
  // registration effect hasn't run yet), so the ghost would "fly" a near-zero distance back to
  // roughly where it started - indistinguishable from a snap. Deferring to a [state]-keyed effect
  // guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        // A foundation's registered top card is the usual landing spot, but if it can't be found (a
        // later flight to the same pile already buried it) the pile's own slot container is
        // card-sized and always there - fly to that rather than hiding the ghost and letting the card
        // simply appear.
        const landed = (await ghost.cardRegistry.measure(p.cardId)) ?? (p.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[p.to.index]) : null)
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

  // Reverse-animates any auto-played cascade that rode along with the move currently being undone -
  // only ever an entry restored from a save written before auto-plays became their own undo steps
  // (see YukonUndoMove / groupCascadedByFoundation above) - runs independently of,
  // and concurrently with, the primary flight's own pendingFlightRef effect just above (separate
  // providers/state, so both animating at once is correct - "everything flies back together").
  // Same measure-after-commit reasoning as every other deferred effect in this file: a cascaded
  // card's own CardRegistry entry only exists once its tableau column's registration effect has
  // actually run for the just-reverted state, which this [state]-keyed effect waits for.
  //
  // This cascade-return flight's completion is folded straight into activeFlightCountRef via
  // settleFlight() below (handleUndo claims it up front via `startFlights(cascadeGroups.length > 0
  // ? 2 : 1)`) rather than guarded by its own separate busy ref. An earlier version of this file had
  // a dedicated `cascadeUndoBusyRef`, reasoning that the shared `deal` animator (useDealAnimator)
  // only supports one active ghost batch at a time, and the initial deal + this cascade-return both
  // share that same `deal` instance. That's a real constraint on `deal`, but it doesn't need its own
  // busy ref here: Yukon's PRIMARY undo flight always goes through `ghost` (DragGhostLayer), never
  // `deal` - unlike Klondike, which has draw-3/recycle-undo branches that route the primary flight
  // through `deal` too, and even Klondike doesn't use a separate busy ref for that overlap (see its
  // own handleUndo, which just sequences the cascade's deal.start() to start after the primary
  // deal.start() batch it shares finishes). So the only two things that could ever contend for
  // `deal` here are this cascade-return and a fresh "New Game" deal - and undoBusyRef already blocks
  // a new deal from starting mid-undo (startNewGame/restoreGame aren't reachable while undoBusyRef
  // is true), while dealTokenRef's own gen-check above/below drops this cascade-return's callbacks
  // harmlessly if a new deal ever did start anyway. No concrete case where retiring the separate ref
  // breaks anything was found - see YukonScreen's CLAUDE.md history for the analogous fix to
  // DealProvider's own React key generation (and per-deal stamp on every ghost slot), which already makes overlapping deal.start() calls
  // safe at the mechanism level.
  useEffect(() => {
    const pending = pendingCascadeUndoRef.current
    if (!pending || !state) return
    pendingCascadeUndoRef.current = null
    const allCardIds = pending.groups.flatMap((g) => g.cards.map((c) => c.anchorCardId))
    const foundationIndices = pending.groups.map((g) => g.foundationIndex)
    // Un-hides whichever of the returning cards/foundations are named (all of them, on abandon or
    // failure) rather than leaving any stuck invisible/foundation-frozen forever - mirrors runDeal's
    // own top-level fallback for the same failure mode.
    const clearFlags = (cardIds: string[], indices: number[]) => {
      if (cardIds.length > 0) {
        setDealHiddenIds((ids) => {
          const next = new Set(ids)
          cardIds.forEach((id) => next.delete(id))
          return next
        })
      }
      if (indices.length > 0) {
        setCascadeFlyingFoundations((prev) => {
          const next = new Set(prev)
          indices.forEach((i) => next.delete(i))
          return next
        })
      }
    }
    ;(async () => {
      const origins = await Promise.all(pending.groups.map((g) => measureView(foundationSlotRefs.current[g.foundationIndex])))
      // Same "New Game tapped mid-measurement" guard as every other async measurement here - card
      // ids are shuffle-independent and reused across deals (see deck.ts), so a stale measurement
      // would otherwise land against the NEW deal's unrelated cards.
      if (dealTokenRef.current !== pending.gen) {
        clearFlags(allCardIds, foundationIndices)
        settleFlight()
        return
      }

      const resolved = await Promise.all(
        pending.groups.flatMap((group, gi) => {
          const origin = origins[gi]
          return group.cards.map(async (c): Promise<DealCardSpec | null> => {
            if (!origin) return null
            const dest = await ghost.cardRegistry.measure(c.anchorCardId)
            if (!dest) return null
            return { cardId: c.anchorCardId, card: c.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: 0 }
          })
        })
      )
      if (dealTokenRef.current !== pending.gen) {
        clearFlags(allCardIds, foundationIndices)
        settleFlight()
        return
      }

      const entries = resolved.filter((e): e is DealCardSpec => e !== null)
      const failedIds = allCardIds.filter((id) => !entries.some((e) => e.cardId === id))
      if (failedIds.length > 0) clearFlags(failedIds, [])

      if (entries.length === 0) {
        clearFlags([], foundationIndices)
        settleFlight()
        return
      }

      deal.start(
        entries,
        cardWidth,
        (cardId) => {
          if (dealTokenRef.current !== pending.gen) return
          setDealHiddenIds((ids) => {
            if (!ids.has(cardId)) return ids
            const next = new Set(ids)
            next.delete(cardId)
            return next
          })
        },
        () => {
          if (dealTokenRef.current !== pending.gen) return
          clearFlags([], foundationIndices)
          settleFlight()
        }
      )
    })()
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

  // Auto-play-to-foundation: only ever follows the player's own play of a card to a foundation - see
  // useAutoFoundationCascade for the trigger model (afterPlayerMove, called from applyMove below; any
  // other move of theirs stops it), and engine/autoFoundation.ts for the two mechanisms computeNextStep composes.
  // Declared here, just above the hook call that uses them, rather than lower in the component
  // (Klondike/FreeCell's equivalent functions are declared further down and still lint clean there,
  // but the same forward-reference shape trips react-hooks/immutability in this file specifically -
  // this ordering resolves it cleanly with no behavior change, since function declarations hoist
  // either way). Mechanism B (a guaranteed full clear) takes priority and, once true, ignores
  // mechanism A's caution entirely since there's no longer any player decision left to protect.
  function computeNextStep(s: YukonState): AutoCompleteStep | null {
    if (!controller.accessibleCards) return null
    const entry = isFullyAutoCompletable(controller, s) ? nextAutoCompleteMove(controller, s) : findSafeAutoPlay(controller.accessibleCards(s), s.foundation)
    return entry ? { kind: 'play', entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } } : null
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move (every other mutator here either has no await at all, or - like
  // handleUndo - captures everything it needs from the pre-move state synchronously first). Guard
  // against something else changing state during that gap by snapshotting stateRef before the
  // await and bailing if it no longer matches after. Claims a flight slot up front (see
  // activeFlightCountRef's own doc comment) - mirrors handleCardTap/tableau onDrop's identical
  // undoBusyRef gate, even though the cascade hook's own isBusy check already keeps this from being
  // invoked while undo is running - belt and suspenders against the same race those two guard.
  // Resolves once the move is COMMITTED (true) or refused (false), not when it lands - which is what
  // lets the cascade send the next card while this one is still flying.
  async function firePlay(entry: AccessibleCard, to: PileRef): Promise<boolean> {
    if (undoBusyRef.current) return false
    startFlights(1)
    const stateAtStart = stateRef.current
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart || undoBusyRef.current || !cascade.isArmed()) {
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

  const cascade = useAutoFoundationCascade<YukonState>({
    state,
    isLanding,
    getState: () => stateRef.current,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep,
    firePlay
  })

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<YukonState, UndoEntry<YukonState, YukonUndoMove>>('yukon').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('yukon')
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
      saveGameInProgress('yukon', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('yukon', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

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
    recordHintUsed('yukon')
  }

  function pushUndo(prev: YukonState, move: YukonUndoMove) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would. Undo holds mutual exclusion with every non-undo action (see
  // useFlightConcurrency's own undoBusyRef doc comment); undos overlap each other's flights (see
  // undoGate).
  //
  // Each auto-played card is its own entry, so one press takes back one card. An entry from a save
  // written before that can still carry a `cascaded` list: undoing its `primary` move also
  // reverse-animates every card the auto-play cascade played on top of it, in one press (see
  // YukonUndoMove above and the pendingCascadeUndoRef effect above).
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // A plain move's undo takes its cards back off the pile it went to, so it overlaps the undos
  // before it once nothing is still landing there. A legacy entry's cascade flies back through the
  // deal layer from several foundations at once - one at a time.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!entry || !stateRef.current) return null
    if (entry.move.cascaded.length > 0) return 'exclusive'
    return { takesFrom: [entry.move.primary.to] }
  }

  async function revertTopUndo() {
    // The stack and the board are read via their refs, not the closure: undos can run back-to-back
    // before React re-renders (see runUndo).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    // A still-armed auto-play cascade must not fire again on the board this undo reverts to - the
    // player is taking cards back, one at a time, and would otherwise watch them go straight back up.
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
    }
    const { move, state: prevState } = entry
    const { primary, cascaded } = move
    // Captured once, up front - every stash this call makes uses this same token, so a "New Game"
    // that fires mid-await consistently invalidates every one of this undo's pending flights rather
    // than some using a token read before the race and some after (mirrors Klondike's own `gen`).
    const gen = dealTokenRef.current

    // Resolved against stateRef.current, not the render-closure `state` - same reasoning as
    // applyMove's identical read (see PATTERN_OVERLAP_GATE). Computed synchronously here, before any
    // await, so it's available up front for startFlights' own count below, and each cascaded card is
    // still findable on its real foundation pile right now, whereas after the revert later in this
    // function it (may) no longer be there at all.
    const cascadeGroups = groupCascadedByFoundation(current, cascaded)
    startFlights(cascadeGroups.length > 0 ? 2 : 1)

    const sourcePile = resolvePile(primary.to, current)
    // A foundation move's own card can sit BURIED under a legacy entry's cascaded auto-plays that
    // landed on the same pile after it (they come back via their own flights below) - so it is found by id, not
    // assumed to be on top.
    const buriedAt = primary.to.zone === 'foundation' && sourcePile ? sourcePile.findIndex((c) => c.id === primary.anchorCardId) : -1
    const movingCards = sourcePile ? (buriedAt >= 0 ? [sourcePile[buriedAt]] : sourcePile.slice(sourcePile.length - primary.count)) : []
    const offsetStep = primary.count > 1 ? faceUpFanOffset(cardWidth) : 0
    // A buried card, or any foundation card once the win celebration has hidden the real ones, is not
    // in CardRegistry (only a visible top card is) - the pile's own always-present slot container is
    // where it sits, so it flies from there instead of simply reappearing.
    const origin = movingCards.length > 0 ? ((await ghost.cardRegistry.measure(primary.anchorCardId)) ?? (primary.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[primary.to.index]) : null)) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (cascadeGroups.length > 0) {
      // Hidden BEFORE commitState(prevState) below, in the same commit - React batches same-tick
      // setState calls, so this avoids a frame where the restored cards flash fully visible before
      // their ghosts arrive to cover them (same reasoning startNewGame's own setDealHiddenIds
      // relies on for the initial deal).
      setDealHiddenIds((ids) => {
        const next = new Set(ids)
        cascadeGroups.forEach((g) => g.cards.forEach((c) => next.add(c.anchorCardId)))
        return next
      })
      setCascadeFlyingFoundations((prev) => {
        const next = new Set(prev)
        cascadeGroups.forEach((g) => next.add(g.foundationIndex))
        return next
      })
    }

    if (origin) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(primary.from, primary.count)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: primary.anchorCardId, to: primary.from, gen, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight() // primary: nothing to fly, settles immediately
    }

    if (cascadeGroups.length > 0) {
      pendingCascadeUndoRef.current = { groups: cascadeGroups, gen }
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see firePlay above): an auto-played card
  // isn't a player decision, so it doesn't count toward the moves/score the player is judged on. It
  // is still its own undo step, like any other move.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
    // commitState just did, not the same stale board both closures captured.
    const current = stateRef.current
    if (!current) return false
    // The card flying is the card the player tapped or grabbed (or the auto-play chose); tryMove only knows positions, so if
    // the board moved on since - an auto-play took that very card between the tap and now - it would move whatever now sits
    // there, under a ghost of a different card. Refuse instead (FreeCell's moveHeadCard check).
    const sourcePile = resolvePile(from, current)
    if (sourcePile?.[sourcePile.length - count]?.id !== anchorCardId) return false
    const result = controller.tryMove(current, { from, to, count })
    if (result) {
      const moveInfo: MoveInfo = { from, to, count, anchorCardId }
      // Every move gets its own undo entry, an auto-played one included (the finish sweep too - it
      // plays through the same firePlay), so one Undo press takes back one card and the player can
      // stop exactly where they want (an auto-play used to be folded into the entry of the move that
      // set it off, see YukonUndoMove).
      pushUndo(current, { primary: moveInfo, cascaded: [] })
      commitState(result)
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      // Only the player's own play of a card to a foundation starts auto-play; any other move of theirs
      // stops it, so a card it uncovers (an ace flipped up on the tableau, say) is theirs to find and play.
      if (!opts?.silent) cascade.afterPlayerMove(to)
      return true
    }
    return false
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move, a manual drag's
  // drop, or an auto-play) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto,
  // instead of it just vanishing/appearing at the destination instantly.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    const flyingId = beginFlying(to, count)
    pendingFlightRef.current.push({ cardId: anchorCardId, to, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  // A foundation card dragged back down to the tableau (rules.ts's tryMove) - the only drag here that doesn't start on
  // the tableau, so the only one that runs its own hit test (Klondike's attemptDrop, same shape). Claims its flight
  // before the hit-test await so undo sees the drop as in flight for its whole duration, and refuses outright while an
  // undo is running (the drag's ghost just snaps back).
  async function attemptFoundationDrop(foundationIndex: number, absoluteX: number, absoluteY: number, anchorCardId: string, flight: DragFlightHandle): Promise<boolean> {
    if (undoBusyRef.current) return false
    startFlights(1)
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target || undoBusyRef.current || !completeMove({ zone: 'foundation', index: foundationIndex }, target, 1, anchorCardId, flight)) {
      settleFlight()
      return false
    }
    return true
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    // Unlike Klondike/FreeCell (isDescendingAltColor) - Yukon has no run-validity requirement at
    // all: any face-up card, plus everything stacked above it, is always a legal group to move
    // together (see engine/pile.ts's alwaysValidRun).
    return runCountFrom(state.tableau[colIndex], indexFromTop, alwaysValidRun)
  }

  // `s` defaults to the render closure's `state`; handleUndo passes stateRef.current (the board as of
  // right now - another undo may have committed since this render).
  function resolvePile(ref: PileRef, s: YukonState | null = state): Card[] | null {
    if (!s) return null
    switch (ref.zone) {
      case 'tableau':
        return s.tableau[ref.index] ?? null
      case 'foundation':
        return s.foundation[ref.index] ?? null
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
    if (!state || !controller.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const move = controller.autoMoveHint(state, ref, cardId)
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

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Yukon' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} rules={YUKON_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={[styles.foundationsGroup, { gap }]}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              // Several tap flights can be headed to one pile at once (they overlap), so count the cards still
              // in the air. The pile keeps showing the top card that has already LANDED under the rest instead of
              // reverting to the one from before the whole stream (see FoundationCell's settledCard).
              //
              // That applies to forward flights ONLY. The cascade-undo flag (the pile's only other reason to be
              // hidden) leaves settledCard unset, so the cell keeps its frozen copy of what was on top before the
              // undo - the departing card. The revert has already taken the departing cards off `pile`, but their
              // return ghosts only start after the [state] effect has measured (slot, per-card destination) and the
              // deal layer has mounted its slots, several frames later: showing what is UNDER them (settledCard)
              // would let the departing card vanish for that whole gap before its ghost appears. It cannot
              // coincide with a forward flight - undo waits for every flight and blocks new ones.
              const flightsInAir = flying.filter((f) => f.to.zone === 'foundation' && f.to.index === i).reduce((sum, f) => sum + f.count, 0)
              const isFlyingHere = flightsInAir > 0 || cascadeFlyingFoundations.has(i)
              const cascadeTookOver = winRevealed && cascadeHandoff?.state === state && cascadeHandoff.piles.has(i)
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={cascadeTookOver ? undefined : t}
                    isFlyingHere={isFlyingHere}
                    settledCard={flightsInAir > 0 ? (pile[pile.length - 1 - flightsInAir] ?? null) : undefined}
                    suit={SUITS[i]}
                    highlighted={hintCountFor(activeHint, { zone: 'foundation', index: i }) > 0}
                    slotRef={(el) => {
                      foundationSlotRefs.current[i] = el
                    }}
                    // A foundation card may come back down to the tableau (rules.ts's tryMove) - by drag only, and never
                    // once the deal is won. Any move to a column stops a running auto-play (applyMove), so it isn't sent
                    // straight back up.
                    under={pile[pile.length - 2] ?? null}
                    onDrop={won ? undefined : (x, y, flight, dragged) => attemptFoundationDrop(i, x, y, dragged.id, flight)}
                  />
                </DropZone>
              )
            })}
          </View>

          {deckVisible && (
            <View ref={dealOriginRef} collapsable={false} style={[styles.dealOriginSlot, { width: cardWidth }]}>
              <PlayingCard card={DECK_PLACEHOLDER_CARD} testID='yukon-deck-origin' />
            </View>
          )}
        </View>

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              // Claims a flight slot (see activeFlightCountRef's doc comment above) purely so undo
              // sees this drop as in-flight for its whole duration, not just once completeMove
              // lands one - PileView.tsx (shared, not ours to edit) already ran its own hitTest
              // await before invoking this callback, so this is the earliest point YukonScreen
              // gets a look-in. Rejects outright if undo is running (undo holds full mutual
              // exclusion, not just a one-way wait - see undoBusyRef's own doc comment) - the
              // drag's own ghost (already shown by PileView/DraggableCard well before this runs)
              // just snaps back, same as "no legal target".
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
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} />
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
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles() {
  return StyleSheet.create({
    dealOriginSlot: {},
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
