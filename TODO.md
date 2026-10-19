# TODO

Deferred on 2026-10-16 to ship the first Expo SDK 58 build the same day.

1. **React Native 0.88 strict types.** `@infinitetoken/tsconfig` 0.6 resolves React Native 0.88's legacy types, and React Native drops them after 0.88. Under the strict types this app's own code had 76 errors on 2026-10-16 (nearly all refs: `RefObject<View>` and friends become `ViewInstance`-style instance types), plus about 40 in the `@rific`/`@tastic` source it type-checks. Fix them (packages first, see TSConfig's TODO.md) before moving past SDK 58. Check by type-checking with `customConditions: ["react-native"]` only.
2. **Web tab title in the static HTML.** Since SDK 58, `expo-router/head`'s `<Head>` (in `src/app/_layout.tsx`) only sets the title after hydration; the static export's HTML has none, so the tab shows the URL until the JS loads and crawlers see no title. Export `generateMetadata()` (returns `{ title }`) from each route, or from the root layout if Expo Router supports it there, then drop `<Head>`.
3. **Gestures on a device under gesture-handler 3.** `@rific/toaster` 0.8.1 only had its peer range raised for gesture-handler 3.3, and its tests mock gesture-handler, so try swiping a toast away (and tapping one) in an SDK 58 dev build.

## Store ignores back to the root .gitignore (2026-10-19)

`store/.gitignore` holds `creative/.build-*/` only because the root `.gitignore` is part of the EAS fingerprint (`ios/` and `android/` are gitignored, so it decides what's generated): adding the line there changed the runtime version and would have cut OTA updates off from build 1.2.5 (17). Move it back, and delete `store/.gitignore`, in the same change as the next native change that bumps the fingerprint anyway (a native dependency, a config plugin, an `app.json` native field). Check with `eas fingerprint:compare --build-id <id>` that the fingerprint was already changing before adding this to it.
