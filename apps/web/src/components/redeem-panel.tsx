import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ClaimCodeNotFoundError, RedeemConflictError, redeemEnrolment } from '#/api/enrolments'
import { PROVIDERS, serversQueryOptions, type Provider } from '#/api/servers'

export function RedeemPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<Provider>(PROVIDERS[0])
  const [redeemedName, setRedeemedName] = useState<string | null>(null)
  const codeId = useId()
  const nameId = useId()
  const providerId = useId()

  const mutation = useMutation({
    mutationFn: () => redeemEnrolment(code, { name, provider }),
    onSuccess: (result) => {
      setRedeemedName(result.server.name)
      queryClient.invalidateQueries({ queryKey: serversQueryOptions.queryKey })
    },
  })

  if (redeemedName) {
    return (
      <div className="panel card">
        <div className="card-section">
          {/* "redeemed", not "connected": the response confirms the binding, but whether the
              daemon's socket handshake completed after delivery is the list's fact to show. */}
          <p className="server-note">
            <span className="dot dot-pending" /> {redeemedName} redeemed.
          </p>
        </div>
        <div className="card-section card-foot">
          <div className="panel-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <form
      className="panel card"
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
    >
      <div className="card-section">
        <div className="panel-fields">
          <div className="field">
            <label className="field-label" htmlFor={codeId}>
              claim code
            </label>
            <input
              id={codeId}
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ck_claim_…"
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={nameId}>
              name
            </label>
            <input
              id={nameId}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="lab-nbg1"
              required
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={providerId}>
              provider
            </label>
            <select
              id={providerId}
              className="select"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        {mutation.isError && (
          <p className="form-error" role="alert" style={{ marginTop: 'calc(var(--spacing) * 3)' }}>
            {mutation.error instanceof ClaimCodeNotFoundError || mutation.error instanceof RedeemConflictError
              ? mutation.error.message
              : `Couldn't redeem the code (${mutation.error.message}).`}
          </p>
        )}
      </div>
      <div className="card-section card-foot">
        <div className="panel-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={mutation.isPending}>
            {mutation.isPending ? 'Redeeming…' : 'Redeem'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
