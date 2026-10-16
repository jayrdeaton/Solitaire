import { getProfilePickerContentSize, type ProfilePickerColorSection } from '@tastic/profile'

import { useFrameAutoAlign } from './useFrameAutoAlign'

/** Frame-aware placement for a `@tastic/profile` ProfilePicker inside a fake-rotated frame - pass the result as
 * its `alignOverride`. `open` is the picker's own popover id (`host.openId === `${idPrefix}-profile``);
 * `hasManageRow` mirrors whether the picker is given an `onManage`, and `colorSection` is the one handed to the
 * picker, since both are part of the popover's size. Sized with the package's own `getProfilePickerContentSize`,
 * so the two can't drift. */
export function useProfilePickerAlign(open: boolean, profileCount: number, hasManageRow: boolean, colorSection?: Pick<ProfilePickerColorSection, 'swatches' | 'caption'>) {
  const { width, height } = getProfilePickerContentSize(profileCount, hasManageRow, colorSection)
  return useFrameAutoAlign(open, width, height)
}
