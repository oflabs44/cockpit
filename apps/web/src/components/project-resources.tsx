import { Link } from '@tanstack/react-router'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  Clock01Icon,
  DatabaseIcon,
  FirewallIcon,
  GlobeIcon,
  HardDriveIcon,
  Package01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons'
import { appSource, type AppSource, type Resource } from '#/api/resources'
import { HealthStatus } from '#/components/status'

function sourceLabel(source: AppSource | null): string {
  if (source?.type === 'repo') return `${source.url} · ${source.ref}`
  if (source?.type === 'image') return source.image

  return 'Saved source is unavailable'
}

const KIND_ICON: Partial<Record<Resource['kind'], IconSvgElement>> = {
  app: Package01Icon,
  database: DatabaseIcon,
  proxy: GlobeIcon,
  volume: HardDriveIcon,
  cron: Clock01Icon,
  firewall_rule: FirewallIcon,
  daemon: Settings01Icon,
  domain: GlobeIcon,
  dns_record: GlobeIcon,
}

export function AppCards({
  apps,
  serverId,
  projectId,
}: {
  apps: Resource[]
  serverId: string
  projectId: string
}) {
  if (apps.length === 0) {
    return <p className="detail-note">No apps belong to this project yet.</p>
  }

  return (
    <div className="project-apps-grid">
      {apps.map((app) => {
        const source = appSource(app)

        return (
          <Link
            key={app.id}
            to="/$serverId/projects/$projectId/resources/$resourceId"
            params={{ serverId, projectId, resourceId: app.id }}
            className="card project-app-card"
          >
            <div className="card-section">
              <div className="resource-title">
                <HugeiconsIcon icon={Package01Icon} className="icon icon-sm kindicon" />
                <span>{app.name}</span>
                <span className="resource-scope">independent app</span>
              </div>
              <p className="resource-source">{sourceLabel(source)}</p>
            </div>
            <div className="card-section card-foot resource-facts">
              <span><HealthStatus health={app.health} /></span>
              <span className="mono-value">
                {app.current_release_id ? app.current_release_id : 'no release'}
              </span>
              <span className={app.drifted ? 'drift-value is-drifted' : 'drift-value'}>
                {app.drifted ? 'drifted' : 'no drift'}
              </span>
            </div>
          </Link>
        )
      })}
    </div>
  )
}

export function ProjectResourcesTable({
  resources,
  serverId,
  projectId,
}: {
  resources: Resource[]
  serverId: string
  projectId: string
}) {
  if (resources.length === 0) {
    return <p className="detail-note">No resources belong to this project yet.</p>
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 130 }}>kind</th>
            <th>name</th>
            <th>ownership</th>
            <th>health</th>
            <th>current release</th>
            <th>drift</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((resource) => {
            const icon = KIND_ICON[resource.kind]
            const name =
              resource.kind === 'app' ? (
                <Link
                  to="/$serverId/projects/$projectId/resources/$resourceId"
                  params={{ serverId, projectId, resourceId: resource.id }}
                  className="table-link"
                >
                  {resource.name}
                </Link>
              ) : (
                resource.name
              )

            return (
              <tr key={resource.id}>
                <td>
                  <span className="cell">
                    {icon && <HugeiconsIcon icon={icon} className="icon icon-sm kindicon" />}
                    <span className="muted">{resource.kind}</span>
                  </span>
                </td>
                <td>{name}</td>
                <td className="muted">
                  {resource.kind === 'app' ? 'independent app' : 'project resource'}
                </td>
                <td><HealthStatus health={resource.health} /></td>
                <td className="muted">{resource.current_release_id ?? 'not recorded'}</td>
                <td className={resource.drifted ? 'drift-value is-drifted' : 'muted'}>
                  {resource.drifted ? 'drifted' : 'none'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
