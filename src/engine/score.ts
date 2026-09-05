// Lower is better - a move and a second of play each cost one point, so a fast, efficient win
// scores low. Every caller goes through this one function, so the formula can be retuned later
// without touching stats/achievements plumbing.
export function computeScore(moves: number, elapsedSeconds: number): number {
  return moves + elapsedSeconds;
}
