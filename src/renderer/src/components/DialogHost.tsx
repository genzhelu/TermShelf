import { useAppStore } from '../state/appStore'
import { ConfirmDialog } from './dialogs/ConfirmDialog'
import { ConflictDialog } from './dialogs/ConflictDialog'
import { PromptDialog } from './dialogs/PromptDialog'
import { SettingsDialog } from './dialogs/SettingsDialog'
import { SshDialog } from './dialogs/SshDialog'

export function DialogHost(): React.JSX.Element | null {
  const dialog = useAppStore((state) => state.dialog)
  if (!dialog) return null

  switch (dialog.kind) {
    case 'ssh':
      return <SshDialog key={dialog.seed.profile?.id ?? 'new'} seed={dialog.seed} />
    case 'settings':
      return <SettingsDialog />
    case 'conflict':
      return <ConflictDialog request={dialog.request} conflicts={dialog.conflicts} />
    case 'confirm':
      return <ConfirmDialog options={dialog.options} />
    case 'prompt':
      return <PromptDialog options={dialog.options} />
    default:
      return null
  }
}
