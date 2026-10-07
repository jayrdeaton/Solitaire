import { act, renderHook } from '@testing-library/react-native'

import { PileRef } from '@/engine/gameTypes'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'

// runUndo, driven by a stand-in screen: each undo entry takes a card from one pile and flies it to another. Its revert claims a
// flight, "measures" its origin (MEASURE_MS of fake time), then pops the entry and marks its destination as landing - the shape
// every screen's revertTopUndo has. A flight lands only when a test says so (land()).

const MEASURE_MS = 20
const POLL_MS = 16
const MAX_WAIT_MS = 3000

const pile = (index: number): PileRef => ({ zone: 'tableau', index })

interface Entry {
  id: string
  takesFrom: PileRef
  landsOn: PileRef
  exclusive?: boolean
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

async function setup(entries: Entry[]) {
  const stack = [...entries] // the top entry is the last one
  const log: string[] = []
  const flyingIds = new Map<string, number>()
  const { result } = await renderHook(() => useFlightConcurrency<string>())
  const fc = () => result.current

  const gate = (): UndoGate => {
    const top = stack[stack.length - 1]
    if (!top) return null
    return top.exclusive ? 'exclusive' : { takesFrom: [top.takesFrom] }
  }
  const run = async () => {
    const top = stack[stack.length - 1]
    if (!top) return
    fc().startFlights(1)
    log.push(`start ${top.id}`)
    await new Promise((resolve) => setTimeout(resolve, MEASURE_MS))
    stack.pop()
    flyingIds.set(top.id, fc().beginFlying(top.landsOn, 1))
    log.push(`commit ${top.id}`)
  }
  const outcomes: Record<string, boolean | 'pending'> = {}
  let requests = 0
  /** One tap of Undo; its outcome is recorded under `req1`, `req2`, ... */
  const request = async (opts?: { cancelled?: () => boolean }) => {
    const name = `req${++requests}`
    outcomes[name] = 'pending'
    await act(async () => {
      fc()
        .runUndo(gate, run, opts)
        .then((started) => {
          outcomes[name] = started
        })
    })
    return name
  }
  const land = async (id: string) => {
    await act(async () => {
      fc().endFlying(flyingIds.get(id)!)
      fc().settleFlight()
    })
    log.push(`land ${id}`)
  }
  /** A flight that is not an undo's (a move the player just made): claimed, and landing on `on`. */
  const otherFlight = async (on: PileRef) => {
    let flyingId = 0
    await act(async () => {
      fc().startFlights(1)
      flyingId = fc().beginFlying(on, 1)
    })
    return async () => {
      await act(async () => {
        fc().endFlying(flyingId)
        fc().settleFlight()
      })
    }
  }
  return { fc, stack, log, outcomes, request, land, otherFlight }
}

describe('useFlightConcurrency - runUndo', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('an undo tapped while a move is still flying waits for it to land instead of being dropped, then runs', async () => {
    const { fc, log, outcomes, request, otherFlight } = await setup([{ id: 'a', takesFrom: pile(0), landsOn: pile(1) }])
    const landMove = await otherFlight(pile(5))

    const req = await request()
    expect(fc().undoBusyRef.current).toBe(true) // held at once: nothing new may start while it waits
    await advance(200)
    expect(log).toEqual([])
    expect(outcomes[req]).toBe('pending')

    await landMove()
    await advance(POLL_MS)
    expect(log).toEqual(['start a'])
    await advance(MEASURE_MS)
    expect(log).toEqual(['start a', 'commit a'])
    expect(outcomes[req]).toBe(true)
  })

  it('a second undo starts while the first one is still flying, once the first has committed - its pile is not being landed on', async () => {
    const { log, outcomes, request } = await setup([
      { id: 'older', takesFrom: pile(2), landsOn: pile(3) },
      { id: 'newer', takesFrom: pile(0), landsOn: pile(1) }
    ])

    const first = await request()
    const second = await request()
    expect(log).toEqual(['start newer']) // one revert at a time: the second waits for the first to commit...
    await advance(MEASURE_MS)
    expect(log).toEqual(['start newer', 'commit newer', 'start older']) // ...and not for it to land
    await advance(MEASURE_MS)
    expect(log).toEqual(['start newer', 'commit newer', 'start older', 'commit older'])
    expect(outcomes[first]).toBe(true)
    expect(outcomes[second]).toBe(true)
  })

  it('an undo whose pile is still being landed on waits for that landing - picking the card up mid-air would show it twice', async () => {
    const { log, outcomes, request, land } = await setup([
      { id: 'older', takesFrom: pile(1), landsOn: pile(4) },
      { id: 'newer', takesFrom: pile(0), landsOn: pile(1) }
    ])

    await request()
    const second = await request()
    await advance(MEASURE_MS + 100)
    expect(log).toEqual(['start newer', 'commit newer'])
    expect(outcomes[second]).toBe('pending')

    await land('newer')
    await advance(POLL_MS)
    expect(log).toEqual(['start newer', 'commit newer', 'land newer', 'start older'])
    await advance(MEASURE_MS)
    expect(outcomes[second]).toBe(true)
  })

  it('an exclusive undo waits for every flight to land, and no undo starts after it until its own flights have landed', async () => {
    const { log, request, land } = await setup([
      { id: 'after', takesFrom: pile(6), landsOn: pile(7) },
      { id: 'exclusive', takesFrom: pile(4), landsOn: pile(5), exclusive: true },
      { id: 'before', takesFrom: pile(0), landsOn: pile(1) }
    ])

    await request()
    await request()
    await request()
    await advance(MEASURE_MS + 100)
    expect(log).toEqual(['start before', 'commit before']) // the exclusive one waits for 'before' to land

    await land('before')
    await advance(POLL_MS + MEASURE_MS)
    expect(log).toEqual(['start before', 'commit before', 'land before', 'start exclusive', 'commit exclusive'])
    await advance(200)
    expect(log).toHaveLength(5) // 'after' takes from a quiet pile, but waits out the exclusive one's flight all the same

    await land('exclusive')
    await advance(POLL_MS + MEASURE_MS)
    expect(log.slice(5)).toEqual(['land exclusive', 'start after', 'commit after'])
  })

  it('undoBusyRef is held until the last undo flight has landed, then let go', async () => {
    const { fc, request, land } = await setup([
      { id: 'older', takesFrom: pile(2), landsOn: pile(3) },
      { id: 'newer', takesFrom: pile(0), landsOn: pile(1) }
    ])

    await request()
    await request()
    await advance(2 * MEASURE_MS)
    expect(fc().undoBusyRef.current).toBe(true)
    await land('newer')
    expect(fc().undoBusyRef.current).toBe(true) // 'older' is still in the air
    await land('older')
    expect(fc().undoBusyRef.current).toBe(false)
  })

  it('nothing to undo: refused at once, and a request queued behind the last entry is refused once that entry is gone', async () => {
    const { fc, log, outcomes, request, land } = await setup([{ id: 'only', takesFrom: pile(0), landsOn: pile(1) }])

    const first = await request()
    const second = await request()
    await advance(MEASURE_MS)
    expect(outcomes[first]).toBe(true)
    expect(outcomes[second]).toBe(false)
    expect(log).toEqual(['start only', 'commit only'])

    await land('only')
    const third = await request()
    expect(outcomes[third]).toBe(false)
    expect(fc().undoBusyRef.current).toBe(false)
  })

  it('a request cancelled while it waits never runs, and lets go of undoBusyRef', async () => {
    const { fc, log, outcomes, request, otherFlight } = await setup([{ id: 'a', takesFrom: pile(0), landsOn: pile(1) }])
    const landMove = await otherFlight(pile(5))
    let released = false

    const req = await request({ cancelled: () => released })
    released = true // the finger lifted while the request was waiting
    await landMove()
    await advance(POLL_MS)
    expect(log).toEqual([])
    expect(outcomes[req]).toBe(false)
    expect(fc().undoBusyRef.current).toBe(false)
  })

  it('a request that cannot start within the wait is refused, and lets go of undoBusyRef so play can go on', async () => {
    const { fc, log, outcomes, request, otherFlight } = await setup([{ id: 'a', takesFrom: pile(0), landsOn: pile(1) }])
    await otherFlight(pile(5)) // never lands

    const req = await request()
    await advance(MAX_WAIT_MS - POLL_MS)
    expect(outcomes[req]).toBe('pending')
    await advance(2 * POLL_MS)
    expect(outcomes[req]).toBe(false)
    expect(log).toEqual([])
    expect(fc().undoBusyRef.current).toBe(false)
  })

  it('a press event handed in as the options is not mistaken for a cancel check', async () => {
    const { log, outcomes, fc } = await setup([{ id: 'a', takesFrom: pile(0), landsOn: pile(1) }])
    let started: boolean | undefined
    await act(async () => {
      fc()
        .runUndo(
          () => ({ takesFrom: [pile(0)] }),
          () => {
            log.push('ran')
          },
          { nativeEvent: {} } as unknown as { cancelled?: () => boolean }
        )
        .then((s) => {
          started = s
        })
    })
    expect(log).toEqual(['ran'])
    expect(started).toBe(true)
    expect(outcomes).toEqual({})
  })

  it('reset() (a New Game) refuses every waiting request', async () => {
    const { fc, log, outcomes, request, otherFlight } = await setup([
      { id: 'older', takesFrom: pile(2), landsOn: pile(3) },
      { id: 'newer', takesFrom: pile(0), landsOn: pile(1) }
    ])
    await otherFlight(pile(5))

    const first = await request()
    const second = await request()
    await act(async () => fc().reset())
    await advance(MAX_WAIT_MS)
    expect(outcomes[first]).toBe(false)
    expect(outcomes[second]).toBe(false)
    expect(log).toEqual([])
    expect(fc().undoBusyRef.current).toBe(false)
  })
})
