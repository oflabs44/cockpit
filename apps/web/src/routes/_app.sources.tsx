import { useState } from 'react'
import { createFileRoute, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
} from '@tanstack/react-query'
import {
  connectGithub,
  disconnectSource,
  sourcesQueryOptions,
  type DisconnectSourceResponse,
  type Source,
} from '#/api/sources'
import { formatAgo } from '#/lib/format'

// The plane's GitHub callback redirects the browser back here carrying the outcome:
// `?connected=<source_id>` after a successful install/update, `?notice=<code>` when the
// flow ended without an installation to record, `?error=<code>` when the installation
// lookup failed (detail stays in the plane's logs). All are one-shot hints, not state —
// unknown values render nothing.
type SourcesSearch = {
  connected?: string
  notice?: string
  error?: string
}

export const Route = createFileRoute('/_app/sources')({
  staticData: { title: 'Sources' },
  validateSearch: (search: Record<string, unknown>): SourcesSearch => ({
    connected: typeof search.connected === 'string' ? search.connected : undefined,
    notice: typeof search.notice === 'string' ? search.notice : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(sourcesQueryOptions),
  pendingComponent: SourcesPending,
  errorComponent: SourcesError,
  component: SourcesScreen,
})

function SourcesPending() {
  return (
    <div className="empty">
      <p className="empty-body">Loading sources&hellip;</p>
    </div>
  )
}

function SourcesError({ error }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load sources</h2>
      <p className="empty-body">{error.message}. Check that the plane is running.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

// The failure codes the callback redirect can carry today. Anything else gets the
// generic line rather than being echoed raw into the page.
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  github_app_misconfigured:
    'GitHub is not fully configured on this plane. Check the GitHub App settings and try again.',
  github_installation_lookup_failed:
    "GitHub didn't confirm the installation, so nothing was saved. Try connecting again.",
  github_connect_failed:
    "The GitHub connection didn't complete, so nothing was saved. Check the plane's logs and try again.",
}

const CALLBACK_NOTICE_MESSAGES: Record<string, string> = {
  'pending-approval':
    'Your install request went to the account owner. The source appears here once they approve it.',
}

function CallbackNotice({ search, sources }: { search: SourcesSearch; sources: Source[] }) {
  if (search.error) {
    return (
      <p className="form-error" role="alert" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
        {CALLBACK_ERROR_MESSAGES[search.error] ??
          "The GitHub connection didn't complete. Try connecting again."}
      </p>
    )
  }

  if (search.notice) {
    const message = CALLBACK_NOTICE_MESSAGES[search.notice]

    if (!message) return null

    return (
      <p className="form-success" role="status" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
        {message}
      </p>
    )
  }

  if (search.connected) {
    // The redirect may carry an id for either a new installation or a refreshed grant on an
    // existing one — name it if the list has it, and stay quiet on a stale/unknown id.
    const source = sources.find((s) => s.id === search.connected)

    if (!source) return null

    return (
      <p className="form-success" role="status" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
        GitHub installation for @{source.github_login} connected.
      </p>
    )
  }

  return null
}

function SourcesScreen() {
  const { data, error } = useSuspenseQuery(sourcesQueryOptions)
  const search = Route.useSearch()
  const queryClient = useQueryClient()

  const disconnect = useMutation({
    mutationFn: disconnectSource,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sourcesQueryOptions.queryKey }),
  })

  const connect = useMutation({
    mutationFn: connectGithub,
    onSuccess: ({ url }) => {
      // The rest of the flow happens off-app: GitHub's install page finishes and returns
      // via the plane's callback. Full navigation, not a popup — the page is abandoned
      // either way, and the button's pending state honestly covers the gap until unload.
      window.location.assign(url)
    },
  })

  // Secondary once something is connected: GitHub has no "install, or come back if already
  // installed" flow, so an operator who takes this path with the app already installed lands
  // on GitHub's configure page with Save disabled and no way back. Managing an existing
  // installation belongs on the card; this button is only for adding another account.
  const connectButton = (variant: 'primary-lg' | 'secondary-sm') => (
    <button
      type="button"
      className={variant === 'primary-lg' ? 'btn btn-primary btn-lg' : 'btn btn-ghost btn-sm'}
      onClick={() => connect.mutate()}
      disabled={connect.isPending}
    >
      {connect.isPending
        ? 'Connecting…'
        : variant === 'primary-lg'
          ? 'Connect GitHub'
          : 'Connect another account'}
    </button>
  )

  if (data.length === 0) {
    return (
      <div className="empty">
        <div className="empty-art">
          <SourcesEmptyArt />
        </div>
        <h2 className="empty-title">No sources connected</h2>
        <p className="empty-body">
          Install the cockpit GitHub App to deploy straight from your repositories &mdash; a
          push becomes a deployment. cockpit only sees the repositories you grant, and you can
          revoke the installation from GitHub at any time.
        </p>
        <div className="empty-actions">{connectButton('primary-lg')}</div>
        {!connect.isError && search.error && (
          <div style={{ marginTop: 'calc(var(--spacing) * 4)' }}>
            <CallbackNotice search={search} sources={data} />
          </div>
        )}
        {connect.isError && (
          <p className="form-error" role="alert" style={{ marginTop: 'calc(var(--spacing) * 4)' }}>
            Couldn&rsquo;t start the GitHub connection ({connect.error.message}).
          </p>
        )}
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
      <CallbackNotice search={search} sources={data} />
      <div className="toolbar">
        <p className="toolbar-note">
          GitHub App installations connected to this account. Pushes to their repositories can
          trigger deployments.
        </p>
        <span className="spacer" />
        {connectButton('secondary-sm')}
      </div>
      {connect.isError && (
        <p className="form-error" role="alert" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
          Couldn&rsquo;t start the GitHub connection ({connect.error.message}).
        </p>
      )}
      {disconnect.isSuccess && (
        <p className="form-success" role="status" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
          Disconnected.
          {!disconnect.data.revoked_on_github &&
            ' GitHub had no such installation for this App — it was already uninstalled, or it belongs to a different GitHub App than this plane is configured with.'}
        </p>
      )}
      {disconnect.isError && (
        <p className="form-error" role="alert" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
          {disconnect.error.message}
        </p>
      )}
      <div className="servers-grid">
        {data.map((source) => (
          <SourceCard key={source.id} source={source} disconnect={disconnect} />
        ))}
      </div>

    </>
  )
}

type DisconnectMutation = UseMutationResult<
  DisconnectSourceResponse,
  Error,
  { id: string; confirm: string }
>

function SourceCard({ source, disconnect }: { source: Source; disconnect: DisconnectMutation }) {
  const permissions = Object.entries(source.permissions)
  // GitHub renders the same string twice for a personal account, where the display name
  // defaults to the login at connect time.
  const showLogin = source.github_login !== source.name

  return (
    <div className="card">
      <div className="card-section">
        <div className="server-head">
          <SourceAvatar login={source.github_login} />
          <span style={{ minWidth: 0 }}>
            <span className="server-name">{source.name}</span>
            <span className="server-meta">
              <span>
                <GitHubMark />
                GitHub
              </span>
              {showLogin && (
                <span>
                  <span className="sep">&middot;</span>@{source.github_login}
                </span>
              )}
              <span>
                <span className="sep">&middot;</span>installation {source.github_installation_id}
              </span>
            </span>
          </span>
        </div>
      </div>

      <div className="card-section">
        <div className="kv">
          <div className="kv-item">
            <div className="kv-k">repositories</div>
            <div className="kv-v">
              {source.repository_selection === 'all' ? 'all repositories' : 'selected repositories'}
            </div>
          </div>
          {/* One kv-item per permission rather than a comma-joined line: the data is a
              mapping, and the kv grid is the design system's existing way to show one.
              There is no repeatable badge/pill component to reuse (`resource-scope` is a
              single right-aligned scope marker), so nothing new is invented here. */}
          {permissions.map(([scope, level]) => (
            <div className="kv-item" key={scope}>
              <div className="kv-k">{scope}</div>
              <div className="kv-v">{level}</div>
            </div>
          ))}
          {/* No events row at all when there are none: cockpit subscribes to no webhook
              events yet, so a permanent em dash is noise rather than information. */}
          {source.events.length > 0 && (
            <div className="kv-item">
              <div className="kv-k">events</div>
              <div className="kv-v">{source.events.join(', ')}</div>
            </div>
          )}
        </div>
      </div>

      <SourceCardFoot source={source} disconnect={disconnect} />
    </div>
  )
}

function SourceCardFoot({
  source,
  disconnect,
}: {
  source: Source
  disconnect: DisconnectMutation
}) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="card-section card-foot">
        <p className="server-note" style={{ padding: 0, marginBottom: 'calc(var(--spacing) * 3)' }}>
          Disconnect @{source.github_login}? This uninstalls the app on GitHub, so cockpit
          loses access to those repositories.
        </p>
        <div className="server-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirming(false)}
            disabled={disconnect.isPending}
          >
            Cancel
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              // The plane requires the login back, not a flag — a client cannot disconnect
              // a connection it has not read.
              disconnect.mutate({ id: source.id, confirm: source.github_login })
            }
            disabled={disconnect.isPending}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Yes, disconnect'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card-section card-foot">
      <div className="server-foot">
        {/* Managing an installation is GitHub's job, so cockpit hands it over rather than
            mirroring GitHub's own controls. The personal-settings path is right for every
            installation this plane can have: the App is registered "Only on this account",
            so oflabs44 is the only possible target. An org installation would need
            /organizations/<org>/settings/installations/<id> instead — this link would 404. */}
        <a
          className="table-link"
          href={`https://github.com/settings/installations/${source.github_installation_id}`}
          target="_blank"
          rel="noreferrer"
        >
          Manage on GitHub
        </a>
        {source.github_app_slug && (
          <a
            className="table-link"
            href={`https://github.com/settings/apps/${source.github_app_slug}`}
            target="_blank"
            rel="noreferrer"
          >
            App settings
          </a>
        )}
        <span className="spacer" />
        <span className="server-foot-value">connected {formatAgo(source.created_at)}</span>
        {/* Least prominent action on the card: it revokes cockpit's access to the
            operator's repositories, and the confirmation step is the point. */}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setConfirming(true)}
        >
          Disconnect
        </button>
      </div>
    </div>
  )
}

// The account's avatar, straight from github.com: stable for users and organisations, no
// API call and nothing stored. If it fails to load the card keeps its shape — the mark in
// the meta line already says which provider this is.
function SourceAvatar({ login }: { login: string }) {
  const [failed, setFailed] = useState(false)

  if (failed) return null

  return (
    <img
      src={`https://github.com/${login}.png?size=80`}
      alt={`${login} on GitHub`}
      width={40}
      height={40}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ flex: 'none', border: '1px solid var(--color-ink-20)' }}
    />
  )
}

// Inline, like SourcesEmptyArt below: one mark does not justify an icon dependency, and
// GitHub's is a brand mark rather than a generic glyph.
function GitHubMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
      style={{ verticalAlign: '-1px', marginRight: 4 }}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

// Solid = what exists (cockpit). Dashed = what is absent (the commit graph feeding it) —
// same convention as the servers empty art.
function SourcesEmptyArt() {
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
      <g strokeDasharray="4 4" opacity={0.8}>
        <circle cx="40" cy="35" r="6" />
        <circle cx="40" cy="85" r="6" />
        <circle cx="40" cy="135" r="6" />
        <path d="M40 41v38M40 91v38" />
        <path d="M46 85h20" />
        <circle cx="72" cy="85" r="6" />
        <path d="M78 85h36" />
      </g>
      <path d="M114 51h48v68h-48z" />
      <path d="M114 71h48" opacity={0.4} />
      <g opacity={0.45}>
        <path d="M122 87h16M122 97h26M122 107h20" />
      </g>
    </svg>
  )
}
