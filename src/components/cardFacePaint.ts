import { createContext, useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'

/**
 * Which cards have a face mounted on the board whose bitmap has not been delivered yet - so a ghost can stay over a card
 * it just landed on until the card can really be seen.
 *
 * A card face is ONE <Image> of a pre-rasterized bitmap (PlayingCard, cardFaceBitmaps.ts), and React Native's iOS image
 * pipeline never hands a new Image its bitmap in the commit that mounts it: RCTImageManager.requestImage always
 * dispatch_asyncs the load to a background queue, and the image view is only filled in the same frame when that load has
 * already finished by the time the mount transaction reaches the main thread (otherwise it arrives a runloop turn or more
 * later). Until then the card is its plain face colour with a border and a shadow - no rank, no pips. So a card revealed
 * in the commit that retires its ghost (a FlyingCardSlot swapped for the real card at a tableau landing, a pile overlay
 * switching to the card that just landed) used to flash blank for a frame or two at the end of the flight; pixel-checked
 * on the Simulator (a landed Q♦ blank for 2 frames, the waste blank at most draws). Every face Image reports here from
 * the commit it mounts or changes source until its onLoad (PlayingCard's CardFaceImage), and DragGhostLayer keeps a landed
 * ghost on top - same pixels - until none of its cards is still loading (whenFacesPainted).
 *
 * Ghosts themselves don't report (FaceLoadTrackingContext): what matters is the card that stays on the board.
 */
const loading = new Map<string, number>()
const listeners = new Set<() => void>()
let notifyScheduled = false

// Batched to a microtask: a face can finish from an effect cleanup in the middle of a commit (it unmounted), and the
// listeners set React state.
function scheduleNotify() {
  if (notifyScheduled) return
  notifyScheduled = true
  // A promise job rather than queueMicrotask: same timing, and not swapped out by Jest's fake timers.
  void Promise.resolve().then(() => {
    notifyScheduled = false
    listeners.forEach((listener) => listener())
  })
}

/** Marks one face of `cardId` as loading; the returned function marks it done (loaded, unmounted, or replaced by a
 * different source) and is safe to call more than once. */
export function trackFaceLoad(cardId: string): () => void {
  loading.set(cardId, (loading.get(cardId) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const left = (loading.get(cardId) ?? 1) - 1
    if (left > 0) loading.set(cardId, left)
    else loading.delete(cardId)
    scheduleNotify()
  }
}

export function isAnyFaceLoading(cardIds: readonly string[]): boolean {
  return cardIds.some((id) => loading.has(id))
}

/** Calls `onPainted` once no face of any of `cardIds` is still loading - at once if none is - or after `maxWaitMs` at
 * the latest (a load that fails never reports). Returns a cancel function. */
export function whenFacesPainted(cardIds: readonly string[], maxWaitMs: number, onPainted: () => void): () => void {
  let finished = false
  let timer: ReturnType<typeof setTimeout> | null = null
  function stop() {
    finished = true
    listeners.delete(check)
    if (timer) clearTimeout(timer)
  }
  function finish() {
    if (finished) return
    stop()
    onPainted()
  }
  function check() {
    if (!isAnyFaceLoading(cardIds)) finish()
  }
  timer = setTimeout(finish, maxWaitMs)
  listeners.add(check)
  check()
  return stop
}

/**
 * whenFacesPainted, plus: none of `cardIds` is taking off with a ghost that is not on screen yet (isGhostPending). What a
 * LANDED ghost waits for before it goes (DragGhostLayer): it is often the only painted copy of its card - the face it
 * landed on may still be loading, and a card can take off again (a re-tap, an auto-play, Spider sweeping the run it just
 * completed) before that - so it stays until the board face has painted and any new ghost of the card has appeared over it.
 */
export function whenCardsSettled(cardIds: readonly string[], maxWaitMs: number, onSettled: () => void): () => void {
  let finished = false
  let timer: ReturnType<typeof setTimeout> | null = null
  function stop() {
    finished = true
    listeners.delete(check)
    ghostListeners.delete(check)
    if (timer) clearTimeout(timer)
  }
  function finish() {
    if (finished) return
    stop()
    onSettled()
  }
  function check() {
    if (!isAnyFaceLoading(cardIds) && !cardIds.some((id) => ghostPending.has(id))) finish()
  }
  timer = setTimeout(finish, maxWaitMs)
  listeners.add(check)
  ghostListeners.add(check)
  check()
  return stop
}

/** False inside a ghost (DragGhostLayer's flights): its faces are not the board's, so they never hold a landing back. */
export const FaceLoadTrackingContext = createContext(true)

/**
 * Cards whose flight has STARTED but whose ghost is not on screen yet - the take-off side of the same problem.
 *
 * A ghost is a freshly mounted Image too, so in the commit a move starts it would be a blank card at the source (the move
 * removes or re-sources the real card in that same commit) - pixel-checked on the Simulator on most tap moves. So a ghost
 * stays invisible until its own faces have painted (DragGhostLayer's FlightGhostCard; Pyramid's and Spider's flight
 * overlays), and while it does, the SOURCE keeps drawing the departing card - the same, already-painted Image instance:
 * PileView keeps a card that just left its column (and a dragged card un-hidden), the single-card piles keep showing it
 * (useTakeOffHold). A flight marks its cards here synchronously as it starts - before the move's commit renders - and the
 * mark is released from the commit after its ghost has turned visible, so the source never lets go before the ghost shows.
 * Components read it with useGhostPendingAmong (useSyncExternalStore), which only re-renders a component when one of ITS
 * cards changes.
 */
const ghostPending = new Map<string, number>()
const ghostListeners = new Set<() => void>()

function notifyGhostPending() {
  ghostListeners.forEach((listener) => listener())
}

/** Backstop on a take-off hold nobody released (a flight dropped before its ghost ever mounted): far longer than any real
 * wait for a ghost to show, short enough that a source never keeps drawing a card that has long gone. */
export const GHOST_PENDING_MAX_MS = 1000

/** Marks `cardIds` as taking off with a ghost that is not visible yet. The returned release is safe to call more than
 * once, and runs by itself after GHOST_PENDING_MAX_MS. */
export function markGhostPending(cardIds: readonly string[]): () => void {
  if (cardIds.length === 0) return () => {}
  cardIds.forEach((id) => ghostPending.set(id, (ghostPending.get(id) ?? 0) + 1))
  notifyGhostPending()
  let released = false
  const backstop = setTimeout(() => release(), GHOST_PENDING_MAX_MS)
  function release() {
    if (released) return
    released = true
    clearTimeout(backstop)
    cardIds.forEach((id) => {
      const left = (ghostPending.get(id) ?? 1) - 1
      if (left > 0) ghostPending.set(id, left)
      else ghostPending.delete(id)
    })
    notifyGhostPending()
  }
  return release
}

export function isGhostPending(cardId: string): boolean {
  return ghostPending.has(cardId)
}

export function subscribeGhostPending(listener: () => void): () => void {
  ghostListeners.add(listener)
  return () => {
    ghostListeners.delete(listener)
  }
}

/** The ids among `cardIds` whose ghost is pending, as one string (a stable snapshot): re-renders the caller only when that
 * set changes. */
export function useGhostPendingAmong(cardIds: readonly string[]): string {
  const key = cardIds.join('|')
  const getSnapshot = useCallback(() => (key ? key.split('|').filter(isGhostPending).join('|') : ''), [key])
  return useSyncExternalStore(subscribeGhostPending, getSnapshot, getSnapshot)
}

/**
 * How long a ghost may stay over the card it has landed on, waiting for that card's face to paint. The settle reveals the
 * real card; a card mounted (or re-sourced) in that commit usually gets its bitmap a frame or two later, and until then it
 * is a blank face - so the ghost, the same pixels, stays on top until none of its cards is still loading (whenCardsSettled,
 * from a layout effect of the landing commit, so the board's faces have registered). Shared by every overlay that holds a
 * landed ghost (DragGhostLayer, Pyramid's pair flights, Spider's sequence flights). Normally a frame or two; this only
 * bounds a load that never reports.
 */
export const LANDED_GHOST_MAX_MS = 250

/**
 * How long a slot that re-sourced its one face Image (a single-card pile showing its next card after a take-off or a drop)
 * may keep the real card hidden, waiting for the new face to paint. Bounds a load that never reports.
 */
export const REVEAL_MAX_MS = 150

/**
 * How long a new ghost may stay invisible waiting for its faces to paint (useGhostPaintGate) - normally a frame or two (the
 * bitmap's async delivery plus the onLoad event's trip to JS); this only bounds a load that never reports. Its source
 * holds the departing card for as long, and the flight cannot start moving before the ghost shows.
 *
 * This cap does NOT keep flights in the order they were started: it counts from the ghost's own commit, not from when its
 * flight began, and a ghost with nothing to paint (an adopted, already-painted ghost, or a face-down card) shows in its
 * first commit with no wait at all - so a later card (an auto-play stream's next one, 96ms behind) could otherwise start,
 * and with every flight taking the same time land, ahead of an earlier one still waiting here. DragGhostLayer's start queue
 * (startQueueRef) is what keeps its show() flights in order: a flight's gate opens only once every earlier show()
 * flight's has (its ghost has shown). It orders the gates, not the flyTo calls - a flight moves at the later of its gate
 * and its own flyTo - so landing order also relies on the callers sending their flights in start order, which every
 * screen's streams do. Pyramid's pair flights, Spider's sequence flights and DealLayer have their own paint gates and are
 * not in that queue. What the cap does bound there is how long a later flight can be held back behind an earlier ghost,
 * so it is kept short - under the auto-play stream's 96ms gap (AUTO_PLAY_STAGGER_MS).
 */
export const GHOST_PAINT_MAX_MS = 80

/**
 * The paint gate every ghost overlay uses at take-off (DragGhostLayer's FlightGhostCard, Pyramid's pair flights, Spider's
 * completed runs): `shown` turns true once every id in `faceIds` has reported its face painted (`markPainted`, wired to
 * each card's PlayingCard onFacePainted), or after `maxMs` (GHOST_PAINT_MAX_MS unless the caller can afford a longer wait -
 * the win cascade, where nothing else waits on it). Draw the ghost at opacity 0 and start its motion only once `shown`.
 * `onShown` runs in the commit it turns true (a layout effect): release the take-off hold there, so the source lets go no
 * earlier than the ghost appears. A ghost with nothing to wait for (`faceIds` empty) is shown at once.
 */
export function useGhostPaintGate(faceIds: readonly string[], onShown: () => void, maxMs: number = GHOST_PAINT_MAX_MS): { shown: boolean; markPainted: (cardId: string) => void } {
  const [painted, setPainted] = useState<ReadonlySet<string>>(() => new Set())
  const [timedOut, setTimedOut] = useState(false)
  const shown = timedOut || faceIds.every((id) => painted.has(id))
  const markPainted = useCallback((cardId: string) => setPainted((prev) => (prev.has(cardId) ? prev : new Set(prev).add(cardId))), [])
  useEffect(() => {
    if (shown) return
    const backstop = setTimeout(() => setTimedOut(true), maxMs)
    return () => clearTimeout(backstop)
  }, [shown, maxMs])
  useLayoutEffect(() => {
    if (shown) onShown()
  }, [shown, onShown])
  return { shown, markPainted }
}
