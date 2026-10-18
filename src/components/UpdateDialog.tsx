import { useToast } from '@rific/toaster'
import { UpdateDialog as SharedUpdateDialog } from '@tastic/hud/chrome'

export function UpdateDialog() {
  const { error } = useToast()
  return <SharedUpdateDialog onError={(message) => error('Update check failed', message)} />
}
