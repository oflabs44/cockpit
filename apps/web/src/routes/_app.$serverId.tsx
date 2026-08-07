import { createFileRoute, Link, Outlet, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { ServerNotFoundError, serverDetailQueryOptions } from '#/api/server-detail'

export const Route = createFileRoute('/_app/$serverId')({
  loader: async ({ context, params }) => {
    // The bar's breadcrumb (docs/design.md §4.2) needs the server's name, which is only
    // known after this resolves — returned here so `_app.tsx` can read it off the match's
    // `loaderData` instead of `staticData.title`. Also warms the cache entry every child
    // route (Overview, and later Projects/Resources/Firewall/Settings) reads via
    // `useSuspenseQuery(serverDetailQueryOptions(serverId))` — one fetch per server, not
    // one per tab.
    const detail = await context.queryClient.ensureQueryData(serverDetailQueryOptions(params.serverId))
    return { title: detail.server.name }
  },
  pendingComponent: ServerDetailPending,
  errorComponent: ServerDetailError,
  component: ServerLayout,
})

function ServerDetailPending() {
  return (
    <div className="empty">
      <p className="empty-body">Loading server&hellip;</p>
    </div>
  )
}

function ServerDetailError({ error }: ErrorComponentProps) {
  const router = useRouter()

  if (error instanceof ServerNotFoundError) {
    return (
      <div className="empty">
        <h2 className="empty-title">No such server</h2>
        <p className="empty-body">{error.message}.</p>
        <div className="empty-actions">
          <Link to="/" className="btn btn-ghost btn-lg">
            Back to servers
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t reach the plane</h2>
      <p className="empty-body">{error.message}. Check that the plane is running.</p>
      <div className="empty-actions">
        {/* invalidate() re-runs the loader and resets this boundary; a plain boundary reset
            would keep the errored query and dead-end the screen. */}
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

const tabActiveProps = { 'aria-current': 'page' as const }

function ServerLayout() {
  const { serverId } = Route.useParams()
  // The staleness banners live here, not in Overview: a deleted or unreachable server is a
  // fact about the whole section, and a tab that renders without the warning implies all is
  // well. `useSuspenseQuery` reads the entry the loader warmed; a failed background refetch
  // keeps cached data and surfaces as `error` without throwing.
  const { error } = useSuspenseQuery(serverDetailQueryOptions(serverId))

  return (
    <>
      {/* A refetch 404 means the server was deleted while this page was open — saying
          "plane unreachable" for that would blame the wrong thing. */}
      {error instanceof ServerNotFoundError ? (
        <p className="server-note" role="alert">
          This server no longer exists on the plane &mdash; the data below is its last known state.
        </p>
      ) : error ? (
        <p className="server-note" role="alert">
          Refresh failed ({error.message}) &mdash; this page may be stale.
        </p>
      ) : null}

      <nav className="tabs">
        <Link
          to="/$serverId"
          params={{ serverId }}
          activeOptions={{ exact: true }}
          activeProps={tabActiveProps}
        >
          Overview
        </Link>
        {/* Projects and Resources are siblings inside the server, which is what makes the
            scoping legible: a database is a thing on THIS box, and a project binds to it.
            Neither floats free of the machine (prototype/server.html). */}
        <Link to="/$serverId/projects" params={{ serverId }} activeProps={tabActiveProps}>
          Projects
        </Link>
        <Link to="/$serverId/resources" params={{ serverId }} activeProps={tabActiveProps}>
          Resources
        </Link>
        <Link to="/$serverId/firewall" params={{ serverId }} activeProps={tabActiveProps}>
          Firewall
        </Link>
        <Link to="/$serverId/settings" params={{ serverId }} activeProps={tabActiveProps}>
          Settings
        </Link>
      </nav>
      <Outlet />
    </>
  )
}
