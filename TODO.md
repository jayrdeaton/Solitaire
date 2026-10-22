# TODO

Deferred on 2026-10-16 to ship the first Expo SDK 58 build the same day.

1. **React Native 0.88 strict types.** `@infinitetoken/tsconfig` 0.6 resolves React Native 0.88's legacy types, and React Native drops them after 0.88. Under the strict types this app's own code had 76 errors on 2026-10-16 (nearly all refs: `RefObject<View>` and friends become `ViewInstance`-style instance types), plus about 40 in the `@rific`/`@tastic` source it type-checks. Fix them (packages first, see TSConfig's TODO.md) before moving past SDK 58. Check by type-checking with `customConditions: ["react-native"]` only.
2. **Web tab title in the static HTML.** Since SDK 58, `expo-router/head`'s `<Head>` (in `src/app/_layout.tsx`) only sets the title after hydration; the static export's HTML has none, so the tab shows the URL until the JS loads and crawlers see no title. Export `generateMetadata()` (returns `{ title }`) from each route, or from the root layout if Expo Router supports it there, then drop `<Head>`.
3. **Gestures on a device under gesture-handler 3.** `@rific/toaster` 0.8.1 only had its peer range raised for gesture-handler 3.3, and its tests mock gesture-handler, so try swiping a toast away (and tapping one) in an SDK 58 dev build.

## Store ignores back to the root .gitignore (2026-10-19)

`store/.gitignore` holds `creative/.build-*/` only because the root `.gitignore` is part of the EAS fingerprint (`ios/` and `android/` are gitignored, so it decides what's generated): adding the line there changed the runtime version and would have cut OTA updates off from build 1.2.5 (17). Move it back, and delete `store/.gitignore`, in the same change as the next native change that bumps the fingerprint anyway (a native dependency, a config plugin, an `app.json` native field). Check with `eas fingerprint:compare --build-id <id>` that the fingerprint was already changing before adding this to it.

## Stats screen pickers side by side (2026-10-22)

The two pills at the top of the Stats screen (`src/components/StatsFilters.tsx`: whose stats, which game) wrap onto two lines on phones under about 404pt wide, and on any phone once a long name is picked (Forty Thieves, a long profile name). `@tastic/profile` can now shrink a picker pill and cut its label off with an ellipsis, with the chip and chevron kept whole (a `flexShrink` in `triggerStyle`; see that repo's CLAUDE.md, "A trigger that shrinks"). That change is written and tested but not committed or released. `@tastic/profile` is native, so the new version needs a new native build: wait for the build freeze to end.

1. Release `@tastic/profile` with the change (a minor) and install it here.
2. In `StatsFilters.tsx`: add `flexShrink: 1` to `styles.pill`, and in `styles.row` drop `flexWrap: 'wrap'` and `rowGap`, and take `columnGap` from 8 to 6. With 8, Everyone | All Games needs 363.5pt against the 362pt row of a 402pt iPhone 17, so both labels would be cut for 1.5pt; with 6 they fit whole at 402pt and up.
3. Update `StatsFilters`' doc comment and CLAUDE.md's "Everyone and Guest" bullet ("The pills still wrap on most phones ...").
4. Check it on a phone at 375pt or narrower. Pills shrink in proportion to their natural width, so at 375 both labels are cut (Everyone along with Forty Thieves). Giving only the game pill a `flexShrink` would keep the player pill whole, but then a long profile name overflows the row.
