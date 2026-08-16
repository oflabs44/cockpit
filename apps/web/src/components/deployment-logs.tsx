import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

// The browser half of docs/architecture.md §3.4: apps/plane's StreamDO fans deployment output
// out over `WS /deployments/{id}/logs`. This renders it and nothing else — no parsing of the
// output, no inference about the deployment from it (CONTEXT.md #2). The only decisions here
// are transport ones: when to reconnect, and how much to keep in a tab.
//
// Loss is reported, never hidden. The stream is loss-aware by construction — the daemon can
// drop chunks (`dropped`), the plane's retained tail can evict them (`evicted`/`gap`), and
// this viewer itself discards the oldest chunks past MAX_CHUNKS. All three are stated above
// the output rather than rendered as a silent hole.

export type LogStage = 'fetch' | 'normalize' | 'build' | 'migrate' | 'apply' | 'health'
export type LogSource = 'stdout' | 'stderr' | 'system'

type LogChunk = {
  seq: number
  stage: LogStage
  source: LogSource
  data: string
  at: number
  dropped: number
  final: boolean
}

type StreamFrame =
  | ({ type: 'log' } & LogChunk)
  | {
      type: 'stream_open'
      retained_from: number | null
      last_seq: number | null
      evicted: number
      terminal: boolean
      gap: boolean
    }
  | { type: 'stream_end'; last_seq: number }

type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'complete' | 'offline'

type Loss = {
  /** Chunks the daemon discarded before delivery, summed over what this viewer received. */
  dropped: number
  /** Chunks that left the plane's retained tail — no client can still read them. */
  evicted: number
  /** The plane had already evicted the chunks this viewer asked to resume from: output it
   *  never saw is gone. Set by the plane, not inferred here. */
  gap: boolean
  /** Chunks this viewer dropped itself to stay under MAX_CHUNKS. */
  truncated: number
}

const NO_LOSS: Loss = { dropped: 0, evicted: 0, gap: false, truncated: 0 }

/** A long build's output, matching StreamDO's own tail bound (MAX_TAIL_ENTRIES = 1000) with
 *  room for live chunks on top of a full replay. Per-chunk `data` is capped at 8 KiB by the
 *  plane's schema, so this is a hard ceiling on the tab's memory, not a guess. */
const MAX_CHUNKS = 2000

/** Frames arrive one WebSocket message at a time and a replay burst is a thousand of them;
 *  rendering per message would re-render a growing list a thousand times. */
const FLUSH_MS = 60

/** Bounded backoff. Exhausting it stops the loop rather than retrying forever against a
 *  deployment that no longer exists — a 404 or a rejected Access cookie fails the handshake
 *  instantly, so "keep trying" would be a tight loop the operator cannot see or stop. The
 *  Retry button is what resumes it. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 20_000, 20_000, 20_000]

export function DeploymentLogs({ deploymentId }: { deploymentId: string }) {
  const { chunks, status, loss, retry } = useDeploymentLogStream(deploymentId)
  const [follow, setFollow] = useState(true)
  const bodyRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!follow) return
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [chunks, follow])

  // Scrolling away from the bottom is itself the "stop following" gesture — the toggle is
  // for saying so deliberately, and for getting back. `atBottom` is slack by a line so a
  // fractional scrollHeight doesn't read as "the operator scrolled up".
  const onScroll = () => {
    const body = bodyRef.current
    if (!body) return
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
    setFollow(atBottom)
  }

  const notices = lossNotices(loss)

  return (
    <div className="term logs">
      <div className="term-head">
        <span className="term-title">deployment output</span>
        <span className="logs-status" data-state={status} role="status">
          {STATUS_TEXT[status]}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-pressed={follow}
          onClick={() => setFollow((on) => !on)}
        >
          {follow ? 'Following' : 'Follow'}
        </button>
        {status === 'offline' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={retry}>
            Retry
          </button>
        )}
      </div>

      {notices.length > 0 && (
        <ul className="logs-notices">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}

      <pre
        ref={bodyRef}
        onScroll={onScroll}
        className="term-body logs-body"
        // `role="log"` defaults to an assertive-enough live region that a build's output
        // would be read aloud line by line; the status above it is the one thing worth
        // announcing. The region stays focusable and labelled so it can be reached and
        // read on demand.
        role="log"
        aria-live="off"
        aria-label="Deployment output"
        tabIndex={0}
      >
        {chunks.length === 0 ? (
          <span className="logs-empty">{EMPTY_TEXT[status]}</span>
        ) : (
          chunks.map((chunk, index) => (
            <Fragment key={chunk.seq}>
              {chunks[index - 1]?.stage !== chunk.stage && (
                <span className="logs-stage">{`\n── ${chunk.stage} ──\n`}</span>
              )}
              {chunk.dropped > 0 && (
                <span className="logs-loss">{`\n── ${chunk.dropped} chunk${chunk.dropped === 1 ? '' : 's'} dropped by the daemon ──\n`}</span>
              )}
              <span className="logs-chunk" data-source={chunk.source}>
                {chunk.data}
              </span>
            </Fragment>
          ))
        )}
      </pre>
    </div>
  )
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  complete: 'complete',
  offline: 'disconnected',
}

const EMPTY_TEXT: Record<StreamStatus, string> = {
  connecting: 'Connecting to the log stream…',
  live: 'Connected. No output yet.',
  reconnecting: 'Connection lost. Reconnecting…',
  complete: 'This deployment produced no output that the plane still retains.',
  offline: 'Disconnected. Retry to reconnect.',
}

function lossNotices(loss: Loss): string[] {
  const notices: string[] = []

  if (loss.gap) {
    notices.push(
      'The plane no longer retains the output this viewer resumed from. Everything before the first line below is gone.',
    )
  }
  if (loss.evicted > 0) {
    notices.push(
      `${loss.evicted} earlier chunk${loss.evicted === 1 ? '' : 's'} left the plane’s retained tail and cannot be read by any client.`,
    )
  }
  if (loss.dropped > 0) {
    notices.push(
      `${loss.dropped} chunk${loss.dropped === 1 ? '' : 's'} were dropped by the daemon before delivery, marked inline below.`,
    )
  }
  if (loss.truncated > 0) {
    notices.push(
      `${loss.truncated} older chunk${loss.truncated === 1 ? '' : 's'} are hidden by this viewer, which keeps the last ${MAX_CHUNKS}. Reload to replay from the plane.`,
    )
  }

  return notices
}

function useDeploymentLogStream(deploymentId: string) {
  const [chunks, setChunks] = useState<LogChunk[]>([])
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [loss, setLoss] = useState<Loss>(NO_LOSS)
  const [retryToken, setRetryToken] = useState(0)

  // The array is held in a ref as well as in state: reconnecting needs the last *rendered*
  // sequence, and a state updater is the wrong place to read it from.
  const chunksRef = useRef<LogChunk[]>([])
  const lastSeqRef = useRef<number | null>(null)

  const retry = useCallback(() => setRetryToken((token) => token + 1), [])

  useEffect(() => {
    let disposed = false
    let terminal = false
    let attempt = 0
    let socket: WebSocket | null = null
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let pending: LogChunk[] = []

    const flush = () => {
      clearTimeout(flushTimer)
      flushTimer = undefined
      if (pending.length === 0) return

      const batch = pending
      pending = []
      const merged = chunksRef.current.concat(batch)
      const overflow = Math.max(0, merged.length - MAX_CHUNKS)
      chunksRef.current = overflow > 0 ? merged.slice(overflow) : merged
      const last = chunksRef.current.at(-1)
      if (last) lastSeqRef.current = last.seq

      const dropped = batch.reduce((total, chunk) => total + chunk.dropped, 0)
      setChunks(chunksRef.current)
      if (overflow > 0 || dropped > 0) {
        setLoss((prev) => ({
          ...prev,
          dropped: prev.dropped + dropped,
          truncated: prev.truncated + overflow,
        }))
      }
    }

    const handle = (frame: StreamFrame) => {
      if (frame.type === 'log') {
        pending.push(frame)
        // A backgrounded tab throttles timers, so a full buffer flushes on arrival instead
        // of waiting — otherwise a chatty build accumulates without bound behind a timer
        // that fires once a minute.
        if (pending.length >= MAX_CHUNKS) flush()
        else if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_MS)
        return
      }

      if (frame.type === 'stream_open') {
        attempt = 0
        if (frame.evicted > 0 || frame.gap) {
          setLoss((prev) => ({
            ...prev,
            evicted: Math.max(prev.evicted, frame.evicted),
            gap: prev.gap || frame.gap,
          }))
        }
        // A terminal stream still replays its tail on this socket; what `terminal` stops is
        // the reconnect when the socket later closes.
        terminal = frame.terminal
        setStatus(frame.terminal ? 'complete' : 'live')
        return
      }

      // stream_end: the deployment stopped producing output. Distinct from the socket
      // closing, which means "reconnect".
      terminal = true
      flush()
      setStatus('complete')
    }

    const scheduleReconnect = () => {
      const delay = BACKOFF_MS[attempt]
      attempt += 1
      if (delay === undefined) {
        setStatus('offline')
        return
      }

      setStatus('reconnecting')
      reconnect = setTimeout(connect, delay)
    }

    function connect() {
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      socket = new WebSocket(streamUrl(deploymentId, lastSeqRef.current))
      socket.onmessage = (event) => {
        const frame = parseFrame(event.data)
        if (frame) handle(frame)
      }
      // `onerror` needs no handler of its own: every failure — a refused handshake included
      // — is followed by `onclose`.
      socket.onclose = () => {
        if (disposed) return
        flush()
        if (terminal) return
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      disposed = true
      clearTimeout(reconnect)
      clearTimeout(flushTimer)
      if (socket) {
        socket.onmessage = null
        socket.onclose = null
        socket.close()
      }
    }
  }, [deploymentId, retryToken])

  return { chunks, status, loss, retry }
}

/** Same origin as the app — the plane serves the UI and the API, and the WebSocket carries
 *  the operator's Access cookie the way every other request here does. */
function streamUrl(deploymentId: string, after: number | null): string {
  const url = new URL(`/deployments/${encodeURIComponent(deploymentId)}/logs`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  // Absent means "replay whatever is retained"; present resumes after the last chunk this
  // viewer actually rendered, so a reconnect neither re-draws nor skips.
  if (after !== null) url.searchParams.set('after', String(after))

  return url.toString()
}

/** The plane's frames are validated by a closed zod schema before they are stored or sent
 *  (apps/plane/src/schema.ts), so this checks the discriminator and trusts the rest. A frame
 *  it cannot read is skipped rather than thrown: one malformed message must not take down a
 *  viewer that is otherwise following a live build. */
function parseFrame(raw: unknown): StreamFrame | null {
  if (typeof raw !== 'string') return null

  try {
    const frame = JSON.parse(raw) as StreamFrame
    if (frame.type === 'log' || frame.type === 'stream_open' || frame.type === 'stream_end') {
      return frame
    }
  } catch {
    // fall through
  }

  return null
}
