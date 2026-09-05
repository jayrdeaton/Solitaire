import { legacyKeyFor, toVariantStats } from '@/stores/statsLegacy';

describe('legacyKeyFor', () => {
  it('reproduces the exact keys the old stores/stats.ts wrote', () => {
    expect(legacyKeyFor('klondike')).toBe('solitaire.stats.v1.klondike');
    expect(legacyKeyFor('freecell')).toBe('solitaire.stats.v1.freecell');
  });
});

describe('toVariantStats', () => {
  const legacy = JSON.stringify({ wins: 7, losses: 2, currentStreak: 3, bestStreak: 5, bestTimeSeconds: 240 });

  it('carries every legacy field across', () => {
    expect(toVariantStats(legacy)).toEqual({
      record: { played: 9, wins: 7, losses: 2, draws: 0 },
      streak: { currentWinStreak: 3, bestWinStreak: 5 },
      bestTimeSeconds: 240,
      bestMoves: null,
      bestScore: null,
    });
  });

  it('derives played as wins + losses, the only information the legacy shape had', () => {
    const blob = JSON.stringify({ wins: 4, losses: 0, currentStreak: 4, bestStreak: 4, bestTimeSeconds: null });
    expect(toVariantStats(blob)?.record).toEqual({ played: 4, wins: 4, losses: 0, draws: 0 });
  });

  it('preserves a null best time rather than coercing it to 0', () => {
    const blob = JSON.stringify({ wins: 0, losses: 3, currentStreak: 0, bestStreak: 0, bestTimeSeconds: null });
    expect(toVariantStats(blob)?.bestTimeSeconds).toBeNull();
  });

  it('returns null for absent, corrupt or foreign-shaped blobs rather than throwing', () => {
    expect(toVariantStats(null)).toBeNull();
    expect(toVariantStats('not json')).toBeNull();
    expect(toVariantStats(JSON.stringify({ wins: 'lots' }))).toBeNull();
    expect(toVariantStats(JSON.stringify([1, 2, 3]))).toBeNull();
  });
});
