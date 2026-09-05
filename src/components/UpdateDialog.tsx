import { useAutoPaperTheme } from '@rific/auto-paper'
import { Button } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { UpdateManifest, useUpdater } from '@rific/updater'
import { useCallback, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Icon, Text } from 'react-native-paper'

// Same icon-stacked-above-title, contained-and-stacked-button treatment as every other @tastic
// app's own UpdateDialog (BoxHockey, AirHockey, Pong, LightCycles) and as BaseSettingsDialog's own
// info overlay below, so an OTA prompt reads as the same kind of dialog as the rest of the fleet
// instead of the raw native Alert.alert (which can't see the in-app theme at all).
export function UpdateDialog() {
  const { dark, colors } = useAutoPaperTheme()
  const { error } = useToast()
  const [manifest, setManifest] = useState<UpdateManifest | null>(null)
  // Stashed between the manifest arriving (onConfirm below) and the user tapping a button -
  // bridges useUpdater's Promise-based confirm contract to this component's own visible/dismiss
  // state, which can only resolve later, off a press handler.
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null)

  const onConfirm = useCallback((next: UpdateManifest) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setManifest(next)
    })
  }, [])

  const respond = (confirmed: boolean) => {
    setManifest(null)
    resolveRef.current?.(confirmed)
    resolveRef.current = null
  }

  useUpdater({ onConfirm, onError: (message) => error('Update check failed', message) })

  if (!manifest) return null

  // High-contrast retro look, matching BaseSettingsDialog's own info overlay: literal black/white
  // by appearance, not auto-paper's own (slightly tinted) background role.
  const fg = dark ? '#FFFFFF' : '#000000'
  const cardBg = dark ? '#111111' : '#F2F2F2'
  const cardBorder = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'

  const date = new Date(manifest.createdAt)

  return (
    <View style={styles.overlay}>
      <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        <Icon source='update' size={64} color={colors.secondary} />
        <Text variant='headlineLarge' style={[styles.title, { color: colors.secondary }]}>
          Update Available
        </Text>
        <Text variant='bodyLarge' style={[styles.body, { color: fg }]}>
          Released {date.toLocaleDateString()} at {date.toLocaleTimeString()}
        </Text>
        <Button mode='contained' onPress={() => respond(false)} style={styles.button} buttonColor={colors.primary} textColor={colors.onPrimary}>
          Later
        </Button>
        <Button mode='contained' onPress={() => respond(true)} style={styles.button} buttonColor={colors.secondary} textColor={colors.onSecondary}>
          Restart
        </Button>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { textAlign: 'center' },
  button: { width: 160 },
  card: {
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: 1,
    gap: 16,
    padding: 32
  },
  overlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0
  },
  title: { fontWeight: 'bold' }
})
