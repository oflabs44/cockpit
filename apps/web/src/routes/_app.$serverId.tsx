import { createFileRoute, Link, Outlet, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { ServerNotFoundError, serverDetailQueryOptions } from '#/api/server-detail'
import { DOT_CLASS } from '#/components/server-card'
import type { CrumbSegment } from '#/routes/_app'

export const Route = createFileRoute('/_app/$serverId')({
  loader: async ({ context, params }): Promise<{ crumbs: CrumbSegment[] }> => {
    // The bar's breadcrumb (docs/design.md §4.2) needs the server's name and status, which
    // are only known after this resolves — returned here so `_app.tsx` can read them off the
    // match's `loaderData` instead of `staticData.title`. Also warms the cache entry every
    // child route (Overview, and later Projects/Resources/Firewall/Settings) reads via
    // `useSuspenseQuery(serverDetailQueryOptions(serverId))` — one fetch per server, not
    // one per tab.
    const detail = await context.queryClient.ensureQueryData(serverDetailQueryOptions(params.serverId))
    return {
      crumbs: [{ label: 'Servers' }, { label: detail.server.name, dot: DOT_CLASS[detail.server.status] }],
    }
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

      {/* The tab strip itself is rendered by _app.tsx, as a sibling of .bar/.content — same
          nesting as prototype/server.html — rather than here inside .content-inner. */}
      <Outlet />
    </>
  )
}
