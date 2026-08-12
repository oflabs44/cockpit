import { useId, useState } from 'react'
import { createFileRoute, useNavigate, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import {
  ResourceConflictError,
  createProjectResource,
  resourceQueryOptions,
  serverResourcesQueryOptions,
  type AppConfiguration,
} from '#/api/resources'
import { AppCards, ProjectResourcesTable } from '#/components/project-resources'

export const Route = createFileRoute('/_app/$serverId/projects/$projectId/resources/')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(serverResourcesQueryOptions(params.serverId)),
  errorComponent: ResourcesError,
  component: ResourcesScreen,
})

function ResourcesError({ error }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load resources</h2>
      <p className="empty-body">{error.message}.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

function ResourcesScreen() {
  const { serverId, projectId } = Route.useParams()
  const { data: serverResources, error } = useSuspenseQuery(serverResourcesQueryOptions(serverId))
  const [adding, setAdding] = useState(false)
  const resources = serverResources.filter((resource) => resource.project_id === projectId)
  const apps = resources.filter((resource) => resource.kind === 'app')

  if (adding) {
    return <CreateAppPanel serverId={serverId} projectId={projectId} onClose={() => setAdding(false)} />
  }

  return (
    <>
      {error && <p className="server-note" role="alert">Refresh failed. Resource data may be stale.</p>}
      <div className="toolbar">
        <p className="toolbar-note">Apps own their saved configuration, release, health, drift, and deployment history.</p>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          Add app
        </button>
      </div>

      <div className="sec compact-sec"><span className="label">Apps</span></div>
      <AppCards apps={apps} serverId={serverId} projectId={projectId} />

      <div className="sec"><span className="label">All project resources</span></div>
      <ProjectResourcesTable resources={resources} serverId={serverId} projectId={projectId} />
    </>
  )
}

function CreateAppPanel({
  serverId,
  projectId,
  onClose,
}: {
  serverId: string
  projectId: string
  onClose: () => void
}) {
  const nameId = useId()
  const sourceTypeId = useId()
  const sourceId = useId()
  const refId = useId()
  const [name, setName] = useState('')
  const [sourceType, setSourceType] = useState<'repo' | 'image'>('repo')
  const [sourceValue, setSourceValue] = useState('')
  const [ref, setRef] = useState('main')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: createProjectResource,
    onSuccess: async (resource) => {
      queryClient.setQueryData(resourceQueryOptions(resource.id).queryKey, resource)
      await queryClient.invalidateQueries({ queryKey: serverResourcesQueryOptions(serverId).queryKey })
      await navigate({
        to: '/$serverId/projects/$projectId/resources/$resourceId',
        params: { serverId, projectId, resourceId: resource.id },
      })
    },
  })

  const configuration: AppConfiguration = {
    source:
      sourceType === 'repo'
        ? { type: 'repo', url: sourceValue.trim(), ref: ref.trim() }
        : { type: 'image', image: sourceValue.trim() },
    domains: [],
    ports: [],
    env: {},
    replicas: 1,
    limits: { cpu: '1', memory: '512m' },
    restart: 'unless-stopped',
  }

  return (
    <form
      className="panel card"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate({ projectId, name: name.trim(), kind: 'app', configuration })
      }}
    >
      <div className="card-section">
        <div className="panel-fields app-create-fields">
          <div className="field">
            <label className="field-label" htmlFor={nameId}>app name</label>
            <input
              id={nameId}
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="api"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={sourceTypeId}>source type</label>
            <select
              id={sourceTypeId}
              className="select"
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value === 'image' ? 'image' : 'repo')}
            >
              <option value="repo">Repository</option>
              <option value="image">Image</option>
            </select>
          </div>
          <div className="field field-wide">
            <label className="field-label" htmlFor={sourceId}>
              {sourceType === 'repo' ? 'repository URL' : 'image'}
            </label>
            <input
              id={sourceId}
              className="input mono-input"
              value={sourceValue}
              onChange={(event) => setSourceValue(event.target.value)}
              placeholder={sourceType === 'repo' ? 'https://github.com/org/repo.git' : 'ghcr.io/org/app:latest'}
              required
            />
          </div>
          {sourceType === 'repo' && (
            <div className="field">
              <label className="field-label" htmlFor={refId}>ref</label>
              <input
                id={refId}
                className="input mono-input"
                value={ref}
                onChange={(event) => setRef(event.target.value)}
                required
              />
            </div>
          )}
        </div>
        <p className="field-help">The app starts with conservative limits. Edit the complete saved configuration after creation.</p>
        {mutation.isError && (
          <p className="form-error" role="alert">
            {mutation.error instanceof ResourceConflictError
              ? mutation.error.message
              : `Couldn't create the app (${mutation.error.message}).`}
          </p>
        )}
      </div>
      <div className="card-section card-foot">
        <div className="panel-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create app'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
