import type { ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { projectQueryOptions } from '#/api/projects'
import { formatTimestamp } from '#/lib/format'

export const Route = createFileRoute('/_app/$serverId/projects/$projectId/settings')({
  component: ProjectSettings,
})

function ProjectSettings() {
  const { projectId } = Route.useParams()
  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId))

  return (
    <>
      <div className="summary project-summary">
        <div className="card">
          <div className="card-section">
            <div className="kv kv-inline">
              <Kv label="name">{project.name}</Kv>
              <Kv label="project id">{project.id}</Kv>
              <Kv label="server id">{project.server_id}</Kv>
              <Kv label="created">{formatTimestamp(project.created_at)}</Kv>
              <Kv label="updated">{formatTimestamp(project.updated_at)}</Kv>
            </div>
          </div>
        </div>
      </div>
      <div className="capability-note">
        <span className="label">Read only</span>
        <p>The Plane API has no project settings mutation. Project names and server ownership cannot change here.</p>
      </div>
    </>
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
