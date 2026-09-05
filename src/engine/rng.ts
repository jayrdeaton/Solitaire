// Deterministic, seedable PRNG so a "game number" can reproduce an exact deal
// (and so game logic is unit-testable without real randomness).

export type RandomFn = () => number;

/** mulberry32 - small, fast, good-enough PRNG for shuffling. */
export function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle using an injected RNG (never mutates the input array). */
export function shuffle<T>(items: T[], rng: RandomFn): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** A fresh, non-reproducible seed for "New Game" (not for use inside tests). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
