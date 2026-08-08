import { errorDetail, type Provider, type Server } from '#/api/servers'

// Shape matches apps/plane/src/schema.ts's `RedeemResponse`. Only the "create a new server on
// redeem" branch of `RedeemBody` (name + provider) is exposed here — the `server_id` branch
// (binding a claim to a pre-created server row) has no UI path yet.
export type RedeemBody = { name: string; provider: Provider }
export type RedeemResponse = { server: Server }

// The two documented failure modes of POST /enrolments/{code}/redeem
// (apps/plane/src/routes/enrolments-redeem.ts), kept distinct so the form can say which one
// happened instead of a generic failure.
export class ClaimCodeNotFoundError extends Error {}
// The route's own 409 doc: "no daemon is currently holding this claim code's socket ... or
// the server name is already taken" — genuinely two causes behind one status code, so the
// message names both rather than picking one and being wrong half the time.
export class RedeemConflictError extends Error {}

export async function redeemEnrolment(code: string, body: RedeemBody): Promise<RedeemResponse> {
  const res = await fetch(`/enrolments/${encodeURIComponent(code)}/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 404) throw new ClaimCodeNotFoundError('No such claim code, or it has expired')

  if (res.status === 409) {
    throw new RedeemConflictError(
      'That name is already taken, or no daemon is currently waiting with this code',
    )
  }

  if (!res.ok) {
    throw new Error(`POST /enrolments/${code}/redeem failed: ${res.status}${await errorDetail(res)}`)
  }

  const redeemed = (await res.json()) as Partial<RedeemResponse>

  if (!redeemed.server) throw new Error(`POST /enrolments/${code}/redeem: unexpected response shape`)

  return redeemed as RedeemResponse
}
