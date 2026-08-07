import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { fetchServers } from '#/api/servers'
import { ServerCard } from '#/components/server-card'

export const Route = createFileRoute('/_app/')({
  staticData: { title: 'Servers' },
  component: ServersScreen,
})

function ServersScreen() {
  const { data, isPending, isError, error } = useQuery({ queryKey: ['servers'], queryFn: fetchServers })

  if (isPending) {
    return (
      <div className="empty">
        <p className="empty-body">Loading servers&hellip;</p>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="empty">
        <h2 className="empty-title">Couldn&rsquo;t reach the plane</h2>
        <p className="empty-body">{error.message}. Check that the plane is running.</p>
      </div>
    )
  }

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
          <button type="button" className="btn btn-primary btn-lg">
            Add server
          </button>
          <button type="button" className="btn btn-ghost btn-lg">
            Redeem a claim code
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="servers-grid">
      {data.map((server) => (
        <ServerCard key={server.id} server={server} />
      ))}
    </div>
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
