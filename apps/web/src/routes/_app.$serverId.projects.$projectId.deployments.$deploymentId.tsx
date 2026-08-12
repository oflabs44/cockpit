import type { ReactNode } from 'react'
import { Link, createFileRoute, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import {
  DeploymentNotFoundError,
  deploymentQueryOptions,
  type Change,
  type DeploymentTrigger,
} from '#/api/deployments'
import { projectQueryOptions } from '#/api/projects'
import { serverResourcesQueryOptions } from '#/api/resources'
import { serverDetailQueryOptions } from '#/api/server-detail'
import { DeploymentStatusValue, StepStatusValue } from '#/components/status'
import { formatTimestamp, formatTiming } from '#/lib/format'
import type { CrumbSegment } from '#/routes/_app'

export const Route = createFileRoute('/_app/$serverId/projects/$projectId/deployments/$deploymentId')({
  loader: async ({ context, params }): Promise<{ crumbs: CrumbSegment[] }> => {
    const [deployment, project, detail] = await Promise.all([
      context.queryClient.ensureQueryData(deploymentQueryOptions(params.deploymentId)),
      context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
      context.queryClient.ensureQueryData(serverDetailQueryOptions(params.serverId)),
      context.queryClient.ensureQueryData(serverResourcesQueryOptions(params.serverId)),
    ])

    if (
      deployment.project_id !== params.projectId ||
      deployment.server_id !== params.serverId ||
      project.server_id !== params.serverId
    ) {
      throw new DeploymentNotFoundError('This deployment does not belong to this project')
    }

    return {
      crumbs: [
        { label: 'Servers', link: { kind: 'servers' } },
        { label: detail.server.name, link: { kind: 'server', serverId: params.serverId } },
        {
          label: project.name,
          scope: 'project',
          link: {
            kind: 'project',
            serverId: params.serverId,
            projectId: params.projectId,
          },
        },
        { label: deployment.id },
      ],
    }
  },
  pendingComponent: DeploymentPending,
  errorComponent: DeploymentError,
  component: DeploymentDetail,
})

function DeploymentPending() {
  return <div className="empty"><p className="empty-body">Loading deployment&hellip;</p></div>
}

function DeploymentError({ error }: ErrorComponentProps) {
  const { serverId, projectId } = Route.useParams()
  const router = useRouter()

  if (error instanceof DeploymentNotFoundError) {
    return (
      <div className="empty">
        <h2 className="empty-title">No such deployment</h2>
        <p className="empty-body">{error.message}.</p>
        <div className="empty-actions">
          <Link
            to="/$serverId/projects/$projectId/deployments"
            params={{ serverId, projectId }}
            className="btn btn-ghost btn-lg"
          >
            Back to deployments
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load the deployment</h2>
      <p className="empty-body">{error.message}.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function DeploymentDetail() {
  const { serverId, projectId, deploymentId } = Route.useParams()
  const { data: deployment, error } = useSuspenseQuery(deploymentQueryOptions(deploymentId))
  const { data: resources } = useSuspenseQuery(serverResourcesQueryOptions(serverId))
  const app = resources.find((resource) => resource.id === deployment.app_id)

  return (
    <>
      {error && <p className="server-note" role="alert">Refresh failed. This record may be stale.</p>}
      <div className="app-detail-head">
        <Link
          to="/$serverId/projects/$projectId/deployments"
          params={{ serverId, projectId }}
          className="back-link"
        >
          &larr; Deployment history
        </Link>
      </div>

      <div className="summary project-summary">
        <div className="card">
          <div className="card-section">
            <div className="kv kv-inline deployment-kv">
              <Kv label="status"><DeploymentStatusValue status={deployment.status} /></Kv>
              <Kv label="app">{app?.name ?? deployment.app_id}</Kv>
              <Kv label="trigger">{triggerTitle(deployment.trigger)}</Kv>
              <Kv label="actor">{deployment.triggered_by.kind} / {deployment.triggered_by.id}</Kv>
              <Kv label="source">{sourceRevision(deployment.source_revision)}</Kv>
              <Kv label="release">{deployment.release_id ?? 'No release recorded'}</Kv>
              <Kv label="created">{formatTimestamp(deployment.created_at)}</Kv>
              <Kv label="started">{formatTimestamp(deployment.started_at)}</Kv>
              <Kv label="finished">{formatTimestamp(deployment.finished_at)}</Kv>
              <Kv label="took">{formatTiming(deployment.started_at, deployment.finished_at)}</Kv>
              <Kv label="config">version {deployment.configuration_version}</Kv>
            </div>
          </div>
        </div>
      </div>

      <div className="sec"><span className="label">Trigger</span></div>
      <div className="summary section-summary">
        <div className="card"><div className="card-section"><TriggerDetail trigger={deployment.trigger} /></div></div>
      </div>

      <div className="sec"><span className="label">Recorded steps</span></div>
      {deployment.steps.length === 0 ? (
        <p className="detail-note">No steps are recorded. The queued deployment has not started execution.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>step</th><th>status</th><th>started</th><th>finished</th><th>took</th><th>error</th></tr></thead>
            <tbody>
              {deployment.steps.map((step) => (
                <tr key={step.name}>
                  <td>{step.name}</td>
                  <td><StepStatusValue status={step.status} /></td>
                  <td className="muted">{formatTimestamp(step.started_at)}</td>
                  <td className="muted">{formatTimestamp(step.finished_at)}</td>
                  <td className="muted">{formatTiming(step.started_at, step.finished_at)}</td>
                  <td className="muted">{step.error ? `${step.error.kind}: ${step.error.message}` : 'none'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="sec"><span className="label">Recorded changes</span></div>
      {!deployment.changes ? (
        <p className="detail-note">No changes are recorded. The system calculates changes during execution.</p>
      ) : deployment.changes.changes.length === 0 ? (
        <p className="detail-note">The recorded change set contains no changes.</p>
      ) : (
        <div className="change-list">
          {deployment.changes.changes.map((change, index) => (
            <ChangeRecord key={`${change.target}:${index}`} change={change} />
          ))}
        </div>
      )}

      <div className="sec"><span className="label">Configuration snapshot</span></div>
      <div className="summary section-summary">
        <div className="card"><pre className="record-json">{json(deployment.configuration_snapshot)}</pre></div>
      </div>

      <div className="capability-note">
        <span className="label">Unavailable</span>
        <p>Live logs and Workflow progress are not available from the Plane API. This page shows only the stored deployment record.</p>
      </div>
    </>
  )
}

function TriggerDetail({ trigger }: { trigger: DeploymentTrigger }) {
  if (trigger.kind === 'manual') {
    return (
      <div className="kv kv-inline">
        <Kv label="kind">manual</Kv>
        <Kv label="commit">{trigger.commit ?? 'Null for image app'}</Kv>
      </div>
    )
  }

  if (trigger.kind === 'git_push') {
    return (
      <div className="kv kv-inline">
        <Kv label="kind">git push</Kv>
        <Kv label="source">{trigger.source_id}</Kv>
        <Kv label="delivery">{trigger.delivery_id}</Kv>
        <Kv label="revision">{trigger.revision.ref} @ {trigger.revision.commit}</Kv>
      </div>
    )
  }

  if (trigger.kind === 'redeploy') {
    return <div className="kv kv-inline"><Kv label="kind">redeploy</Kv><Kv label="deployment">{trigger.deployment_id}</Kv></div>
  }

  return <div className="kv kv-inline"><Kv label="kind">rollback</Kv><Kv label="release">{trigger.release_id}</Kv></div>
}

function ChangeRecord({ change }: { change: Change }) {
  return (
    <article className="card change-record">
      <div className="card-section change-head">
        <span className="change-action">{change.action}</span>
        <span className="mono-value">{change.target}</span>
        <span className="spacer" />
        <span className="change-impact">{change.impact}</span>
        <span>{change.result}</span>
      </div>
      <div className="change-values">
        <div><span className="field-label">before</span><pre className="record-json">{json(change.before)}</pre></div>
        <div><span className="field-label">after</span><pre className="record-json">{json(change.after)}</pre></div>
      </div>
      {change.error && <p className="form-error card-section">{change.error.kind}: {change.error.message}</p>}
    </article>
  )
}

function triggerTitle(trigger: DeploymentTrigger): string {
  if (trigger.kind === 'git_push') return 'git push'
  if (trigger.kind === 'manual') return 'manual'
  return trigger.kind
}

function sourceRevision(revision: { ref: string; commit: string; message: string | null } | null): string {
  if (!revision) return 'No source revision recorded'

  return `${revision.ref} @ ${revision.commit}${revision.message ? ` · ${revision.message}` : ''}`
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null'
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv-item">
      <div className="kv-k">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  )
}
