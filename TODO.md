# TODO

Found during the 2026-10-15 fleet review. Line numbers are as of that date.

1. **Adopt the next `@tastic/profile` release** (pending in React-Native-Game-Profile). `resolveInitialProfiles` and `useSharedProfilesSync` (`src/stores/profiles.tsx:95,112`) pick up the failed-read fix with the bump; nothing else to change. It stops a failed App Group read from emptying the roster, after which the next profile create overwrote every Tastic game's profiles.
2. **A font-load error leaves the app on its title forever** (audit F010). `src/components/useFontsPreload.ts:33-34` marks the `fonts` gate from `loaded` only, and `src/app/_layout.tsx:235` returns the title while fonts aren't loaded. `useFonts` leaves `loaded` false after an error, so a failed load never gets past it. Treat `loaded || !!error` as loaded, as Snake's `Theme.tsx` does.
