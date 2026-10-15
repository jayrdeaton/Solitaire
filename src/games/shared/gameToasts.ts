import { type useToast } from '@rific/toaster'

type InfoToast = ReturnType<typeof useToast>['info']

/** The toast a pressed Hint shows when there is nothing to suggest (an Auto Hint says nothing), with the Hint button's own light bulb switched off. */
export function showNoHintToast(info: InfoToast) {
  info('No helpful moves right now.', undefined, undefined, { icon: 'lightbulb-off-outline' })
}
