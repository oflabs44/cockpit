import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PROVIDERS,
  ServerNameConflictError,
  createServer,
  serversQueryOptions,
  type CreateServerResponse,
  type Provider,
} from '#/api/servers'
import { InstallTerminal } from '#/components/install-terminal'

export function AddServerPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<Provider>(PROVIDERS[0])
  const [created, setCreated] = useState<CreateServerResponse | null>(null)
  const nameId = useId()
  const providerId = useId()

  const mutation = useMutation({
    mutationFn: createServer,
    onSuccess: (result) => {
      setCreated(result)
      // The new row is already in the plane's D1 — refetch so its card shows up (as
      // "enrolling", honestly, since nothing has connected yet) without waiting for the
      // operator to close this panel.
      queryClient.invalidateQueries({ queryKey: serversQueryOptions.queryKey })
    },
  })

  if (created) {
    return (
      <div className="panel card">
        <div className="card-section">
          <p className="server-note">
            <span className="dot dot-pending" /> {created.server.name} created &mdash; run this on the box to
            enrol it:
          </p>
          <div style={{ marginTop: 'calc(var(--spacing) * 3)' }}>
            <InstallTerminal command={created.install_command} />
          </div>
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
        mutation.mutate({ name, provider })
      }}
    >
      <div className="card-section">
        <div className="panel-fields">
          <div className="field">
            <label className="field-label" htmlFor={nameId}>
              name
            </label>
            <input
              id={nameId}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="prod-fsn1"
              required
              autoFocus
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
            {mutation.error instanceof ServerNameConflictError
              ? mutation.error.message
              : `Couldn't create the server (${mutation.error.message}).`}
          </p>
        )}
      </div>
      <div className="card-section card-foot">
        <div className="panel-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create'}
          </button>
          {/* Disabled while pending: cancelling mid-create discards the response — and the
              token in it is returned exactly once, so losing it strands the server row. */}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
