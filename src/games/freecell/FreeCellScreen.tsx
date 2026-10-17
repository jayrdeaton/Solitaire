import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { HintRequest } from '@/components/autoHint'
import { cardLayoutForRow, SPLIT_TOP_ROW_MIN_GAP, splitTopRowGroupGap } from '@/components/cardLayout'
import { columnTops } from '@/components/columnTops'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS, dealStaggerMs, paceFaceUpDeal } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { CARD_HEIGHT_RATIO, useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { rectOffsetToScreenPoint } from '@/components/overlayFrame'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { useGameSession } from '@/components/useGameSession'
import { useTakeOffHold } from '@/components/useTakeOffHold'
import { PipFireworks } from '@/components/winning/PipFireworks'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { FREECELL_RULES } from '@/constants/gameRules'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { parFor } from '@/engine/par'
import { isDescendingAltColor, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { useCascadeFeedback } from '@/games/shared/cascadeFeedback'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { showNoHintToast } from '@/games/shared/gameToasts'
import { liftTappedRun, peelInAir } from '@/games/shared/inAirRun'
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
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useUndoStack } from '@/games/shared/useUndoStack'
import { useWinReveal } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { useSettings } from '@/hooks/useSettings'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { canAutoFinish, nextFinishMove, nextSafeCascadeStep } from './autoPlay'
import { buildFreeCellDealSequence } from './dealSequence'
import { countEmptyFreecells, countEmptyTableauColumns, FreeCellController, FreeCellState, maxSupermoveCount, moveHeadCard } from './rules'
const TABLEAU_COLUMNS = 8
// FreeCell has no stock pile of its own to visually deal from (rules.ts's newGame deals straight
// into the tableau; freecells start, and stay, empty throughout the deal) - the far-right freecell
// doubles as the deck the deal animation flies out of instead, showing this face-down placeholder
// only while dealing (see the freecells row below). Never a real card - just needs to be
// Card-shaped, since a face-down PlayingCard never reads rank/suit.
const DECK_PLACEHOLDER_CARD: Card = { id: 'freecell-deck-origin', suit: 'spades', rank: 1, faceUp: false }

/** FreeCell's own undo-move shape: `primary` is the move this entry takes back (kept nullable only
 * for parity with the shared MoveInfo | null shape - every real FreeCell move has a card to fly, so
 * this is never actually null in practice). Every move, an auto-played one included, now pushes
 * its own entry, so `cascaded` is always empty for a new entry. It is kept only for saves written
 * before that, when each SILENT auto-play-to-foundation move (see applyMove's `opts.silent`) was
 * folded into the entry of the move that set it off, in the order they happened, and one Undo took
 * them all back (see handleUndo and the pendingCascadeUndoRef effect, which still fly those back). */
interface FreeCellUndoMove {
  primary: MoveInfo | null
  cascaded: MoveInfo[]
}

/** A freecell's display - same reasoning as FoundationCell above: the real `card` stays mounted
 * and registered (via DraggableCard, just hidden by opacity) so the flight has something to
 * measure, while a frozen, decorative copy of whatever was there before (always empty, for a
 * freecell - see useFrozenWhileHidden) covers it while flying. */
export function FreecellCell({
  card,
  isFlyingHere,
  shakeToken,
  highlighted,
  onPress,
  onDrop
}: {
  card: Card | undefined
  isFlyingHere: boolean
  shakeToken?: number
  /** Highlight this cell as the Hint feature's suggested source/destination - see PlayingCard's
   * own `hinted` prop. */
  highlighted?: boolean
  /** Lazy measure function - see DraggableCard.tsx's onPress doc comment for why (this is a
   * straight pass-through to that same prop). */
  onPress: (measure: () => Promise<{ x: number; y: number }>) => void
  onDrop: (x: number, y: number, flight: DragFlightHandle) => Promise<boolean> | boolean
}) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere)
  // Take-off hold: keeps drawing a card that has just left while its ghost is not on screen yet (useTakeOffHold).
  const { shown, holding } = useTakeOffHold(card)
  // A card flying in hides the real card under the frozen copy - but not while a departing card is still held here: a
  // card can be sent to this freecell the moment the one that left it is gone from state (two quick taps), and hiding the
  // held card then made it vanish before its ghost had appeared - the take-off flash. The arriving card is registered
  // all along (registryId), so its flight can measure it; it is hidden once the hold ends. No reveal phase here: a
  // freecell holds one card, so a card that leaves always leaves it empty (and the frozen copy is the empty slot).
  const flyingHere = isFlyingHere && !holding
  return (
    <View>
      {shown ? <DraggableCard card={shown} hidden={flyingHere} disabled={holding} registryId={holding ? (card?.id ?? null) : undefined} shakeToken={holding ? undefined : shakeToken} hinted={highlighted && !holding} emptyFallback={<EmptySlot />} onPress={holding ? undefined : onPress} onDrop={onDrop} /> : <EmptySlot hinted={highlighted} />}
      {flyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {frozen ? <PlayingCard card={frozen} /> : <EmptySlot />}
        </View>
      )}
    </View>
  )
}

export default withGameProviders(FreeCellScreenInner)

function FreeCellScreenInner() {
  const { styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play can all run concurrently with each other -
  // PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`, `commitState`,
  // `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, shrinkLanding, landingCount, isLanding, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<FreeCellState>()
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<FreeCellState, FreeCellUndoMove>>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: FreeCellState; skip: number } | null>(null)
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
  const rotation = useRotation()
  // The tableau's gap floor is doubled so the top row can squeeze its foundations and freecells to half of it and
  // pool the rest between the two groups - see SPLIT_TOP_ROW_MIN_GAP.
  // Sized by the width alone, in both layouts: in the wide layout a column too long for the ~400pt of height scrolls
  // rather than shrinking every card to fit it (Jay, 2026-10-14: big cards in landscape, and scroll a bit sometimes).
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, SPLIT_TOP_ROW_MIN_GAP)
  const topRowGroupGap = splitTopRowGroupGap(gap)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth)
  const ghost = useDragGhost()
  const playHintGlide = useHintGlide(state, ghost.cardRegistry, dropZones)
  // `gen` is the `dealTokenRef` value at the moment this flight was queued - re-checked once the async
  // measurement below resolves, so a flight queued against a game that's since been replaced by
  // "New Game" doesn't measure/land against the new deal's DOM (card ids are shuffle-independent
  // and reused across deals - see deck.ts). Mirrors exactly how runDeal below already guards itself
  // with dealTokenRef/pendingDealTokenRef. A list (not a single slot) since concurrent flights (see
  // PATTERN_OVERLAP_GATE) can now genuinely overlap - two entries queued in the same commit would
  // otherwise clobber each other in a single ref slot, permanently stranding whichever one lost.
  // `flyingId` is this entry's own beginFlying-issued id, removed via endFlying once it lands.
  // `isUndo` (Klondike has no equivalent - see its own `viaStock`) no longer distinguishes anything
  // here: the old finishOneUndoAnimation-vs-undoBusyRef split this flag used to pick between has
  // collapsed into a single settleFlight() call for every flight, undo or not.
  const pendingAutoMoveCardIdRef = useRef<{ cardId: string; to: PileRef; gen: number; flight: DragFlightHandle; flyingId: number }[]>([])
  // A silently auto-played cascade being reversed by handleUndo (see FreeCellUndoMove above) -
  // measured/flown by its own [state]-effect below, independently of and concurrently with the
  // primary move's own flight(s) (pendingAutoMoveCardIdRef's effect). Stays a single nullable slot
  // (not a list, unlike pendingAutoMoveCardIdRef above) - an entry with a cascade is an 'exclusive'
  // undo (see undoGate: it starts only once nothing is in the air, and no other undo starts until it
  // has landed), so at most one cascade-undo is ever pending at a time, same reasoning Klondike's own
  // pendingCascadeUndoRef documents.
  const pendingCascadeUndoRef = useRef<{ moves: MoveInfo[]; gen: number } | null>(null)
  const deal = useDealAnimator()
  const dealOriginRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  // Separate from dealHiddenIds (which tracks each tableau card's own landing) - the deck
  // placeholder should read as exhausted the moment the LAST card actually leaves it, not once
  // every card has finished landing. See runDeal's onCardDealt for the timing.
  const [deckVisible, setDeckVisible] = useState(false)
  // Nothing is dimmed while the deal is in the air; the whole board dims at once when it has landed (see useDimAfterDeal).
  const dimAfterDeal = useDimAfterDeal()
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck(FreeCellController, 'freecell', session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing animating and the initial deal finished - what the auto-play hooks below wait for, and
  // what the win celebration waits for too (see useWinReveal).
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0
  // `won` is game state (clock, stat, save, undo/hint gating) and flips with the winning move; the
  // celebration - foundations giving way to the win cascade, fireworks, banner - waits until the
  // last card has flown in and landed, so it is never hidden mid-flight (which used to make it
  // simply appear) and the finished board reads for a beat first.
  const winRevealed = useWinReveal(won, settled)
  // The board the win cascade has taken over from, and which suits' piles it took (set once its ghosts are on screen -
  // startChains' onShown, see runWinCascade): once that state IS the current one, and the win is revealed, those piles'
  // real cards blank - not a moment earlier, or the piles would sit empty (or under blank ghosts) until the cascade's
  // ghosts can be seen. Compared by identity (state is replaced wholesale on every change) so an undo or a New Game
  // un-blanks the piles with nothing to reset, and a re-win after an undo (which never relaunches the cascade) can
  // never blank piles with no ghosts. A suit whose chain could not start keeps its real card showing.
  const [cascadeHandoff, setCascadeHandoff] = useState<{ state: FreeCellState; suits: ReadonlySet<number> } | null>(null)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can find each pile's screen position whether
   * or not its real King is drawn (the container is card-sized and always mounted; the piles only
   * blank once the cascade has taken over, see cascadeHandoff in runWinCascade). */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const cascadeFeedback = useCascadeFeedback(playCardSound, hapticCard)
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<FreeCellState, UndoEntry<FreeCellState, FreeCellUndoMove>>('freecell').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('freecell')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through commitState). Gated on !won: Undo
  // is never disabled post-win (a pre-existing gap, out of scope here), so without this guard, winning
  // and then tapping the still-enabled Undo would resurrect a save for an already-resolved deal right
  // after checkWin below just cleared it. Deliberately NOT also keyed on a ticking elapsed-seconds
  // value the way an earlier version of this effect was: `session.getElapsed()` computes the true
  // current elapsed from wall-clock time on demand (see useGameSession.ts), but a save still holds the
  // elapsed time from when it was made, so useSaveInProgressBackstop saves again every 10s, when the
  // screen is left, and when the app is backgrounded.
  useEffect(() => {
    if (state && !won) saveGameInProgress('freecell', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('freecell', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using. Origin is the far-right
  // freecell's placeholder (see dealOriginRef/DECK_PLACEHOLDER_CARD above) rather than a real
  // stock pile - FreeCell has none. Unlike Klondike's runDeal, the flying card isn't forced
  // face-down: real FreeCell deals every card face up from the start (rules.ts's newGame already
  // sets faceUp: true on the whole deck), so step.card's own faceUp is left as-is.
  //
  // Destinations are computed ANALYTICALLY (this column's own measured container + PileView's own
  // columnTops, called below) instead of by measuring each real destination CARD
  // via CardRegistry, the way this used to work - because a hidden tableau card is no longer mounted
  // at all while the deal hasn't reached it yet (see PileView's own `isFlying` doc comment), so there
  // is no real card there to measure anymore. Only the 8 column CONTAINERS are measured (via
  // DropZoneRegistry, already tracking them for hit-testing - see its own `measure` doc comment),
  // once each, not once per card - the same "measure a stable container, compute each card's offset
  // from it" idiom Pyramid/TriPeaks already use for their own analytical destinations.
  async function runDeal(s: FreeCellState, token: number) {
    const sequence = buildFreeCellDealSequence(s.tableau)
    const cardHeight = cardWidth * CARD_HEIGHT_RATIO
    const faceUpOffset = faceUpFanOffset(cardWidth)
    const [origin, columnRects] = await Promise.all([measureView(dealOriginRef.current), Promise.all(s.tableau.map((_, colIndex) => dropZones.measure({ zone: 'tableau', index: colIndex })))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      setDeckVisible(false)
      dimAfterDeal.release()
      return
    }

    // Each column's card tops from PileView's own columnTops (with PileView's default fan offsets; nothing is held during a
    // deal), so a dealt card lands exactly where its real card is drawn - a hand-copied formula here drifted from it once.
    const columnTopsFor = s.tableau.map((col) => columnTops(col, [], faceUpOffset, cardHeight * 0.13, cardHeight, tableauMaxHeight).tops)

    const built: DealCardSpec[] = []
    // A column whose container measurement comes back null (the DropZone hasn't mounted/laid out
    // yet) can't fly any of its cards - but they must still be unhidden right away instead of
    // staying in dealHiddenIds forever, which would otherwise soft-lock them out of play permanently
    // (and keep dealHiddenIds.size from ever reaching 0, which also permanently disables the
    // moves===0-gated auto-play effect above). Mirrors the same fallback this file's own
    // runWinCascade/handleUndo use for an equivalent measurement failure.
    const unresolvedIds: string[] = []
    sequence.forEach((step) => {
      const rect = columnRects[step.colIndex]
      if (!rect) {
        unresolvedIds.push(step.cardId)
        return
      }
      const top = columnTopsFor[step.colIndex][step.rowIndex]
      // The column rect is a screen-space bounding box: under a fake landscape rotation the fan runs along another screen
      // axis, so the offset is composed through the column's centre (see rectOffsetToScreenPoint) - not `rect.y + top`.
      built.push({
        cardId: step.cardId,
        card: step.card,
        from: origin,
        to: rectOffsetToScreenPoint(rect, 0, top, cardWidth, cardHeight, rotation),
        delayMs: step.visitOrder * dealStaggerMs(sequence.length)
      })
    })
    // Every card here flies face-up, so the deal is slowed to a pace where each one can actually be seen (see paceFaceUpDeal).
    const entries = paceFaceUpDeal(built)
    if (unresolvedIds.length > 0) {
      setDealHiddenIds((ids) => {
        if (unresolvedIds.every((id) => !ids.has(id))) return ids
        const next = new Set(ids)
        unresolvedIds.forEach((id) => next.delete(id))
        return next
      })
    }
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      setDeckVisible(false)
      dimAfterDeal.release()
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
        dimAfterDeal.release()
      },
      (cardId) => {
        if (dealTokenRef.current !== token) return
        if (cardId === lastCardId) setDeckVisible(false)
      }
    )
  }

  // Foundation piles are guaranteed full (13 cards each, Ace..King) the instant isWon() is true -
  // measures each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef),
  // not the King via CardRegistry (a container is measurable whether or not the pile's real card
  // is drawn). Chains that whole pile King-first/head down to Ace-last/tail (foundation arrays are
  // built bottom-up, Ace pushed first, so reversing gives the right order).
  //
  // This runs while the real foundation cards are STILL on screen: the piles blank only afterwards,
  // once the cascade's ghosts are on screen (cascadeHandoff, set from startChains' onShown - in the
  // commit the ghosts appear, which waits for their parked faces to paint; see WinCascadeLayer's
  // CascadeChains). Blanking on winRevealed alone left every pile empty for the frames this
  // measurement takes (~140ms in a dev bundle) before the ghosts appeared; blanking in the commit
  // that mounted them showed blank-faced Kings for a frame or two. An undo or New Game before then
  // clears the cascade, which drops the callback (and the hand-off is keyed to `s` anyway). A suit
  // whose slot measurement failed (rare) gets no chain and so keeps its real card, rather than
  // vanishing with nothing to replace it; if no chain can start the piles simply stay up under the
  // banner (an empty cascade never calls onShown). Same dealTokenRef guard as every other async
  // measurement here, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: FreeCellState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    const handedOff = new Set<number>()
    s.foundation.forEach((pile, suit) => {
      const origin = origins[suit]
      if (!origin || pile.length === 0) return
      chains.push({ cards: pile.slice().reverse(), origin })
      handedOff.add(suit)
    })
    winCascade.startChains(chains, cardWidth, () => setCascadeHandoff({ state: s, suits: handedOff }))
  }

  // Measuring CardRegistry synchronously right after the commitState in applyMove would find the
  // still-mounted SOURCE card (the destination card's own registration effect hasn't run yet), so
  // the ghost would "fly" a near-zero distance back to roughly where it started - indistinguishable
  // from a snap (same race documented for Klondike's deal animation). Deferring to a [state]-keyed
  // effect guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    if (pendingAutoMoveCardIdRef.current.length === 0 || !state) return
    const pending = pendingAutoMoveCardIdRef.current
    pendingAutoMoveCardIdRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        // A foundation's registered top card is the usual landing spot, but if it can't be found
        // the pile's own slot container is card-sized and always there - fly to that rather than
        // hiding the ghost and letting the card simply appear.
        const landed = (await ghost.cardRegistry.measure(p.cardId)) ?? (p.to.zone === 'foundation' ? await measureView(foundationSlotRefs.current[p.to.index]) : null)
        // A new game can start while the measurement above is in flight (e.g. tapping "New Game"
        // mid auto-play-cascade - see maybeAutoPlay). `landed`, if it resolved at all, would then be
        // measuring an unrelated card in the NEW deal (ids are shuffle-independent and reused across
        // deals - see deck.ts), so drop this flight instead of landing on a nonsensical position.
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

  // Reverses a silently auto-played cascade's own flight (see FreeCellUndoMove/handleUndo below) -
  // independent of, and running concurrently with, the primary move's own flight(s) above.
  // Deferred the same way (a [state]-effect) since these cards' own registration effects, back in
  // their now-reverted tableau/freecell homes, haven't necessarily run yet in the same commit as
  // handleUndo's commitState(prevState). Every cascaded move's shared origin is its FOUNDATION pile's
  // own container ref (foundationSlotRefs) rather than CardRegistry - a buried, no-longer-topmost
  // foundation card has no registry entry of its own (see foundationSlotRefs' doc comment above).
  useEffect(() => {
    const pending = pendingCascadeUndoRef.current
    if (!pending || !state) return
    pendingCascadeUndoRef.current = null
    ;(async () => {
      const foundationIndices = Array.from(new Set(pending.moves.map((m) => m.to.index)))
      const [origins, destinations] = await Promise.all([Promise.all(foundationIndices.map((idx) => measureView(foundationSlotRefs.current[idx]))), Promise.all(pending.moves.map((m) => ghost.cardRegistry.measure(m.anchorCardId)))])
      // A new game can start while these measurements are in flight (e.g. tapping "New Game" right
      // after an Undo) - same dealTokenRef guard every other async step here uses.
      if (dealTokenRef.current !== pending.gen) {
        settleFlight()
        return
      }
      const originByIndex = new Map(foundationIndices.map((idx, i) => [idx, origins[i]]))

      const entries: DealCardSpec[] = []
      // A card whose own origin/destination/self-lookup fails can't be flown - unhide it
      // immediately instead of leaving it stuck invisible forever (same fallback runDeal's own
      // unresolvedIds handling above uses).
      const unresolvedIds: string[] = []
      const n = pending.moves.length
      pending.moves.forEach((m, i) => {
        const origin = originByIndex.get(m.to.index)
        const dest = destinations[i]
        const pile = resolvePile(m.from)
        const card = pile?.find((c) => c.id === m.anchorCardId)
        if (!origin || !dest || !card) {
          unresolvedIds.push(m.anchorCardId)
          return
        }
        // Staggered newest-cascaded-first, same convention as Klondike's own stock-draw undo - the
        // last card auto-played is the first one un-played.
        entries.push({ cardId: m.anchorCardId, card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: (n - 1 - i) * DEAL_STAGGER_MS })
      })

      if (unresolvedIds.length > 0) {
        setDealHiddenIds((ids) => {
          if (unresolvedIds.every((id) => !ids.has(id))) return ids
          const next = new Set(ids)
          unresolvedIds.forEach((id) => next.delete(id))
          return next
        })
      }

      if (entries.length === 0) {
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
        () => settleFlight()
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Same deferral reasoning as the deal/flight effects above - never measure CardRegistry
  // synchronously inside checkWin itself, since the winning foundation cards' own registration
  // effects haven't necessarily run yet in that same commit.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  // Auto-play-to-foundation has two independent halves (applyMove's afterPlayerMove calls) - see
  // autoPlay.ts for the full policy. This one is the safe-card cascade, which only the player's own
  // play of a card to a foundation (a tap or a drag) starts.
  const cascade = useAutoFoundationCascade<FreeCellState>({
    state,
    isLanding,
    getState: () => stateRef.current,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep: nextSafeCascadeStep,
    firePlay
  })
  // The finish: once every column is sorted (nothing hidden, no choice left), every remaining card
  // files away on its own, at a pace that ramps up - after the player's play of a card to a foundation
  // that leaves the board that way, or the cascade that play set off (see useAutoFinish).
  const finish = useAutoFinish<FreeCellState>({
    state,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    getState: () => stateRef.current,
    canFinish: canAutoFinish,
    nextMove: nextFinishMove,
    isLanding,
    firePlay
  })

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    finish.suppress()
    cascade.disarm()
    const s = FreeCellController.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingAutoMoveCardIdRef.current = []
    pendingCascadeUndoRef.current = null
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
    setDealHiddenIds(dealtIds)
    setDeckVisible(true)
    dimAfterDeal.hold()
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal) and no deck placeholder (deckVisible stays false - nothing is dealing). Also restores the
  // saved undo stack (falling back to empty for an older save written before undo persistence
  // existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<FreeCellState, UndoEntry<FreeCellState, FreeCellUndoMove>>) {
    ++dealTokenRef.current
    finish.suppress()
    cascade.disarm()
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingAutoMoveCardIdRef.current = []
    pendingCascadeUndoRef.current = null
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setDeckVisible(false)
    dimAfterDeal.releaseNow()
    commitState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('freecell')
    startNewGame()
  }

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint(request?: HintRequest): boolean {
    if (!state) return false
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(FreeCellController, state, skip)
    if (result.kind === 'none') {
      if (!request?.auto) showNoHintToast(infoToast)
      return false
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('freecell')
    // The glide is the Hint button's alone: Auto Hint only rings the cards.
    if (result.kind === 'move' && !request?.auto) {
      const { from, to, count } = result.move
      const source = resolvePile(from) ?? []
      void playHintGlide({ moving: source.slice(source.length - count), dest: resolvePile(to) ?? [], destFanned: to.zone === 'tableau', slot: to, cardWidth })
    }
    // True when pressing Hint again shows a different move: a held Hint button steps on while it is (hintHold.ts).
    return result.kind === 'move' && result.choices > 1
  }

  function pushUndo(prev: FreeCellState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move: { primary: move, cascaded: [] } }])
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingAutoMoveCardIdRef effect below can only measure a DESTINATION once it's committed
  // and re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would.
  //
  // An entry from a save written before auto-plays became their own undo steps can still carry a
  // `cascaded` list: undoing its `primary` move also reverse-animates every card the auto-play
  // cascade played on top of it, in one Undo press (see FreeCellUndoMove above and the
  // pendingCascadeUndoRef effect above).
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // A plain move's undo takes its cards back off the pile it went to, so it overlaps the undos
  // before it once nothing is still landing there - holding Undo after a finish brings the cards
  // down in a stream. A legacy entry's cascade flies back through its own single-slot effect, from
  // several foundations at once - one at a time.
  function undoGate(): UndoGate {
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    const current = stateRef.current
    if (!entry || !current) return null
    const { primary, cascaded } = entry.move
    if (!primary || cascaded.length > 0) return 'exclusive'
    // Cards still flying in to that pile turn back in mid-air (revertTopUndo's peel): nothing to wait for.
    if (ghost.canPeel(undoGhost(primary, current))) return { takesFrom: [] }
    return { takesFrom: [primary.to] }
  }

  // The ghost a plain undo of `move` flies back: the cards it takes off `move.to` as `current` has them.
  function undoGhost(move: MoveInfo, current: FreeCellState) {
    const sourcePile = resolvePile(move.to, current)
    const cards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    return { cards, offsetStep: move.count > 1 ? faceUpFanOffset(cardWidth) : 0, cardWidth }
  }

  async function revertTopUndo() {
    // The stack and the board are read via their refs, not the closure: undos can run back-to-back
    // before React re-renders (see runUndo).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    // Undoing lands on an earlier board that may itself be finishable - it must not immediately
    // re-fire the cards the player just took back (see useAutoFinish's suppress), and likewise a
    // still-armed safe-card cascade must not replay the tap this undo is reverting.
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
    }
    const { move: undoMove, state: prevState } = entry
    const { primary, cascaded } = undoMove
    // Captured once, up front - every stash this call makes uses this same token, so a "New Game"
    // that fires mid-await consistently invalidates every one of this undo's pending flights rather
    // than some using a token read before the race and some after (mirrors Klondike's own handleUndo).
    const gen = dealTokenRef.current
    startFlights(cascaded.length > 0 ? 2 : 1)

    if (!primary) {
      setUndoStack((stack) => stack.slice(0, -1))
      commitState(prevState)
      settleFlight() // primary: nothing to fly, settles immediately
      return
    }

    const ghostContent = undoGhost(primary, current)
    const movingCards = ghostContent.cards
    // Cards the undo before this one is still flying in (a held Undo, where that undo's move put them
    // on this pile): they turn back in mid-air, the rest of that flight landing as before, instead of
    // the undo waiting for them to land and then sending them off again. Taken here, before any await,
    // in the same task the gate saw them (undoGate).
    const peeled = movingCards.length > 0 ? ghost.peel(ghostContent) : null
    const origin = peeled || movingCards.length === 0 ? null : await ghost.cardRegistry.measure(primary.anchorCardId)

    setUndoStack((stack) => stack.slice(0, -1))

    if (cascaded.length > 0) {
      const cascadeIds = new Set(cascaded.map((m) => m.anchorCardId))
      // Same "hide before reverting" ordering as Pyramid's own removal-undo (see this repo's own
      // CLAUDE.md) - set the hide flags in the SAME synchronous stretch as commitState(prevState)
      // below, so React batches them into one commit with no frame where the restored cards flash
      // fully visible before their ghosts arrive to cover them.
      setDealHiddenIds((ids) => {
        const next = new Set(ids)
        cascadeIds.forEach((id) => next.add(id))
        return next
      })
      pendingCascadeUndoRef.current = { moves: cascaded, gen }
    }

    const flight = peeled ?? (origin ? ghost.show(ghostContent, { x: origin.x, y: origin.y }) : null)
    if (flight) {
      playCardSound()
      hapticCard()
      // The flight they were taken out of now reveals only what it still carries when it lands.
      if (peeled) shrinkLanding(primary.to, movingCards.length)
      const flyingId = beginFlying(primary.from, primary.count)
      commitState(prevState)
      pendingAutoMoveCardIdRef.current.push({ cardId: primary.anchorCardId, to: primary.from, gen, flight, flyingId })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so it doesn't arm the cascade or start the finish, but it
  // counts as a move like any other (so Auto-Move only saves taps) and is its own undo step.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
    // commitState just did, not the same stale board both closures captured.
    const current = stateRef.current
    if (!current) return false
    // The card flying is the card the player grabbed (or the auto-play chose); tryMove only knows
    // positions, so if the board moved on since - an auto-play took that very card between the grab
    // and the drop - it would move whatever now sits there while the ghost shows a different card.
    // Refuse instead, so a card never moves without its own flight.
    if (moveHeadCard(current, from, count)?.id !== anchorCardId) return false
    const result = FreeCellController.tryMove(current, { from, to, count })
    if (result) {
      const moveInfo: MoveInfo = { from, to, count, anchorCardId }
      // Every move gets its own undo entry, an auto-played one included, so one Undo press takes back one card and the
      // player can stop exactly where they want (an auto-play used to be folded into the entry of the move that set it
      // off, see FreeCellUndoMove).
      pushUndo(current, moveInfo)
      commitState(result)
      // Every move counts, the player\'s or an auto-play\'s: Auto-Move only saves taps, never score.
      session.registerMove()
      checkWin(result)
      // Only the player's own play of a card to a foundation (a tap or a drag) starts the cascade; any other
      // move of theirs stops it, so a card it uncovers is theirs to play. The finish follows the same
      // foundation play, once the board is solved (see autoPlay.ts).
      if (!opts?.silent) {
        cascade.afterPlayerMove(to)
        finish.afterPlayerMove(to)
      }
      return true
    }
    return false
  }

  // `s` defaults to the closure's own live `state` (every pre-existing call site) - handleCardTap
  // passes an explicit stateRef.current instead (see its own call site below), since that call has
  // an await gap before it and wants the board as of right now, not whatever render handleCardTap's
  // own closure was created against (mirrors Klondike's resolvePile).
  function resolvePile(ref: PileRef, s: FreeCellState | null = state): Card[] | null {
    if (!s) return null
    switch (ref.zone) {
      case 'tableau':
        return s.tableau[ref.index] ?? null
      case 'foundation':
        return s.foundation[ref.index] ?? null
      case 'freecell': {
        const c = s.freecells[ref.index]
        return c ? [c] : null
      }
      default:
        return null
    }
  }

  // Tapping any movable card sends it to its best legal destination: a foundation if one exists,
  // otherwise the tableau pile that buries the fewest cards (see engine/autoMove.ts), otherwise an
  // empty freecell as a last resort (see rules.ts's autoMoveHint). Tapping the same card again
  // re-evaluates from its new position, so a card cycles through its alternatives one tap at a
  // time rather than needing a separate destination tap.
  //
  // The move applies immediately (so game logic/undo never wait on an animation), but the card
  // that just moved stays hidden at its destination until a ghost copy - shown at the tapped
  // origin - flies there and lands. cardRegistry.measure() finds that destination position by
  // measuring the real (already re-rendered) card rather than recomputing pile fan math here, so
  // the ghost always lands exactly on top of it with no seam.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>, indexFromTop?: number) {
    if (!state || !FreeCellController.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const move = FreeCellController.autoMoveHint(state, ref, cardId)
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

    playCardSound()
    hapticCard()
    if (!completeMove(move.from, move.to, move.count, cardId, takeOff.flight, { inAir: takeOff.inAir })) {
      takeOff.flight.hide()
      settleFlight()
    }
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual
  // drag's drop) - applies the move, then marks the destination "incoming" and stashes the
  // anchor card id for the [state]-effect above to measure and fly the ghost onto, instead of it
  // just vanishing/appearing at the destination instantly.
  //
  // `inAir`: a tapped run's cards still flying in to `from` (inAirRun.ts) - `flight` carries only the cards on the board, and each piece
  // goes on from mid-air in a flight of its own, landing on top of them.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean; inAir?: Card[][] }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) {
      // tableauRunCount's dimming only rules out a run that could NEVER move anywhere (the
      // best-case cap, assuming a non-empty destination - see its own comment). A run that passed
      // that check can still fail here specifically when the player aims it at an empty column:
      // that column can't double as its own intermediate storage, so its real cap is one factor of
      // 2 smaller than the best case. Since any card may start an empty column regardless of rank
      // (canPlaceOnTableau), this capacity check is the ONLY way a >1-count move to an empty column
      // can fail - so surface it, rather than leaving the player to guess why it silently bounced.
      // Reads stateRef.current (not the render closure's `state`), same reasoning as applyMove's
      // own doc comment - applyMove itself already rejected this move against the true current
      // board, so this diagnostic should explain that same board, not a possibly-stale render.
      const current = stateRef.current
      if (current && to.zone === 'tableau' && count > 1) {
        const cap = maxSupermoveCount(current, to.index)
        if (count > cap) {
          const freecells = countEmptyFreecells(current)
          // Excludes `to` itself, matching what actually fed `cap` above - the destination can't
          // double as its own intermediate storage, so this is the count of OTHER empty columns
          // that could help, not the board's total (which would be one higher here).
          const otherEmptyCols = countEmptyTableauColumns(current, to.index)
          // A short title and the reason under it: as one sentence it ran past the toast's two title lines and was cut off.
          infoToast(`Only ${cap} card${cap === 1 ? '' : 's'} can move there`, `With ${freecells} empty freecell${freecells === 1 ? '' : 's'} and ${otherEmptyCols} other empty column${otherEmptyCols === 1 ? '' : 's'}.`, undefined, { icon: 'card-multiple-outline' })
        }
      }
      return false
    }
    const gen = dealTokenRef.current
    const inAirCount = (opts?.inAir ?? []).reduce((n, piece) => n + piece.length, 0)
    pendingAutoMoveCardIdRef.current.push({ cardId: anchorCardId, to, gen, flight, flyingId: beginFlying(to, count - inAirCount) })
    if (inAirCount > 0) {
      // Out of `from`'s landing count, so the cards left there show at once.
      shrinkLanding(from, inAirCount)
      const pieces = peelInAir(ghost, opts?.inAir ?? [], cardWidth)
      startFlights(pieces.length)
      for (const p of pieces) pendingAutoMoveCardIdRef.current.push({ cardId: p.anchorCardId, to, gen, flight: p.flight, flyingId: beginFlying(to, p.count) })
    }
    return true
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move (every other mutator here either has no await at all, or - like
  // handleUndo - captures everything it needs from the pre-move state synchronously first). Guard
  // against something else changing state during that gap by snapshotting stateRef before the
  // await and bailing if it no longer matches after. `stillOn` is re-checked there too: whichever
  // automation sent this card - the cascade (its isArmed, the default) or the finish (its isAllowed,
  // which useAutoFinish passes) - may have been ended meanwhile by the player's move elsewhere, an undo
  // or a new deal.
  async function firePlay(entry: AccessibleCard, to: PileRef, stillOn: () => boolean = () => cascade.isArmed()): Promise<boolean> {
    startFlights(1)
    const stateAtStart = stateRef.current
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart || undoBusyRef.current || !stillOn()) {
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

  // A card whose own coherent run (indexFromTop + 1 cards) is longer than what the current
  // freecells/empty columns can actually carry is not draggable from here, even though the run
  // itself is well-formed - grabbing it would always bounce back (see rules.ts's tryMove, which
  // rejects any count over maxSupermoveCount). -1 as the destIndex asks for the best-case cap
  // (not knowing the eventual destination yet), same as tryMove would apply for a non-empty
  // destination column - the common case, and consistent with this dimming already being a
  // coarse "would this always fail" check rather than a full destination-aware oracle. Reads
  // stateRef.current (not the render closure's `state`) - this can be queried mid-drag-gesture,
  // right after some other concurrent action just committed a newer board but before this
  // component has re-rendered, and a stale read here could dim/undim a run against the wrong
  // freecell/column occupancy.
  // useCallback'd (not a plain function like every other handler here) specifically so it can sit in
  // dragConfigs' own useMemo deps below and actually stay stable there - its body only ever reads
  // stateRef.current (never the render closure's `state`), so it genuinely never needs to change
  // identity at all.
  const tableauRunCount = useCallback(
    (colIndex: number, indexFromTop: number): number => {
      const current = stateRef.current
      if (!current) return 0
      const runLen = runCountFrom(current.tableau[colIndex], indexFromTop, isDescendingAltColor)
      if (runLen > 1 && runLen > maxSupermoveCount(current, -1)) return 0
      return runLen
    },
    [stateRef]
  )

  // Every other handler above (completeMove, handleCardTap, startFlights/settleFlight from
  // useFlightConcurrency) is a plain function/hook return rebuilt fresh every render - fine for a
  // normal event handler, but it means a naive per-column `drag`/`onPressCard` object built inline in
  // the JSX below (as this used to be) gets a brand-new identity every render too. PileView is now
  // memoized (see its own doc comment) specifically so a card landing during a deal only re-renders
  // the ONE column it actually landed in - but that only works if the other 7 columns' own props,
  // `drag`/`onPressCard` included, are genuinely unchanged objects across that render. Routing the
  // unstable pieces through a ref (refreshed every render, read only from inside a later callback -
  // never during render) lets dragConfigs/onPressCardConfigs below be built ONCE and stay stable for
  // this screen's whole lifetime, exactly the `latest`-ref idiom PileView.tsx's own onPressCard/drag
  // plumbing already relies on, one level up.
  const latestRef = useRef({ completeMove, startFlights, settleFlight, handleCardTap })
  useEffect(() => {
    latestRef.current = { completeMove, startFlights, settleFlight, handleCardTap }
  })

  // One stable PileDragConfig per tableau column, built once (colIndex never changes for a given
  // array slot) instead of a fresh object every render - see latestRef's own doc comment above for why.
  const dragConfigs = useMemo(
    () =>
      Array.from({ length: TABLEAU_COLUMNS }, (_, colIndex): PileDragConfig => ({
        registry: dropZones,
        getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
        onDrop: (to, count, anchorCardId, flight) => {
          if (undoBusyRef.current) return false
          latestRef.current.startFlights(1)
          if (!latestRef.current.completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId, flight)) {
            latestRef.current.settleFlight()
            return false
          }
          return true
        }
      })),
    [dropZones, tableauRunCount, undoBusyRef]
  )

  // Same reasoning as dragConfigs above - a fresh `(card, indexFromTop, measure) => handleCardTap(...)`
  // arrow every render defeated PileView's memoization on its own, independently of dragConfigs.
  const onPressCardConfigs = useMemo(() => Array.from({ length: TABLEAU_COLUMNS }, (_, colIndex) => (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => latestRef.current.handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)), [])

  if (!state) return <GameLoading />

  // What every column's run counts depend on besides its own cards (see tableauRunCount above and PileView's runCountKey).
  const supermoveCap = maxSupermoveCount(state, -1)

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='FreeCell' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} autoHintKey={state} hintShowing={!!activeHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} pauseClock={session.setPaused} par={parFor('freecell')} clockRunning={session.started && !won} movesCount={session.moves} rules={FREECELL_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={[styles.foundationsGroup, { gap: topRowGroupGap }]}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              // How many of this pile's cards are still in the air: the finish overlaps flights, so
              // several can be headed here at once (see FoundationCell's settledCard).
              const flightsInAir = flying.filter((f) => f.to.zone === 'foundation' && f.to.index === i).reduce((sum, f) => sum + f.count, 0)
              const isFlyingHere = flightsInAir > 0
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={winRevealed && cascadeHandoff?.state === state && cascadeHandoff.suits.has(i) ? undefined : t}
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

          <View style={[styles.freecellsGroup, { gap: topRowGroupGap }]}>
            {state.freecells.map((card, i) => {
              const ref: PileRef = { zone: 'freecell', index: i }
              // dealHiddenIds also covers a cascaded card returning HERE via handleUndo's own
              // cascade-undo flight (see pendingCascadeUndoRef's effect above) - it's not just the
              // initial deal's own hidden-until-landed set. PileView already consumes the same set
              // for a tableau destination (its own hiddenCardIds prop below); FreecellCell has no
              // such prop of its own, so this folds it into the same isFlyingHere-driven hide/freeze
              // this cell already does for the single-ghost `flying` case.
              const isFlyingHere = flying.some((f) => f.count > 0 && f.to.zone === 'freecell' && f.to.index === i) || (!!card && dealHiddenIds.has(card.id))
              // The far-right freecell doubles as the deal's flight origin while dealing (see
              // dealOriginRef/DECK_PLACEHOLDER_CARD above) - freecells are never touched by the
              // initial deal itself, so `card` is guaranteed still null underneath for the whole
              // time this placeholder shows, and it reverts to the plain FreecellCell below as soon
              // as deckVisible goes false (see runDeal - deliberately timed to the last card
              // LEAVING, not landing, so the deck doesn't linger after it's already been emptied).
              const isDealOrigin = i === state.freecells.length - 1 && deckVisible
              return (
                <DropZone key={i} registry={dropZones} pileRef={ref} style={[styles.freecellSlot, { width: cardWidth }]}>
                  {isDealOrigin ? (
                    <View ref={dealOriginRef} collapsable={false}>
                      <PlayingCard card={DECK_PLACEHOLDER_CARD} testID='freecell-deck-origin' />
                    </View>
                  ) : (
                    <FreecellCell card={card ?? undefined} isFlyingHere={isFlyingHere} shakeToken={card && shake?.cardId === card.id ? shake.token : undefined} highlighted={hintCountFor(activeHint, ref) > 0} onPress={(measure) => handleCardTap(ref, card!.id, measure)} onDrop={(x, y, flight) => attemptDrop(ref, 1, x, y, card!.id, flight)} />
                  )}
                </DropZone>
              )
            })}
          </View>
        </View>

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const hiddenCount = flying.filter((f) => f.to.zone === 'tableau' && f.to.index === colIndex).reduce((sum, f) => sum + f.count, 0)
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                <PileView cards={col} onPressCard={onPressCardConfigs[colIndex]} maxHeight={tableauMaxHeight} drag={dragConfigs[colIndex]} runCountKey={supermoveCap} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable && !dimAfterDeal.held} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
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
      {winRevealed && <WinBanner elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} par={parFor('freecell')} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles() {
  return StyleSheet.create({
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row'
    },
    freecellSlot: {},
    freecellsGroup: {
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
