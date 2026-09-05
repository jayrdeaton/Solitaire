import React, { useEffect, useRef } from 'react'
import { StyleProp, View, ViewStyle } from 'react-native'

import { PileRef } from '@/engine/gameTypes'

import { DropZoneRegistry } from './DropZoneRegistry'

interface DropZoneProps {
  registry: DropZoneRegistry
  pileRef: PileRef
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}

/** Wraps a pile container (tableau column, foundation slot, ...) and registers its live screen rect as a drop target. */
export function DropZone({ registry, pileRef, style, children }: DropZoneProps) {
  const viewRef = useRef<View>(null)

  useEffect(() => {
    registry.register(pileRef, viewRef)
    return () => registry.unregister(pileRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, pileRef.zone, pileRef.index])

  return (
    <View ref={viewRef} style={style}>
      {children}
    </View>
  )
}
