// Delay between successive chains (foundation piles / completed runs / the single discard pile)
// starting their own cascade - independent of, and much coarser than, CHAIN_SEGMENT_DELAY_MS
// below. Kept small enough that all of a game's chains read as erupting together, not one pile at
// a time.
export const CHAIN_ENTRANCE_STAGGER_MS = 220

// Delay between successive cards WITHIN one chain - card i (0 = head) starts i * this many ms
// after the chain's own entranceDelayMs. Every card in a chain plays the identical fixed-period
// path, so this constant delay produces a permanent, non-drifting phase offset: the whole chain
// stays racked together nose-to-tail forever instead of spreading apart over time.
export const CHAIN_SEGMENT_DELAY_MS = 90

// The bounce path itself - randomized once per chain (see buildChainPath), then shared by every
// card in that chain via the delay above, never randomized per-card. Both apexY and floorY are
// independently randomized across nearly the full screen height (see buildChainPath), not just
// the apex - a shared floor had every chain converging on the same bottom band, which read as
// clustering rather than spreading out. BOUNCE_MIN_SPAN_PX is the shortest any one chain's own
// bounce is allowed to be, so a particularly close apex/floor draw never reads as a broken flicker.
export const BOUNCE_FLOOR_MARGIN_PX = 24
export const BOUNCE_TOP_MARGIN_PX = 24
export const BOUNCE_MIN_SPAN_PX = 220
// vHalfPeriodMs is randomized per chain too (not derived from its own span) so a short bounce
// doesn't automatically read as a frantic flicker - see buildChainPath for how this still keeps
// the motion feeling weighty regardless of how tall that particular chain's arc turned out.
export const BOUNCE_V_HALF_PERIOD_MIN_MS = 650
export const BOUNCE_V_HALF_PERIOD_MAX_MS = 950
export const BOUNCE_H_MARGIN_PX = 12
export const BOUNCE_H_HALF_PERIOD_MIN_MS = 3200
export const BOUNCE_H_HALF_PERIOD_MAX_MS = 4800
