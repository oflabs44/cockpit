import { Link, createFileRoute, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { projectDeploymentsQueryOptions, type DeploymentTrigger } from '#/api/deployments'
import { serverResourcesQueryOptions } from '#/api/resources'
import { DeploymentStatusValue } from '#/components/status'
import { formatAgo, formatTiming } from '#/lib/format'

export const Route = createFileRoute('/_app/$serverId/projects/$projectId/deployments/')({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectDeploymentsQueryOptions(params.projectId)),
      context.queryClient.ensureQueryData(serverResourcesQueryOptions(params.serverId)),
    ]),
  pendingComponent: DeploymentsPending,
  errorComponent: DeploymentsError,
  component: DeploymentsScreen,
})

function DeploymentsPending() {
  return <div className="empty"><p className="empty-body">Loading deployments&hellip;</p></div>
}

function DeploymentsError({ error }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load deployments</h2>
      <p className="empty-body">{error.message}.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function DeploymentsScreen() {
  const { serverId, projectId } = Route.useParams()
  const { data: deployments, error } = useSuspenseQuery(projectDeploymentsQueryOptions(projectId))
  const { data: resources } = useSuspenseQuery(serverResourcesQueryOptions(serverId))
  const appNames = new Map(resources.map((resource) => [resource.id, resource.name]))

  if (deployments.length === 0) {
    return (
      <div className="empty empty-inline deployment-empty">
        <h2 className="empty-title">No deployments recorded</h2>
        <p className="empty-body">
          Start a manual deployment from an app. Repository apps require an explicit commit.
        </p>
        <div className="empty-actions">
          <Link
            to="/$serverId/projects/$projectId/resources"
            params={{ serverId, projectId }}
            className="btn btn-ghost btn-sm"
          >
            Open apps
          </Link>
        </div>
      </div>
    )
  }

  return (
    <>
      {error && <p className="server-note" role="alert">Refresh failed. Deployment history may be stale.</p>}
      <div className="table-scroll deployment-table">
        <table className="table">
          <thead>
            <tr>
              <th>deployment</th>
              <th>app</th>
              <th>trigger and source</th>
              <th>status</th>
              <th>actor</th>
              <th>release</th>
              <th>timing</th>
              <th className="col-age">when</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((deployment) => (
              <tr key={deployment.id}>
                <td>
                  <Link
                    to="/$serverId/projects/$projectId/deployments/$deploymentId"
                    params={{ serverId, projectId, deploymentId: deployment.id }}
                    className="table-link mono-value"
                  >
                    {deployment.id}
                  </Link>
                </td>
                <td>{appNames.get(deployment.app_id) ?? deployment.app_id}</td>
                <td className="muted">{triggerLabel(deployment.trigger)}</td>
                <td><DeploymentStatusValue status={deployment.status} /></td>
                <td className="muted">{deployment.triggered_by.kind} / {deployment.triggered_by.id}</td>
                <td className="muted">{deployment.release_id ?? 'not recorded'}</td>
                <td className="muted">{formatTiming(deployment.started_at, deployment.finished_at)}</td>
                <td className="muted col-age">{formatAgo(deployment.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function triggerLabel(trigger: DeploymentTrigger): string {
  if (trigger.kind === 'manual') return trigger.commit ? `manual · ${trigger.commit}` : 'manual · image'
  if (trigger.kind === 'git_push') return `git push · ${trigger.revision.commit}`
  if (trigger.kind === 'redeploy') return `redeploy · ${trigger.deployment_id}`

  return `rollback · ${trigger.release_id}`
}
