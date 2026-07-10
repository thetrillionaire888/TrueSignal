'use client'

import * as React from 'react'
import { io, type Socket } from 'socket.io-client'

const COLLECTOR_PORT = 3001

// Build a collector API URL with the gateway transform query param.
export function collectorUrl(path: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ XTransformPort: String(COLLECTOR_PORT) })
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v)
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${params.toString()}`
}

export async function collectorFetch<T>(
  path: string,
  opts?: RequestInit & { json?: unknown }
): Promise<T> {
  const { json, ...init } = opts ?? {}
  const res = await fetch(collectorUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: json ? JSON.stringify(json) : init?.body,
  })
  const data = await res.json().catch(() => ({ error: 'invalid response' }))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

export type AuthState =
  | 'disconnected'
  | 'connected'
  | 'code_sent'
  | 'authenticated'
  | 'awaiting_2fa'
  | 'error'

export type SessionInfo = {
  state: AuthState
  me: { id: string; firstName: string; lastName: string; username: string; phone: string } | null
  sessionSaved: boolean
  error: string | null
}

export type ResolvedChannel = {
  id: string
  title: string
  username: string | null
  type: string
  participantCount: number
  verified: boolean
}

export type IngestProgress = {
  jobId: string
  phase: 'resolve' | 'resolved' | 'fetching' | 'ingesting' | 'complete' | 'error'
  message: string
  fetched?: number
  limit?: number
  signals?: number
  channel?: ResolvedChannel
  channelId?: string
  channelName?: string
  inserted?: number
  signalsParsed?: number
  totalMessages?: number
  totalSignals?: number
  paused?: boolean
  stopped?: boolean
  canResume?: boolean
}

export type IngestionControlState = 'running' | 'paused' | 'stopped' | 'idle'

export type IngestionStatus = {
  state: IngestionControlState
  jobId: string | null
  channelId: string | null
  channelName: string | null
  fetched: number
  inserted: number
  signalsParsed: number
  offsetId: number | null
  canResume: boolean
}

export type EvalProgress = {
  jobId: string
  phase: 'starting' | 'fetching' | 'evaluating' | 'complete' | 'error'
  message: string
  current?: number
  total?: number
  instrument?: string
  summary?: {
    total: number
    wins: number
    losses: number
    breakeven: number
    invalid: number
    noData: number
    winRate: number
    totalR: number
    barsCached?: number
    barsFetched?: number
  }
  results?: Array<{
    signalId: string
    instrument: string
    outcome: string
    rMultiple: number
  }>
}

// Singleton socket manager — connects lazily on first use.
let socket: Socket | null = null

export function useCollectorSocket(
  onProgress: (p: IngestProgress) => void,
  onEvalProgress?: (p: EvalProgress) => void
) {
  const cbRef = React.useRef(onProgress)
  const evalCbRef = React.useRef(onEvalProgress)
  React.useEffect(() => {
    cbRef.current = onProgress
    evalCbRef.current = onEvalProgress
  })

  React.useEffect(() => {
    if (!socket) {
      socket = io('/?XTransformPort=' + COLLECTOR_PORT, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1500,
        timeout: 10000,
      })
    }
    const handler = (p: IngestProgress) => cbRef.current(p)
    const evalHandler = (p: EvalProgress) => evalCbRef.current?.(p)
    socket.on('ingest:progress', handler)
    socket.on('ingest:complete', handler)
    socket.on('ingest:error', handler)
    socket.on('evaluate:progress', evalHandler)
    return () => {
      socket?.off('ingest:progress', handler)
      socket?.off('ingest:complete', handler)
      socket?.off('ingest:error', handler)
      socket?.off('evaluate:progress', evalHandler)
    }
  }, [])
}
