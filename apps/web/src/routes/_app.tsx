import { useId, useState } from 'react'
import { Link, Outlet, createFileRoute, useMatches, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ServerStack01Icon,
  Layers01Icon,
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
import { plansQueryOptions } from '#/api/plans'

// Pathless layout route (docs/architecture.md §2.2, prototype/frame.html): the frame wraps
// every app section, but a route with no shell — an auth screen, say — would sit outside
// this layout rather than inside it. None exists yet.
export const Route = createFileRoute('/_app')({ component: AppShell })

const activeProps = { 'aria-current': 'page' as const }

// One segment of the bar's breadcrumb (docs/design.md §4.2: the last crumb IS the page
// title — no separate <h1>). `dot` mirrors server-card.tsx's `DOT_CLASS`: `undefined` means
// "not applicable" (most routes), `null` means "applicable status, deliberately no dot"
// (an enrolling server), and a class string draws one.
export type CrumbSegment = { label: string; dot?: string | null }

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

function AppShell() {
  const [rail, setRail] = useState<'open' | 'collapsed'>('open')
  const crumbs = useCrumbs()
  const leafCrumb = crumbs.at(-1)
  // Every server route (the layout and all its tabs) shares this param — used only to decide
  // whether the tab strip renders, not to read anything about the server itself.
  const { serverId } = useParams({ strict: false })
  const contentId = useId()

  // Plain `useQuery`, not `useSuspenseQuery`: the rail renders on every route, so a badge
  // must never block or suspend the page around it — it just appears once real data has
  // arrived. `undefined` (still loading, or errored) renders no badge at all rather than a
  // false "0". The interval is the badges' only recovery path: `AppShell` never unmounts
  // and nothing else consumes `['plans','pending']`, so without it one failed fetch (or a
  // plan created after load) would leave the badge wrong until a window-refocus.
  const serverCount = useQuery({ ...serversQueryOptions, refetchInterval: 60_000 }).data?.length
  const pendingPlanCount = useQuery({ ...plansQueryOptions, refetchInterval: 60_000 }).data?.length
  // The prototype has no zero-count example for the Plans badge (every page hardcodes a
  // non-zero demo value). The badge is info-blue because pending plans are *pending* —
  // §2.3's info row — and a real zero is nothing pending, so it renders no badge at all
  // rather than a neutral "0", consistent with how the rest of the app treats "nothing to
  // flag" (e.g. an enrolling server's card gets no status dot at all).
  const plansBadgeCount = pendingPlanCount || undefined

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
          <NavLink
            to="/plans"
            activeProps={activeProps}
            icon={Layers01Icon}
            label="Plans"
            count={plansBadgeCount}
            attention
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
            {/* A parent crumb only ever appears alongside a leaf (2 segments today: Servers /
                {name}) — it always links back to the root list, the one container every
                multi-level trail in this app currently has. */}
            {crumbs.length > 1 && (
              <>
                <Link to="/">{crumbs[0]?.label}</Link>
                <span className="sep">/</span>
              </>
            )}
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

        {/* Sibling of `.bar`/`.content`, matching prototype/server.html's nesting — flush
            under the bar with a full-width hairline, rather than inside `.content-inner`'s
            padded column. Hardcoded to the one section that has tabs today rather than a
            generic per-route mechanism: a second tabbed section can generalise this then.
            Gated on the detail loader having resolved (a multi-segment crumb trail exists
            only then), not on the URL param alone — the param is set during pending AND
            error states, and tabs over a "No such server" screen are dead controls
            presented as navigation. */}
        {serverId && crumbs.length > 1 && (
          <nav className="tabs">
            <Link
              to="/$serverId"
              params={{ serverId }}
              activeOptions={{ exact: true }}
              activeProps={activeProps}
            >
              Overview
            </Link>
            {/* Projects and Resources are siblings inside the server, which is what makes the
                scoping legible: a database is a thing on THIS box, and a project binds to it.
                Neither floats free of the machine (prototype/server.html). */}
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
        )}

        <main id={contentId} className="content">
          <div className="content-inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
