import { useId, useState } from 'react'
import { Link, Outlet, createFileRoute, useMatches, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ServerStack01Icon,
  Activity01Icon,
  GlobeIcon,
  Package01Icon,
  DatabaseIcon,
  Settings01Icon,
  SidebarLeftIcon,
  Search01Icon,
  BellIcon,
} from '@hugeicons/core-free-icons'
import { NavLink, NavSep } from '#/components/nav-link'
import { serversQueryOptions } from '#/api/servers'

// Pathless layout route (docs/architecture.md §2.2, prototype/frame.html): the frame wraps
// every app section, but a route with no shell — an auth screen, say — would sit outside
// this layout rather than inside it. None exists yet.
export const Route = createFileRoute('/_app')({ component: AppShell })

const activeProps = { 'aria-current': 'page' as const }

export type CrumbLink =
  | { kind: 'servers' }
  | { kind: 'server'; serverId: string }
  | { kind: 'project'; serverId: string; projectId: string }

// The final crumb is the page title. Earlier crumbs keep the containment path navigable.
export type CrumbSegment = {
  label: string
  dot?: string | null
  scope?: 'project'
  link?: CrumbLink
}

function useCrumbs(): CrumbSegment[] {
  const matches = useMatches()

  // Walk from the deepest match up: a titled layout route's own children (the server tabs)
  // carry no title/crumbs of their own, so the first match that has either wins.
  for (const match of [...matches].reverse()) {
    const loaderData = match.loaderData as { crumbs?: CrumbSegment[]; title?: string } | undefined
    if (loaderData?.crumbs) return loaderData.crumbs

    const label = loaderData?.title ?? match.staticData.title
    if (label) return [{ label }]
  }

  return []
}

function CrumbAnchor({ crumb }: { crumb: CrumbSegment }) {
  if (crumb.link?.kind === 'servers') return <Link to="/">{crumb.label}</Link>

  if (crumb.link?.kind === 'server') {
    return <Link to="/$serverId" params={{ serverId: crumb.link.serverId }}>{crumb.label}</Link>
  }

  if (crumb.link?.kind === 'project') {
    return (
      <Link
        to="/$serverId/projects/$projectId"
        params={{ serverId: crumb.link.serverId, projectId: crumb.link.projectId }}
      >
        {crumb.label}
      </Link>
    )
  }

  return <span>{crumb.label}</span>
}

function AppShell() {
  const [rail, setRail] = useState<'open' | 'collapsed'>('open')
  const crumbs = useCrumbs()
  const leafCrumb = crumbs.at(-1)
  const { serverId, projectId } = useParams({ strict: false })
  const projectWorkspace = crumbs.some((crumb) => crumb.scope === 'project')
  const contentId = useId()

  // Plain `useQuery`, not `useSuspenseQuery`: the rail renders on every route, so its
  // count must never block or suspend the page around it.
  const serverCount = useQuery({ ...serversQueryOptions, refetchInterval: 60_000 }).data?.length

  return (
    <div className="frame" data-rail={rail}>
      <nav className="rail">
        <Link to="/" className="brand" title="cockpit">
          {/* The cockpit mark, not an icon-library glyph — brand identity stays hand-drawn. */}
          <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
            <path d="M1.25 1.25h29.5v29.5H1.25V1.25zm2.5 2.5v24.5h24.5V3.75H3.75z" />
            <path d="M3.75 20h24.5v8.25H3.75z" />
            <path d="M6.5 14.5h6.5v3H6.5zM14.5 14.5h3v3h-3zM19 14.5h6.5v3H19z" />
          </svg>
          <span className="word">cockpit</span>
        </Link>

        <div className="nav">
          <NavLink
            to="/"
            activeOptions={{ exact: true }}
            activeProps={activeProps}
            icon={ServerStack01Icon}
            label="Servers"
            count={serverCount}
          />
          <NavLink to="/activity" activeProps={activeProps} icon={Activity01Icon} label="Activity" />

          <NavSep />

          {/* Account-scoped (#11, ADR-0007): no server, so kept outside the containment
              spine above but out of Settings — domains are operational, touched on most
              deploys, and burying routing in configuration would misrepresent that. */}
          <NavLink to="/domains" activeProps={activeProps} icon={GlobeIcon} label="Domains" />
          <NavLink to="/sources" activeProps={activeProps} icon={Package01Icon} label="Sources" />
          <NavLink to="/secrets" activeProps={activeProps} icon={DatabaseIcon} label="Secrets" />

          <NavSep />

          <NavLink to="/settings" activeProps={activeProps} icon={Settings01Icon} label="Settings" />
        </div>
      </nav>

      <div className="main">
        <header className="bar">
          <button
            type="button"
            className="railtoggle"
            title="Toggle rail"
            aria-expanded={rail === 'open'}
            aria-controls={contentId}
            onClick={() => setRail((r) => (r === 'open' ? 'collapsed' : 'open'))}
          >
            <HugeiconsIcon icon={SidebarLeftIcon} className="icon" strokeWidth={1.25} />
          </button>

          <div className="crumbs">
            {crumbs.slice(0, -1).map((crumb, index) => (
              <span className="crumb-part" key={`${crumb.label}:${index}`}>
                <CrumbAnchor crumb={crumb} />
                <span className="sep">/</span>
              </span>
            ))}
            <span className="here">
              {leafCrumb?.dot && <span className={`dot ${leafCrumb.dot}`} />}
              {leafCrumb?.label}
            </span>
          </div>

          <span className="spacer" />

          <button type="button" className="search">
            <HugeiconsIcon icon={Search01Icon} className="icon icon-sm" strokeWidth={1.25} />
            <span>Search or run</span>
            <kbd>&#8984;K</kbd>
          </button>

          <button type="button" className="bell" title="Notifications">
            <HugeiconsIcon icon={BellIcon} className="icon" strokeWidth={1.25} />
          </button>
        </header>

        {serverId && projectId && projectWorkspace ? (
          <nav className="tabs" aria-label="Project">
            <Link
              to="/$serverId/projects/$projectId"
              params={{ serverId, projectId }}
              activeOptions={{ exact: true }}
              activeProps={activeProps}
            >
              Overview
            </Link>
            <Link
              to="/$serverId/projects/$projectId/resources"
              params={{ serverId, projectId }}
              activeProps={activeProps}
            >
              Resources
            </Link>
            <Link
              to="/$serverId/projects/$projectId/deployments"
              params={{ serverId, projectId }}
              activeProps={activeProps}
            >
              Deployments
            </Link>
            <Link
              to="/$serverId/projects/$projectId/settings"
              params={{ serverId, projectId }}
              activeProps={activeProps}
            >
              Settings
            </Link>
          </nav>
        ) : serverId && crumbs.length > 1 ? (
          <nav className="tabs" aria-label="Server">
            <Link
              to="/$serverId"
              params={{ serverId }}
              activeOptions={{ exact: true }}
              activeProps={activeProps}
            >
              Overview
            </Link>
            <Link to="/$serverId/projects" params={{ serverId }} activeProps={activeProps}>
              Projects
            </Link>
            <Link to="/$serverId/resources" params={{ serverId }} activeProps={activeProps}>
              Resources
            </Link>
            <Link to="/$serverId/firewall" params={{ serverId }} activeProps={activeProps}>
              Firewall
            </Link>
            <Link to="/$serverId/settings" params={{ serverId }} activeProps={activeProps}>
              Settings
            </Link>
          </nav>
        ) : null}

        <main id={contentId} className="content">
          <div className="content-inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
