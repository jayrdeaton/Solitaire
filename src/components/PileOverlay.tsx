import React from 'react'
import { StyleSheet, View } from 'react-native'

const styles = StyleSheet.create({ hidden: { opacity: 0 }, layer: { pointerEvents: 'none' } })

/** The layer a single-card pile (foundation, discard, waste, reserve) draws over its real card while a flight is landing
 * there: the card from before the flight (or the one that has landed so far). Kept mounted and invisible the rest of the
 * time, showing the pile's current card, so that when a flight starts the same Image simply becomes visible, already
 * painted - mounting it then showed a blank face for a frame or two at the start of the flight (React Native loads a new
 * Image's bitmap asynchronously - see cardFacePaint.ts). For the same reason it is also made visible, over the hidden real
 * card, while a slot reveals the card a take-off uncovered (useTakeOffHold's `revealing`): the real card's Image has just
 * been re-sourced from the departed card and would show that card's stale bitmap, while this one has been showing the new
 * top since the move's own commit. Never touchable (its card must be `disabled` too: on web a Pressable inside still
 * takes clicks and Tab focus), and hidden from assistive tech while invisible. A face-down pile (the stock) doesn't need
 * it: a back is SVG, drawn in the frame it mounts. */
export function PileOverlay({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.layer, !visible && styles.hidden]} aria-hidden={!visible}>
      {children}
    </View>
  )
}
