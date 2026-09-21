import type { WithSpringConfig } from 'react-native-reanimated'

import { DEAL_SPRING } from '@/components/dealing/dealSpring'
import { AUTO_MOVE_SPRING, autoMoveSpringFor, autoPlaySpringFor, FLIGHT_SPRING_MASS, FLIGHT_TIME_SCALE, scaledMs, SNAP_BACK_SPRING, SPRING_SETTLE_FACTOR, SPRING_START_LAG_MS, springSettleMs, winSweepSpringFor } from '@/components/dragdrop/dragSpring'

// ---------------------------------------------------------------------------------------------------------------------
// What a flight's timing constants MUST satisfy, measured against Reanimated's OWN spring code (its real `withSpring`, driven
// frame by frame at 60Hz with fake timestamps - not a re-derivation of its maths):
//   1. every flight config really takes 1.5 x its `duration` to end. It did not for the short ones: the library's duration solver
//      caps stiffness, and with the default mass every duration under ~184ms silently ran as one ~283ms spring (FLIGHT_SPRING_MASS
//      lifts that cap);
//   2. the ghost is retired at springSettleMs() - the spring's real end minus a tail that is under a pixel - not at the bare
//      `duration`, which retired it with up to 137px still to go (and failed for every short flight the moment the UI thread
//      started its spring a frame or two after the JS timer that covers it).
// The real spring code needs the worklets runtime's serialization helpers, which the repo-wide mock does not provide.
// ---------------------------------------------------------------------------------------------------------------------

jest.mock('react-native-worklets', () => ({
  createSerializable: (value: unknown) => value,
  isWorkletFunction: () => false,
  RuntimeKind: { ReactNative: 1, UI: 2, Worker: 3 },
  scheduleOnUI: (fn: () => void) => fn(),
  serializableMappingCache: new Map()
}))

interface SpringAnimation {
  current: number
  onStart(animation: SpringAnimation, value: number, now: number, previous: undefined): void
  onFrame(animation: SpringAnimation, now: number): boolean
}
const { withSpring } = jest.requireActual('react-native-reanimated/src/animation/spring/spring') as { withSpring: (toValue: number, config: WithSpringConfig) => unknown }

const FRAME_MS = 1000 / 60
/** The UI thread receives the withSpring assignment up to one frame after the JS timer that covers it starts, and then starts the spring on its NEXT frame - so the
 * spring can start up to two 60Hz frames (~33ms - SPRING_START_LAG_MS) after the timer. */
const UI_HOP_MS = FRAME_MS
const UI_START_LAG_MS = 33
const DISTANCES = [60, 100, 200, 360, 600, 900] // px - a card hop to a full corner-to-corner flight on a tall phone / iPad

/** Pixels still to travel at `atMs` after the JS timer started: the UI thread receives the assignment `hopMs` later, starts the spring on its next frame (frames
 * fall on a grid `phaseMs` past the timer's start) and what is DRAWN at `atMs` is the last frame at or before it. */
function remainingAt(config: WithSpringConfig, distance: number, atMs: number, hopMs: number, phaseMs: number): number {
  const animation = withSpring(0, config) as SpringAnimation
  let frame = phaseMs
  while (frame < hopMs) frame += FRAME_MS
  animation.onStart(animation, distance, frame, undefined)
  let remaining = distance
  for (frame += FRAME_MS; frame <= atMs; frame += FRAME_MS) {
    if (animation.onFrame(animation, frame)) return 0
    remaining = Math.abs(animation.current)
  }
  return remaining
}
/** The worst of remainingAt over every frame-grid phase, for a UI thread that receives the assignment anywhere from at once up to `maxHopMs` late (so the spring starts up to
 * `maxHopMs` plus one frame after the timer). */
function worstRemaining(config: WithSpringConfig, distance: number, atMs: number, maxHopMs: number): number {
  let worst = 0
  for (const hopMs of maxHopMs > 0 ? [0, maxHopMs] : [0]) for (let step = 0; step < 16; step++) worst = Math.max(worst, remainingAt(config, distance, atMs, hopMs, (FRAME_MS * step) / 16))
  return worst
}
/** When the spring really ends (snaps to its target), ms after the UI thread started it. */
function realEndMs(config: WithSpringConfig, distance: number): number {
  const animation = withSpring(0, config) as SpringAnimation
  animation.onStart(animation, distance, 0, undefined)
  for (let frame = FRAME_MS; frame < 5000; frame += FRAME_MS) if (animation.onFrame(animation, frame)) return frame
  return Infinity
}

/** Every flight config a play can start, at every distance the table covers: [name, config]. */
const FLIGHTS: [string, WithSpringConfig][] = DISTANCES.flatMap((distance) => [
  [`autoMove @${distance}px`, autoMoveSpringFor(distance)],
  [`autoPlay @${distance}px`, autoPlaySpringFor(distance)],
  [`sweep @${distance}px`, winSweepSpringFor(distance)],
  [`snapBack @${distance}px`, SNAP_BACK_SPRING]
]) as [string, WithSpringConfig][]
const DISTANCE_OF = (name: string) => Number(name.match(/@(\d+)px/)![1])

describe('the flight pace knob', () => {
  it('scaledMs multiplies a scale-1 pacing constant by FLIGHT_TIME_SCALE (rounded to a whole ms)', () => {
    expect(scaledMs(100)).toBe(Math.round(100 * FLIGHT_TIME_SCALE))
    expect(scaledMs(0)).toBe(0)
    expect(scaledMs(60)).toBe(Math.round(60 * FLIGHT_TIME_SCALE))
  })

  it('re-paces every play tier from its scale-1 range, keeping the distance-scaled shape and the clamps', () => {
    const tiers: [string, (distance: number) => WithSpringConfig, number, number][] = [
      ['autoMove', autoMoveSpringFor, 130, 320],
      ['autoPlay', autoPlaySpringFor, 75, 170],
      ['sweep', winSweepSpringFor, 40, 90]
    ]
    for (const [name, springFor, min, max] of tiers) {
      expect([name, springFor(0).duration]).toEqual([name, scaledMs(min)]) // nearer than the clamp: the shortest
      expect([name, springFor(60).duration]).toEqual([name, scaledMs(min)])
      expect([name, springFor(360).duration]).toEqual([name, scaledMs(max)]) // and the longest from the far clamp on
      expect([name, springFor(5000).duration]).toEqual([name, scaledMs(max)])
      expect(springFor(210).duration).toBeCloseTo((scaledMs(min) + scaledMs(max)) / 2, 6) // linear in between (210px is the middle of 60..360)
      for (const distance of [60, 100, 250, 360]) expect(springFor(distance)).toMatchObject({ dampingRatio: 1, overshootClamping: true, mass: FLIGHT_SPRING_MASS })
    }
    expect(AUTO_MOVE_SPRING.duration).toBe(scaledMs(320))
  })

  it('leaves the deal and the drag snap-back exactly as they were', () => {
    expect(SNAP_BACK_SPRING).toEqual({ duration: 240, dampingRatio: 1, overshootClamping: true })
    expect(DEAL_SPRING).toEqual({ duration: 280, dampingRatio: 1, overshootClamping: true })
  })

  it('slows every play flight down noticeably at the default pace (the reason the knob exists)', () => {
    expect(FLIGHT_TIME_SCALE).toBeGreaterThanOrEqual(1.5)
    expect(autoMoveSpringFor(200).duration).toBeGreaterThan(130 * 1.5)
    expect(winSweepSpringFor(200).duration).toBeGreaterThan(40 * 1.5)
  })
})

describe('springSettleMs', () => {
  it('is the perceptual duration x SPRING_SETTLE_FACTOR plus the UI start lag, rounded up', () => {
    expect(springSettleMs({ duration: 100 })).toBe(Math.ceil(100 * SPRING_SETTLE_FACTOR + SPRING_START_LAG_MS))
    expect(springSettleMs({ duration: 333.3 })).toBe(Math.ceil(333.3 * SPRING_SETTLE_FACTOR + SPRING_START_LAG_MS))
    expect(SPRING_START_LAG_MS).toBe(UI_START_LAG_MS)
  })

  it('is 0 for a spring with no duration (nothing animates, nothing to wait out)', () => {
    expect(springSettleMs({})).toBe(0)
    expect(springSettleMs({ duration: 0 })).toBe(0)
  })

  it('always outlasts the bare duration - what the old timer was - by at least the start lag', () => {
    for (const [, config] of FLIGHTS) expect(springSettleMs(config)).toBeGreaterThanOrEqual((config.duration ?? 0) + SPRING_START_LAG_MS)
  })
})

describe("against Reanimated's real spring", () => {
  it('every flight config really ends at 1.5 x its duration (to within a frame) - the perceptual-duration fact the settle maths rests on', () => {
    for (const [name, config] of FLIGHTS) {
      const duration = config.duration ?? 0
      expect([name, Math.abs(realEndMs(config, DISTANCE_OF(name)) - 1.5 * duration) <= FRAME_MS + 1]).toEqual([name, true])
    }
  })

  it('the play flights keep that at every duration they use - the library default mass would not (its solver caps stiffness: every duration under ~184ms ran as one ~283ms spring)', () => {
    // Documents what FLIGHT_SPRING_MASS works around. If a Reanimated upgrade makes THIS fail, the cap is gone and the override can be dropped.
    const shortWithDefaultMass = { duration: scaledMs(40), dampingRatio: 1, overshootClamping: true } // the shortest sweep flight, no mass override
    expect(realEndMs(shortWithDefaultMass, 200)).toBeGreaterThan(250)
    expect(realEndMs({ ...shortWithDefaultMass, mass: FLIGHT_SPRING_MASS }, 200)).toBeLessThan(1.5 * scaledMs(40) + FRAME_MS + 1)
  })

  it('at the retire time the ghost is within a pixel of its target for every flight - whether the spring starts on the next frame or up to two frames late', () => {
    for (const [name, config] of FLIGHTS) {
      const distance = DISTANCE_OF(name)
      const settle = springSettleMs(config)
      expect([name, 'next frame', worstRemaining(config, distance, settle, 0) < 1]).toEqual([name, 'next frame', true])
      expect([name, 'two frames', worstRemaining(config, distance, settle, UI_HOP_MS) < 1]).toEqual([name, 'two frames', true])
    }
  })

  it('and the old timer (the bare duration) did NOT hold that: it retired the sweep ghosts with tens of pixels to go - this test fails the old maths', () => {
    // The pre-fix shape: default mass (durations under ~184ms all ran as ~283ms springs), timer = duration, scale 1.
    const old = (min: number, max: number, distance: number): WithSpringConfig => {
      const t = Math.max(0, Math.min(1, (distance - 60) / 300))
      return { duration: min + t * (max - min), dampingRatio: 1, overshootClamping: true }
    }
    let worstSweep = 0
    for (const distance of DISTANCES) {
      const config = old(40, 90, distance)
      worstSweep = Math.max(worstSweep, worstRemaining(config, distance, config.duration ?? 0, 0))
    }
    expect(worstSweep).toBeGreaterThan(40) // px left when the ghost was removed, even with no start lag at all
    // ...and with the new timer but the OLD (uncapped-mass-less) spring the ghost is still cut short for the short flights:
    expect(worstRemaining(old(40, 90, 200), 200, springSettleMs(old(40, 90, 200)), 0)).toBeGreaterThan(1)
  })

  it('a flat 1.3 x duration would not have been enough once the spring starts two frames late (why the lag is added on top of the factor, not folded into it)', () => {
    const shortSweep = winSweepSpringFor(100)
    expect(worstRemaining(shortSweep, 100, Math.ceil((shortSweep.duration ?? 0) * 1.3), UI_HOP_MS)).toBeGreaterThan(1) // 2.6px measured
    expect(worstRemaining(shortSweep, 100, springSettleMs(shortSweep), UI_HOP_MS)).toBeLessThan(1)
  })

  it('the deal is left alone: its ghost (retired at the bare duration) stays within a few pixels of its target even at a full-board distance', () => {
    // Not a fix target - recorded so a change to DEAL_SPRING or the deal's timer is a deliberate one.
    expect(worstRemaining(DEAL_SPRING, 300, DEAL_SPRING.duration ?? 0, UI_HOP_MS)).toBeLessThan(3) // 2.45px measured, two frames late
  })
})
