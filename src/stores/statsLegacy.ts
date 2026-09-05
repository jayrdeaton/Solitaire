import { SolitaireGameId, VariantStats } from './statsTypes';

// The per-game keys this app wrote before stats moved into a single blob (see the original
// stores/stats.ts). Still read, once, on an install that has no new-format blob yet — see
// gameStats.tsx's createMigratingStorage.
export function legacyKeyFor(gameId: SolitaireGameId): string {
  return `solitaire.stats.v1.${gameId}`;
}

// The legacy record shape: { wins, losses, currentStreak, bestStreak, bestTimeSeconds }.
interface LegacyGameStats {
  wins: number;
  losses: number;
  currentStreak: number;
  bestStreak: number;
  bestTimeSeconds: number | null;
}

function isLegacyGameStats(value: unknown): value is LegacyGameStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<LegacyGameStats>;
  return (
    typeof v.wins === 'number' &&
    typeof v.losses === 'number' &&
    typeof v.currentStreak === 'number' &&
    typeof v.bestStreak === 'number' &&
    (v.bestTimeSeconds === null || typeof v.bestTimeSeconds === 'number')
  );
}

// Converts one legacy blob into the new per-variant shape, or null if it's missing or unreadable
// (in which case that variant simply starts empty rather than taking the whole migration down).
//
// `played` is derived as wins + losses because the legacy shape never stored it. That's exact for
// the data this app actually wrote: recordWin and recordLoss were the only two writers, and
// recordLoss was never called from anywhere, so in practice losses is 0 and played === wins.
export function toVariantStats(blob: string | null): VariantStats | null {
  if (blob === null) return null;
  try {
    const parsed: unknown = JSON.parse(blob);
    if (!isLegacyGameStats(parsed)) return null;
    return {
      record: { played: parsed.wins + parsed.losses, wins: parsed.wins, losses: parsed.losses, draws: 0 },
      streak: { currentWinStreak: parsed.currentStreak, bestWinStreak: parsed.bestStreak },
      bestTimeSeconds: parsed.bestTimeSeconds,
      bestMoves: null,
      bestScore: null,
    };
  } catch {
    return null;
  }
}
