/** A screen test's stand-in flight: whatever its own mock does, it has these two. */
interface StandInFlight {
  hide: () => void
  flyTo: (x: number, y: number, onArrived: () => void) => void
}

/**
 * DragGhostController.canPeel/peel for a screen test's stand-in ghost: remembers which cards each flight the screen starts
 * still carries until it lands or is hidden, so a later undo can find its cards at the top of one, like the real layer does
 * (minus its wait for the ghost to show, which a stand-in's flights never need). `track` wraps a flight the stand-in's show()
 * hands out; `peel` takes the cards out of the flight carrying them and hands out a fresh flight from `makeFlight`.
 */
export function peelableFlights<F extends StandInFlight>(makeFlight: (cardIds: string[]) => F) {
  const air: { cards: string[] }[] = []
  /** Every peel that found its cards in the air (the ids, joined with '+'), and when (Date.now(), fake time). */
  const peeled: string[] = []
  const peeledAt: number[] = []

  function track(cardIds: string[], flight: F): F {
    const entry = { cards: cardIds }
    air.push(entry)
    const down = () => {
      const at = air.indexOf(entry)
      if (at >= 0) air.splice(at, 1)
    }
    return {
      ...flight,
      hide: () => {
        down()
        flight.hide()
      },
      flyTo: (x: number, y: number, onArrived: () => void) =>
        flight.flyTo(x, y, () => {
          down()
          onArrived()
        })
    }
  }

  function source(spec: { cards: { id: string }[] }) {
    const ids = spec.cards.map((c) => c.id).join('+')
    const k = spec.cards.length
    return air.find((f) => k > 0 && k <= f.cards.length && f.cards.slice(f.cards.length - k).join('+') === ids) ?? null
  }

  return {
    peeled,
    peeledAt,
    track,
    canPeel: (spec: { cards: { id: string }[] }) => source(spec) !== null,
    peel: (spec: { cards: { id: string }[] }) => {
      const from = source(spec)
      if (!from) return null
      const ids = spec.cards.map((c) => c.id)
      from.cards = from.cards.slice(0, from.cards.length - ids.length)
      peeled.push(ids.join('+'))
      peeledAt.push(Date.now())
      return track(ids, makeFlight(ids))
    },
    reset: () => {
      air.length = 0
      peeled.length = 0
      peeledAt.length = 0
    }
  }
}
