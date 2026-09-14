// Delay between successive chains (foundation piles / completed runs / the single discard pile)
// starting their own cascade - independent of, and much coarser than, CHAIN_SEGMENT_DELAY_MS
// below. Kept small enough that all of a game's chains read as erupting together, not one pile at
// a time.
export const CHAIN_ENTRANCE_STAGGER_MS = 220

// Delay between successive cards WITHIN one chain - card i (0 = head) starts i * this many ms
// after the chain's own entranceDelayMs. Every card in a chain plays the identical fixed-period
// path, so this constant delay produces a permanent, non-drifting phase offset: the whole chain
// stays racked together nose-to-tail forever instead of spreading apart over time.
//
// A 13-card chain's total span is 12 * this value - that MUST stay comfortably under
// BOUNCE_V_HALF_PERIOD_MIN_MS below, or the tail card starts its own fall/rise more than half a
// bounce cycle behind its King. Once the lag exceeds half a cycle, the tail isn't just "behind" -
// it can land in the OPPOSITE leg (rising while the King is falling, or vice versa), which reads
// as the chain splitting apart rather than one snake trailing its head. At 42ms, a 13-card span
// (504ms) still stays safely under half the shortest half-period's full range (900ms).
export const CHAIN_SEGMENT_DELAY_MS = 42

// The bounce path itself - assigned once per chain (see buildChainPath/computeCascadeVerticals),
// then shared by every card in that chain via the delay above, never randomized per-card, and
// fixed for the whole cascade (no drift). apexY is RANKED by each chain's own horizontal speed
// against the other chains in this cascade (see computeCascadeVerticals) rather than its own
// independent random draw - the floor is always the screen's actual bottom, shared by every
// chain. BOUNCE_MIN_SPAN_PX is the shortest any one chain's own bounce is allowed to be, so even
// the fastest/highest-bouncing chain never reads as a broken flicker against the floor.
export const BOUNCE_FLOOR_MARGIN_PX = 24
export const BOUNCE_TOP_MARGIN_PX = 24
export const BOUNCE_MIN_SPAN_PX = 220
// vHalfPeriodMs is randomized per chain too (not derived from its own span) so a short bounce
// doesn't automatically read as a frantic flicker - see buildChainPath for how this still keeps
// the motion feeling weighty regardless of how tall that particular chain's arc turned out.
export const BOUNCE_V_HALF_PERIOD_MIN_MS = 900
export const BOUNCE_V_HALF_PERIOD_MAX_MS = 1330
export const BOUNCE_H_MARGIN_PX = 12
// Deliberately a much wider spread than the vertical half-period above (nearly 4x, min to max,
// vs. vertical's ~1.5x) - since every chain now shares the same floor and alternates its starting
// wall by index (see buildChainPath), a wide horizontal speed range is what keeps chains reading as
// visually distinct from each other over time, rather than a uniform mass that only ever splits
// into two lockstep groups (one per starting wall).
export const BOUNCE_H_HALF_PERIOD_MIN_MS = 2500
export const BOUNCE_H_HALF_PERIOD_MAX_MS = 9500

// How far down the available apex range (from BOUNCE_TOP_MARGIN_PX at the top down to the
// screen's true lowest-allowed apex) the SLOWEST chain in a cascade bounces, by rank - see
// computeCascadeVerticals in WinCascadeLayer. 0 would put it at the very top alongside the
// fastest chain (no visible height difference at all); 1 would put it at the absolute lowest
// bounce the screen allows (uncomfortably close to the floor, reading as a weak, stunted hop
// rather than a deliberate "conservative" bounce). 0.75 still keeps it a real, deliberate bounce
// rather than the absolute minimum, while reading noticeably lower/calmer than the fastest chain's.
export const BOUNCE_APEX_CONSERVATIVE_FRACTION = 0.75
