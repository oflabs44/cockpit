import { useId, useState, type ReactNode } from 'react'
import { Link, createFileRoute, useNavigate, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import {
  createManualDeployment,
  deploymentQueryOptions,
  projectDeploymentsQueryOptions,
} from '#/api/deployments'
import { projectQueryOptions } from '#/api/projects'
import {
  ResourceNotFoundError,
  appSource,
  resourceQueryOptions,
  serverResourcesQueryOptions,
  updateResourceConfiguration,
  type AppSource,
  type Resource,
} from '#/api/resources'
import { serverDetailQueryOptions } from '#/api/server-detail'
import { HealthStatus } from '#/components/status'
import { formatAgo } from '#/lib/format'
import type { CrumbSegment } from '#/routes/_app'

function sourceLabel(source: AppSource | null): string {
  if (source?.type === 'repo') return source.url
  if (source?.type === 'image') return source.image

  return 'Unavailable'
}

export const Route = createFileRoute('/_app/$serverId/projects/$projectId/resources/$resourceId')({
  loader: async ({ context, params }): Promise<{ crumbs: CrumbSegment[] }> => {
    const [resource, project, detail] = await Promise.all([
      context.queryClient.ensureQueryData(resourceQueryOptions(params.resourceId)),
      context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
      context.queryClient.ensureQueryData(serverDetailQueryOptions(params.serverId)),
    ])

    if (
      resource.kind !== 'app' ||
      resource.server_id !== params.serverId ||
      resource.project_id !== params.projectId ||
      project.server_id !== params.serverId
    ) {
      throw new ResourceNotFoundError('This app does not belong to this project')
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
        { label: resource.name },
      ],
    }
  },
  pendingComponent: AppPending,
  errorComponent: AppError,
  component: AppDetail,
})

function AppPending() {
  return <div className="empty"><p className="empty-body">Loading app&hellip;</p></div>
}

function AppError({ error }: ErrorComponentProps) {
  const { serverId, projectId } = Route.useParams()
  const router = useRouter()

  if (error instanceof ResourceNotFoundError) {
    return (
      <div className="empty">
        <h2 className="empty-title">No such app</h2>
        <p className="empty-body">{error.message}.</p>
        <div className="empty-actions">
          <Link
            to="/$serverId/projects/$projectId/resources"
            params={{ serverId, projectId }}
            className="btn btn-ghost btn-lg"
          >
            Back to resources
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load the app</h2>
      <p className="empty-body">{error.message}.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function AppDetail() {
  const { serverId, projectId, resourceId } = Route.useParams()
  const { data: resource, error } = useSuspenseQuery(resourceQueryOptions(resourceId))
  const source = appSource(resource)

  return (
    <>
      {error && <p className="server-note" role="alert">Refresh failed. This app may show stale data.</p>}
      <div className="app-detail-head">
        <Link
          to="/$serverId/projects/$projectId/resources"
          params={{ serverId, projectId }}
          className="back-link"
        >
          &larr; All resources
        </Link>
      </div>
      <div className="summary project-summary">
        <div className="card">
          <div className="card-section">
            <div className="kv kv-inline">
              <Kv label="ownership">independent app</Kv>
              <Kv label="health"><HealthStatus health={resource.health} /></Kv>
              <Kv label="drift">{resource.drifted ? 'drifted' : 'none'}</Kv>
              <Kv label="release">{resource.current_release_id ?? 'No release recorded'}</Kv>
              <Kv label="source">{sourceLabel(source)}</Kv>
              <Kv label="saved">{formatAgo(resource.updated_at)}</Kv>
            </div>
          </div>
        </div>
      </div>

      <div className="detail-columns">
        <ConfigurationEditor resourceId={resourceId} serverId={serverId} resource={resource} />
        <DeployPanel
          resourceId={resourceId}
          serverId={serverId}
          projectId={projectId}
          sourceType={source?.type ?? null}
        />
      </div>
    </>
  )
}

function ConfigurationEditor({
  resourceId,
  serverId,
  resource,
}: {
  resourceId: string
  serverId: string
  resource: Resource
}) {
  const configId = useId()
  const [text, setText] = useState(() => JSON.stringify(resource.configuration, null, 2))
  const [parseError, setParseError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: updateResourceConfiguration,
    onSuccess: async (updated) => {
      queryClient.setQueryData(resourceQueryOptions(resourceId).queryKey, updated)
      setText(JSON.stringify(updated.configuration, null, 2))
      setParseError(null)
      await queryClient.invalidateQueries({ queryKey: serverResourcesQueryOptions(serverId).queryKey })
    },
  })

  return (
    <form
      className="card detail-panel"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.reset()

        try {
          const parsed: unknown = JSON.parse(text)

          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            setParseError('Configuration must be a JSON object.')
            return
          }

          setParseError(null)
          mutation.mutate({ id: resourceId, configuration: Object.fromEntries(Object.entries(parsed)) })
        } catch {
          setParseError('Configuration must contain valid JSON.')
        }
      }}
    >
      <div className="card-section detail-panel-head">
        <div>
          <h2 className="panel-title">Saved configuration</h2>
          <p className="panel-copy">Save updates the next deployment input. It does not apply changes.</p>
        </div>
        <span className="config-version">schema v{resource.configuration_version}</span>
      </div>
      <div className="card-section detail-panel-body">
        <label className="field-label" htmlFor={configId}>configuration JSON</label>
        <textarea
          id={configId}
          className="textarea config-editor"
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setParseError(null)
            mutation.reset()
          }}
          spellCheck={false}
        />
        {(parseError || mutation.isError) && (
          <p className="form-error" role="alert">
            {parseError ?? `Couldn't save the configuration (${mutation.error?.message}).`}
          </p>
        )}
        {mutation.isSuccess && <p className="form-success" role="status">Configuration saved. Nothing was applied.</p>}
      </div>
      <div className="card-section card-foot">
        <button type="submit" className="btn btn-ghost btn-sm" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save configuration'}
        </button>
      </div>
    </form>
  )
}

function DeployPanel({
  resourceId,
  serverId,
  projectId,
  sourceType,
}: {
  resourceId: string
  serverId: string
  projectId: string
  sourceType: 'repo' | 'image' | null
}) {
  const commitId = useId()
  const [commit, setCommit] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: createManualDeployment,
    onSuccess: async (deployment) => {
      queryClient.setQueryData(deploymentQueryOptions(deployment.id).queryKey, deployment)
      await queryClient.invalidateQueries({ queryKey: projectDeploymentsQueryOptions(projectId).queryKey })
      await navigate({
        to: '/$serverId/projects/$projectId/deployments/$deploymentId',
        params: { serverId, projectId, deploymentId: deployment.id },
      })
    },
  })

  const canDeploy = sourceType === 'image' || (sourceType === 'repo' && commit.trim().length > 0)

  return (
    <form
      className="card detail-panel deploy-panel"
      onSubmit={(event) => {
        event.preventDefault()

        if (!canDeploy) return

        mutation.mutate({
          resourceId,
          commit: sourceType === 'repo' ? commit.trim() : null,
        })
      }}
    >
      <div className="card-section detail-panel-head">
        <div>
          <h2 className="panel-title">Manual deployment</h2>
          <p className="panel-copy">Deploy snapshots the saved configuration into a new immutable record.</p>
        </div>
      </div>
      <div className="card-section detail-panel-body">
        {sourceType === 'repo' ? (
          <div className="field">
            <label className="field-label" htmlFor={commitId}>commit</label>
            <input
              id={commitId}
              className="input mono-input"
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
              placeholder="Full commit SHA"
              required
            />
            <p className="field-help">Repository deployments require an explicit commit.</p>
          </div>
        ) : sourceType === 'image' ? (
          <p className="panel-copy">This image app sends a null commit. The saved image reference selects the artifact.</p>
        ) : (
          <p className="form-error" role="alert">The saved source is unavailable. Save a valid app configuration first.</p>
        )}
        {mutation.isError && (
          <p className="form-error" role="alert">Couldn&rsquo;t create the deployment ({mutation.error.message}).</p>
        )}
      </div>
      <div className="card-section card-foot">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canDeploy || mutation.isPending}>
          {mutation.isPending ? 'Queuing…' : 'Deploy'}
        </button>
      </div>
    </form>
  )
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv-item">
      <div className="kv-k">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  )
}
