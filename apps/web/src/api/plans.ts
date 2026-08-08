import { queryOptions } from '@tanstack/react-query'

// Minimal shape — the rail badge only needs a count of matching rows, not the full
// `PlanSchema`/`CorruptPlanSchema` union from apps/plane/src/schema.ts.
export type PendingPlan = { id: string | null }

export async function fetchPendingPlans(): Promise<PendingPlan[]> {
  // `status=pending` is the plane's own filter (apps/plane/src/routes/plans-list.ts) — plans
  // still awaiting the operator's decision, not the full history (approved/applying/applied/
  // rejected/failed/reverted all excluded).
  const res = await fetch('/plans?status=pending')

  if (!res.ok) throw new Error(`GET /plans failed: ${res.status}`)

  const body = (await res.json()) as { plans?: unknown[] }

  if (!Array.isArray(body.plans)) throw new Error('GET /plans: unexpected response shape')

  return body.plans as PendingPlan[]
}

// Same shared-cache-key pattern as api/servers.ts's `serversQueryOptions` — named for what it
// holds (the rail badge is its only consumer today, but the key is `['plans', 'pending']`,
// not `['plans']`, so a future full plans list can cache independently).
export const plansQueryOptions = queryOptions({
  queryKey: ['plans', 'pending'],
  queryFn: fetchPendingPlans,
})
