import type { ConfigContext, ExpoConfig } from 'expo/config'

// The web build is served at games.infinitetoken.com/<game>/, beside the other Tastic games, so they share one origin
// (and one browser storage, where @tastic/profile keeps the shared player roster on web). build:web sets WEB_BASE_URL
// to that path and Expo prefixes every URL in the export with it. It stays out of app.json because a base URL also
// reaches native bundles, asset paths and EAS updates, which must keep running from the root.
export default ({ config }: ConfigContext): ExpoConfig => {
  const baseUrl = process.env.WEB_BASE_URL
  return (baseUrl ? { ...config, experiments: { ...config.experiments, baseUrl } } : config) as ExpoConfig
}
