import { buriedCount } from './pile'
import { Card } from './types'

/** A tableau pile under consideration as an auto-move destination. */
export interface TableauCandidate {
  index: number
  pile: Card[]
}

/**
 * Pick the best of several already-legal tableau destinations: fewest buried cards first, then
 * the largest pile, then leftmost (lowest index) to break any remaining tie. `candidates` must be
 * given in ascending index order - on an exact tie we keep whichever was found first, which is
 * how "leftmost" falls out without a separate comparison.
 */
export function pickBestTableauTarget<T extends TableauCandidate>(candidates: T[], isValidRun: (cards: Card[]) => boolean): T | null {
  let best: T | null = null
  let bestBuried = Infinity
  for (const c of candidates) {
    const buried = buriedCount(c.pile, isValidRun)
    if (best === null || buried < bestBuried || (buried === bestBuried && c.pile.length > best.pile.length)) {
      best = c
      bestBuried = buried
    }
  }
  return best
}
