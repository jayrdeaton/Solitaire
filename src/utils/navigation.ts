import { configureNavigation, safeBack } from '@rific/core'
import { router } from 'expo-router'

// router.back() throws a "The action 'GO_BACK' was not handled" error toast whenever this screen
// has no actual history to pop to — reached directly (a deep link, a refreshed page, or a dev
// reload) rather than pushed from another screen within the app. achievements.tsx and profiles.tsx
// are both only ever reached via router.push() in normal use, but neither guarded against this —
// falls back to the title screen, always a valid destination, instead of leaving the user stuck
// looking at an error toast with a back button that does nothing. Backed by @rific/core's shared
// safeBack — see that package's own doc for why it's injected via configureNavigation rather than
// imported directly (keeps @rific/core free of a hard expo-router dependency).
//
// GameChrome.tsx's own Back button deliberately keeps its existing unconditional
// router.replace('/') instead of this — see that file's own comment — since it already handles
// this exact failure mode for a fixed one-level nav structure; this wrapper is for the two other,
// less-traveled back-navigation sites that never got the same treatment.
configureNavigation({ router })

export { safeBack }
