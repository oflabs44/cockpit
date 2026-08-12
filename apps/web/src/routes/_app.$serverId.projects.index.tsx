import { useId, useState } from 'react'
import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import {
  ProjectNameConflictError,
  createProject,
  projectQueryOptions,
  projectsQueryOptions,
} from '#/api/projects'
import { serverResourcesQueryOptions } from '#/api/resources'
import { formatAgo } from '#/lib/format'

export const Route = createFileRoute('/_app/$serverId/projects/')({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectsQueryOptions(params.serverId)),
      context.queryClient.ensureQueryData(serverResourcesQueryOptions(params.serverId)),
    ]),
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
  const { data: resources } = useSuspenseQuery(serverResourcesQueryOptions(serverId))
  const [creating, setCreating] = useState(false)

  if (creating) return <CreateProjectPanel serverId={serverId} onClose={() => setCreating(false)} />

  if (projects.length === 0) {
    return (
      <div className="empty">
        <h2 className="empty-title">No projects on this server</h2>
        <p className="empty-body">
          Create a project to group its apps and resources. Each app keeps its own deployment history.
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
        {projects.map((project) => {
          const owned = resources.filter((resource) => resource.project_id === project.id)
          const apps = owned.filter((resource) => resource.kind === 'app')

          return (
            <Link
              key={project.id}
              to="/$serverId/projects/$projectId"
              params={{ serverId, projectId: project.id }}
              className="card project-card"
            >
              <div className="card-section">
                <div className="project-card-name">{project.name}</div>
                <p className="project-card-note">Apps deploy independently inside this project.</p>
              </div>
              <div className="card-section card-foot project-card-foot">
                <span>{apps.length} {apps.length === 1 ? 'app' : 'apps'}</span>
                <span>{owned.length} {owned.length === 1 ? 'resource' : 'resources'}</span>
                <span className="spacer" />
                <span className="mono-value">updated {formatAgo(project.updated_at)}</span>
              </div>
            </Link>
          )
        })}
      </div>
    </>
  )
}

function CreateProjectPanel({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const nameId = useId()
  const [name, setName] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: async (project) => {
      queryClient.setQueryData(projectQueryOptions(project.id).queryKey, project)
      await queryClient.invalidateQueries({ queryKey: projectsQueryOptions(serverId).queryKey })
      await navigate({
        to: '/$serverId/projects/$projectId',
        params: { serverId, projectId: project.id },
      })
    },
  })

  return (
    <form
      className="panel card compact-panel"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate({ server_id: serverId, name: name.trim() })
      }}
    >
      <div className="card-section">
        <div className="field">
          <label className="field-label" htmlFor={nameId}>project name</label>
          <input
            id={nameId}
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="jerry"
            required
            autoFocus
          />
        </div>
        {mutation.isError && (
          <p className="form-error" role="alert">
            {mutation.error instanceof ProjectNameConflictError
              ? mutation.error.message
              : `Couldn't create the project (${mutation.error.message}).`}
          </p>
        )}
      </div>
      <div className="card-section card-foot">
        <div className="panel-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create project'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
