import React, { useEffect, useRef } from 'react'
import { StyleProp, View, ViewStyle } from 'react-native'

import { PileRef } from '@/engine/gameTypes'

import { DropZoneRegistry } from './DropZoneRegistry'

interface DropZoneProps {
  registry: DropZoneRegistry
  pileRef: PileRef
  style?: StyleProp<ViewStyle>
  /** False: drawn, but not a drop target (a covered Pyramid/TriPeaks card, kept in the same element tree as when it is
   * exposed so its painted face survives the change - see those screens). Default true. */
  enabled?: boolean
  children?: React.ReactNode
}

/** Wraps a pile container (tableau column, foundation slot, ...) and registers its live screen rect as a drop target. */
export function DropZone({ registry, pileRef, style, enabled = true, children }: DropZoneProps) {
  const viewRef = useRef<View>(null)

  useEffect(() => {
    if (!enabled) return
    registry.register(pileRef, viewRef)
    return () => registry.unregister(pileRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, pileRef.zone, pileRef.index, enabled])

  return (
    <View ref={viewRef} style={style}>
      {children}
    </View>
  )
}
