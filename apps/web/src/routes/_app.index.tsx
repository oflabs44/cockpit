import { useState } from 'react'
import { createFileRoute, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { serversQueryOptions } from '#/api/servers'
import { ServerCard } from '#/components/server-card'
import { AddServerPanel } from '#/components/add-server-panel'
import { RedeemPanel } from '#/components/redeem-panel'

export const Route = createFileRoute('/_app/')({
  staticData: { title: 'Servers' },
  // Warms the exact cache entry the component reads via `useSuspenseQuery` below — a hover
  // (defaultPreload: 'intent') starts the fetch before the click, so a hover-to-click
  // usually shows no pending state.
  loader: ({ context }) => context.queryClient.ensureQueryData(serversQueryOptions),
  pendingComponent: ServersPending,
  errorComponent: ServersError,
  component: ServersScreen,
})

function ServersPending() {
  return (
    <div className="empty">
      <p className="empty-body">Loading servers&hellip;</p>
    </div>
  )
}

function ServersError({ error }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t reach the plane</h2>
      <p className="empty-body">{error.message}. Check that the plane is running.</p>
      <div className="empty-actions">
        {/* invalidate() re-runs the loader and resets this boundary; a plain boundary
            reset would keep the errored query and dead-end the screen. */}
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function ServersScreen() {
  // `useSuspenseQuery` throws to the error boundary only when no data exists; a failed
  // background refetch keeps rendering cached data and surfaces here as `error` instead.
  const { data, error } = useSuspenseQuery(serversQueryOptions)
  const [panel, setPanel] = useState<'add' | 'redeem' | null>(null)
  const closePanel = () => setPanel(null)

  if (panel === 'add') return <AddServerPanel onClose={closePanel} />

  if (panel === 'redeem') return <RedeemPanel onClose={closePanel} />

  if (data.length === 0) {
    return (
      <div className="empty">
        <div className="empty-art">
          <ServersEmptyArt />
        </div>
        <h2 className="empty-title">No servers yet</h2>
        <p className="empty-body">
          cockpit doesn&rsquo;t create machines &mdash; you bring a box you already own. Run one
          line on it and it enrols itself, with no SSH access handed over.
        </p>
        <div className="empty-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => setPanel('add')}>
            Add server
          </button>
          <button type="button" className="btn btn-ghost btn-lg" onClick={() => setPanel('redeem')}>
            Redeem a claim code
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {error && (
        <p className="server-note" role="alert">
          Plane unreachable since the last refresh &mdash; this list may be stale.
        </p>
      )}
      {/* The prototype's header bar shows one primary action ("Add server") once the list is
          populated, since the empty state's own actions are gone by then. Rendered here as a
          content toolbar instead — the shell has no per-route bar-action mechanism yet.
          "Redeem a claim code" has no bar equivalent in the prototype — kept reachable as a
          second, non-primary action rather than dropped, since the daemon-prints-a-code path
          is otherwise a dead end once a server already exists. */}
      <div className="toolbar">
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel('redeem')}>
          Redeem a claim code
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setPanel('add')}>
          Add server
        </button>
      </div>
      <div className="servers-grid">
        {data.map((server) => (
          <ServerCard key={server.id} server={server} />
        ))}
      </div>
    </>
  )
}

// Solid = what exists (the rack). Dashed = what is absent (the servers). Flat elevation
// rather than isometric — ported from prototype/servers.html.
function ServersEmptyArt() {
  return (
    <svg
      viewBox="0 0 180 170"
      width="200"
      height="189"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="M30 8h120v144H30z" />
      <path d="M41 8v144M139 8v144" opacity={0.4} />
      <g opacity={0.45}>
        <path d="M34 20h4M34 38h4M34 56h4M34 74h4M34 92h4M34 110h4M34 128h4M34 140h4" />
        <path d="M142 20h4M142 38h4M142 56h4M142 74h4M142 92h4M142 110h4M142 128h4M142 140h4" />
      </g>
      <g strokeDasharray="4 4" opacity={0.8}>
        <path d="M49 20h82v34H49z" />
        <path d="M49 63h82v34H49z" />
        <path d="M49 106h82v34H49z" />
      </g>
      <path d="M38 152v10M142 152v10" opacity={0.6} />
      <path d="M22 162h136" opacity={0.45} />
    </svg>
  )
}
