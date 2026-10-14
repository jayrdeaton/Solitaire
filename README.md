# Solitaire

Eleven classic solitaire games in one ad-free app, from Klondike and FreeCell to Pyramid and Aces Up.

Solitaire (SolitaireTastic on the App Store) is a single-player card game collection for iPhone, iPad, Android, and web, with no ads and no accounts. Built with Expo, React Native, Reanimated, and Redux Toolkit, it's part of a family of games built on my open-source `@tastic` game-engine and `@rific` Expo utility packages. App Store and Google Play release in progress.

<!-- TODO: add gameplay GIF/screenshot here -->

## Features

- **Eleven games:** Klondike, FreeCell, Yukon, Canfield, Forty Thieves, Spider, Scorpion, Pyramid, Golf, TriPeaks, and Aces Up. Each Home tile shows a thumbnail of the game's opening deal, and its rules are one tap away (the info button on the tile, or the game's title during play).
- **Rule variants:** Draw 1 or Draw 3 for Klondike and Canfield, 1, 2, or 4 suits for Spider, No Wrap or K-A Wrap for Golf and TriPeaks, Assisted or Classic for Scorpion (Assisted holds three cards back to deal in later), and Single Card or Allow Runs for Forty Thieves. Each is set from that game's Settings dialog.
- **Tap or drag:** tap a card to send it to its best move, or drag it (along with the cards on top of it, where the rules allow) to the pile you want. In Pyramid, tap two exposed cards that add up to 13, or a lone King. A tapped card with nowhere to go shakes, and an illegal drop springs back.
- **Undo, Hint, and New Game:** undo has no limit, and holding Undo keeps rewinding one move at a time. Hint rings a legal move, or the stock when drawing is the move. New Game asks for confirmation before abandoning a deal in progress.
- **Scoring:** score is moves plus seconds, and lower is better. The clock starts on the first move and pauses while the game is left, the app is in the background, or Rules or Settings is open. Every move counts, including one later undone and every card auto-played to the foundations (so Auto-Move only saves taps); an Undo press and a hint are free. Each game and rule set (Spider 1/2/4 suits, Klondike Draw 1/3, and so on) has a par, a good win's moves, time, and score, from a simulated Hint-following player; a win shows Moves, Score, and Time, each over its par.
- **Auto-play:** with Auto-Move to Foundation on, safe cards follow your own play to the foundations, and a solved board files itself away (Klondike, FreeCell, Yukon, Canfield, Forty Thieves). Spider clears a completed suit run on its own.
- **Dead-end detection:** Aces Up, Golf, TriPeaks, Forty Thieves, and Scorpion show No Moves Left, with an Undo button, when a deal can no longer be won. The loss is recorded when the player deals a new game or leaves; an Undo cancels it.
- **Win celebration:** fireworks and a bouncing card cascade.
- **Card styles:** four faces (Compact, Numeric, Decorated, Tarot) and three backs (Geometric, Ornate, Plain), plus an Invert Dark Mode Colors option that gives dark mode near-black faces with white ink for spades and clubs. The card artwork is based on SVG-cards by David Bellot and Huub de Beer (LGPL-2.1), with numerals in DejaVu Serif.
- **Player profiles:** pick a profile on Home and its color tints the card backs, the felt, and the app theme. Guests can pick a table color of their own. On iOS the roster is shared with my other games through an App Group.
- **Stats and achievements:** a Stats & Achievements screen with overall, per game and rule set (played, won, lost, streak, and fastest, fewest moves and lowest score next to par), and daily activity records, viewable for all profiles or one, plus 41 bronze/silver/gold achievements.
- **Picks up where you left off:** every game's board and undo history are saved, and relaunching the app reopens the game you were playing.
- **Turns with the phone:** the layout follows the device into portrait or a wide landscape layout, with an app-wide Lock Orientation setting.
- **How-to-play guide:** three short cards on first launch, replayable from Settings on Home.
- **Settings:** sound, haptics, appearance, Lock Orientation, Auto-Move to Foundation, Dim Unplayable Cards, Invert Dark Mode Colors, Reduce Motion (skips the deal and draw animations), card face and back styles, and a manual update check.

## Under the hood

- **Pure rules layer:** every game's `rules.ts` implements one `GameController<TState>` contract (`src/engine/gameTypes.ts`): `newGame(seed)`, `legalMoves`, `tryMove`, `drawStock`, `isWon`, `isStuck`, plus optional hooks for tap-to-move, hint ranking, and auto-play. States are immutable and moves return a new state or `null`. Deals are shuffled by a seeded mulberry32 PRNG, so a seed always reproduces the same deal in tests. Shared engine code covers decks and piles, scoring, tap-to-move target picking, safe auto-play to the foundations, and hints, which rank the game's own `legalMoves` instead of running a separate solver.
- **Three flight systems:** card motion is split by job. A single drag ghost layer handles drags and tap-to-move, using registries of on-screen card and drop-zone positions. A separate deal layer flies many cards at once (the opening deal, stock draws, undo returns) and can be skipped with a tap. A third layer runs the win cascade. Each game's `dealSequence.ts` decouples the visual deal order from how the rules store the board.
- **Pre-rendered card faces:** a live card face is over a dozen native views, so `scripts/generate-card-face-bitmaps.mjs` renders `@tastic/cards`' real `CardFace` through react-native-web in headless Chrome and saves every face as a PNG (4 styles, 2 ink variants, 52 cards), and the Home thumbnails the same way. On the board each face is one `Image`, and a landing card's flight stays on top until that bitmap has actually painted, so a card never flashes blank.
- **Rotation without rotating the OS:** the native window stays portrait (`@tastic/core`'s config plugin), and `OrientationProvider` reads `expo-sensors` device motion to turn the whole screen frame instead. Dialogs portal into a host inside the turned frame so they lay out at the right angle.
- **State and persistence:** Redux Toolkit with redux-persist on AsyncStorage holds settings, theme, sound and haptics, profiles, table color, stats and achievements, and guide state. Each game's saved board lives under its own key, and saves are coalesced (written once moves pause, at most every 3 seconds during a long burst) and flushed when the app goes to the background. A persist `migrate` recognizes players from the pre-Redux build so they skip the guide.
- **Stats:** `@tastic/achievements` records every win, loss (an abandoned deal or a dead board), and hint into device-wide and per-profile buckets, and the 41-entry catalog is evaluated as pure predicates over those stats.
- **Sound:** card sounds play from pooled `expo-audio` players through `@rific/feedback-press`, with a separate web implementation to avoid audio element latency, and a short throttle so skipping a deal plays a riffle instead of dozens of overlapping clicks.
- **Updates:** over-the-air updates ship through `expo-updates` and `@rific/updater`.
- **Tests:** 105 Jest suites with 1,770 tests covering the engine, every game's rules, board models and deal order, screen-level win, undo, and auto-play flows, the deal, drag, and win-cascade layers, card-face bitmaps, the stats engine, Redux slices and persist migration, saved games, profiles, and the guide copy. CI runs `npm run verify` on pushes and pull requests to `main`.

## Built on

| Package | Used for |
| --- | --- |
| [`@tastic/core`](https://github.com/jayrdeaton/React-Native-Game-Core) | Orientation provider and rotation hooks, themed root background, config plugin for the native portrait lock |
| [`@tastic/cards`](https://www.npmjs.com/package/@tastic/cards) | Card faces, backs, and the decorated art pack, card size context, shared card vocabulary |
| [`@tastic/hud`](https://www.npmjs.com/package/@tastic/hud) | Rotated frame, settings and update dialogs, stats screen rows, popovers and color picker, how-to-play guide |
| [`@tastic/profile`](https://www.npmjs.com/package/@tastic/profile) | Player profiles, picker, roster screen, shared App Group sync |
| [`@tastic/achievements`](https://www.npmjs.com/package/@tastic/achievements) | Tiered achievement catalog, win and day streaks, Redux-backed persistence |
| [`@tastic/animations`](https://www.npmjs.com/package/@tastic/animations) | Fireworks on a win |
| [`@tastic/split-screen`](https://www.npmjs.com/package/@tastic/split-screen) | Peer dependency of `@tastic/hud` |
| [`@rific/core`](https://www.npmjs.com/package/@rific/core) | Redux settings slice factory, safe back navigation |
| [`@rific/auto-paper`](https://www.npmjs.com/package/@rific/auto-paper) | React Native Paper theming from the profile color, light/dark appearance |
| [`@rific/feedback-press`](https://www.npmjs.com/package/@rific/feedback-press) | Buttons with haptic and sound feedback, pooled card sounds |
| [`@rific/toaster`](https://www.npmjs.com/package/@rific/toaster) | Toast notifications (no moves for a hint, update errors) |
| [`@rific/splash-gate`](https://www.npmjs.com/package/@rific/splash-gate) | Keeps the splash screen up until the theme, fonts, and profiles are ready |
| [`@rific/updater`](https://www.npmjs.com/package/@rific/updater) | OTA update checks and the build/update scripts |
| [`@rific/focus-chain`](https://www.npmjs.com/package/@rific/focus-chain) | Peer dependency of `@tastic/profile` for form focus |

## Getting started

```bash
npm install
npm run ios        # or: npm run android / npm run web
```

The app uses native code that Expo Go doesn't include (the `@tastic/core` config plugin and `@tastic/profile`'s native iOS shared-roster module), so iOS and Android run as a development build (`expo-dev-client`). `npm run ios` and `npm run android` build it locally, and once it's installed `npm run client` starts Metro for it. `npm install` also runs `setup-skia-web`, which copies Skia's `canvaskit.wasm` into `public/` for the web target.

### Checks

```bash
npm run verify     # lint (expo lint) + Jest + typecheck (tsc)
```

## Project layout

```
src/
  app/          expo-router routes: home, one screen per game, achievements, profiles
  components/   playing cards and piles, drag, deal, and win-cascade layers, game chrome, dialogs, theme, guide art
  constants/    per-game rules copy, guide steps, theme seed, release info
  engine/       shared card engine: deck, piles, seeded RNG, hints, auto-move, auto-play, scoring
  games/        one folder per game (rules, board model, deal order, screen, settings), plus shared hooks and cells
  hooks/        settings hook
  redux/        store and persisted slices (settings, saved games, achievements, profiles, table color, guide)
  stores/       stats engine, achievement catalog, saved-game and profile APIs
  types/        persisted settings type
  utils/        navigation and splash-gate wiring
  testUtils/    test helpers
  __tests__/    Jest suites
  __mocks__/    manual mocks for native and Expo modules
```

## License

The code is released under the MIT License, see [LICENSE](LICENSE).

The game's name, logo, and icons, and the original artwork and audio in this repository, are not covered by that license and remain all rights reserved. If you fork it, please give your version its own name and look.

The card artwork derived from [SVG-cards](https://github.com/htdebeer/SVG-cards) (David Bellot and Huub de Beer) is not original to this project and remains under the LGPL-2.1, see the [artwork notice](https://github.com/jayrdeaton/React-Native-Cards/blob/main/src/artwork/NOTICE.md) in `@tastic/cards`.
