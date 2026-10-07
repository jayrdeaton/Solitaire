import { createGuideSlice } from '@tastic/hud/guide'

import { GUIDE_VERSION } from '@/constants/guide'

// Thin binding over @tastic/hud/guide's createGuideSlice factory: the persisted "which version of the
// how-to-play flow has this player finished or skipped" flag. A fresh install starts at 0 (the guide
// auto-shows on Home); a player who already had the app is stamped with GUIDE_VERSION on their first
// rehydrate, so an over-the-air update never greets them with a "how to play" screen (see the
// factory's own doc for how it tells the two apart, and LEGACY_STORAGE_KEYS below for players coming
// from a shipped pre-redux build). Mounted under `guide` in store.ts, the key the REHYDRATE payload
// is read from.
const slice = createGuideSlice({ currentVersion: GUIDE_VERSION })

// Every AsyncStorage key the last shipped pre-redux build wrote: 25532f0 (otaVersion 3, 2026-09-12),
// read from that commit's own source. The redux-persist root store only arrived in 6dbe6e5 and first
// shipped in otaVersion 4 (464e3e1), so a player last on otaVersion 3 or earlier has no root store at
// all and would otherwise look exactly like a fresh install. store.ts hands these to
// createReturningPlayerMigrate: no root store but any of these keys present means "played a shipped
// build", and that player is grandfathered past the guide. Players already on otaVersion 4+ have a
// root store and are grandfathered by the slice itself. The earlier shipped builds (5f3078f,
// otaVersion 1, and f065784, otaVersion 2) wrote this same set, so the list covers them too.
//
// A historical record, so plain strings rather than today's constants: renaming a key in today's code
// must never change this list. Where each one was written at 25532f0 (a real setItem, not a comment):
//   solitaire.stats, solitaire.achievements: stores/gameStats.tsx passes namespace 'solitaire' to
//     @tastic/achievements 0.1.1's useAchievements, which writes `${namespace}.stats` and
//     `${namespace}.achievements` through that file's storage shim
//   solitaire.game-in-progress.v1.<gameId>, one per game in that build's SOLITAIRE_GAME_IDS:
//     stores/gameInProgress.ts (saveGameInProgress, called by every game screen)
//   solitaire.guest-color.v1, solitaire.profiles.v1: stores/profiles.tsx
//   solitaire.last-active-game.v1: stores/lastActiveGame.tsx
//   solitaire.settings.v1: stores/settings.tsx
//   solitaire.sound.v1, solitaire.vibrate.v1: stores/feedbackSettings.ts
//   solitaire.theme-settings.v1: stores/themeSettings.ts (written on every launch, via ProfileThemeSync)
// Not listed: solitaire.stats.v1.<gameId> (stores/statsLegacy.ts). That build only ever READ those
// keys (to migrate much older stats), and no commit in this repo ever wrote them.
//
// None of them may be written by today's build before PersistGate opens (the migrate would then take a
// fresh install for a returning player). Today, solitaire.theme-settings.v1 and
// solitaire.last-active-game.v1 still belong to providers mounted OUTSIDE PersistGate (see
// _layout.tsx), but neither writes on mount: each writes only when something calls its setter, and
// every setter call at boot (ProfileThemeSync, the game screens) comes from inside PersistGate, i.e.
// after the migrate has already run. solitaire.settings.v1 is no longer written at all: settings live
// in the Redux store since 2026-10-07.
export const LEGACY_STORAGE_KEYS: readonly string[] = ['solitaire.achievements', 'solitaire.game-in-progress.v1.acesup', 'solitaire.game-in-progress.v1.canfield', 'solitaire.game-in-progress.v1.fortythieves', 'solitaire.game-in-progress.v1.freecell', 'solitaire.game-in-progress.v1.golf', 'solitaire.game-in-progress.v1.klondike', 'solitaire.game-in-progress.v1.pyramid', 'solitaire.game-in-progress.v1.scorpion', 'solitaire.game-in-progress.v1.spider', 'solitaire.game-in-progress.v1.tripeaks', 'solitaire.game-in-progress.v1.yukon', 'solitaire.guest-color.v1', 'solitaire.last-active-game.v1', 'solitaire.profiles.v1', 'solitaire.settings.v1', 'solitaire.sound.v1', 'solitaire.stats', 'solitaire.theme-settings.v1', 'solitaire.vibrate.v1']

export const guideActions = slice.actions
export const selectGuideVersionSeen = slice.selectVersionSeen
export default slice.reducer
