import { Pressable, useVibration } from '@rific/feedback-press'
import { Fireworks } from '@tastic/animations/fireworks'
import { computeContentBounds } from '@tastic/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleProp, StyleSheet, Text, useWindowDimensions, View, ViewStyle } from 'react-native'
import { useTheme } from 'react-native-paper'

import { faceUpFanOffset } from '@/components/cards/CardFace'
import { CardSizeProvider, cardWidthForRow, useCardSize } from '@/components/CardSizeContext'
import { DealCardSpec, DealProvider, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DragGhostProvider, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { useDropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { formatTime, GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { fireworksColors, TableColors, useTableColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts, WinCascadeProvider } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { PileRef } from '@/engine/gameTypes'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { clearGameInProgress, loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useGameStats } from '@/stores/gameStats'
import { useLastActiveGame } from '@/stores/lastActiveGame'
import { useSettings } from '@/stores/settings'

import { buildSpiderDealSequence } from './dealSequence'
import { createSpiderController, SpiderState } from './rules'
import { SpiderSettingsSection } from './SpiderSettingsSection'

const TABLEAU_COLUMNS = 10
const TABLEAU_GAP = 4
// Stock always starts a game with exactly 50 cards (104 total minus the 54 dealt into the tableau,
// true for every numSuits variant - see rules.ts's newGame) - 5 rounds of TABLEAU_COLUMNS cards
// each, so the fan never needs more than 5 packets regardless of how the game was configured.
const STOCK_MAX_PACKETS = 5
// How far each successive fanned packet peeks out from the one behind it, as a fraction of a
// card's width - small enough to read as "a few decks deep," not a wide hand-of-cards spread.
const STOCK_FAN_OFFSET_RATIO = 0.16
// A placeholder face-down card for the stock fan's decorative packets - id/suit/rank are never
// shown (faceUp: false always renders CardBack instead), so any valid values work here.
const STOCK_PACKET_CARD: Card = { id: 'stock-packet', suit: 'spades', rank: 1, faceUp: false }

/** CardRegistry id for the packet at this depth (0 = deepest, present until the very last deal;
 * STOCK_MAX_PACKETS-1 = frontmost, gone after the very first deal - see StockFan/StockPacket). */
function stockPacketId(index: number): string {
  return `stock-packet-${index}`
}

/** Records enough about an applied move to reverse its animation later - undoing doesn't just
 * revert to the previous state snapshot, it flies the moved card(s) back from wherever they
 * currently sit (`to`) to their previous pile (`from`), mirroring the forward flight in reverse. */
interface MoveInfo {
  from: PileRef
  to: PileRef
  count: number
  anchorCardId: string
}

interface HistoryEntry {
  state: SpiderState
  /** Null for a stock deal (10 cards land across every column at once - see runDeal - rather than
   * one card landing somewhere new, so there's no single MoveInfo shape to record) - handleUndo
   * detects this case itself and flies all 10 back to the stock fan (see runUndoDeal). */
  move: MoveInfo | null
}

function isDescendingSameSuitRun(cards: Card[]): boolean {
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].rank !== cards[i - 1].rank - 1) return false
    if (cards[i].suit !== cards[i - 1].suit) return false
  }
  return true
}

/** Thin wrapper so the screen body below can be a descendant of its own DragGhostProvider - it
 * needs useDragGhost() itself now (to drive the tap-to-move fly animation), not just the
 * PileView children that used to be its only consumers. DealProvider wraps from further out
 * still, for both the initial deal and every later stock-deal (see runInitialDeal/runDeal below)
 * - a separate mechanism from DragGhostProvider's single-flight ghost, since either one needs up
 * to 54 (or 10) cards flying independently at once. */
export default function SpiderScreen() {
  return (
    <DealProvider>
      <DragGhostProvider>
        <WinCascadeProvider>
          <SpiderScreenInner />
        </WinCascadeProvider>
      </DragGhostProvider>
    </DealProvider>
  )
}

function SpiderScreenInner() {
  const colors = useTableColors()
  const { dark } = useTheme()
  const { recordDealWon, recordDealAbandoned } = useGameStats()
  const { setLastActiveGame, clearLastActiveGame } = useLastActiveGame()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const dropZones = useDropZoneRegistry()
  const { settings } = useSettings()
  const [ready, setReady] = useState(false)
  // The suit count of the game currently in progress - only updated when a new game actually
  // starts (mount, or handleNewGame below), always reading the live `settings.spiderSuits` at
  // that moment. Deliberately NOT derived directly from `settings.spiderSuits` on every render:
  // the in-progress game's own controller/rules must stay fixed to whatever suit count it was
  // dealt with, even if the player changes the setting mid-game without starting a new deal.
  const [numSuits, setNumSuits] = useState<1 | 2 | 4>(settings.spiderSuits)
  const controller = useMemo(() => createSpiderController(numSuits), [numSuits])

  const [state, setState] = useState<SpiderState | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const session = useGameSession()
  const [won, setWon] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const recordedRef = useRef(false)
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, TABLEAU_GAP)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  /** A stock deal awaiting its post-commit measurement + deal.start() (see runDeal/the effect
   * below) - stashes the actual dealt cards and the already-measured flight origin (the specific
   * packet dealt from - see handleDrawStock) rather than a bare token, since a card can immediately
   * complete (and get removed as part of) a run the instant it's dealt - see runDeal's comment. */
  const pendingDealRef = useRef<{ dealt: { card: Card; colIndex: number }[]; origin: { x: number; y: number } | null; token: number } | null>(null)
  /** An initial deal awaiting its post-commit measurement + deal.start() (see runInitialDeal/the
   * effect below) - just a token, unlike pendingDealRef above: the freshly dealt tableau can't
   * have already completed a run before any of its cards have even landed, so there's no need to
   * stash a pre-captured card list - runInitialDeal re-reads it straight from `state`, exactly
   * like Klondike's own initial-deal effect does. */
  const pendingInitialDealTokenRef = useRef<number | null>(null)
  /** An undone stock deal awaiting its post-commit measurement + deal.start() (see runUndoDeal/the
   * effect below) - the mirror image of pendingDealRef: this flight's origins (where the dealt
   * cards currently sit) are measured up front, before the revert below removes them, while its
   * single shared destination (the stock fan's restored packet) can only be measured after, once
   * that packet exists to register itself - the same "measure whichever side hasn't mounted yet"
   * split as every other deferred deal effect here, just with which side is early/late swapped. */
  const pendingUndoDealRef = useRef<{
    entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[]
    destinationPacketIndex: number
    token: number
  } | null>(null)
  const pendingAutoMoveCardIdRef = useRef<string | null>(null)
  const winCascade = useWinCascade()
  /** Mirrors pendingInitialDealTokenRef/pendingDealRef's own shape - set by the win-check effect,
   * consumed by the [state]-effect below once the winning completed-run slots have actually
   * committed (see runWinCascade). */
  const pendingWinCascadeRef = useRef<{ gen: number } | null>(null)
  /** One ref per completed-sequence slot below - unlike a foundation pile's own card, these slots
   * have no per-card CardRegistry registration (there's no single occupant identity to track, just
   * "is this run done or not") - measured the same plain-view way Pyramid's discard pile is. */
  const completedSlotRefs = useRef<(View | null)[]>(new Array(8).fill(null))
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handlePressCard and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  const startNewGame = useCallback(
    (ctrl: ReturnType<typeof createSpiderController>) => {
      const myToken = ++dealTokenRef.current
      const s = ctrl.newGame(randomSeed())
      setHistory([])
      session.reset()
      setWon(false)
      setMessage(null)
      recordedRef.current = false
      winCascade.clear()
      pendingWinCascadeRef.current = null

      const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
      setDealHiddenIds(dealtIds)
      pendingInitialDealTokenRef.current = myToken
      setState(s)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal), no fresh history. `saved.config` is the suit count the game was actually dealt under
  // (see numSuits's own doc comment above) - falls back to the live setting only if the saved value
  // is somehow missing/invalid. Setting numSuits here is enough to bring `controller` (a useMemo
  // keyed on it) back in sync by the same render that commits `state` below - both setters run
  // inside the same batch.
  function restoreGame(saved: SavedGame<SpiderState>) {
    ++dealTokenRef.current
    const suits = saved.config === 1 || saved.config === 2 || saved.config === 4 ? saved.config : settings.spiderSuits
    setNumSuits(suits)
    setHistory([])
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    setMessage(null)
    recordedRef.current = false
    setDealHiddenIds(new Set())
    setState(saved.state)
  }

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<SpiderState>('spider').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame(controller)
      setReady(true)
      setLastActiveGame('spider')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after the win-check effect below just cleared it.
  useEffect(() => {
    if (state && !won) {
      saveGameInProgress('spider', { state, moves: session.moves, elapsedSeconds: session.elapsed, config: numSuits })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, numSuits])

  useEffect(() => {
    if (!state) return
    if (controller.isWon(state) && !won) {
      setWon(true)
      if (!recordedRef.current) {
        recordedRef.current = true
        session.stopClock()
        recordDealWon('spider', { seconds: session.elapsed, moves: session.moves, score: computeScore(session.moves, session.elapsed) })
        clearGameInProgress('spider')
        pendingWinCascadeRef.current = { gen: dealTokenRef.current }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Foundation-equivalent measurement for Spider's win cascade: each completed run's own slot
  // (see completedSlotRefs above) is a stable, always-mounted plain View - unlike a foundation
  // pile's per-card CardRegistry registration, there's no per-card identity to look up here, just
  // the slot's own screen position. Same dealTokenRef guard as every other async measurement in
  // this file, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: SpiderState, gen: number) {
    const origins = await Promise.all(completedSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    s.completedRuns.forEach((run, slot) => {
      const origin = origins[slot]
      if (!origin || run.length === 0) return
      chains.push({ cards: run, origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS }) // already King-first, Ace-last
    })
    winCascade.startChains(chains, cardWidth)
  }

  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Measuring CardRegistry synchronously right after the setState in commitMove would find the
  // still-mounted SOURCE card (the destination card's own registration effect hasn't run yet), so
  // the ghost would "fly" a near-zero distance back to roughly where it started - indistinguishable
  // from a snap (same race documented for Klondike's deal animation). Deferring to a [state]-keyed
  // effect guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    const cardId = pendingAutoMoveCardIdRef.current
    if (!cardId || !state) return
    pendingAutoMoveCardIdRef.current = null
    ;(async () => {
      const landed = await ghost.cardRegistry.measure(cardId)
      if (landed) {
        ghost.flyTo(landed.x, landed.y, () => setFlying(null))
      } else {
        ghost.hide()
        setFlying(null)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Shared tail for both the initial deal and every later stock-deal (see runInitialDeal and
  // handleDrawStock's effect below) - flies each of `cards` from the same single `origin` (already
  // measured by the caller, which the "no cards left to fly" case below also relies on to tell a
  // real empty deal apart from one that's still waiting on a caller-side measurement) to its own
  // real (already re-rendered) destination, each after its own `delayMs`. A card whose destination
  // can't be measured - namely a Spider run that completed (see resolveCompletedSequence) and
  // removed that very card the instant it landed - simply has no entry, so its own flight is
  // skipped while every other card's still flies normally, mirroring Klondike's own runDeal.
  async function runDeal(cards: { card: Card; delayMs: number }[], origin: { x: number; y: number } | null, token: number) {
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }
    const destinations = await Promise.all(cards.map((c) => ghost.cardRegistry.measure(c.card.id)))
    if (dealTokenRef.current !== token) return

    const entries: DealCardSpec[] = []
    cards.forEach((c, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({
        cardId: c.card.id,
        card: c.card,
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: c.delayMs
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

  // Same race as the pending auto-move effect above (and Klondike's identical deal effect):
  // measuring CardRegistry synchronously right after the setState in handleDrawStock would run
  // before the newly-dealt cards' own registration effects have fired. Deferring to this
  // [state]-keyed effect guarantees they've already registered by the time runDeal measures them.
  useEffect(() => {
    const pending = pendingDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingDealRef.current = null
    runDeal(
      pending.dealt.map((d) => ({ card: d.card, delayMs: d.colIndex * DEAL_STAGGER_MS })),
      pending.origin,
      pending.token
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Mirrors Klondike/Pyramid's own initial-deal animation (see components/dealing/DealLayer.tsx):
  // flies all 54 cards from the stock to their tableau positions, round-robin (see
  // buildSpiderDealSequence), the instant a fresh game commits. Unlike a stock-deal's origin (see
  // handleDrawStock), there's no already-mounted packet to measure BEFORE this commit - state was
  // null (or a previous game's tableau) until now - so the origin here can only be measured the
  // same way the per-card destinations are: after this fresh tableau, and the stock fan sitting
  // above it, have actually mounted and registered themselves.
  async function runInitialDeal(s: SpiderState, token: number) {
    const sequence = buildSpiderDealSequence(s.tableau)
    const originIndex = Math.ceil(s.stock.length / TABLEAU_COLUMNS) - 1
    const origin = await ghost.cardRegistry.measure(stockPacketId(originIndex))
    if (dealTokenRef.current !== token) return
    runDeal(
      // Flies face-down regardless of step.card's real faceUp - a real dealer lays every card
      // down blind and only turns the top one of each column face-up after it's placed, not
      // while it's still sliding across the table. The real card underneath (revealed the
      // instant this ghost lands - see dealHiddenIds) already carries the correct true faceUp,
      // so forcing it here only affects this flight's own appearance. Unlike this, a stock-deal's
      // own cards (see handleDrawStock below) are left showing their real face while flying -
      // every stock-dealt card is always face-up already, with no buried cards to distinguish it
      // from, the same as Klondike's own single-card stock-draw flight.
      sequence.map((step) => ({ card: { ...step.card, faceUp: false }, delayMs: step.visitOrder * DEAL_STAGGER_MS })),
      origin,
      token
    )
  }

  useEffect(() => {
    if (pendingInitialDealTokenRef.current === null || pendingInitialDealTokenRef.current !== dealTokenRef.current || !state) return
    const token = pendingInitialDealTokenRef.current
    pendingInitialDealTokenRef.current = null
    runInitialDeal(state, token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Reverses a stock deal's own forward flight (see runDeal/handleDrawStock): the 10 cards that
  // deal placed fly from their current tableau spots - already measured by the caller, before its
  // own revert removed them - back to the stock fan's restored packet, converging on that one
  // shared point instead of each having its own destination. A card with no origin (the caller
  // couldn't measure it - see handleUndo's comment on a swept-run column) or if the destination
  // itself can't be measured just isn't included, the same graceful-skip every other deal flight
  // here already uses for an unmeasurable side.
  async function runUndoDeal(entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[], destinationPacketIndex: number, token: number) {
    const destination = await ghost.cardRegistry.measure(stockPacketId(destinationPacketIndex))
    if (dealTokenRef.current !== token || !destination) return

    const dealEntries: DealCardSpec[] = []
    entries.forEach((e) => {
      if (!e.origin) return
      dealEntries.push({ cardId: e.card.id, card: e.card, from: e.origin, to: destination, delayMs: e.delayMs })
    })
    if (dealEntries.length === 0) return

    deal.start(
      dealEntries,
      cardWidth,
      () => {},
      () => {}
    )
  }

  useEffect(() => {
    const pending = pendingUndoDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingUndoDealRef.current = null
    runUndoDeal(pending.entries, pending.destinationPacketIndex, pending.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  if (!ready || !state) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  function pushHistory(prev: SpiderState, move: MoveInfo | null) {
    setHistory((h) => [...h, { state: prev, move }])
  }

  // Tapping any movable card sends it to the tableau pile that buries the fewest cards (see
  // engine/autoMove.ts) - Spider has no foundation, so unlike Klondike/FreeCell this only ever
  // considers other tableau columns. Tapping the same card again re-evaluates from its new
  // position, so it cycles through its alternatives one tap at a time.
  //
  // The move applies immediately (so game logic/undo never wait on an animation), but the card(s)
  // that just moved stay hidden at their destination until a ghost copy - shown at the tapped
  // origin - flies there and lands. cardRegistry.measure() finds that destination position by
  // measuring the real (already re-rendered) card rather than recomputing pile fan math here, so
  // the ghost always lands exactly on top of it with no seam.
  async function handlePressCard(colIndex: number, card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    const move = controller.autoMoveHint(state, { zone: 'tableau', index: colIndex }, card.id)
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather
      // than a dead press, with a short haptic tap alongside (see shakeAnimation.ts). Tapping mid-
      // stack (indexFromTop > 0) with a valid run below shakes that whole run, not just the one
      // card under the finger - it's the same "stuck" outcome for all of them. Deliberately never
      // calls measure() - this branch has no use for the tapped card's position, so it skips
      // paying for the measurement at all (see PileView.tsx's onPress doc comment).
      const count = Math.max(1, tableauRunCount(colIndex, indexFromTop))
      setShake({ cardId: card.id, count, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    const origin = await measure()
    const sourcePile = state.tableau[move.from.index] ?? null
    if (!sourcePile) return
    const movingCards = sourcePile.slice(sourcePile.length - move.count)
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0

    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: movingCards, offsetStep, cardWidth })

    if (!completeMove(move.from, move.to, move.count, card.id)) {
      ghost.hide()
    }
  }

  function commitMove(from: PileRef, to: PileRef, count: number, anchorCardId: string): boolean {
    const next = controller.tryMove(state!, { from, to, count })
    if (next) {
      pushHistory(state!, { from, to, count, anchorCardId })
      setState(next)
      session.registerMove()
      return true
    }
    return false
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual
  // drag's drop) - applies the move, then marks the destination "incoming" and stashes the
  // anchor card id for the pendingAutoMoveCardIdRef effect above to measure and fly the ghost
  // onto, instead of it just vanishing/appearing at the destination instantly.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string): boolean {
    if (!commitMove(from, to, count, anchorCardId)) return false
    setFlying({ to, count })
    pendingAutoMoveCardIdRef.current = anchorCardId
    return true
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    const col = state.tableau[colIndex]
    const count = indexFromTop + 1
    const run = col.slice(col.length - count)
    if (!run.every((c) => c.faceUp) || !isDescendingSameSuitRun(run)) return 0
    return count
  }

  async function handleDrawStock() {
    if (won) return
    if (!controller.drawStock) return
    // Captured from the PRE-deal stock - see runDeal's comment on why this can't be re-derived
    // from the post-deal tableau.
    const dealt = state!.stock.slice(0, TABLEAU_COLUMNS).map((card, colIndex) => ({ card, colIndex }))
    const next = controller.drawStock(state!)
    if (!next) {
      setMessage("Can't deal - clear a column first")
      return
    }
    setMessage(null)
    // A deal has no single MoveInfo shape to record (10 cards land across every column at once,
    // not one card landing somewhere new) - handleUndo detects the null move itself and reverses
    // this same flight (see runUndoDeal) rather than needing anything stashed here.
    pushHistory(state!, null)
    session.registerMove()

    const myToken = ++dealTokenRef.current

    // The packet this round is dealt from is the frontmost currently-rendered one (see
    // StockFan/StockPacket) - has to be measured now, before the setState below commits a state
    // with one fewer packet and unmounts (and unregisters) it, unlike the per-card destinations
    // below, which can only be measured AFTER they've mounted.
    const packetIndex = Math.ceil(state!.stock.length / TABLEAU_COLUMNS) - 1
    const origin = await ghost.cardRegistry.measure(stockPacketId(packetIndex))

    setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
    pendingDealRef.current = { dealt, origin, token: myToken }
    setState(next)
  }

  // Mirrors handlePressCard's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingAutoMoveCardIdRef effect above can only measure a DESTINATION once it's committed
  // and re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would.
  async function handleUndo() {
    if (history.length === 0 || !state) return
    const entry = history[history.length - 1]
    const { move, state: prevState } = entry

    if (!move) {
      // Undoing a stock deal (see runUndoDeal above): the 10 cards it dealt fly from their
      // current tableau spots back to the stock fan, converging on the packet this revert is
      // about to restore. Every history entry is undone in strict most-recent-first order, so at
      // the moment THIS entry is undone, nothing later has touched these columns since the deal
      // itself - state.tableau[col]'s current top card is reliably the one that deal placed
      // there, UNLESS that same deal immediately completed (and swept away) a 13-card run in that
      // column (see resolveCompletedSequence) - column lengths grow by exactly 1 per dealt card,
      // so a column that doesn't fit that shape had its card swept, and is left out entirely:
      // there's nothing left in the tableau to measure or fly back for it.
      const myToken = ++dealTokenRef.current
      const dealtColumns = state.tableau.map((col, colIndex) => ({ col, colIndex })).filter(({ col, colIndex }) => col.length === prevState.tableau[colIndex].length + 1)
      const dealtCards = dealtColumns.map(({ col }) => col[col.length - 1])
      const origins = await Promise.all(dealtCards.map((c) => ghost.cardRegistry.measure(c.id)))
      const destinationPacketIndex = Math.ceil(prevState.stock.length / TABLEAU_COLUMNS) - 1

      setHistory((h) => h.slice(0, -1))
      pendingUndoDealRef.current = {
        entries: dealtCards.map((c, i) => ({ card: c, delayMs: dealtColumns[i].colIndex * DEAL_STAGGER_MS, origin: origins[i] })),
        destinationPacketIndex,
        token: myToken
      }
      setState(prevState)
      return
    }

    const sourcePile = state.tableau[move.to.index] ?? null
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setHistory((h) => h.slice(0, -1))

    if (origin) {
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: movingCards, offsetStep, cardWidth })
      setFlying({ to: move.from, count: move.count })
      setState(prevState)
      pendingAutoMoveCardIdRef.current = move.anchorCardId
    } else {
      setState(prevState)
    }
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog). Also reachable directly from the win
  // banner's own "New Game" button below, which calls this same function - the `!won` guard is
  // required there: without it, tapping that button would fire recordDealAbandoned right alongside
  // the recordDealWon the win-check effect above already recorded for this same deal.
  function handleNewGame() {
    // session.moves, not history.length: a resumed deal always restores with an empty history
    // (see restoreGame above) even when it has real progress, so history alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('spider')
    setNumSuits(settings.spiderSuits)
    startNewGame(createSpiderController(settings.spiderSuits))
  }

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title={`Spider · ${numSuits} Suit${numSuits > 1 ? 's' : ''}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={history.length === 0} hasProgress={session.moves > 0} elapsedSeconds={session.elapsed} movesCount={session.moves} settingsContent={<SpiderSettingsSection />}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + TABLEAU_GAP * (TABLEAU_COLUMNS - 1) }]}>
          <View style={styles.completedGroup}>
            {Array.from({ length: 8 }).map((_, i) => {
              // Hidden once won - the win cascade owns these cards now (see runWinCascade), the same
              // way Pyramid's discard-top goes blank once its own chain takes over.
              const completedCard = won ? undefined : state.completed[i]
              return (
                <View
                  key={i}
                  ref={(el) => {
                    completedSlotRefs.current[i] = el
                  }}
                  collapsable={false}
                  style={{ width: cardWidth }}
                >
                  {completedCard ? <PlayingCard card={completedCard} /> : <EmptySlot />}
                </View>
              )
            })}
          </View>
          <StockFan count={state.stock.length} onPress={handleDrawStock} />
        </View>

        {message ? <Text style={styles.message}>{message}</Text> : null}

        <View style={styles.tableauRow}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              onDrop: (to, count, anchorCardId) => completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId)
            }
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.column, { width: cardWidth }]}>
                <PileView cards={col} maxHeight={420} onPressCard={(card, indexFromTop, measure) => handlePressCard(colIndex, card, indexFromTop, measure)} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} />
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
      {won ? (
        <View style={styles.winBanner}>
          <Text style={styles.winText}>
            You won! {formatTime(session.elapsed)} · {session.moves} moves · Score {computeScore(session.moves, session.elapsed)}
          </Text>
          <Pressable style={[styles.button, styles.winButton]} onPress={handleNewGame}>
            <Text style={styles.buttonText}>New Game</Text>
          </Pressable>
        </View>
      ) : null}
    </CardSizeProvider>
  )
}

/** One fanned packet in the stock (see StockFan) - registered into CardRegistry under its depth
 * index so handleDrawStock can measure exactly where it sits on screen right before dealing it
 * out, the same way a foundation/freecell slot registers itself (see FoundationCell/FreecellCell
 * in KlondikeScreen.tsx/FreeCellScreen.tsx) so a tap-to-move flight can measure its destination.
 * Wrapped in pointerEvents="none" so its own internal Pressable (PlayingCard always renders one)
 * can't intercept the tap meant for StockFan's single covering Pressable - the same pattern
 * DragGhostLayer/DealLayer use for their own non-interactive card copies. */
function StockPacket({ index, style }: { index: number; style: StyleProp<ViewStyle> }) {
  const ghost = useDragGhost()
  const viewRef = useRef<View>(null)

  useEffect(() => {
    const id = stockPacketId(index)
    ghost.cardRegistry.register(id, viewRef)
    return () => ghost.cardRegistry.unregister(id, viewRef)
  }, [index, ghost.cardRegistry])

  return (
    <View ref={viewRef} collapsable={false} pointerEvents='none' style={style}>
      <PlayingCard card={STOCK_PACKET_CARD} />
    </View>
  )
}

/** The stock, shown as up to 5 fanned face-down packets - one per remaining round of
 * TABLEAU_COLUMNS cards (see rules.ts's drawStock) - instead of a single pile with a card count on
 * it, so depleting the stock reads as packets disappearing one at a time rather than a number
 * ticking down. Anchored to the right edge and fanned leftward (toward the completed-sequence
 * slots), each packet peeking out from under the one before it - depth 0 is deepest/rendered
 * first (furthest right, bottom of the stack) and STOCK_MAX_PACKETS-1 is frontmost (furthest
 * left, on top), so the front packet is both the one a round visually deals from and the one that
 * disappears first as the stock depletes. */
function StockFan({ count, onPress }: { count: number; onPress: () => void }) {
  const { width, height } = useCardSize()
  const packets = Math.min(STOCK_MAX_PACKETS, Math.ceil(count / TABLEAU_COLUMNS))
  const fanOffset = width * STOCK_FAN_OFFSET_RATIO
  const totalWidth = width + fanOffset * (STOCK_MAX_PACKETS - 1)

  return (
    <View style={{ width: totalWidth, height }}>
      {packets === 0 ? (
        <EmptySlot onPress={onPress} />
      ) : (
        <Pressable onPress={onPress} style={{ width: totalWidth, height }}>
          {Array.from({ length: packets }).map((_, i) => {
            const packetStyle = { position: 'absolute' as const, right: i * fanOffset, top: 0 }
            return <StockPacket key={i} index={i} style={packetStyle} />
          })}
        </Pressable>
      )}
    </View>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    loadingContainer: {
      alignItems: 'center',
      backgroundColor: colors.tableFelt,
      flex: 1,
      justifyContent: 'center'
    },
    loadingText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16
    },
    // width is set inline (cardWidth * TABLEAU_COLUMNS + gaps) rather than left to stretch - on a
    // wide-enough screen, cardWidthForRow clamps cardWidth at its max, so the tableau row below
    // stops growing and ends up narrower than the full available width. Left unconstrained, this
    // row's own space-between would still spread across that full (wider) width, dragging StockFan
    // past the tableau's real right edge instead of lining up with column 10.
    topRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16
    },
    completedGroup: {
      flexDirection: 'row',
      gap: TABLEAU_GAP
    },
    button: {
      backgroundColor: '#ffffff22',
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6
    },
    buttonText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 13,
      fontWeight: '600'
    },
    message: {
      color: '#FFE082',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 12,
      marginBottom: 4,
      textAlign: 'center'
    },
    tableauRow: {
      flexDirection: 'row',
      gap: TABLEAU_GAP,
      paddingBottom: 24
    },
    column: {},
    winBanner: {
      alignItems: 'center',
      backgroundColor: '#08573Fee',
      bottom: 0,
      gap: 12,
      left: 0,
      paddingVertical: 20,
      position: 'absolute',
      right: 0
    },
    winText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 20,
      fontWeight: '800'
    },
    winButton: {
      backgroundColor: colors.hintGreen
    }
  })
}
