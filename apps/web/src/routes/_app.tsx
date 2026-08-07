import { useId, useState } from 'react'
import { Link, Outlet, createFileRoute, useMatches } from '@tanstack/react-router'
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

// Pathless layout route (docs/architecture.md §2.2, prototype/frame.html): the frame wraps
// every app section, but a route with no shell — an auth screen, say — would sit outside
// this layout rather than inside it. None exists yet.
export const Route = createFileRoute('/_app')({ component: AppShell })

const activeProps = { 'aria-current': 'page' as const }

function AppShell() {
  const [rail, setRail] = useState<'open' | 'collapsed'>('open')
  const matches = useMatches()
  // A route with dynamic content (the server detail screen's server name) can't know its
  // title at route-definition time the way `staticData.title` requires — its loader returns
  // `{ title }` instead. The deepest match alone isn't enough: a titled layout route's
  // children (the server tabs) carry no title of their own, so take the deepest match that
  // has one, from either source.
  const title =
    matches
      .map((m) => (m.loaderData as { title?: string } | undefined)?.title ?? m.staticData.title)
      .reverse()
      .find((t) => t !== undefined) ?? ''
  const contentId = useId()

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
          />
          <NavLink to="/plans" activeProps={activeProps} icon={Layers01Icon} label="Plans" />
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
            <span className="here">{title}</span>
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

        <main id={contentId} className="content">
          <div className="content-inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
