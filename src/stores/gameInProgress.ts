import { AppState } from 'react-native'

import { FOUNDATION_LAYOUT, FOUNDATION_SUITS } from '@/engine/foundation'
import { SUITS } from '@/engine/types'
import type { UndoEntry } from '@/games/shared/undoTypes'
import { GUEST_PLAYER_ID } from '@/redux/activeProfileSlice'
import { gameInProgressActions, LEGACY_OWNER, type SavedGame } from '@/redux/gameInProgressSlice'
import { persistor, store } from '@/redux/store'

import { SOLITAIRE_GAME_IDS, SolitaireGameId } from './statsTypes'

export type { SavedGame } from '@/redux/gameInProgressSlice'

// Each game's resumable board lives in its own slot of the Redux store's `gameInProgress` slice,
// persisted under its own key (see redux/gameInProgressSlice.ts). This module is the only reader and
// writer, called imperatively from the game screens (no component subscribes to the slice).
//
// Every read, save and clear is the ACTIVE profile's (guest's while none is selected): a player only
// ever resumes their own deals. The owner is taken when the save is handed in, not when the coalesced
// dispatch lands, so a save can never be filed under a player who was picked after it was made.
//
// Saves are coalesced: every move/undo/autoplay hands over the WHOLE board plus the whole undo stack
// (each undo entry embeds a full state snapshot, so it grows with every move - ~1MB after 300 Klondike
// moves, several MB for a long Spider game), and a foundation cascade fires dozens of moves back to
// back. Dispatching (and so persisting) each one would serialize all of that per move, so the latest
// object is just remembered and dispatched once the moves stop (SAVE_DEBOUNCE_MS), or at the latest
// SAVE_MAX_WAIT_MS after the first unsaved move during a long burst. It is also flushed straight away
// (and redux-persist made to write it) whenever the app leaves the foreground (which is what precedes a
// swipe-away kill), when a game screen unmounts (see useSaveInProgressBackstop), and before any read -
// so the only thing a hard crash can lose is the last half second of moves. Callers' `state`/`undoStack`
// values are immutable snapshots, so storing them a moment later stores exactly what was handed in (or
// something newer, never anything inconsistent).
const SAVE_DEBOUNCE_MS = 500
const SAVE_MAX_WAIT_MS = 3000

interface PendingSave {
  owner: string
  saved: SavedGame<unknown, unknown>
  firstAt: number
}
const pendingSaves = new Map<SolitaireGameId, PendingSave>()
const saveTimers = new Map<SolitaireGameId, ReturnType<typeof setTimeout>>()
let appStateListenerInstalled = false
let legacyAdopted = false

/** Whose saves are being read and written: the selected profile's id, or GUEST_PLAYER_ID. */
function currentOwner(): string {
  // Optional on purpose: the test stand-in store (testUtils/gameInProgressStore.ts) has no activeProfile slice.
  return (store.getState() as { activeProfile?: string | null }).activeProfile ?? GUEST_PLAYER_ID
}

// Saves from before they were per profile belong to nobody in particular; the player active the first
// time any save is touched after the update gets them all (players who never made a profile: guest).
function adoptLegacySaves(): void {
  if (legacyAdopted) return
  legacyAdopted = true
  const owner = currentOwner()
  const slots = store.getState().gameInProgress
  SOLITAIRE_GAME_IDS.forEach((id) => {
    if (slots[id][LEGACY_OWNER]) store.dispatch(gameInProgressActions[id].adoptLegacy(owner))
  })
}

function ensureFlushOnBackground() {
  if (appStateListenerInstalled) return
  appStateListenerInstalled = true
  AppState.addEventListener('change', (next) => {
    if (next !== 'active') flushGameInProgress()
  })
}

function dispatchPending(gameId: SolitaireGameId): void {
  const timer = saveTimers.get(gameId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(gameId)
  const entry = pendingSaves.get(gameId)
  if (!entry) return
  pendingSaves.delete(gameId)
  store.dispatch(gameInProgressActions[gameId].setSaved({ owner: entry.owner, saved: entry.saved }))
}

/** Stores any coalesced save for `gameId` (or every game's, with no argument) right now, and waits for
 * redux-persist to write it. */
export async function flushGameInProgress(gameId?: SolitaireGameId): Promise<void> {
  const ids = gameId ? [gameId] : Array.from(pendingSaves.keys())
  ids.forEach(dispatchPending)
  try {
    await persistor.flush()
  } catch {
    // Best effort - a failed write only costs the resume, and there is nothing a player could do about it.
  }
}

// The games whose foundation slots are locked to a suit by position. Forty Thieves' 8 piles take any Ace, in any slot.
const SUIT_LOCKED_FOUNDATION_GAMES: readonly SolitaireGameId[] = ['klondike', 'freecell', 'yukon', 'canfield']
// Old slot index -> new slot index.
const LEGACY_FOUNDATION_SLOT = SUITS.map((suit) => FOUNDATION_SUITS.indexOf(suit))

function remapFoundationRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(remapFoundationRefs)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(source)) {
    if (key === 'foundation' && Array.isArray(child) && child.length === LEGACY_FOUNDATION_SLOT.length) {
      const piles: unknown[] = []
      child.forEach((pile, i) => {
        piles[LEGACY_FOUNDATION_SLOT[i]] = remapFoundationRefs(pile)
      })
      out[key] = piles
    } else {
      out[key] = remapFoundationRefs(child)
    }
  }
  // A PileRef naming a foundation slot (an undo entry's move, a legacy entry's cascaded moves).
  if (source.zone === 'foundation' && typeof source.index === 'number') out.index = LEGACY_FOUNDATION_SLOT[source.index] ?? source.index
  return out
}

/** A save made before the foundations followed FOUNDATION_SUITS, moved over: every board's four foundation piles
 * (the live one and each undo entry's) and every foundation slot an undo entry names. Exported for tests. */
export function remapLegacyFoundations<T>(gameId: SolitaireGameId, saved: SavedGame<T, unknown>): SavedGame<T, unknown> {
  if (saved.foundationLayout === FOUNDATION_LAYOUT || !SUIT_LOCKED_FOUNDATION_GAMES.includes(gameId)) return saved
  return { ...(remapFoundationRefs(saved) as SavedGame<T, unknown>), foundationLayout: FOUNDATION_LAYOUT }
}

export async function loadGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId): Promise<SavedGame<TState, TUndo> | null> {
  adoptLegacySaves()
  // A save still waiting out its debounce must land first, or this would resume a stale board.
  dispatchPending(gameId)
  const saved = store.getState().gameInProgress[gameId][currentOwner()]
  return saved ? (remapLegacyFoundations(gameId, saved) as SavedGame<TState, TUndo>) : null
}

export function saveGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId, saved: SavedGame<TState, TUndo>): void {
  ensureFlushOnBackground()
  adoptLegacySaves()
  const owner = currentOwner()
  // Another player's save still waiting for this game is theirs: store it before this one takes its place.
  const waiting = pendingSaves.get(gameId)
  if (waiting && waiting.owner !== owner) dispatchPending(gameId)
  const now = Date.now()
  const firstAt = pendingSaves.get(gameId)?.firstAt ?? now
  pendingSaves.set(gameId, { owner, saved: { ...(saved as SavedGame<unknown, unknown>), foundationLayout: FOUNDATION_LAYOUT }, firstAt })
  const existing = saveTimers.get(gameId)
  if (existing) clearTimeout(existing)
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, firstAt + SAVE_MAX_WAIT_MS - now))
  saveTimers.set(
    gameId,
    setTimeout(() => dispatchPending(gameId), wait)
  )
}

function dropPending(gameId: SolitaireGameId): void {
  const timer = saveTimers.get(gameId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(gameId)
  pendingSaves.delete(gameId)
}

/** Drops the active player's save for `gameId` (a win, a loss, a New Game). */
export async function clearGameInProgress(gameId: SolitaireGameId): Promise<void> {
  adoptLegacySaves()
  const owner = currentOwner()
  // Drop anything still waiting to be stored first, or it would resurrect the save being cleared. One that
  // belongs to another player is stored instead: it is theirs, not the one being cleared.
  if (pendingSaves.get(gameId)?.owner === owner) dropPending(gameId)
  else dispatchPending(gameId)
  store.dispatch(gameInProgressActions[gameId].setSaved({ owner, saved: null }))
}

/** Drops every player's saves for every game (Reset Stats, which resets every player). */
export function clearAllGamesInProgress(): void {
  SOLITAIRE_GAME_IDS.forEach((id) => {
    dropPending(id)
    store.dispatch(gameInProgressActions[id].clearAll())
  })
}

/** Drops a deleted profile's saves for every game: nothing could ever resume them again. */
export function clearProfileGamesInProgress(profileId: string): void {
  SOLITAIRE_GAME_IDS.forEach((id) => {
    if (pendingSaves.get(id)?.owner === profileId) dropPending(id)
    store.dispatch(gameInProgressActions[id].setSaved({ owner: profileId, saved: null }))
  })
}
