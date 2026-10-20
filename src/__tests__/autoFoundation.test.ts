import { findSafeAutoPlay, isFullyAutoCompletable, isFullyAutoCompletableWithDraws, isSafeAutoPlay, nextAutoCompleteMove, nextAutoCompleteMoveWithDraws } from '@/engine/autoFoundation'
import { FOUNDATION_SUITS } from '@/engine/foundation'
import { AccessibleCard } from '@/engine/gameTypes'
import { Card, Suit } from '@/engine/types'
import { FreeCellController, FreeCellState } from '@/games/freecell/rules'
import { createKlondikeController, KlondikeState } from '@/games/klondike/rules'

function card(id: string, suit: Suit, rank: Card['rank'], faceUp = true): Card {
  return { id, suit, rank, faceUp }
}

/** A foundation Card[][] (FOUNDATION_SUITS order) with just a top card of the given rank per suit - 0/unset
 * means that suit's foundation pile is still empty. isSafeAutoPlay/findSafeAutoPlay only ever read
 * the top card of a foundation pile, so a single-card pile is all these tests need. */
function foundationAt(ranks: Partial<Record<Suit, Card['rank']>>): Card[][] {
  return FOUNDATION_SUITS.map((suit) => (ranks[suit] ? [card(`${suit}-top`, suit, ranks[suit]!)] : []))
}

describe('isSafeAutoPlay', () => {
  it('does not send a 5 up while the opposite color is still only at 2 (the reported scenario)', () => {
    const five = card('clubs-5-0', 'clubs', 5)
    expect(isSafeAutoPlay(foundationAt({ hearts: 2, diamonds: 2 }), five)).toBe(false)
  })

  it('flips to safe exactly when both opposite-color foundations reach rank-1', () => {
    const five = card('clubs-5-0', 'clubs', 5)
    expect(isSafeAutoPlay(foundationAt({ hearts: 4, diamonds: 3 }), five)).toBe(false) // min of the two is 3
    expect(isSafeAutoPlay(foundationAt({ hearts: 4, diamonds: 4 }), five)).toBe(true)
  })

  it('uses the minimum of the two opposite-color foundations, not the maximum', () => {
    const five = card('clubs-5-0', 'clubs', 5)
    expect(isSafeAutoPlay(foundationAt({ hearts: 6 }), five)).toBe(false) // diamonds left unset - still empty
  })

  it('an ace is always safe regardless of the opposite color', () => {
    const ace = card('clubs-1-0', 'clubs', 1)
    expect(isSafeAutoPlay(foundationAt({}), ace)).toBe(true)
  })
})

describe('findSafeAutoPlay', () => {
  it('refuses a card that is color-safe but not yet legal on its own suit', () => {
    const foundation = foundationAt({ clubs: 2, hearts: 4, diamonds: 4 }) // spades still empty
    const accessible: AccessibleCard[] = [{ ref: { zone: 'tableau', index: 0 }, card: card('clubs-5-0', 'clubs', 5) }]
    expect(findSafeAutoPlay(accessible, foundation)).toBeNull()
  })

  it('picks the first accessible entry that is both legal and safe', () => {
    const foundation = foundationAt({})
    const accessible: AccessibleCard[] = [
      { ref: { zone: 'tableau', index: 0 }, card: card('clubs-5-0', 'clubs', 5) }, // not legal - clubs needs an ace first
      { ref: { zone: 'tableau', index: 1 }, card: card('hearts-1-0', 'hearts', 1) }, // legal and safe
      { ref: { zone: 'tableau', index: 2 }, card: card('spades-1-0', 'spades', 1) } // also legal and safe, but comes second
    ]
    expect(findSafeAutoPlay(accessible, foundation)?.card.id).toBe('hearts-1-0')
  })

  it('plays an ace sitting on the waste (just drawn from stock) immediately, same as anywhere else', () => {
    const foundation = foundationAt({})
    const accessible: AccessibleCard[] = [{ ref: { zone: 'waste', index: 0 }, card: card('hearts-1-0', 'hearts', 1) }]
    expect(findSafeAutoPlay(accessible, foundation)?.card.id).toBe('hearts-1-0')
  })

  it('picks a waste ace over a later entry, same ordering as any other accessible card', () => {
    const foundation = foundationAt({})
    const accessible: AccessibleCard[] = [
      { ref: { zone: 'waste', index: 0 }, card: card('hearts-1-0', 'hearts', 1) },
      { ref: { zone: 'tableau', index: 0 }, card: card('spades-1-0', 'spades', 1) }
    ]
    expect(findSafeAutoPlay(accessible, foundation)?.card.id).toBe('hearts-1-0')
  })

  it('does not skip a non-ace card on the waste', () => {
    const foundation = foundationAt({ clubs: 4, hearts: 4, diamonds: 4 })
    const accessible: AccessibleCard[] = [{ ref: { zone: 'waste', index: 0 }, card: card('clubs-5-0', 'clubs', 5) }]
    expect(findSafeAutoPlay(accessible, foundation)?.card.id).toBe('clubs-5-0')
  })
})

describe('Klondike accessibleCards', () => {
  it('includes the waste top and every face-up tableau top, and never stock', () => {
    const controller = createKlondikeController(1)
    const state: KlondikeState = {
      tableau: [[card('clubs-2-0', 'clubs', 2)], [], [card('hearts-9-0', 'hearts', 9, false), card('spades-4-0', 'spades', 4)]],
      foundation: [[], [], [], []],
      stock: [card('diamonds-1-0', 'diamonds', 1, false)],
      waste: [card('hearts-3-0', 'hearts', 3)]
    }
    const ids = controller.accessibleCards!(state)
      .map((e) => e.card.id)
      .sort()
    expect(ids).toEqual(['clubs-2-0', 'hearts-3-0', 'spades-4-0'].sort())
  })
})

describe('FreeCell accessibleCards', () => {
  it('includes every freecell in use and every tableau top', () => {
    const state: FreeCellState = {
      tableau: [[card('clubs-2-0', 'clubs', 2)], [], [card('hearts-9-0', 'hearts', 9), card('spades-4-0', 'spades', 4)]],
      freecells: [card('diamonds-6-0', 'diamonds', 6), null, null, null],
      foundation: [[], [], [], []]
    }
    const ids = FreeCellController.accessibleCards!(state)
      .map((e) => e.card.id)
      .sort()
    expect(ids).toEqual(['clubs-2-0', 'diamonds-6-0', 'spades-4-0'].sort())
  })
})

describe('isFullyAutoCompletable / nextAutoCompleteMove (Klondike)', () => {
  const controller = createKlondikeController(1)

  function emptyState(): KlondikeState {
    return { tableau: [[], [], [], [], [], [], []], foundation: [[], [], [], []], stock: [], waste: [] }
  }

  it('an already-won board is trivially complete', () => {
    const state = emptyState()
    state.foundation = [[card('spades-13-f', 'spades', 13)], [card('diamonds-13-f', 'diamonds', 13)], [card('clubs-13-f', 'clubs', 13)], [card('hearts-13-f', 'hearts', 13)]]
    expect(isFullyAutoCompletable(controller, state)).toBe(true)
  })

  it('a stuck board (the needed lower ranks do not exist anywhere) is not completable, and terminates', () => {
    const state = emptyState()
    state.tableau[0] = [card('clubs-5-0', 'clubs', 5)] // clubs foundation is empty - needs an ace first, which doesn't exist in this fixture
    expect(isFullyAutoCompletable(controller, state)).toBe(false)
  })

  it('does not complete while the stock still holds a card, even if nothing else is left to play', () => {
    const state = emptyState()
    state.foundation = [[card('spades-12-f', 'spades', 12)], [card('diamonds-13-f', 'diamonds', 13)], [card('clubs-13-f', 'clubs', 13)], [card('hearts-13-f', 'hearts', 13)]]
    state.stock = [card('spades-13-0', 'spades', 13, false)]
    expect(isFullyAutoCompletable(controller, state)).toBe(false)
  })

  // A pile with foundations {clubs:12, diamonds:12, hearts:11, spades:13(done)} and column 0 =
  // [Q♥ (buried, face-down), K♣ (on top, face-up)]. K♣ is LEGAL right now (clubs is at 12) but not
  // SAFE (hearts, its opposite color, is still at 11 - one short of the 12 the formula needs) -
  // and hearts can never reach 12 without K♣ moving off the buried Q♥ first. Mechanism A alone
  // deadlocks on this; the full simulation (mechanism B) does not, because it doesn't care whether
  // a move is "safe", only whether it's legal.
  function deadlockState(): KlondikeState {
    return {
      tableau: [[card('hearts-12-0', 'hearts', 12, false), card('clubs-13-0', 'clubs', 13)], [card('diamonds-13-0', 'diamonds', 13)], [card('hearts-13-0', 'hearts', 13)], [], [], [], []],
      foundation: [[card('spades-13-f', 'spades', 13)], [card('diamonds-12-f', 'diamonds', 12)], [card('clubs-12-f', 'clubs', 12)], [card('hearts-11-f', 'hearts', 11)]],
      stock: [],
      waste: []
    }
  }

  it('findSafeAutoPlay alone gets permanently stuck with hearts one card short', () => {
    const state = deadlockState()
    const step1 = findSafeAutoPlay(controller.accessibleCards!(state), state.foundation)
    expect(step1?.card.id).toBe('diamonds-13-0') // the only move mechanism A considers safe right now - K♣ isn't, yet

    const afterStep1 = controller.tryMove(state, { from: step1!.ref, to: { zone: 'foundation', index: FOUNDATION_SUITS.indexOf('diamonds') }, count: 1 })!
    const step2 = findSafeAutoPlay(controller.accessibleCards!(afterStep1), afterStep1.foundation)
    expect(step2).toBeNull() // K♣ is legal but still not safe - hearts is now stuck at 11 forever under mechanism A alone
  })

  it('isFullyAutoCompletable/nextAutoCompleteMove clears the same board completely', () => {
    let cur = deadlockState()
    expect(isFullyAutoCompletable(controller, cur)).toBe(true)

    for (let i = 0; i < 4 && !controller.isWon(cur); i++) {
      const entry = nextAutoCompleteMove(controller, cur)!
      const to = { zone: 'foundation', index: FOUNDATION_SUITS.indexOf(entry.card.suit) }
      cur = controller.tryMove(cur, { from: entry.ref, to, count: 1 })!
    }
    expect(controller.isWon(cur)).toBe(true)
  })
})

describe('isFullyAutoCompletableWithDraws / nextAutoCompleteMoveWithDraws (Klondike)', () => {
  const controller = createKlondikeController(1)

  function emptyState(): KlondikeState {
    return { tableau: [[], [], [], [], [], [], []], foundation: [[], [], [], []], stock: [], waste: [] }
  }

  it('completes once the stock is drawn through, unlike the plain (non-draws) check', () => {
    const state = emptyState()
    state.foundation = [[card('spades-12-f', 'spades', 12)], [card('diamonds-13-f', 'diamonds', 13)], [card('clubs-13-f', 'clubs', 13)], [card('hearts-13-f', 'hearts', 13)]]
    state.stock = [card('spades-13-0', 'spades', 13, false)]
    expect(isFullyAutoCompletable(controller, state)).toBe(false)
    expect(isFullyAutoCompletableWithDraws(controller, state)).toBe(true)

    const step = nextAutoCompleteMoveWithDraws(controller, state)!
    expect(step).toEqual({ kind: 'drawAndPlay', entry: { ref: { zone: 'waste', index: 0 }, card: card('spades-13-0', 'spades', 13) }, to: { zone: 'foundation', index: FOUNDATION_SUITS.indexOf('spades') } })
  })

  it('keeps recycling through the waste as many passes as it takes to complete', () => {
    const state = emptyState()
    // Foundation index 3 is hearts (FOUNDATION_SUITS order: spades, diamonds, clubs, hearts) - the other 3 are
    // already done, only hearts goes through the stock.
    state.foundation = [[card('spades-13-f', 'spades', 13)], [card('diamonds-13-f', 'diamonds', 13)], [card('clubs-13-f', 'clubs', 13)], []]
    // Drawing removes from the END of this array, so draw order is 2H,3H,4H,...,KH, then AH last.
    // None of 2H..KH are playable until AH lands, and by then every one of them is buried under a
    // later draw, so a single pass can only ever play AH itself before getting stuck on KH. Only a
    // recycle re-exposes 2H (recycling reverses the order, so the very next pass draws 2H,3H,...
    // again - now playable one after another with AH already down).
    state.stock = [card('hearts-1-0', 'hearts', 1, false), ...Array.from({ length: 12 }, (_, i) => card(`hearts-${13 - i}-0`, 'hearts', (13 - i) as Card['rank'], false))]
    expect(isFullyAutoCompletableWithDraws(controller, state)).toBe(true)

    let cur = state
    let recycled = false
    for (let i = 0; i < 200 && !controller.isWon(cur); i++) {
      const step = nextAutoCompleteMoveWithDraws(controller, cur)!
      if (step.kind === 'play') cur = controller.tryMove(cur, { from: step.entry.ref, to: step.to, count: 1 })!
      else {
        if (cur.stock.length === 0 && cur.waste.length > 0) recycled = true
        const afterDraw = controller.drawStock!(cur)!
        cur = step.kind === 'drawAndPlay' ? controller.tryMove(afterDraw, { from: step.entry.ref, to: step.to, count: 1 })! : afterDraw
      }
    }
    expect(controller.isWon(cur)).toBe(true)
    expect(recycled).toBe(true) // proves this fixture genuinely exercised a recycle, not just a lucky single pass
  })

  it('returns false promptly instead of hanging when no amount of drawing/recycling ever finds a play', () => {
    const state = emptyState()
    // Hearts can never start - no ace of hearts anywhere in this fixture - so every recycle pass
    // through these cards plays nothing, forever, and the cycle guard must catch the repeat.
    state.foundation = [[card('spades-13-f', 'spades', 13)], [card('diamonds-13-f', 'diamonds', 13)], [card('clubs-13-f', 'clubs', 13)], []]
    state.stock = [card('hearts-5-0', 'hearts', 5, false), card('hearts-3-0', 'hearts', 3, false), card('hearts-2-0', 'hearts', 2, false)]
    expect(isFullyAutoCompletableWithDraws(controller, state)).toBe(false)
  })
})

describe('isFullyAutoCompletable / nextAutoCompleteMove (FreeCell)', () => {
  function emptyState(): FreeCellState {
    return { tableau: [[], [], [], [], [], [], [], []], freecells: [null, null, null, null], foundation: [[], [], [], []] }
  }

  it('an already-won board is trivially complete', () => {
    const state = emptyState()
    state.foundation = [[card('spades-13-f', 'spades', 13)], [card('diamonds-13-f', 'diamonds', 13)], [card('clubs-13-f', 'clubs', 13)], [card('hearts-13-f', 'hearts', 13)]]
    expect(isFullyAutoCompletable(FreeCellController, state)).toBe(true)
  })

  it('a stuck board (the needed lower ranks do not exist anywhere) is not completable', () => {
    const state = emptyState()
    state.tableau[0] = [card('clubs-5-0', 'clubs', 5)]
    expect(isFullyAutoCompletable(FreeCellController, state)).toBe(false)
  })

  // Same deadlock shape as Klondike's, minus the face-down mechanic (FreeCell tableau is always
  // face-up) - a buried Q♥ under a legal-but-unsafe K♣.
  function deadlockState(): FreeCellState {
    return {
      tableau: [[card('hearts-12-0', 'hearts', 12), card('clubs-13-0', 'clubs', 13)], [card('diamonds-13-0', 'diamonds', 13)], [card('hearts-13-0', 'hearts', 13)], [], [], [], [], []],
      freecells: [null, null, null, null],
      foundation: [[card('spades-13-f', 'spades', 13)], [card('diamonds-12-f', 'diamonds', 12)], [card('clubs-12-f', 'clubs', 12)], [card('hearts-11-f', 'hearts', 11)]]
    }
  }

  it('findSafeAutoPlay alone gets permanently stuck, but the full simulation clears it', () => {
    const state = deadlockState()
    const step1 = findSafeAutoPlay(FreeCellController.accessibleCards!(state), state.foundation)
    expect(step1?.card.id).toBe('diamonds-13-0')
    const afterStep1 = FreeCellController.tryMove(state, { from: step1!.ref, to: { zone: 'foundation', index: FOUNDATION_SUITS.indexOf('diamonds') }, count: 1 })!
    expect(findSafeAutoPlay(FreeCellController.accessibleCards!(afterStep1), afterStep1.foundation)).toBeNull()

    expect(isFullyAutoCompletable(FreeCellController, state)).toBe(true)
    let cur = state
    for (let i = 0; i < 4 && !FreeCellController.isWon(cur); i++) {
      const entry = nextAutoCompleteMove(FreeCellController, cur)!
      const to = { zone: 'foundation', index: FOUNDATION_SUITS.indexOf(entry.card.suit) }
      cur = FreeCellController.tryMove(cur, { from: entry.ref, to, count: 1 })!
    }
    expect(FreeCellController.isWon(cur)).toBe(true)
  })
})
