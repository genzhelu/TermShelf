import { useAppStore } from '../state/appStore'

/** Drag handle between the file sidebar and the terminal area. */
export function SidebarResizer(): React.JSX.Element {
  const sidebarWidth = useAppStore((state) => state.sidebarWidth)
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth)
  const persistUi = useAppStore((state) => state.persistUi)

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    document.body.classList.add('is-resizing')
    const move = (moveEvent: PointerEvent): void => {
      setSidebarWidth(startWidth + (moveEvent.clientX - startX))
    }
    const up = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
      persistUi()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file browser"
      data-testid="sidebar-resizer"
      onPointerDown={startResize}
      onDoubleClick={() => {
        setSidebarWidth(320)
        persistUi()
      }}
    />
  )
}
