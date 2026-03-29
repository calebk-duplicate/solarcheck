import { useState, useEffect, useRef, useCallback } from 'react'
import { getLive, getHistory, getDaily, getRates, getBill, USE_MOCK } from '../api/client'
import type { LiveResponse, HistoryResponse, DailyResponse, RatesResponse, RatePeriod } from '../types'
import { MetricCard } from '../components/MetricCard'
import { StatusBadge } from '../components/StatusBadge'
import { HistoryChart } from '../components/HistoryChart'
import { RatesEditor } from '../components/RatesEditor'
import { BillEstimate } from '../components/BillEstimate'
import { BackfillPanel } from '../components/BackfillPanel'
import { determineStatus, formatWatts, formatTimestamp, formatKWh, formatCurrency } from '../utils/format'
import { todayInTz, startOfLocalDay, endOfLocalDay, formatDayDisplay } from '../utils/dateTime'

// Returns current HH:mm and whether it's a weekend in the given IANA timezone.
function getCurrentTimeInTz(timezone: string): { hhmm: string; isWeekend: boolean } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now)
  const hour = parts.find(p => p.type === 'hour')?.value ?? '00'
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00'
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Mon'
  return {
    hhmm: `${hour}:${minute}`,
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function isInPeriod(hhmm: string, isWeekend: boolean, period: RatePeriod): boolean {
  const days = period.days ?? 'all'
  if (days === 'weekday' && isWeekend) return false
  if (days === 'weekend' && !isWeekend) return false
  const cur = toMinutes(hhmm)
  return cur >= toMinutes(period.start) && cur < toMinutes(period.end)
}

function hasFreeImportNow(rates: RatesResponse): boolean {
  try {
    const { hhmm, isWeekend } = getCurrentTimeInTz(rates.timezone)
    return rates.import_periods.some(p => p.cents_per_kwh === 0 && isInPeriod(hhmm, isWeekend, p))
  } catch {
    return false
  }
}

export function Dashboard() {
  const [liveData, setLiveData] = useState<LiveResponse | null>(null)
  const [historyData, setHistoryData] = useState<HistoryResponse | null>(null)
  const [dailyData, setDailyData] = useState<DailyResponse | null>(null)
  const [rates, setRates] = useState<RatesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [lastLiveSuccessAt, setLastLiveSuccessAt] = useState<number | null>(null)
  const [lastLiveError, setLastLiveError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(Date.now())
  const [refreshKey, setRefreshKey] = useState(0)
  // selectedDay: local date string "YYYY-MM-DD" in the configured timezone
  const [selectedDay, setSelectedDay] = useState<string>('')
  // timezone from the rates config
  const [timezone, setTimezone] = useState<string>('UTC')
  // chartVersion tracks user-triggered day changes; starts at -1 so the effect
  // can distinguish "initial load" (chartVersion === -1 → skip) from user actions.
  const [chartVersion, setChartVersion] = useState(-1)

  const chartRef = useRef<HTMLDivElement>(null)

  const isConnected = lastLiveSuccessAt !== null && nowMs - lastLiveSuccessAt <= 10000
  const todayKey = timezone ? todayInTz(timezone) : ''

  // Fetch data for a specific local day and update chart/summary state
  const fetchDayData = useCallback(async (dayKey: string, tz: string) => {
    try {
      const from = startOfLocalDay(dayKey, tz)
      const to = endOfLocalDay(dayKey, tz)
      const [history, daily, bill] = await Promise.all([
        getHistory(from.toISOString(), to.toISOString()),
        getDaily(from.toISOString(), to.toISOString()),
        getBill(from.toISOString(), to.toISOString()).catch(() => null),
      ])
      const mergedDaily = daily
        ? {
            ...daily,
            import_cost: bill?.summary.total_import_cost,
            export_credit: bill?.summary.total_export_credit,
            net_cost: bill?.summary.total_net_cost,
          }
        : null
      setHistoryData(history)
      setDailyData(mergedDaily)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    async function fetchInitialData() {
      try {
        setIsLoading(true)

        // Fetch rates first to obtain the configured timezone before computing
        // local-day boundaries (critical for timezones far from UTC like NZ UTC+13).
        const ratesData = await getRates()
        const tz = ratesData.timezone || 'UTC'
        const todayKeyLocal = todayInTz(tz)

        const from = startOfLocalDay(todayKeyLocal, tz)
        const to = endOfLocalDay(todayKeyLocal, tz)

        const [live, history, daily, bill] = await Promise.all([
          getLive(),
          getHistory(from.toISOString(), to.toISOString()),
          getDaily(from.toISOString(), to.toISOString()),
          getBill(from.toISOString(), to.toISOString()).catch(() => null),
        ])

        const mergedDaily = daily
          ? {
              ...daily,
              import_cost: bill?.summary.total_import_cost,
              export_credit: bill?.summary.total_export_credit,
              net_cost: bill?.summary.total_net_cost,
            }
          : null

        setRates(ratesData)
        setTimezone(tz)
        setSelectedDay(todayKeyLocal)
        setLiveData(live)
        setHistoryData(history)
        setDailyData(mergedDaily)
        setLastLiveSuccessAt(Date.now())
        setLastLiveError(null)
        setError(null)
        // Mark initial load complete. chartVersion moves from -1 → 0 so the
        // day-change effect (which skips when chartVersion <= 0) won't re-fetch.
        setChartVersion(0)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load data'
        setError(message)
        setLastLiveError(message)
      } finally {
        setIsLoading(false)
      }
    }

    fetchInitialData()
  }, [])

  // Re-fetch chart and daily summary when the user selects a different day,
  // or when backfill forces a refresh (chartVersion > 0 skips the initial load).
  useEffect(() => {
    if (chartVersion <= 0 || !selectedDay || !timezone) return
    fetchDayData(selectedDay, timezone)
  }, [chartVersion, selectedDay, timezone, fetchDayData])

  // Periodically refresh today's chart data while the current day is selected.
  useEffect(() => {
    if (!timezone || !selectedDay) return
    const interval = setInterval(() => {
      if (selectedDay === todayInTz(timezone)) {
        fetchDayData(selectedDay, timezone)
      }
    }, 5 * 60 * 1000) // every 5 minutes
    return () => clearInterval(interval)
  }, [timezone, selectedDay, fetchDayData])

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const live = await getLive()
        setLiveData(live)
        setLastLiveSuccessAt(Date.now())
        setLastLiveError(null)
        setError(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch live data'
        setError(message)
        setLastLiveError(message)
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const heartbeat = setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => clearInterval(heartbeat)
  }, [])

  // User selects a specific day from the daily breakdown table
  function handleDaySelect(day: string) {
    setSelectedDay(day)
    setChartVersion(v => v + 1)
    // Scroll the chart into view for quick feedback (brief delay lets React flush the state update first)
    setTimeout(() => chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  // Reset to today's view
  function handleBackToToday() {
    const today = todayInTz(timezone)
    setSelectedDay(today)
    setChartVersion(v => v + 1)
    chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p className="text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  const freeImport = rates ? hasFreeImportNow(rates) : false

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <div className={`mb-6 p-3 rounded-lg border ${isConnected ? 'bg-green-900/50 border-green-700' : 'bg-red-900/50 border-red-700'}`}>
          <p className={`text-sm font-medium ${isConnected ? 'text-green-200' : 'text-red-200'}`}>
            {isConnected ? 'Connected' : `Disconnected${lastLiveError ? `: ${lastLiveError}` : ''}`}
          </p>
        </div>

        <header className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold">Solar Dashboard</h1>
            <p className="text-gray-400 mt-1">
              Real-time energy monitoring {USE_MOCK && '(Mock Mode)'}
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            {liveData && <StatusBadge status={determineStatus(liveData)} />}
            {liveData && (
              <p className="text-sm text-gray-400">
                Updated: {formatTimestamp(liveData.ts_utc)}
              </p>
            )}
          </div>
        </header>

        {error && (
          <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg">
            <p className="text-red-200">⚠️ {error}</p>
          </div>
        )}

        {liveData && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
              <MetricCard
                label="PV Generation"
                value={formatWatts(liveData.pv_w)}
                unit="W"
              />
              <MetricCard
                label="Load"
                value={formatWatts(liveData.load_w)}
                unit="W"
              />
              <MetricCard
                label="Grid Import"
                value={formatWatts(liveData.grid_import_w)}
                unit="W"
              />
              <MetricCard
                label="Grid Export"
                value={formatWatts(liveData.grid_export_w)}
                unit="W"
              />
            </div>

            {liveData.explanation && (
              <div className="mb-8 p-4 bg-gray-800 border border-gray-700 rounded-lg">
                <p className="text-gray-300">ℹ️ {liveData.explanation}</p>
              </div>
            )}
          </>
        )}

        {historyData && historyData.data.length > 0 && (
          <div className="mb-8" ref={chartRef}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">
                  {selectedDay === todayKey ? 'Today' : 'Selected day'}
                </p>
                <p className="text-sm font-medium text-gray-300">
                  {selectedDay && timezone ? formatDayDisplay(selectedDay, timezone) : ''}
                </p>
              </div>
              {selectedDay && todayKey && selectedDay !== todayKey && (
                <button
                  onClick={handleBackToToday}
                  className="px-3 py-1.5 rounded text-sm font-medium bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                >
                  ← Back to Today
                </button>
              )}
            </div>
            <HistoryChart
              data={historyData.data}
              title={`Day View – ${selectedDay && timezone ? formatDayDisplay(selectedDay, timezone) : ''}`}
              timezone={timezone}
            />
          </div>
        )}

        {dailyData && (
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 mb-8">
            <h3 className="text-lg font-semibold mb-4">
              {selectedDay && timezone
                ? selectedDay === todayKey
                  ? "Today's Summary"
                  : `Summary – ${formatDayDisplay(selectedDay, timezone)}`
                : "Day Summary"}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 md:gap-6">
              <div>
                <p className="text-sm text-gray-400 mb-1">PV Generated</p>
                <p className="text-2xl font-bold text-yellow-400">{formatKWh(dailyData.pv_kwh)} kWh</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">Load Consumed</p>
                <p className="text-2xl font-bold text-blue-400">{formatKWh(dailyData.load_kwh)} kWh</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">Grid Import</p>
                <p className="text-2xl font-bold text-amber-500">{formatKWh(dailyData.import_kwh)} kWh</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">Grid Export</p>
                <p className="text-2xl font-bold text-green-500">{formatKWh(dailyData.export_kwh)} kWh</p>
              </div>
            </div>

            <div className="mt-6 pt-6 border-t border-gray-700">
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <h4 className="text-sm font-semibold text-gray-300">Cost Summary</h4>
                {rates && (
                  <span className="text-xs text-gray-500">({rates.timezone})</span>
                )}
                {freeImport && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/60 border border-green-700 text-green-300">
                    Free import window active
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Import Cost</p>
                  <p className="text-lg font-semibold text-red-400">{formatCurrency(dailyData.import_cost ?? 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Export Credit</p>
                  <p className="text-lg font-semibold text-green-400">{formatCurrency(dailyData.export_credit ?? 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Net Cost</p>
                  <p className="text-lg font-semibold text-white">{formatCurrency(dailyData.net_cost ?? 0)}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        <BillEstimate
          freeImport={freeImport}
          refreshKey={refreshKey}
          selectedDay={selectedDay}
          onDaySelect={handleDaySelect}
        />

        <BackfillPanel onComplete={() => {
          setRefreshKey(k => k + 1)
          setChartVersion(v => v + 1)
        }} />

        {rates && (
          <RatesEditor
            initialRates={rates}
            onSaved={updated => setRates(updated)}
          />
        )}
      </div>
    </div>
  )
}
