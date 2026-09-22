import { getProfilePickerContentSize } from '@tastic/profile'

import { useFrameAutoAlign } from './useFrameAutoAlign'

/** Frame-aware placement for a `@tastic/profile` ProfilePicker inside a fake-rotated frame - pass the result as
 * its `alignOverride`. `open` is the picker's own popover id (`host.openId === `${idPrefix}-profile``);
 * `hasManageRow` mirrors whether the picker is given an `onManage`, since that row is part of the popover's size.
 * Sized with the package's own `getProfilePickerContentSize`, so the two can't drift. */
export function useProfilePickerAlign(open: boolean, profileCount: number, hasManageRow: boolean) {
  const { width, height } = getProfilePickerContentSize(profileCount, hasManageRow)
  return useFrameAutoAlign(open, width, height)
}
