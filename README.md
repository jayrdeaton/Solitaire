# Solitaire Suite

An ad-free, ad-account-free, self-contained solitaire app: Klondike, Spider, FreeCell, and Pyramid, in one Expo (React Native + TypeScript) codebase that runs on iPhone and the web from the same source.

No backend, no accounts, no network calls - everything (settings, win/streak stats) is stored locally on-device via AsyncStorage, so there's nothing to maintain or pay for after publishing.

## Project layout

Everything lives under `src/`, with `@/*` import aliases for cross-folder references (same-folder imports stay relative):

- `src/engine/` - pure TypeScript card engine shared by every game (cards, seeded shuffle/deck, generic run-checking helpers, the `GameController<TState>` contract each game implements)
- `src/games/<name>/rules.ts` - one game's rules engine (deal, legal moves, win check) - no UI dependencies
- `src/games/<name>/<Name>Screen.tsx` - that game's board screen
- `src/components/` - shared visual pieces (`PlayingCard`, `PileView`, theme colors)
- `src/stores/` - AsyncStorage-backed settings + per-game win/streak stats
- `src/app/` - Expo Router screens (`index` = home/game picker, `settings`, and one thin route per game)
- `src/__tests__/` - unit tests, mirroring the source tree (engine + each game's rules)

## Theming & feedback

The app follows the system's light/dark appearance automatically (`app.json`'s `userInterfaceStyle: "automatic"`), via [`@rific/auto-paper`](https://www.npmjs.com/package/@rific/auto-paper) - `src/components/theme.ts` exposes a `useTableColors()` hook that returns the right static palette (`lightColors`/`darkColors`) for the current appearance, with the choice persisted in `src/stores/themeSettings.ts`. This pulls in `react-native-paper` as a dependency (auto-paper is built on it), but no Paper UI components are used anywhere in the game screens - every card/button stays plain `View`/`Text`/`Pressable`.

Card and button taps go through [`@rific/feedback-press`](https://www.npmjs.com/package/@rific/feedback-press)'s `Pressable`, which fires a haptic on press; the Settings screen's "Sound effects" toggle controls this live via `useHapticSettings()`/`useSoundSettings()`. Illegal-move attempts (dropping a card somewhere it can't legally go) surface a brief toast via [`@rific/toaster`](https://www.npmjs.com/package/@rific/toaster).

The splash screen stays up until both the theme and app settings have loaded from AsyncStorage (`src/utils/splashGate.ts`, via [`@rific/splash-gate`](https://www.npmjs.com/package/@rific/splash-gate)), so nothing pops in a moment after first paint.

## Interaction model

Every game uses **tap-to-select** rather than drag-and-drop: tap a card (and any cards below it that form a legal run come along), then tap the destination pile. Tap the same card again to deselect. This was a deliberate simplification - a single robust interaction model that works identically across four very different board layouts (columns, a triangle, free cells) beat four bespoke drag-gesture implementations. `react-native-gesture-handler` and `react-native-reanimated` are already installed if you want to layer smoother drag gestures or animations in later.

## Running it

```bash
npm install
npx expo start
```

- Press `w` to open the web version in your browser (or run `npm run web`).
- Scan the QR code with the Expo Go app on your iPhone to run it there instantly, no Mac/Xcode needed for day-to-day development.
- `npm run ios` requires a Mac with Xcode installed (only needed for custom native code, which this project doesn't have yet).

## Testing

```bash
npm test          # jest - 70 tests across the engine + all 4 games' rules
npm run typecheck # tsc --noEmit
npm run lint      # eslint (expo lint .)
npm run ci        # lint && test && typecheck - same checks CI runs
```

## Publishing to the App Store

This project only uses the Expo-managed workflow (no custom native modules), so you can build and submit entirely through [EAS](https://docs.expo.dev/eas/):

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform ios
eas submit --platform ios
```

You'll need your Apple Developer account (which you already have) linked during `eas build:configure`. The web build can be exported as a static site and hosted anywhere:

```bash
npx expo export --platform web
# static site output lands in dist/
```

## What's implemented vs. what's next

Implemented: all 4 games fully playable end-to-end (deal, legal moves, win detection, undo, timer, per-game win/streak stats, Klondike draw-1/draw-3 and Spider 1/2/4-suit difficulty settings).

Not yet built (ideas for later): drag gestures/animations, card-flip/win-celebration animations, actual sound *audio* (the settings toggle currently drives haptic feedback only - see [Theming & feedback](#theming--feedback) - wiring real sound effects needs `expo-audio` plus sound assets this project doesn't have yet), hint button (the rules layer already exposes `legalMoves`, just needs a "show me a move" UI), local multiplayer (parked as a phase 2 - likely a head-to-head timed race using a peer-to-peer connection so it stays server-free).

## License

The code is released under the MIT License, see [LICENSE](LICENSE).

The game's name, logo, and icons, and the original artwork and audio in this repository, are not covered by that license and remain all rights reserved. If you fork it, please give your version its own name and look.
