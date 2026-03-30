import type {
  LiveResponse,
  HistoryResponse,
  DailyResponse,
  RatesResponse,
  BillResponse,
  BillIntervalsResponse,
  Energy5mResponse,
} from '../types'
import { getMockLive, getMockHistory, getMockDaily } from './mock'

export const USE_MOCK = false

type LiveApiEnvelope = {
  data: LiveResponse | null
  message?: string
}

type HistoryApiEnvelope = {
  data: HistoryResponse['data']
}

type DailyApiEnvelope = {
  data: DailyResponse[]
}

export async function getLive(): Promise<LiveResponse> {
  if (USE_MOCK) {
    return getMockLive()
  }

  const response = await fetch('/api/live')
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const payload = (await response.json()) as LiveResponse | LiveApiEnvelope
  if ('data' in payload) {
    if (!payload.data) {
      throw new Error(payload.message || 'No live data yet')
    }
    return payload.data
  }

  return payload
}

export async function getHistory(
  fromIso: string,
  toIso: string
): Promise<HistoryResponse> {
  if (USE_MOCK) {
    return getMockHistory()
  }

  const url = `/api/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const payload = (await response.json()) as HistoryResponse | HistoryApiEnvelope
  if ('data' in payload) {
    return { data: payload.data }
  }

  return payload
}

export async function getDaily(
  fromIso: string,
  toIso: string
): Promise<DailyResponse | null> {
  if (USE_MOCK) {
    return getMockDaily()
  }

  const url = `/api/daily?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const payload = (await response.json()) as DailyResponse | DailyResponse[] | DailyApiEnvelope
  if (Array.isArray(payload)) {
    return payload[0] || null
  }

  if ('data' in payload) {
    return payload.data[0] || null
  }

  return payload
}

export async function getRates(): Promise<RatesResponse> {
  const response = await fetch('/api/rates')
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return (await response.json()) as RatesResponse
}

export async function putRates(rates: RatesResponse): Promise<RatesResponse> {
  const response = await fetch('/api/rates', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rates),
  })
  if (!response.ok) {
    let msg = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      if (body.error) msg = body.error
      else if (body.message) msg = body.message
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return (await response.json()) as RatesResponse
}

export async function getBill(
  fromIso: string,
  toIso: string
): Promise<BillResponse> {
  const url = `/api/bill?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return (await response.json()) as BillResponse
}

export async function getBillIntervals(
  fromIso: string,
  toIso: string
): Promise<BillIntervalsResponse> {
  const url = `/api/bill-intervals?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return (await response.json()) as BillIntervalsResponse
}

export async function fetchEnergy5m(
  fromIso: string,
  toIso: string
): Promise<Energy5mResponse> {
  const url = `/api/energy5m?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return (await response.json()) as Energy5mResponse
}

export type BackfillRequest = { start_month: string; months: number }
export type BackfillStatus = {
  running: boolean
  started_at_utc?: string
  completed_at_utc?: string
  last_error?: string
  range?: {
    start_local: string
    end_local: string
    timezone: string
    requested_start_local?: string
    requested_end_local?: string
    available_start_local?: string
    available_end_local?: string
    clamped?: boolean
  }
  progress?: {
    total_days: number
    completed_days: number
    total_requests: number
    completed_requests: number
    rows_upserted: number
  }
}

export async function startArchiveBackfill(req: BackfillRequest): Promise<BackfillStatus> {
  const response = await fetch('/api/archive/backfill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!response.ok) {
    let msg = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      if (body.error) msg = body.error
      else if (body.message) msg = body.message
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return (await response.json()) as BackfillStatus
}

export async function getArchiveBackfillStatus(): Promise<BackfillStatus> {
  const response = await fetch('/api/archive/backfill/status')
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return (await response.json()) as BackfillStatus
}
