import { Link, createFileRoute, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { projectQueryOptions } from '#/api/projects'
import { serverResourcesQueryOptions } from '#/api/resources'
import { AppCards, ProjectResourcesTable } from '#/components/project-resources'
import { formatAgo } from '#/lib/format'

export const Route = createFileRoute('/_app/$serverId/projects/$projectId/')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(serverResourcesQueryOptions(params.serverId)),
  errorComponent: ProjectOverviewError,
  component: ProjectOverview,
})

function ProjectOverviewError({ error }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load project resources</h2>
      <p className="empty-body">{error.message}.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function ProjectOverview() {
  const { serverId, projectId } = Route.useParams()
  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId))
  const { data: serverResources, error } = useSuspenseQuery(serverResourcesQueryOptions(serverId))
  const resources = serverResources.filter((resource) => resource.project_id === projectId)
  const apps = resources.filter((resource) => resource.kind === 'app')

  return (
    <>
      {error && <p className="server-note" role="alert">Refresh failed. Resource data may be stale.</p>}
      <div className="summary project-summary">
        <div className="card">
          <div className="card-section">
            <div className="kv kv-inline">
              <div className="kv-item"><div className="kv-k">server</div><div className="kv-v">{project.server_id}</div></div>
              <div className="kv-item"><div className="kv-k">apps</div><div className="kv-v">{apps.length}</div></div>
              <div className="kv-item"><div className="kv-k">resources</div><div className="kv-v">{resources.length}</div></div>
              <div className="kv-item"><div className="kv-k">updated</div><div className="kv-v">{formatAgo(project.updated_at)}</div></div>
            </div>
          </div>
        </div>
      </div>

      <div className="sec section-with-action">
        <span className="label">Independent apps</span>
        <span className="section-note">Each app saves, releases, and deploys independently.</span>
        <span className="spacer" />
        <Link
          to="/$serverId/projects/$projectId/resources"
          params={{ serverId, projectId }}
          className="btn btn-ghost btn-sm"
        >
          Manage resources
        </Link>
      </div>
      <AppCards apps={apps} serverId={serverId} projectId={projectId} />

      <div className="sec">
        <span className="label">Project-owned resources</span>
      </div>
      <ProjectResourcesTable resources={resources} serverId={serverId} projectId={projectId} />
    </>
  )
}
