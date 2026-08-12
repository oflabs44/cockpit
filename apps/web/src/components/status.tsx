import type { DeploymentStatus, DeploymentStep } from '#/api/deployments'
import type { Health } from '#/api/resources'

const HEALTH_DOT: Record<Health, string | null> = {
  healthy: 'dot-healthy',
  degraded: 'dot-degraded',
  unhealthy: 'dot-failed',
  stopped: 'dot-stopped',
  unknown: null,
}

const DEPLOYMENT_DOT: Record<DeploymentStatus, string> = {
  queued: 'dot-pending',
  fetching: 'dot-pending',
  building: 'dot-pending',
  planning: 'dot-pending',
  deploying: 'dot-pending',
  checking: 'dot-pending',
  succeeded: 'dot-healthy',
  failed: 'dot-failed',
  cancelled: 'dot-stopped',
}

const STEP_DOT: Record<DeploymentStep['status'], string> = {
  pending: 'dot-stopped',
  running: 'dot-pending',
  succeeded: 'dot-healthy',
  failed: 'dot-failed',
  skipped: 'dot-stopped',
}

export function HealthStatus({ health }: { health: Health }) {
  const dot = HEALTH_DOT[health]

  return (
    <span className="status-value">
      {dot && <span className={`dot ${dot}`} aria-hidden="true" />}
      {health}
    </span>
  )
}

export function DeploymentStatusValue({ status }: { status: DeploymentStatus }) {
  return (
    <span className="status-value">
      <span className={`dot ${DEPLOYMENT_DOT[status]}`} aria-hidden="true" />
      {status}
    </span>
  )
}

export function StepStatusValue({ status }: { status: DeploymentStep['status'] }) {
  return (
    <span className="status-value">
      <span className={`dot ${STEP_DOT[status]}`} aria-hidden="true" />
      {status}
    </span>
  )
}
