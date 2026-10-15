import { useAutoPaperTheme } from '@rific/auto-paper'
import { type ToastCardProps, Toaster, type ToastLevel } from '@rific/toaster'
import { useRotatedWindowDimensions } from '@tastic/core'
import { OverlayCard } from '@tastic/hud'
import { useMemo } from 'react'
import { StyleSheet } from 'react-native'
import { Icon } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/** Where the corner buttons' real box starts below the frame's top inset: their nominal 8 plus react-native-paper's IconButton margin (6), the same
 * line GameChrome's title is laid out on. The pill is as tall as they are (40), so the three read as one row. */
export const TOAST_TOP = 14
/** Each side's clearance from the frame's edge (plus that side's inset): the corner buttons end at 54, and GameChrome's title starts at 60. */
export const TOAST_SIDE_CLEARANCE = 60
/** A wide frame (a phone held sideways, an iPad) caps the pill at the dialogs' own card width. */
export const TOAST_MAX_WIDTH = 360

/** The outline icon each level shows, the same outline set the dialog headers use. A toast can still bring its own (useToast's overrides). */
export const TOAST_LEVEL_ICONS: Record<ToastLevel, string> = {
  error: 'alert-circle-outline',
  info: 'information-outline',
  success: 'check-circle-outline',
  warning: 'alert-outline'
}

/** The toast stack's place in the rotated frame: in the top chrome band, between the two corner buttons (Home and Settings on a game, the trophy
 * and the cog on Home), where a game's title is. Down there it sat on the footer, so the "No helpful moves" toast covered Undo, the very button
 * the player wanted next (Jay, 2026-10-15). Centred between the clearances and capped at TOAST_MAX_WIDTH. */
export function toastStackFrame(width: number, insets: { left: number; right: number }): { left: number; right: number; marginTop: number } {
  const start = TOAST_SIDE_CLEARANCE + insets.left
  const end = width - TOAST_SIDE_CLEARANCE - insets.right
  const pillWidth = Math.min(TOAST_MAX_WIDTH, Math.max(0, end - start))
  const left = start + (end - start - pillWidth) / 2
  return { left, marginTop: TOAST_TOP, right: width - left - pillWidth }
}

// The card is hud's OverlayCard, the surface every dialog here is drawn on (untinted, and blurring what's behind it while the player's Blur
// setting is on), so a toast is one of the same family. The toaster's own card style (a row, its padding and the pill shape below) is laid
// over OverlayCard's dialog padding and corner radius.
function ToastCard({ children, style }: ToastCardProps) {
  return <OverlayCard style={style}>{children}</OverlayCard>
}

// Paper's Icon, the one DialogHeader draws with (the toaster hands an icon component a `name`; Paper's takes it as `source`).
function ToastIcon({ color, name, size }: { color?: string; name: string; size?: number }) {
  return <Icon color={color} size={size ?? 20} source={name} />
}

/** The app's one toaster, laid over every screen in the root overlay frame (see _layout.tsx's RootOverlays). It must render inside that
 * RotatedFrame (with `rotatedSafeArea`): the frame width and the insets it reads are the turned frame's own. */
export function ThemedToaster() {
  const { colors, fonts } = useAutoPaperTheme()
  const insets = useSafeAreaInsets()
  const { width } = useRotatedWindowDimensions()
  const wrapperStyle = toastStackFrame(width, insets)
  // The icon takes the color the dialog headers do: the theme's primary, the danger role for an error.
  const levelColors = useMemo(() => ({ error: colors.danger, info: colors.primary, success: colors.primary, warning: colors.danger }), [colors.danger, colors.primary])
  const labelStyle = useMemo(() => [fonts.bodyMedium, styles.label], [fonts.bodyMedium])
  const captionStyle = useMemo(() => [fonts.bodySmall, styles.caption, { color: colors.onSurfaceVariant }], [colors.onSurfaceVariant, fonts.bodySmall])
  // clearButton/historyButton default to a "clear"/"history" chip stacked by the toasts - this app never surfaces a reason to dig through past
  // toasts or bulk-dismiss them, so both are turned off outright (passing null, not omitting the prop, is what suppresses the default).
  // limit is already 3 by default; passed explicitly so it doesn't silently drift with a future library bump.
  return <Toaster position='top' Card={ToastCard} Icon={ToastIcon} levelIcons={TOAST_LEVEL_ICONS} levelColors={levelColors} textColor={colors.onSurface} labelStyle={labelStyle} captionStyle={captionStyle} toastStyle={styles.card} wrapperStyle={wrapperStyle} clearButton={null} historyButton={null} limit={3} />
}

const styles = StyleSheet.create({
  // The caption's own color is the theme's muted text, not the toaster's 75% fade of the title's.
  caption: {
    opacity: 1
  },
  // A 40pt pill for one line, as tall as the corner buttons beside it, growing for a second line or a caption.
  card: {
    borderRadius: 20,
    gap: 8,
    marginHorizontal: 0,
    minHeight: 40,
    paddingLeft: 10,
    paddingRight: 14,
    paddingVertical: 10
  },
  // bodyMedium's font one size down (13/18), so "No helpful moves right now." stays on one line between the corner buttons of a 390pt phone.
  label: {
    fontSize: 13,
    lineHeight: 18
  }
})
