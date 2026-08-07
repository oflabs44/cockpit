import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'

const queryClient = new QueryClient()

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  // Router's own SWR cache defaults preloaded data fresh for 30s; TanStack Query is already
  // doing that caching (its own staleTime), so this avoids two caches disagreeing about
  // freshness — the router should always re-ask Query rather than short-circuit on its own.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
  interface StaticDataRouteOption {
    // Each `_app.*` route's crumb/title text — the bar renders the deepest match's
    // title instead of a separate <h1> (docs/design.md §4.2). Optional: the root and
    // `_app` layout routes carry no staticData at all.
    title?: string
  }
}

const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}
