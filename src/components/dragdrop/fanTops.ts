/**
 * Where each tableau card sits in its column's fan right now (its offset from the column's top, PileView's `tops`), kept by
 * the instance laid out there. A multi-card ghost reads it to fan its run the way the columns do (DragGhostLayer's fan
 * step): the run lifts off at the spacing it had in the column it leaves and eases to the spacing of the column it lands
 * on as it flies. The ghost used to fan at the natural step, so a run leaving or joining a compressed column stretched the
 * moment it lifted off and snapped shorter as it landed.
 *
 * Module-level, like cardFacePaint.ts's registries: a card's id is unique on the one board on screen.
 */
const tops = new Map<string, { owner: object; top: number }>()

export function setFanTop(cardId: string, owner: object, top: number) {
  tops.set(cardId, { owner, top })
}

/** Only drops the entry `owner` set: a card's next instance (in the column it moved to) can set its own before the old
 * one's cleanup runs. */
export function clearFanTop(cardId: string, owner: object) {
  if (tops.get(cardId)?.owner === owner) tops.delete(cardId)
}

/** The step between consecutive cards of a run (its card ids from the top of the fan down) as its column lays it out
 * now, or null when its first or last card is not laid out in a column. */
export function fanStep(cardIds: readonly string[]): number | null {
  if (cardIds.length < 2) return null
  const first = tops.get(cardIds[0])
  const last = tops.get(cardIds[cardIds.length - 1])
  if (!first || !last) return null
  const step = (last.top - first.top) / (cardIds.length - 1)
  return step > 0 ? step : null
}
