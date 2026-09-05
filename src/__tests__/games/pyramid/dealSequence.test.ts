import { Card } from '@/engine/types';
import { buildPyramidDealSequence } from '@/games/pyramid/dealSequence';
import { PyramidController } from '@/games/pyramid/rules';

function card(id: string): Card {
  return { id, suit: 'clubs', rank: 1, faceUp: true };
}

describe('buildPyramidDealSequence', () => {
  it('visits the flat pyramid array in index order, skipping removed (null) slots', () => {
    const a = card('a');
    const b = card('b');
    const c = card('c');
    const pyramid = [a, null, b, null, null, c];

    const steps = buildPyramidDealSequence(pyramid);

    expect(steps.map((s) => s.cardId)).toEqual(['a', 'b', 'c']);
    expect(steps.map((s) => s.index)).toEqual([0, 2, 5]);
    expect(steps.map((s) => s.visitOrder)).toEqual([0, 1, 2]);
  });

  it('produces 28 steps for a real deal, with visitOrder strictly increasing and equal to index', () => {
    const state = PyramidController.newGame(12345);

    const steps = buildPyramidDealSequence(state.pyramid);

    expect(steps.length).toBe(28);
    steps.forEach((step, i) => {
      expect(step.visitOrder).toBe(i);
      expect(step.index).toBe(i);
    });
  });
});
