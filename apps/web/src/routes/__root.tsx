import { lazy, Suspense } from 'react'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { ToastProvider } from '#/components/toast'

import '../styles.css'

// Injected from main.tsx so route loaders can call `context.queryClient.ensureQueryData(...)`
// without importing the client module-scope (the @tanstack/router-core package skill,
// data-loading: router context + DI is the canonical way to reach Query from a loader).
export interface RouterContext {
  queryClient: QueryClient
}

// Dynamically imported so `@tanstack/react-devtools` / `-router-devtools` never enter the
// production bundle — dev-only tooling, per devDependencies in package.json.
const Devtools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ TanStackDevtools }, { TanStackRouterDevtoolsPanel }] = await Promise.all([
        import('@tanstack/react-devtools'),
        import('@tanstack/react-router-devtools'),
      ])
      return {
        default: () => (
          <TanStackDevtools
            config={{ position: 'bottom-right' }}
            plugins={[{ name: 'TanStack Router', render: <TanStackRouterDevtoolsPanel /> }]}
          />
        ),
      }
    })
  : null

// Factory pattern — createRootRouteWithContext<T>() returns a function, so it takes two
// calls: the first fixes the context type, the second passes route options.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
})

function RootComponent() {
  return (
    <ToastProvider>
      <Outlet />
      {Devtools ? (
        <Suspense fallback={null}>
          <Devtools />
        </Suspense>
      ) : null}
    </ToastProvider>
  )
}
