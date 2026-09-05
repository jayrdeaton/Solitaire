import { WithSpringConfig } from 'react-native-reanimated';

/** Same critically-damped, no-overshoot feel as dragdrop/dragSpring.ts's AUTO_MOVE_SPRING
 * (dampingRatio 1 + overshootClamping), tuned shorter for a snappy "real dealer" pace across many
 * overlapping simultaneous flights. */
export const DEAL_SPRING: WithSpringConfig = { duration: 280, dampingRatio: 1, overshootClamping: true };

/** Delay between each successive card's flight start, in visit order. With DEAL_SPRING's 280ms
 * flight and 28 cards, total deal time is (28-1)*35 + 280 ≈ 1.2s, with ~8 cards in flight at any
 * instant - reads as a fast, energetic dealer rather than one-at-a-time. */
export const DEAL_STAGGER_MS = 35;
