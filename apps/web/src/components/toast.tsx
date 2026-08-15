import { Toast } from '@base-ui/react/toast'

// Base UI's Toast, styled in components.css like every other component here. The compound
// parts are assembled once, below; callers reach for `toast` instead.
//
// The global manager rather than the hook: `useToastManager()` subscribes to the toast
// list, so a component that only ever adds would re-render on every add, height
// measurement and hover expansion. This one lives outside React and only adds.
const manager = Toast.createToastManager()

// Two variants, because the plane only ever tells the operator that something worked or
// that it didn't. `type` is Base UI's own field and surfaces as `[data-type]` on the root,
// so the variant needs no prop of its own.
export const toast = {
  success: (title: string) => manager.add({ title, type: 'success' }),
  /**
   * Errors stay until dismissed: a message explaining why something failed should still be
   * there when the operator looks back at the screen. `id` is what stops a repeated
   * failure — five clicks against a plane that is down — stacking five permanent toasts:
   * adding with an existing id updates that toast in place.
   */
  error: (id: string, title: string) =>
    manager.add({ id, title, type: 'error', timeout: 0, priority: 'high' }),
}

/** Wraps the app: the viewport renders here, and every toast added anywhere lands in it. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={manager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()

  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="toast">
      <Toast.Content className="toast-content">
        {/* The mono tag and the sans sentence of a Notice (docs/design.md §5.2). No error
            code to put in the gutter yet — the plane's messages arrive as prose. */}
        <span className="toast-tag">{toast.type === 'error' ? 'error' : 'ok'}</span>
        <Toast.Title className="toast-title" />
        <Toast.Close className="btn btn-ghost btn-sm" aria-label="Dismiss">
          Dismiss
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ))
}
