# TODO

Deferred on 2026-10-16 to ship the first Expo SDK 58 build the same day.

1. **React Native 0.88 strict types.** `@infinitetoken/tsconfig` 0.6 resolves React Native 0.88's legacy types, and React Native drops them after 0.88. Under the strict types this app's own code had 76 errors on 2026-10-16 (nearly all refs: `RefObject<View>` and friends become `ViewInstance`-style instance types), plus about 40 in the `@rific`/`@tastic` source it type-checks. Fix them (packages first, see TSConfig's TODO.md) before moving past SDK 58. Check by type-checking with `customConditions: ["react-native"]` only.
2. **Web tab title in the static HTML.** Since SDK 58, `expo-router/head`'s `<Head>` (in `src/app/_layout.tsx`) only sets the title after hydration; the static export's HTML has none, so the tab shows the URL until the JS loads and crawlers see no title. Export `generateMetadata()` (returns `{ title }`) from each route, or from the root layout if Expo Router supports it there, then drop `<Head>`.
3. **Gestures on a device under gesture-handler 3.** `@rific/toaster` 0.8.1 only had its peer range raised for gesture-handler 3.3, and its tests mock gesture-handler, so try swiping a toast away (and tapping one) in an SDK 58 dev build.
