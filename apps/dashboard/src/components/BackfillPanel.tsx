import { useState, useEffect, useRef } from 'react'
import { startArchiveBackfill, getArchiveBackfillStatus } from '../api/client'
import type { BackfillStatus } from '../api/client'

function getCurrentMonthNZ(): string {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const year = parts.find(p => p.type === 'year')?.value ?? ''
  const month = parts.find(p => p.type === 'month')?.value ?? ''
  return `${year}-${month}`
}

function getAutoMonthCount(startMonth: string): number {
  if (!/^\d{4}-\d{2}$/.test(startMonth)) return 1

  const [startYearRaw, startMonthRaw] = startMonth.split('-')
  const [currentYearRaw, currentMonthRaw] = getCurrentMonthNZ().split('-')

  const startYear = Number(startYearRaw)
  const startMonthNum = Number(startMonthRaw)
  const currentYear = Number(currentYearRaw)
  const currentMonthNum = Number(currentMonthRaw)

  if (
    !Number.isInteger(startYear) ||
    !Number.isInteger(startMonthNum) ||
    !Number.isInteger(currentYear) ||
    !Number.isInteger(currentMonthNum)
  ) {
    return 1
  }

  const inclusiveMonths = (currentYear - startYear) * 12 + (currentMonthNum - startMonthNum) + 1
  return Math.min(24, Math.max(1, inclusiveMonths))
}

interface BackfillPanelProps {
  onComplete?: () => void
}

export function BackfillPanel({ onComplete }: BackfillPanelProps) {
  const [startMonth, setStartMonth] = useState(getCurrentMonthNZ)
  const [status, setStatus] = useState<BackfillStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmPending, setConfirmPending] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  function stopPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  function startPolling() {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const s = await getArchiveBackfillStatus()
        setStatus(s)
        if (!s.running) {
          stopPolling()
          setSubmitting(false)
          onCompleteRef.current?.()
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2000)
  }

  useEffect(() => stopPolling, [])

  async function handleBackfill() {
    const months = getAutoMonthCount(startMonth)
    setSubmitting(true)
    setNotice(null)
    setSubmitError(null)
    try {
      const s = await startArchiveBackfill({ start_month: startMonth, months })
      setStatus(s)
      startPolling()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('409')) {
        setNotice('Backfill already running')
        startPolling()
      } else {
        setSubmitError(msg)
        setSubmitting(false)
      }
    }
  }

  const isRunning = submitting || (status?.running ?? false)
  const autoMonths = getAutoMonthCount(startMonth)
  const progress = status?.progress
  const pct =
    progress && progress.total_days > 0
      ? Math.round((progress.completed_days / progress.total_days) * 100)
      : 0

  return (
    <>
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 mb-8">
      <h3 className="text-lg font-semibold text-white mb-5">Historical Backfill</h3>

      {/* Controls row */}
      <div className="flex flex-wrap items-end gap-3 mb-1">
        <div>
          <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">
            Start month
          </label>
          <input
            type="month"
            value={startMonth}
            onChange={e => setStartMonth(e.target.value)}
            disabled={isRunning}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
        </div>
        <button
          onClick={() => autoMonths > 6 ? setConfirmPending(true) : handleBackfill()}
          disabled={isRunning}
          className="px-4 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {isRunning ? 'Running…' : 'Start backfill'}
        </button>
      </div>

      <p className="text-xs text-gray-600 mb-5">
        Starts from the 1st of the selected month through current NZ month (auto: {autoMonths} month{autoMonths === 1 ? '' : 's'}, max 24).
      </p>

      {/* 409 notice */}
      {notice && (
        <div className="mb-4 p-3 bg-amber-900/40 border border-amber-700 rounded text-amber-300 text-sm">
          {notice}
        </div>
      )}

      {/* Submit error */}
      {submitError && (
        <div className="mb-4 p-4 bg-red-900/50 border border-red-700 rounded-lg flex items-start justify-between gap-4">
          <p className="text-red-200 text-sm">⚠️ {submitError}</p>
          <button
            onClick={handleBackfill}
            className="shrink-0 px-3 py-1 rounded text-xs font-medium bg-red-700 hover:bg-red-600 text-white transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Running state */}
      {isRunning && (
        <div className="space-y-2">
          <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${pct === 0 ? 'animate-pulse bg-blue-600' : 'bg-blue-500'}`}
              style={{ width: pct === 0 ? '100%' : `${pct}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {progress ? (
              <>
                <span className="text-gray-300">
                  <span className="font-semibold text-white">{progress.completed_days}</span>
                  <span className="text-gray-500"> / {progress.total_days} days</span>
                </span>
                <span className="text-gray-600">·</span>
                <span className="text-gray-400">
                  {progress.rows_upserted.toLocaleString()} rows upserted
                </span>
              </>
            ) : (
              <span className="text-gray-500 text-sm">Starting…</span>
            )}
          </div>
          {status?.range && (
            <p className="text-xs text-gray-600">
              {status.range.start_local} → {status.range.end_local}
              <span className="ml-1 text-gray-700">({status.range.timezone})</span>
            </p>
          )}
        </div>
      )}

      {/* Idle state */}
      {!isRunning && status && (
        <div className="space-y-2">
          {status.range && (
            <p className="text-xs text-gray-600">
              {status.range.start_local} → {status.range.end_local}
              <span className="ml-1 text-gray-700">({status.range.timezone})</span>
            </p>
          )}
          {status.completed_at_utc && !status.last_error && (
            <p className="text-sm text-green-400">
              Completed {new Date(status.completed_at_utc).toLocaleString()}
            </p>
          )}
          {status.last_error && (
            <div className="p-4 bg-red-900/50 border border-red-700 rounded-lg flex items-start justify-between gap-4">
              <p className="text-red-200 text-sm">⚠️ {status.last_error}</p>
              <button
                onClick={handleBackfill}
                className="shrink-0 px-3 py-1 rounded text-xs font-medium bg-red-700 hover:bg-red-600 text-white transition-colors"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>

    {/* Confirmation modal */}
    {confirmPending && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
          <h4 className="text-base font-semibold text-white mb-2">Start backfill?</h4>
          <p className="text-sm text-gray-400 mb-6">
            Backfilling {autoMonths} months can take a while. Continue?
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setConfirmPending(false)}
              className="px-4 py-1.5 rounded text-sm font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => { setConfirmPending(false); handleBackfill() }}
              className="px-4 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  )
}
