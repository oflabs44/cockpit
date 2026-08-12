import { Link, Outlet, createFileRoute, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { projectQueryOptions, ProjectNotFoundError } from '#/api/projects'
import { serverDetailQueryOptions } from '#/api/server-detail'
import type { CrumbSegment } from '#/routes/_app'

export const Route = createFileRoute('/_app/$serverId/projects/$projectId')({
  loader: async ({ context, params }): Promise<{ crumbs: CrumbSegment[] }> => {
    const [project, detail] = await Promise.all([
      context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
      context.queryClient.ensureQueryData(serverDetailQueryOptions(params.serverId)),
    ])

    if (project.server_id !== params.serverId) {
      throw new ProjectNotFoundError('This project does not belong to this server')
    }

    return {
      crumbs: [
        { label: 'Servers', link: { kind: 'servers' } },
        { label: detail.server.name, link: { kind: 'server', serverId: params.serverId } },
        { label: project.name, scope: 'project' },
      ],
    }
  },
  pendingComponent: ProjectPending,
  errorComponent: ProjectError,
  component: ProjectLayout,
})

function ProjectPending() {
  return <div className="empty"><p className="empty-body">Loading project&hellip;</p></div>
}

function ProjectError({ error }: ErrorComponentProps) {
  const { serverId } = Route.useParams()
  const router = useRouter()

  if (error instanceof ProjectNotFoundError) {
    return (
      <div className="empty">
        <h2 className="empty-title">No such project</h2>
        <p className="empty-body">{error.message}.</p>
        <div className="empty-actions">
          <Link to="/$serverId/projects" params={{ serverId }} className="btn btn-ghost btn-lg">
            Back to projects
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load the project</h2>
      <p className="empty-body">{error.message}.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function ProjectLayout() {
  return <Outlet />
}
