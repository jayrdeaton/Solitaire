import { Card } from '@/engine/types';
import { buildFreeCellDealSequence } from '@/games/freecell/dealSequence';
import { FreeCellController } from '@/games/freecell/rules';

function card(id: string): Card {
  return { id, suit: 'clubs', rank: 1, faceUp: true };
}

describe('buildFreeCellDealSequence', () => {
  it('visits a triangular shape round-robin across columns, bottom-to-top per column', () => {
    const a = card('a');
    const b = card('b');
    const c = card('c');
    const d = card('d');
    const e = card('e');
    const f = card('f');
    const tableau = [[a], [b, c], [d, e, f]];

    const steps = buildFreeCellDealSequence(tableau);

    expect(steps.map((s) => s.cardId)).toEqual(['a', 'b', 'd', 'c', 'e', 'f']);
    expect(steps.map((s) => s.visitOrder)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('produces 52 steps for a real 8-column deal, each column strictly increasing in rowIndex as visitOrder increases', () => {
    const state = FreeCellController.newGame(12345);

    const steps = buildFreeCellDealSequence(state.tableau);

    expect(steps.length).toBe(52);

    const lastRowSeenByCol = new Map<number, number>();
    steps.forEach((step) => {
      const lastRow = lastRowSeenByCol.get(step.colIndex);
      if (lastRow !== undefined) {
        expect(step.rowIndex).toBeGreaterThan(lastRow);
      }
      lastRowSeenByCol.set(step.colIndex, step.rowIndex);
    });
  });
});
