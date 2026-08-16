import { useId, useState } from 'react'
import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type UseQueryResult,
} from '@tanstack/react-query'
import {
  DEFAULT_PROJECT_SETTINGS,
  ProjectImportError,
  importProject,
  projectQueryOptions,
  projectsQueryOptions,
} from '#/api/projects'
import { sourceRepositoriesQueryOptions, sourcesQueryOptions, type Repository } from '#/api/sources'
import { formatAgo } from '#/lib/format'

export const Route = createFileRoute('/_app/$serverId/projects/')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(projectsQueryOptions(params.serverId)),
  pendingComponent: ProjectsPending,
  errorComponent: ProjectsError,
  component: ProjectsScreen,
})

function ProjectsPending() {
  return <div className="empty"><p className="empty-body">Loading projects&hellip;</p></div>
}

function ProjectsError({ error }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load projects</h2>
      <p className="empty-body">{error.message}.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function ProjectsScreen() {
  const { serverId } = Route.useParams()
  const { data: projects, error } = useSuspenseQuery(projectsQueryOptions(serverId))
  const [creating, setCreating] = useState(false)

  if (creating) return <ImportProjectPanel serverId={serverId} onClose={() => setCreating(false)} />

  if (projects.length === 0) {
    return (
      <div className="empty">
        <h2 className="empty-title">No projects on this server</h2>
        <p className="empty-body">
          A project is one GitHub repository&rsquo;s Compose stack on this server. Select a
          repository to create it.
        </p>
        <div className="empty-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => setCreating(true)}>
            Create project
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {error && <p className="server-note" role="alert">Refresh failed. This project list may be stale.</p>}
      <div className="toolbar">
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          Create project
        </button>
      </div>
      <div className="projects-grid">
        {projects.map((project) => (
          <Link
            key={project.id}
            to="/$serverId/projects/$projectId"
            params={{ serverId, projectId: project.id }}
            className="card project-card"
          >
            <div className="card-section">
              <div className="project-card-name">{project.name}</div>
              {/* Unbound projects predate ADR-0012 and have no repository to name. They stay
                  listed and openable — they simply cannot deploy. */}
              <p className="project-card-note">
                {project.repository_full_name
                  ? `${project.repository_full_name} · ${project.compose_path}`
                  : 'No repository bound, so this project cannot deploy.'}
              </p>
            </div>
            <div className="card-section card-foot project-card-foot">
              {project.ref && <span className="mono-value">{project.ref}</span>}
              <span className="spacer" />
              <span className="mono-value">updated {formatAgo(project.updated_at)}</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  )
}

function repositoryNote(repository: Repository): string | null {
  if (repository.default_branch === '') return 'no commits yet'
  if (repository.archived) return 'archived'

  return null
}

// The repository select's placeholder doubles as its status line: it says why the list is
// empty when it is, and what to do when it isn't.
function repositoryPlaceholder(sourcePicked: boolean, repositories: UseQueryResult<Repository[]>): string {
  if (!sourcePicked) return 'Select an account first'
  if (repositories.isLoading) return 'Loading repositories…'
  if (repositories.isError && !repositories.data) return 'Repositories unavailable'
  if (repositories.data?.length === 0) return 'No repositories granted'

  return 'Select a repository'
}

function ImportProjectPanel({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const nameFieldId = useId()
  const sourceFieldId = useId()
  const repositoryFieldId = useId()
  const refFieldId = useId()
  const baseDirectoryFieldId = useId()
  const composePathFieldId = useId()

  const [sourceId, setSourceId] = useState('')
  const [repositoryId, setRepositoryId] = useState('')
  const [name, setName] = useState('')
  const [ref, setRef] = useState('')
  const [baseDirectory, setBaseDirectory] = useState('.')
  const [composePath, setComposePath] = useState('compose.yaml')

  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const sources = useQuery(sourcesQueryOptions)
  // Nothing is asked of GitHub until an account is picked: the grant is read live on every
  // request, so listing it before the operator has chosen would be a wasted round trip.
  const repositories = useQuery({
    ...sourceRepositoriesQueryOptions(sourceId),
    enabled: sourceId !== '',
  })

  const availableSources = sources.data ?? []
  const source = availableSources.find((candidate) => candidate.id === sourceId)
  const listed = repositories.data
    ? [...repositories.data].sort((a, b) => a.full_name.localeCompare(b.full_name))
    : []
  const repository = listed.find((candidate) => candidate.id === repositoryId)

  const mutation = useMutation({
    mutationFn: importProject,
    onSuccess: async (project) => {
      queryClient.setQueryData(projectQueryOptions(project.id).queryKey, project)
      await queryClient.invalidateQueries({ queryKey: projectsQueryOptions(serverId).queryKey })
      await navigate({
        to: '/$serverId/projects/$projectId',
        params: { serverId, projectId: project.id },
      })
    },
  })

  // Nothing to import from, or nothing loaded yet: the form would have an empty account
  // list and no honest way to explain itself, so it is replaced rather than disabled.
  if (
    sources.isLoading ||
    (sources.isError && availableSources.length === 0) ||
    (sources.isSuccess && availableSources.length === 0)
  ) {
    return (
      <div className="panel card compact-panel">
        <div className="card-section">
          {sources.isLoading && <p className="panel-copy">Loading GitHub accounts&hellip;</p>}
          {sources.isError && (
            <p className="form-error" role="alert">
              Couldn&rsquo;t load your GitHub accounts ({sources.error.message}).
            </p>
          )}
          {sources.isSuccess && (
            <>
              <h2 className="panel-title">No GitHub account connected</h2>
              <p className="panel-copy">
                A project deploys a Compose file from one GitHub repository, so cockpit needs
                access to the account that holds it.
              </p>
            </>
          )}
        </div>
        <div className="card-section card-foot">
          <div className="panel-actions">
            {sources.isSuccess && (
              <Link to="/sources" className="btn btn-primary btn-sm">
                Connect GitHub
              </Link>
            )}
            {sources.isError && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => sources.refetch()}
              >
                Retry
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <form
      className="panel card compact-panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (!repository) return

        mutation.mutate({
          server_id: serverId,
          name: name.trim(),
          source_id: sourceId,
          // The id is the identity the plane clones by; the full name travels with it as
          // the display cache, read from this listing so it is current.
          repository_id: repository.id,
          repository_full_name: repository.full_name,
          ref: ref.trim(),
          base_directory: baseDirectory.trim(),
          compose_path: composePath.trim(),
          // Push-triggered deployment is not wired yet; do not offer a switch that cannot work.
          auto_deploy: false,
          settings: DEFAULT_PROJECT_SETTINGS,
        })
      }}
    >
      <div className="card-section">
        <div className="panel-fields">
          <div className="field field-wide">
            <label className="field-label" htmlFor={sourceFieldId}>
              github account
            </label>
            <select
              id={sourceFieldId}
              className="select"
              value={sourceId}
              onChange={(event) => {
                setSourceId(event.target.value)
                // The old pick belongs to the old account's grant.
                setRepositoryId('')
              }}
              required
              autoFocus
            >
              <option value="" disabled>
                Select an account
              </option>
              {availableSources.map((source) => (
                <option key={source.id} value={source.id}>
                  @{source.github_login}
                </option>
              ))}
            </select>
          </div>
          <div className="field field-wide">
            <label className="field-label" htmlFor={repositoryFieldId}>
              repository
            </label>
            <select
              id={repositoryFieldId}
              className="select"
              value={repositoryId}
              disabled={
                sourceId === '' ||
                repositories.isLoading ||
                (repositories.isError && listed.length === 0) ||
                listed.length === 0
              }
              onChange={(event) => {
                const picked = listed.find((candidate) => candidate.id === event.target.value)
                setRepositoryId(event.target.value)

                // Defaults, not locks — both fields stay editable below.
                if (picked) {
                  setName(picked.full_name.split('/')[1] ?? '')
                  setRef(picked.default_branch)
                }
              }}
              required
            >
              <option value="" disabled>
                {repositoryPlaceholder(sourceId !== '', repositories)}
              </option>
              {listed.map((candidate) => {
                const note = repositoryNote(candidate)

                return (
                  <option
                    key={candidate.id}
                    value={candidate.id}
                    disabled={candidate.default_branch === ''}
                  >
                    {candidate.full_name}
                    {note ? ` — ${note}` : ''}
                  </option>
                )
              })}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={nameFieldId}>
              project name
            </label>
            <input
              id={nameFieldId}
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="jerry"
              required
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={refFieldId}>
              ref
            </label>
            <input
              id={refFieldId}
              className="input mono-input"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              placeholder="main"
              pattern="[A-Za-z0-9._/-]+"
              title="Use a branch or tag name without spaces or parent-directory segments."
              required
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={baseDirectoryFieldId}>
              base directory
            </label>
            <input
              id={baseDirectoryFieldId}
              className="input mono-input"
              value={baseDirectory}
              onChange={(event) => setBaseDirectory(event.target.value)}
              pattern="[A-Za-z0-9._/-]+"
              title="Use a repository-relative directory without spaces or parent-directory segments."
              required
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={composePathFieldId}>
              compose path
            </label>
            <input
              id={composePathFieldId}
              className="input mono-input"
              value={composePath}
              onChange={(event) => setComposePath(event.target.value)}
              pattern="[A-Za-z0-9._/-]+\\.(yaml|yml)"
              title="Use a repository-relative .yaml or .yml path."
              required
            />
          </div>
        </div>
        <p className="field-help">
          The Compose path is relative to the base directory. Ingress, migration, required health
          services, and variables start empty.
        </p>
        {repositories.isSuccess && listed.length === 0 && (
          <p className="field-help">
            This GitHub installation grants no repositories.{' '}
            <Link to="/sources">Manage repository access under Sources.</Link>
          </p>
        )}
        {repositories.isSuccess && listed.length > 0 && source?.repository_selection === 'selected' && (
          <p className="field-help">
            Only repositories granted to this GitHub installation appear here.{' '}
            <Link to="/sources">Manage repository access under Sources.</Link>
          </p>
        )}
        {sources.isError && availableSources.length > 0 && (
          <p className="form-error" role="alert">
            Couldn&rsquo;t refresh GitHub accounts; using the loaded list.{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => sources.refetch()}>
              Retry
            </button>
          </p>
        )}
        {repositories.isError && (
          <p className="form-error" role="alert">
            Couldn&rsquo;t refresh repositories ({repositories.error.message}).{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => repositories.refetch()}>
              Retry
            </button>
          </p>
        )}
        {mutation.isError && (
          <p className="form-error" role="alert">
            {mutation.error instanceof ProjectImportError
              ? `Import refused: ${mutation.error.message}.`
              : `Couldn't import the project (${mutation.error.message}).`}
          </p>
        )}
      </div>
      <div className="card-section card-foot">
        <div className="panel-actions">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={mutation.isPending || !repository}
          >
            {mutation.isPending ? 'Importing…' : 'Create project'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
