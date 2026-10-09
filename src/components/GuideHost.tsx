import { useIsTouchPrimaryDevice, useRotation } from '@tastic/core'
import { GuideProvider } from '@tastic/hud/guide'
import { type ReactNode, useCallback, useMemo } from 'react'
import { useDispatch, useSelector } from 'react-redux'

import { GUIDE_VERSION } from '@/constants/guide'
import { getGuideSteps } from '@/constants/guideSteps'
import { guideActions, selectGuideVersionSeen } from '@/redux/guideSlice'
import type { RootState } from '@/redux/store'

interface Props {
  children: ReactNode
}

// Wires @tastic/hud/guide's provider to this app: the persisted "seen" version out of Redux, this
// app's own card content, and the live rotation. Mounted once in _layout.tsx, wrapping the screen
// stack, so Home can reach it through useAutoShowGuide() and Home's Settings "How to Play" row through
// useGuide() without prop-drilling.
//
// The card renders through Paper's Portal, which lands in the nearest Portal.Host above this one:
// FeedbackPressProvider's own (FeedbackBridge passes it paper={RNPaper}, and it wraps its children in
// paper.Portal.Host). That host is OUTSIDE every rotated frame, so unlike Home's own dialogs (portaled
// into RotatedScreen's in-frame host and told rotation={0}) the card can't inherit the frame's turn and
// has to be handed it. It reads the same useRotation() that turns Home's frame (RotatedFrame), so it
// sits at the angle Home's Settings dialog visually does; Lock Orientation needs no argument here (_layout.tsx's
// OrientationBridge freezes the provider's one shared reading with freezeWhileLocked). `children` is the stable element _layout passes in, so a tilt-driven re-render
// here never re-renders the stack under it.
//
// The card is laid out against the PORTRAIT window even when turned, so hud sizes a quarter-turned card
// against the swapped window itself (getGuideCardSize), and a page that still doesn't fit scrolls. Short
// bodies (two lines each in constants/guideSteps.tsx) keep that scroll from ever being needed at the
// default text size.
export function GuideHost({ children }: Props) {
  const rotation = useRotation()
  const touch = useIsTouchPrimaryDevice()
  const seenVersion = useSelector((state: RootState) => selectGuideVersionSeen(state))
  const dispatch = useDispatch()

  const steps = useMemo(() => getGuideSteps({ touch }), [touch])
  const onSeen = useCallback((version: number) => dispatch(guideActions.markSeen(version)), [dispatch])

  return (
    <GuideProvider steps={steps} currentVersion={GUIDE_VERSION} seenVersion={seenVersion} onSeen={onSeen} rotation={rotation}>
      {children}
    </GuideProvider>
  )
}
