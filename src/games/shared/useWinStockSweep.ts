import { RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'

import { DealAnimator, DealCardSpec } from '@/components/dealing/DealLayer'
import { dealStaggerMs } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { top } from '@/engine/pile'
import { Card } from '@/engine/types'

import { WIN_REVEAL_HOLD_MS, WIN_REVEAL_MAX_WAIT_MS } from './useWinReveal'

/** A pile blanks this long AFTER its last card takes off in a win sweep (the deal layer's onCardDealt): the departing ghost is
 * drawn exactly over the pile's top card at take-off, so a blank a frame late is hidden under it, while one a frame EARLY would
 * flash an empty slot. Pyramid's sweep and useWinStockSweep's. */
export const SWEEP_PILE_BLANK_LAG_MS = 20

/** How long a won game whose leftover cards are swept onto its pile may wait for its flights before the celebration starts anyway
 * (useWinReveal's maxWaitMs). Longer than useWinReveal's default because the winning move starts a whole sequence the reveal must
 * wait for: the last move's flight (its spring's real end plus ~30ms of measurement), then the sweep of up to ~24 leftover cards
 * (dealStaggerMs(24) = 35ms apart + the 280ms deal spring = ~1.1s - the deal is not re-paced by FLIGHT_TIME_SCALE), then the hold
 * (WIN_REVEAL_HOLD_MS) - ~2.2s nominal at the default pace, against the default 2.5s: too little margin for a slow phone's JS
 * stalls (a 24-card deal was measured at ~+0.8s of lag there), and cutting the sweep short with the fallback timer is exactly what
 * this is meant to avoid. Twice the nominal timeline. Only a flight that never lands waits this long. */
export const SWEEP_WIN_REVEAL_MAX_WAIT_MS = 2 * (springSettleMs(FLIGHT_SPRING) + 30 + 1100 + WIN_REVEAL_HOLD_MS)

/** The stock's cards in the order a sweep deals them onto the waste - top first, as a draw takes them - each turned face up (a
 * draw turns its card over the same way, see Golf's/TriPeaks' drawStock). */
export function sweptStockCards(stock: Card[]): Card[] {
  return stock
    .slice()
    .reverse()
    .map((card) => (card.faceUp ? card : { ...card, faceUp: true }))
}

/** The waste a won board ends up with once its leftover stock has been swept onto it: every card, bottom to top. What the win
 * cascade's one chain carries (reversed, so the card on top leads). */
export function sweptWaste(state: { stock: Card[]; waste: Card[] }): Card[] {
  return state.stock.length === 0 ? state.waste : [...state.waste, ...sweptStockCards(state.stock)]
}

export interface WinStockSweep {
  /** From the winning commit until the leftover stock has been dealt onto the waste: holds the screen's `settled` (and so its win
   * reveal) back. Derived in render, so `settled` never blips true between the last move landing and the sweep starting. */
  active: boolean
  /** The stock's top card as the board shows it: the real one until the sweep's last card has taken off, then none. */
  stockTopCard: Card | undefined
  /** The waste as the board shows it: the real waste plus every swept card that has landed on it. */
  waste: Card[]
  /** The win reveal's fallback wait (useWinReveal's maxWaitMs): SWEEP_WIN_REVEAL_MAX_WAIT_MS for a win that has a sweep to wait
   * for, the default otherwise - a win with nothing left in the stock only has its last card's flight to wait out. */
  revealMaxWaitMs: number
  /** Ends a sweep still running - an undo, a New Game or restore, the reveal's fallback timer starting the cascade first: its
   * ghosts go (an empty deal), and the board shows the finished piles. A no-op when nothing is sweeping. */
  cancel(): void
}

interface SweepProgress<S> {
  state: S
  /** How many swept cards have landed (they land in take-off order: one stagger apart, one spring each). */
  landed: number
  stockGone: boolean
  done: boolean
}

interface SweepRun<S> {
  state: S
  finished: boolean
  dealing: boolean
}

const NO_CARDS: Card[] = []

/**
 * Golf's and TriPeaks' win: the tableau is cleared while cards are still in the stock, and the win cascade carries the waste.
 * Those leftover stock cards used to stay behind (Jay, 2026-10-17: "I'd like the remainder cards to be added to the stack before
 * doing the win animation"), so now they are DEALT onto the waste first, the way Pyramid sweeps its stock and waste onto its
 * discard: one after another, top card first, with the initial deal's stagger, spring, sound and skip-tap (the deal layer), each
 * face up from take-off (the deal layer cannot turn a card over in flight, and a draw flies face up too). Only when the last has
 * landed does the celebration start, so the cascade takes off with every card in one pile.
 *
 * The rules are untouched: the won state still has its stock, and this hook only changes what the board SHOWS (the stock until
 * its last card takes off, the waste with every card that has landed) and what the cascade carries (sweptWaste). Starts once
 * nothing else is in the air (`othersSettled`: the winning card has landed), keyed to the won state's identity, so an undo or a
 * New Game simply leaves it behind - each also calls `cancel` to take its ghosts out of the air.
 */
export function useWinStockSweep<S extends { stock: Card[]; waste: Card[] }>({ state, won, othersSettled, deal, cardWidth, stockViewRef, wasteViewRef }: { state: S | null; won: boolean; othersSettled: boolean; deal: DealAnimator; cardWidth: number; stockViewRef: RefObject<View | null>; wasteViewRef: RefObject<View | null> }): WinStockSweep {
  const [progress, setProgress] = useState<SweepProgress<S> | null>(null)
  const runRef = useRef<SweepRun<S> | null>(null)
  // Pending stock-blanking timers - cleared when a run ends early and on unmount.
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>())

  const needed = !!state && won && state.stock.length > 0
  const mine = needed && progress && progress.state === state ? progress : null
  const done = !!mine?.done
  const swept = useMemo(() => (state && needed ? sweptStockCards(state.stock) : NO_CARDS), [state, needed])
  const landed = done ? swept.length : (mine?.landed ?? 0)
  const shownWaste = useMemo(() => (state ? (landed > 0 ? [...state.waste, ...swept.slice(0, landed)] : state.waste) : NO_CARDS), [state, swept, landed])

  function update(run: SweepRun<S>, patch: (p: SweepProgress<S>) => SweepProgress<S>) {
    setProgress((p) => patch(p && p.state === run.state ? p : { state: run.state, landed: 0, stockGone: false, done: false }))
  }

  function finish(run: SweepRun<S>) {
    if (runRef.current !== run || run.finished) return
    run.finished = true
    timersRef.current.forEach(clearTimeout)
    timersRef.current.clear()
    update(run, (p) => ({ ...p, stockGone: true, done: true }))
  }

  async function sweep(run: SweepRun<S>) {
    const [stockPos, wastePos] = await Promise.all([measureView(stockViewRef.current), measureView(wasteViewRef.current)])
    if (runRef.current !== run || run.finished) return
    const cards = sweptStockCards(run.state.stock)
    // Nothing to fly from or to: the cards simply land (the board shows the finished piles) rather than holding the win back.
    if (!stockPos || !wastePos) {
      finish(run)
      return
    }
    const stagger = dealStaggerMs(cards.length)
    const entries: DealCardSpec[] = cards.map((card, i) => ({ cardId: card.id, card, from: stockPos, to: wastePos, delayMs: i * stagger }))
    const lastId = cards[cards.length - 1].id
    run.dealing = true
    deal.start(
      entries,
      cardWidth,
      () => {
        if (runRef.current === run && !run.finished) update(run, (p) => ({ ...p, landed: p.landed + 1 }))
      },
      () => finish(run),
      // The stock shows backs only, all alike, so it changes once: empty, a beat after its last card has taken off (the deal
      // layer's own signal - a timer armed from the scheduled delays would run ahead of the ghost, see Pyramid's sweep).
      (cardId) => {
        if (cardId !== lastId || runRef.current !== run || run.finished) return
        const timer = setTimeout(() => {
          timersRef.current.delete(timer)
          if (runRef.current === run && !run.finished) update(run, (p) => ({ ...p, stockGone: true }))
        }, SWEEP_PILE_BLANK_LAG_MS)
        timersRef.current.add(timer)
      }
    )
  }

  useEffect(() => {
    if (!state || !needed || done || !othersSettled || runRef.current?.state === state) return
    const run: SweepRun<S> = { state, finished: false, dealing: false }
    runRef.current = run
    void sweep(run)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, needed, done, othersSettled])

  useEffect(() => {
    const timers = timersRef.current
    return () => timers.forEach(clearTimeout)
  }, [])

  function cancel() {
    const run = runRef.current
    if (!run || run.finished) return
    if (run.dealing)
      deal.start(
        [],
        cardWidth,
        () => {},
        () => {}
      )
    finish(run)
  }

  const stockGone = needed && (done || !!mine?.stockGone)
  return {
    active: needed && !done,
    stockTopCard: state && !stockGone ? top(state.stock) : undefined,
    waste: shownWaste,
    revealMaxWaitMs: needed ? SWEEP_WIN_REVEAL_MAX_WAIT_MS : WIN_REVEAL_MAX_WAIT_MS,
    cancel
  }
}
