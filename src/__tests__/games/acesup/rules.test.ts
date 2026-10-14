import { findHint } from '@/engine/hint'
import { Card } from '@/engine/types'
import { AcesUpController, AcesUpState } from '@/games/acesup/rules'

function countCards(state: AcesUpState): number {
  return state.piles.reduce((sum, p) => sum + p.length, 0) + state.stock.length + state.discard.length
}

describe('Aces Up newGame', () => {
  it('deals one card face up onto each of 4 piles, the rest as stock', () => {
    const state = AcesUpController.newGame(12345)

    expect(countCards(state)).toBe(52)
    expect(state.piles.length).toBe(4)
    state.piles.forEach((p) => {
      expect(p.length).toBe(1)
      expect(p[0].faceUp).toBe(true)
    })
    expect(state.stock.length).toBe(48)
    state.stock.forEach((c) => expect(c.faceUp).toBe(false))
    expect(state.discard).toEqual([])
  })

  it('is deterministic given the same seed', () => {
    const a = AcesUpController.newGame(42)
    const b = AcesUpController.newGame(42)
    expect(a.piles.map((p) => p.map((c) => c.id))).toEqual(b.piles.map((p) => p.map((c) => c.id)))
  })
})

describe('Aces Up discard (tryMove to discard)', () => {
  it('discards a card when another pile shows the same suit at a higher rank', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [clubs9], [], []], stock: [], discard: [] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'discard', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.piles[0]).toEqual([])
    expect(result!.discard.map((c) => c.id)).toEqual(['clubs-5-0'])
  })

  it('rejects a discard when the higher card is a different suit', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const hearts9: Card = { id: 'hearts-9-0', suit: 'hearts', rank: 9, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [hearts9], [], []], stock: [], discard: [] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'discard', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('rejects a discard when no other pile is higher', () => {
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const state: AcesUpState = { piles: [[clubs9], [clubs5], [], []], stock: [], discard: [] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'discard', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('Aces rank highest and can never be discarded', () => {
    const clubsAce: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const clubsKing: Card = { id: 'clubs-13-0', suit: 'clubs', rank: 13, faceUp: true }
    const state: AcesUpState = { piles: [[clubsAce], [clubsKing], [], []], stock: [], discard: [] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'discard', index: 0 }, count: 1 })
    expect(result).toBeNull()
  })

  it('a King can be discarded onto a same-suit Ace (Ace outranks King)', () => {
    const clubsAce: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const clubsKing: Card = { id: 'clubs-13-0', suit: 'clubs', rank: 13, faceUp: true }
    const state: AcesUpState = { piles: [[clubsKing], [clubsAce], [], []], stock: [], discard: [] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'discard', index: 0 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.piles[0]).toEqual([])
    expect(result!.discard.map((c) => c.id)).toEqual(['clubs-13-0'])
  })

  it('appends onto whatever was already discarded, oldest first', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const hearts2: Card = { id: 'hearts-2-0', suit: 'hearts', rank: 2, faceUp: true }
    const priorDiscard: Card = { id: 'diamonds-3-0', suit: 'diamonds', rank: 3, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [clubs9], [hearts2], []], stock: [], discard: [priorDiscard] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'discard', index: 0 }, count: 1 })
    expect(result!.discard.map((c) => c.id)).toEqual(['diamonds-3-0', 'clubs-5-0'])
  })
})

describe('Aces Up move to empty pile', () => {
  it('moves a pile top card onto a genuinely empty pile', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [], [], []], stock: [], discard: [] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 })
    expect(result).not.toBeNull()
    expect(result!.piles[0]).toEqual([])
    expect(result!.piles[1].map((c) => c.id)).toEqual(['clubs-5-0'])
  })

  it('rejects moving onto a non-empty pile', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const hearts2: Card = { id: 'hearts-2-0', suit: 'hearts', rank: 2, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [hearts2], [], []], stock: [], discard: [] }
    const result = AcesUpController.tryMove(state, { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 })
    expect(result).toBeNull()
  })
})

describe('Aces Up drawStock', () => {
  it('deals one card onto each of the 4 piles, including any that are empty', () => {
    const stock: Card[] = [1, 2, 3, 4].map((r) => ({ id: `clubs-${r}-0`, suit: 'clubs', rank: r as Card['rank'], faceUp: false }))
    const state: AcesUpState = { piles: [[], [], [], []], stock, discard: [] }
    const result = AcesUpController.drawStock!(state)
    expect(result).not.toBeNull()
    expect(result!.stock.length).toBe(0)
    expect(result!.piles.map((p) => p[0].id)).toEqual(['clubs-1-0', 'clubs-2-0', 'clubs-3-0', 'clubs-4-0'])
    result!.piles.forEach((p) => expect(p[0].faceUp).toBe(true))
  })

  it('returns null once the stock is empty', () => {
    const state: AcesUpState = { piles: [[], [], [], []], stock: [], discard: [] }
    expect(AcesUpController.drawStock!(state)).toBeNull()
  })
})

describe('Aces Up isWon', () => {
  it('is won once the stock is empty and every pile holds exactly one Ace', () => {
    const aces: Card[][] = ['clubs', 'diamonds', 'hearts', 'spades'].map((s) => [{ id: `${s}-1-0`, suit: s as Card['suit'], rank: 1, faceUp: true }])
    const state: AcesUpState = { piles: aces, stock: [], discard: [] }
    expect(AcesUpController.isWon(state)).toBe(true)
  })

  it('is not won while the stock still has cards, even with 4 aces showing', () => {
    const aces: Card[][] = ['clubs', 'diamonds', 'hearts', 'spades'].map((s) => [{ id: `${s}-1-0`, suit: s as Card['suit'], rank: 1, faceUp: true }])
    const state: AcesUpState = { piles: aces, stock: [{ id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: false }], discard: [] }
    expect(AcesUpController.isWon(state)).toBe(false)
  })

  it('is not won if any pile holds more than just its Ace', () => {
    const ace: Card = { id: 'clubs-1-0', suit: 'clubs', rank: 1, faceUp: true }
    const two: Card = { id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: true }
    const state: AcesUpState = { piles: [[two, ace], [], [], []], stock: [], discard: [] }
    expect(AcesUpController.isWon(state)).toBe(false)
  })
})

describe('Aces Up isStuck', () => {
  it('is stuck when the stock is empty, not won, and no discard/move remains', () => {
    // Two piles, same suit but the SAME rank as each other's not possible for one deck of a suit
    // to duplicate - use a genuinely deadlocked shape: two different suits, one card each, no
    // empty pile, nothing dischargeable across suits.
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const diamonds5: Card = { id: 'diamonds-5-0', suit: 'diamonds', rank: 5, faceUp: true }
    const spades5: Card = { id: 'spades-5-0', suit: 'spades', rank: 5, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [hearts5], [diamonds5], [spades5]], stock: [], discard: [] }
    expect(AcesUpController.isStuck!(state)).toBe(true)
  })

  it('is not stuck while a discard is still available', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [clubs9], [], []], stock: [], discard: [] }
    expect(AcesUpController.isStuck!(state)).toBe(false)
  })

  it('is not stuck while the stock still has cards, even with no discard/move available', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const diamonds5: Card = { id: 'diamonds-5-0', suit: 'diamonds', rank: 5, faceUp: true }
    const spades5: Card = { id: 'spades-5-0', suit: 'spades', rank: 5, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [hearts5], [diamonds5], [spades5]], stock: [{ id: 'clubs-2-0', suit: 'clubs', rank: 2, faceUp: false }], discard: [] }
    expect(AcesUpController.isStuck!(state)).toBe(false)
  })

  it('is not stuck once won', () => {
    const aces: Card[][] = ['clubs', 'diamonds', 'hearts', 'spades'].map((s) => [{ id: `${s}-1-0`, suit: s as Card['suit'], rank: 1, faceUp: true }])
    const state: AcesUpState = { piles: aces, stock: [], discard: [] }
    expect(AcesUpController.isStuck!(state)).toBe(false)
  })
})

describe('Aces Up autoMoveHint', () => {
  it('prioritizes discarding over moving to an empty pile', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const clubs9: Card = { id: 'clubs-9-0', suit: 'clubs', rank: 9, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [clubs9], [], []], stock: [], discard: [] }
    const move = AcesUpController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'clubs-5-0')
    expect(move).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'discard', index: 0 }, count: 1 })
  })

  it('falls back to moving onto an empty pile when no discard is available', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [], [], []], stock: [], discard: [] }
    const move = AcesUpController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'clubs-5-0')
    expect(move).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 })
  })

  it('returns null when nowhere legal to go', () => {
    const clubs5: Card = { id: 'clubs-5-0', suit: 'clubs', rank: 5, faceUp: true }
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const diamonds5: Card = { id: 'diamonds-5-0', suit: 'diamonds', rank: 5, faceUp: true }
    const spades5: Card = { id: 'spades-5-0', suit: 'spades', rank: 5, faceUp: true }
    const state: AcesUpState = { piles: [[clubs5], [hearts5], [diamonds5], [spades5]], stock: [], discard: [] }
    const move = AcesUpController.autoMoveHint!(state, { zone: 'tableau', index: 0 }, 'clubs-5-0')
    expect(move).toBeNull()
  })
})

// Regression coverage for the Hint/tap-to-move destination-mismatch investigation: unlike the
// run-consolidation games, Aces Up never needed a scoreHintMove (see rules.ts's own doc comments
// on legalMoves/canonicalMoveFor) - the real bug here was legalMoves enumerating MULTIPLE distinct
// "moves" for the very same pile's own top card (one discard entry plus one move-to-empty entry
// per empty pile), which findHint's own skip-cycling (engine/hint.ts) could surface even though
// tapping that card can only ever perform ONE of them (autoMoveHint's own canonical pick). These
// tests pin legalMoves down to exactly one entry per pile, and confirm every entry findHint could
// ever ranked-cycle to for a given card agrees with what tapping that same card actually does.
describe('Aces Up legalMoves / Hint agreement with autoMoveHint', () => {
  it('legalMoves only ever lists ONE move for a pile that qualifies for both a discard and a move to an empty pile', () => {
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const hearts8: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const diamonds3: Card = { id: 'diamonds-3-0', suit: 'diamonds', rank: 3, faceUp: true }
    // Pile 0's 5H both discards (beaten by pile 1's 8H, same suit) AND could move onto the empty
    // pile 2 - before the canonicalMoveFor fix, legalMoves listed BOTH as separate moves.
    const state: AcesUpState = { piles: [[hearts5], [hearts8], [], [diamonds3]], stock: [], discard: [] }

    const moves = AcesUpController.legalMoves(state)
    const pile0Moves = moves.filter((m) => m.from.zone === 'tableau' && m.from.index === 0)
    expect(pile0Moves).toHaveLength(1)
    expect(pile0Moves[0].to.zone).toBe('discard')
    // 4 piles total, but only 3 ever have anywhere legal to go (pile 2 starts empty, so it has no
    // top card of its own to move) - one canonical move each, never a fan-out per empty pile.
    expect(moves).toHaveLength(3)
  })

  it('legalMoves only ever lists the FIRST empty pile as a destination, never every empty pile', () => {
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const diamonds8: Card = { id: 'diamonds-8-0', suit: 'diamonds', rank: 8, faceUp: true }
    // Two empty piles (1 and 2) - before the fix, pile 0's card (nowhere to discard) generated a
    // separate move entry for EACH empty pile, even though only the first (ascending) is reachable
    // by actually tapping the card.
    const state: AcesUpState = { piles: [[hearts5], [], [], [diamonds8]], stock: [], discard: [] }

    const moves = AcesUpController.legalMoves(state)
    const pile0Moves = moves.filter((m) => m.from.zone === 'tableau' && m.from.index === 0)
    expect(pile0Moves).toHaveLength(1)
    expect(pile0Moves[0]).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 })
  })

  it('every move Hint can ever cycle to for a card matches what tapping that exact card would do', () => {
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const hearts8: Card = { id: 'hearts-8-0', suit: 'hearts', rank: 8, faceUp: true }
    const diamonds3: Card = { id: 'diamonds-3-0', suit: 'diamonds', rank: 3, faceUp: true }
    const state: AcesUpState = { piles: [[hearts5], [hearts8], [], [diamonds3]], stock: [], discard: [] }
    const moveCount = AcesUpController.legalMoves(state).length

    for (let skip = 0; skip < moveCount; skip++) {
      const hint = findHint(AcesUpController, state, skip)
      expect(hint.kind).toBe('move')
      if (hint.kind !== 'move') continue
      const { from, to } = hint.move
      expect(from.zone).toBe('tableau')
      if (from.zone !== 'tableau') continue
      const card = state.piles[from.index][state.piles[from.index].length - 1]
      const tapped = AcesUpController.autoMoveHint!(state, from, card.id)
      // Whatever Hint highlighted for this card, actually tapping that same card must produce the
      // exact same move - the historical bug was Hint showing a move-to-empty for a card that
      // would really discard (or vice versa across empty piles) when tapped.
      expect(tapped).toEqual({ from, to, count: 1 })
    }
  })

  it("prefers ANY pile's available discard over a different pile's move-to-empty on the first hint, with no scoring needed", () => {
    // Pile 0 (hearts-5) can only ever move to the empty pile 2 - no other heart is showing.
    // Pile 1 (diamonds-4) can discard instead - pile 3's diamonds-9 beats it, same suit.
    const hearts5: Card = { id: 'hearts-5-0', suit: 'hearts', rank: 5, faceUp: true }
    const diamonds4: Card = { id: 'diamonds-4-0', suit: 'diamonds', rank: 4, faceUp: true }
    const diamonds9: Card = { id: 'diamonds-9-0', suit: 'diamonds', rank: 9, faceUp: true }
    const state: AcesUpState = { piles: [[hearts5], [diamonds4], [], [diamonds9]], stock: [], discard: [] }

    const hint = findHint(AcesUpController, state, 0)
    expect(hint).toEqual({ kind: 'move', move: { from: { zone: 'tableau', index: 1 }, to: { zone: 'discard', index: 0 }, count: 1 } })
  })

  // Hint used to offer moving a pile's only card into the empty pile, then moving it straight back,
  // for as long as the player kept pressing: it was the first legal move both ways, and Aces Up had no
  // scorer to tell findHint it gains nothing.
  it("scores moving a pile's only card to an empty pile, and its reverse, at 0, so Hint deals instead of ping-ponging", () => {
    const c = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true })
    const state: AcesUpState = {
      piles: [[c('clubs', 5)], [], [c('hearts', 7)], [c('diamonds', 9)]],
      stock: [c('spades', 2), c('spades', 3), c('spades', 4), c('spades', 6)].map((card) => ({ ...card, faceUp: false })),
      discard: []
    }
    const there = AcesUpController.legalMoves(state)[0]
    expect(there).toEqual({ from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 })
    expect(AcesUpController.scoreHintMove!(state, there)).toBe(0)

    const back = AcesUpController.tryMove(state, there)!
    const reverse = AcesUpController.autoMoveHint!(back, { zone: 'tableau', index: 1 }, 'clubs-5-0')
    expect(reverse).toEqual({ from: { zone: 'tableau', index: 1 }, to: { zone: 'tableau', index: 0 }, count: 1 })
    expect(AcesUpController.scoreHintMove!(back, reverse!)).toBe(0)

    expect(findHint(AcesUpController, state)).toEqual({ kind: 'drawStock' })
    expect(findHint(AcesUpController, back)).toEqual({ kind: 'drawStock' })
  })

  it('still suggests a move to an empty pile that exposes a buried card, over dealing', () => {
    const c = (suit: Card['suit'], rank: Card['rank']): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true })
    const state: AcesUpState = {
      piles: [[c('clubs', 5), c('clubs', 8)], [], [c('hearts', 7)], [c('diamonds', 9)]],
      stock: [c('spades', 2), c('spades', 3), c('spades', 4), c('spades', 6)].map((card) => ({ ...card, faceUp: false })),
      discard: []
    }
    const expose = { from: { zone: 'tableau', index: 0 }, to: { zone: 'tableau', index: 1 }, count: 1 }
    expect(AcesUpController.scoreHintMove!(state, expose)).toBeGreaterThan(0)
    expect(findHint(AcesUpController, state)).toEqual({ kind: 'move', move: expose })
  })
})
