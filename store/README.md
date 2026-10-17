# App Store

Everything the iOS listing needs. The text lives in `store.config.json` (repo root), which `eas metadata:push` sends to App Store Connect. The rest is set by hand in App Store Connect once and carries over to later versions.

## Pushed by EAS Metadata (`store.config.json`)

Title, subtitle, promotional text, description, keywords, marketing/support/privacy URLs, copyright, categories (Games > Card, Casual) and the age rating answers (all None, so 4+).

```bash
eas metadata:lint
```

```bash
eas metadata:push
```

`push` needs the app record to exist in App Store Connect and edits the version matching `app.json`'s `expo.version`. The first `eas submit` creates the record (named by `eas.json`'s `submit.production.ios.appName`) when you sign in with your Apple ID. Apple's API can't create apps, so with an API key create it first: My Apps > + > New App, bundle ID `com.infinitetoken.solitaire`, name `SolitaireTastic`, primary language English (U.S.).

Limits: title 30, subtitle 30, promotional text 170 (editable any time without review), description 4000, keywords 100 in total with the commas. Keywords don't repeat words already in the title or subtitle ("solitaire", "games", "ads" are indexed from the subtitle; "SolitaireTastic" is one word, so it does NOT match a search for "solitaire" on its own).

`releaseNotes` (What's New) is left out for the first version, which has none. Add it to `info.en-US` for every later version.

## Screenshots (uploaded by hand)

`store/screenshots/iphone/` (6.9", 1320x2868) and `store/screenshots/ipad/` (13", 2064x2752). Apple scales these to every smaller device, so these two sets are all it asks for. The iPad set is required because `ios.supportsTablet` is on. The order in the folder is the upload order; the first three are what search results show.

The PNGs are build output and are gitignored, along with the raw captures they were made from (`store/screenshots/raw/`). The captions are in `store/screenshots.json`.

How they were made (2026-10-17): a Release build on the iPhone 17 Pro Max and iPad Pro 13" (M5) simulators, status bar pinned to 9:41 with full battery, dark appearance. The saved data was written before first launch (sound off, guide seen, three weeks of stats from a Hint-following player on the real rules and stats engine, and saved boards for Klondike, Yukon and a FreeCell one play from its finish), so every number on screen is one the app produced. The hint and win shots are frames from a screen recording. A compositor puts each capture under its caption in DejaVu Serif Bold, on the felt color sampled from the capture. The tools (simulator setup, the slim build, frame picking, the compositor) are in Jay's `app-store-prep` skill; the Solitaire-specific seeding is here in `store/seed/`.

To redo them:

1. `node store/seed/generate.mjs` (writes `store/seed/seed.json`, gitignored)
2. Build and install a Release copy on the `AppStore iPhone 6.9` and `AppStore iPad 13` simulators (the skill's `sim-build.sh` and `sim-setup.sh --app`)
3. `store/seed/reseed.sh <udid>` on each, then capture into `store/screenshots/raw/<device>/<name>.png`:
   - **01-klondike:** open Klondike (the saved board), draw one card so Undo lights up
   - **02-home:** Home as it opens
   - **03-win:** open FreeCell, record, play the 4♣ to its foundation; use a frame once every card chain is mid-bounce (10 to 25 s in), not the start
   - **04-hint:** open Yukon, record, press Hint; use the frame where the see-through 6♣ 5♥ 4♣ is halfway to the 7♥
   - **05-stats:** the trophy on Home, scrolled to a stretch of achievements with bronze, silver, gold and locked rows
   - **06-style:** `store/seed/reseed.sh <udid> --style '#009688'`, open Pyramid (a fresh deal), draw one card
4. The skill's `compose.mjs store/screenshots.json`

## Set by hand in App Store Connect

**App Privacy:** "No, we don't collect data from this app" (Data Not Collected). Nothing leaves the device except the Expo update check, which carries no personal data (the app version, platform and a random installation ID used to serve the right update), and there is no tracking, so no App Tracking Transparency prompt either. This matches the privacy policy at https://games.infinitetoken.com/privacy. Revisit it if analytics, crash reporting, ads or accounts are ever added.

**App Review Information:** sign-in not required. Contact: name, email and phone (the phone stays out of `store.config.json`, which is public). Notes:

> No account or sign-in is needed, and there are no in-app purchases or ads.
>
> The app turns its own screen using the motion sensor, so the system orientation stays portrait and the app runs full screen on iPad. Turn the device to see the landscape layout. Lock Orientation is in Settings (the cog on the Home screen).
>
> Player profiles are shared through an App Group with other Tastic games by the same developer, if any are installed. No profile, progress or other game data leaves the device.
>
> On first launch a three-card How to Play guide appears. Tap Skip to go straight to the games.

**Content Rights:** yes, the app contains third-party content, and the rights are covered: the card artwork is based on SVG-cards by David Bellot and Huub de Beer (LGPL-2.1, credited in Settings), and the card font is DejaVu Serif (Bitstream Vera license).

**Pricing and Availability:** Free, all territories.

**Export compliance:** already answered by `ITSAppUsesNonExemptEncryption: false` in `app.json`, so App Store Connect doesn't ask.

**Accessibility (optional):** leave blank until each feature has been checked on a device. Apple asks per feature (VoiceOver, Larger Text, Dark Interface, Reduced Motion and so on), and a claim that doesn't hold up is worse than none.

**Version release:** automatic after approval, or manual (you press Release). Manual is the safer choice for the first version.

## Shipping a version

1. `npm run verify`
2. `jrd ship build production`
3. `eas submit -p ios --profile production` (uploads the build to TestFlight)
4. `eas metadata:push`
5. Upload the screenshots if they changed
6. In App Store Connect: pick the build, fill in anything new above, and Add for Review
