import { useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ConsoleIcon, Copy01Icon } from '@hugeicons/core-free-icons'

// apps/plane/src/routes/servers-create.ts builds `install_command` as exactly
// `curl -fsSL <url> | sh -s -- --plane <planeUrl> --token <token>` — matched structurally so
// the real flags/URL/token render as distinct tokens (docs/design.md §5.4). A command that
// doesn't match (a future plane change) still renders verbatim as one plain token rather than
// breaking, since the string itself is always the real, copyable command regardless.
const INSTALL_COMMAND_SHAPE =
  /^curl (-\S+) (\S+) \| sh (-\S+) -- --plane (\S+) --token (\S+)$/

export function InstallTerminal({ command }: { command: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const match = command.match(INSTALL_COMMAND_SHAPE)

  const copy = async () => {
    // Copy takes the command only — no prompt, no styling — so it pastes straight into a
    // shell (docs/design.md §5.4). writeText rejects on plain-HTTP origins and unfocused
    // documents — a silent failure here means the operator pastes a stale clipboard
    // (possibly an old token) into a shell, so the failure must be visible.
    try {
      await navigator.clipboard.writeText(command)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }

    setTimeout(() => setCopyState('idle'), 2000)
  }

  return (
    <div className="term">
      <div className="term-head">
        <HugeiconsIcon icon={ConsoleIcon} />
        <span className="term-title">
          {copyState === 'failed' ? 'copy failed — select the text instead' : 'run on the server'}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-quiet btn-icon btn-sm term-copy"
          data-copied={copyState === 'copied' || undefined}
          onClick={copy}
          title="Copy"
        >
          <HugeiconsIcon icon={Copy01Icon} className="icon icon-sm" />
        </button>
      </div>
      <code className="term-body">
        <span className="t-prompt">$ </span>
        {match ? (
          <>
            <span className="t-cmd">curl</span> <span className="t-flag">{match[1]}</span>{' '}
            <span className="t-url">{match[2]}</span> <span className="t-op">|</span>{' '}
            <span className="t-cmd">sh</span> <span className="t-flag">{match[3]}</span>{' '}
            <span className="t-op">--</span> <span className="t-flag">--plane</span>{' '}
            <span className="t-str">{match[4]}</span> <span className="t-flag">--token</span>{' '}
            <span className="t-slot">{match[5]}</span>
          </>
        ) : (
          <span className="t-cmd">{command}</span>
        )}
      </code>
    </div>
  )
}
