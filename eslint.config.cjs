module.exports = [
  ...require('@infinitetoken/eslint-config/expo'),
  // react-native/no-unused-styles is disabled project-wide: it's structurally blind to this app's
  // theming pattern, not a signal about real dead styles. The rule (eslint-plugin-react-native's
  // no-unused-styles, see its util/stylesheet.js) only recognizes a style sheet when a
  // StyleSheet.create(...) call is the direct initializer of a variable declarator (const styles =
  // StyleSheet.create({...})) - it reads the sheet's "name" off that declarator's own `id`. Every
  // themed screen/component in this app instead does `const styles = useMemo(() => makeStyles(colors),
  // [colors])`, where StyleSheet.create(...) is the return statement of a separate factory function -
  // its parent node is a ReturnStatement, which has no `.id`, so the rule resolves the sheet's name
  // as literally `undefined` (visible directly in its own messages: "Unused style detected:
  // undefined.foo") and can never match it against the real `styles.foo` usages it finds elsewhere,
  // which it tracks under the name `styles`. Confirmed live: every key in every makeStyles(colors)
  // sheet across the app was flagged this way, including keys referenced exactly once, directly, as
  // `style={styles.foo}` a few lines below - the simplest possible usage the rule is supposed to
  // catch. Since makeStyles(colors) is the whole app's theming mechanism (colors come from the
  // selected player's profile, see components/theme.ts) and the factory-plus-useMemo shape is what
  // makes that reactive without rebuilding the sheet on every render, this isn't something to
  // refactor away to satisfy a lint rule's blind spot - and blindly deleting the "unused" styles it
  // reports would delete real, load-bearing styles and break the UI. HeroCards.tsx's plain top-level
  // `const styles = StyleSheet.create(...)` (no theming needed there) is the one place this rule
  // would still add value - lost here too, since flat config rule overrides can't be conditioned on
  // which shape a file happens to use, only on file globs. Worth revisiting only if this app moves
  // off the makeStyles(colors) pattern, or if a future rule version resolves StyleSheet.create's
  // name through a factory-function return.
  {
    rules: {
      'react-native/no-unused-styles': 'off'
    }
  },
  // @tastic/hud's main entry also re-exports the per-seat lobby and the Skia gauge, so one import from
  // it would bring back @shopify/react-native-skia and @tastic/split-screen, which this app doesn't
  // install. Everything Solitaire uses is in the light './chrome' entry (and './guide').
  // src/__tests__/hudImports.test.ts also covers jest.mock() and require(), which this rule doesn't see.
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tastic/hud',
              message: "Import from '@tastic/hud/chrome' instead. The main entry pulls in Skia and @tastic/split-screen."
            }
          ]
        }
      ]
    }
  }
]
