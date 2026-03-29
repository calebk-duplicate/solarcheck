import { useState, useEffect, useCallback } from 'react'
import { subDays, startOfDay, endOfDay, startOfMonth, endOfMonth, subMonths, format } from 'date-fns'
import { getBill, getBillIntervals } from '../api/client'
import type { BillResponse, BillIntervalsResponse } from '../types'

type RangePreset = 'last7' | 'thisMonth' | 'lastMonth' | 'custom'

interface RangeWindow {
  from: Date
  to: Date
}

function getRangeForPreset(preset: Exclude<RangePreset, 'custom'>): RangeWindow {
  const now = new Date()
  switch (preset) {
    case 'last7':
      return { from: startOfDay(subDays(now, 7)), to: now }
    case 'thisMonth':
      return { from: startOfMonth(now), to: now }
    case 'lastMonth': {
      const lastMonth = subMonths(now, 1)
      return { from: startOfMonth(lastMonth), to: endOfMonth(lastMonth) }
    }
  }
}

function fmtCurrency(n: number): string {
  return `$${(n / 100).toFixed(2)}`
}

function fmtKWh(n: number): string {
  return n.toFixed(2)
}

function fmtDate(iso: string): string {
  try {
    return format(new Date(iso + 'T00:00:00'), 'MMM d, yyyy')
  } catch {
    return iso
  }
}

interface BillEstimateProps {
  freeImport: boolean
  refreshKey?: number
  selectedDay?: string
  onDaySelect?: (day: string) => void
}

export function BillEstimate({ freeImport, refreshKey, selectedDay, onDaySelect }: BillEstimateProps) {
  const [preset, setPreset] = useState<RangePreset>('last7')
  const [breakdownMode, setBreakdownMode] = useState<'daily' | 'interval_5m'>('daily')
  const [customFrom, setCustomFrom] = useState(format(startOfDay(subDays(new Date(), 7)), 'yyyy-MM-dd'))
  const [customTo, setCustomTo] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [billData, setBillData] = useState<BillResponse | null>(null)
  const [intervalBillData, setIntervalBillData] = useState<BillIntervalsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [intervalLoading, setIntervalLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intervalError, setIntervalError] = useState<string | null>(null)
  const [activeRange, setActiveRange] = useState<RangeWindow | null>(null)

  const fetchBill = useCallback(async (from: Date, to: Date) => {
    setLoading(true)
    setError(null)
    setIntervalError(null)
    try {
      const data = await getBill(from.toISOString(), to.toISOString())
      setBillData(data)
      setActiveRange({ from, to })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bill estimate')
      setBillData(null)
      setActiveRange(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (breakdownMode !== 'interval_5m') return
    if (!activeRange) return
    const range = activeRange

    async function fetchIntervals() {
      setIntervalLoading(true)
      setIntervalError(null)
      try {
        const data = await getBillIntervals(range.from.toISOString(), range.to.toISOString())
        setIntervalBillData(data)
      } catch (err) {
        setIntervalBillData(null)
        setIntervalError(err instanceof Error ? err.message : 'Failed to load 5-minute breakdown')
      } finally {
        setIntervalLoading(false)
      }
    }

    fetchIntervals()
  }, [breakdownMode, activeRange])

  useEffect(() => {
    if (preset === 'custom') return
    const { from, to } = getRangeForPreset(preset)
    fetchBill(from, to)
  }, [preset, fetchBill, refreshKey])

  function handlePreset(p: RangePreset) {
    setPreset(p)
  }

  function handleCustomApply() {
    if (!customFrom || !customTo) return
    fetchBill(startOfDay(new Date(customFrom)), endOfDay(new Date(customTo)))
  }

  const s = billData?.summary

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 mb-8">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <h3 className="text-lg font-semibold text-white">Bill Estimate</h3>
        {freeImport && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/60 border border-green-700 text-green-300">
            Free power active
          </span>
        )}
      </div>

      {/* Range controls */}
      <div className="flex flex-wrap gap-2 mb-5">
        {(['last7', 'thisMonth', 'lastMonth'] as const).map(p => (
          <button
            key={p}
            onClick={() => handlePreset(p)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              preset === p
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {p === 'last7' ? 'Last 7 days' : p === 'thisMonth' ? 'This month' : 'Last month'}
          </button>
        ))}
        <button
          onClick={() => handlePreset('custom')}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            preset === 'custom'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Custom
        </button>
      </div>

      <div className="flex items-center gap-2 mb-5">
        <span className="text-xs text-gray-500 uppercase tracking-wide">Breakdown</span>
        <button
          onClick={() => setBreakdownMode('daily')}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            breakdownMode === 'daily' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Daily
        </button>
        <button
          onClick={() => setBreakdownMode('interval_5m')}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            breakdownMode === 'interval_5m' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          5-min
        </button>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <input
            type="date"
            value={customFrom}
            onChange={e => setCustomFrom(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <span className="text-gray-500 text-sm">to</span>
          <input
            type="date"
            value={customTo}
            onChange={e => setCustomTo(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleCustomApply}
            disabled={!customFrom || !customTo}
            className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 transition-colors"
          >
            Apply
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-3 py-6 text-gray-400">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-400"></div>
          <span className="text-sm">Loading...</span>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="p-4 bg-red-900/50 border border-red-700 rounded-lg mb-4">
          <p className="text-red-200 text-sm">⚠️ {error}</p>
        </div>
      )}

      {/* Summary cards */}
      {s && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <div className="bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Net cost</p>
              <p className="text-xl font-bold text-white">{fmtCurrency(s.total_net_cost)}</p>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Import cost</p>
              <p className="text-xl font-bold text-red-400">{fmtCurrency(s.total_import_cost)}</p>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Export credit</p>
              <p className="text-xl font-bold text-green-400">{fmtCurrency(s.total_export_credit)}</p>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Fixed charges</p>
              <p className="text-xl font-bold text-gray-300">{fmtCurrency(s.total_fixed_charge)}</p>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Import kWh</p>
              <p className="text-xl font-bold text-amber-500">{fmtKWh(s.total_import_kwh)}</p>
            </div>
            <div className="bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Export kWh</p>
              <p className="text-xl font-bold text-green-500">{fmtKWh(s.total_export_kwh)}</p>
            </div>
          </div>

          {/* Daily breakdown */}
          {breakdownMode === 'daily' && billData!.days.length > 0 && (
            <div className="pt-5 border-t border-gray-700">
              <h4 className="text-sm font-semibold text-gray-300 mb-3">Daily Breakdown</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-700">
                      <th className="text-left pb-2 pr-4 font-medium">Date</th>
                      <th className="text-right pb-2 pr-4 font-medium">Import kWh</th>
                      <th className="text-right pb-2 pr-4 font-medium">Export kWh</th>
                      <th className="text-right pb-2 pr-4 font-medium">Import $</th>
                      <th className="text-right pb-2 pr-4 font-medium">Export $</th>
                      <th className="text-right pb-2 pr-4 font-medium">Fixed $</th>
                      <th className="text-right pb-2 font-medium">Net $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billData!.days.map(row => {
                      const isSelected = selectedDay === row.day_local
                      return (
                        <tr
                          key={row.day_local}
                          onClick={() => onDaySelect?.(row.day_local)}
                          className={`border-b border-gray-800 transition-colors ${
                            onDaySelect ? 'cursor-pointer' : ''
                          } ${
                            isSelected
                              ? 'bg-blue-900/40 border-blue-700/50'
                              : 'hover:bg-gray-700/30'
                          }`}
                        >
                          <td className={`py-2 pr-4 ${isSelected ? 'text-blue-300 font-medium' : 'text-gray-300'}`}>
                            {fmtDate(row.day_local)}
                          </td>
                          <td className="py-2 pr-4 text-right text-amber-500">{fmtKWh(row.import_kwh)}</td>
                          <td className="py-2 pr-4 text-right text-green-500">{fmtKWh(row.export_kwh)}</td>
                          <td className="py-2 pr-4 text-right text-red-400">{fmtCurrency(row.import_cost)}</td>
                          <td className="py-2 pr-4 text-right text-green-400">{fmtCurrency(row.export_credit)}</td>
                          <td className="py-2 pr-4 text-right text-gray-400">{fmtCurrency(row.fixed_charge)}</td>
                          <td className="py-2 text-right text-white font-medium">{fmtCurrency(row.net_cost)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {breakdownMode === 'interval_5m' && (
            <div className="pt-5 border-t border-gray-700">
              <h4 className="text-sm font-semibold text-gray-300 mb-3">5-minute Cost Breakdown</h4>

              {intervalLoading && (
                <p className="text-sm text-gray-400">Loading 5-minute intervals...</p>
              )}

              {intervalError && !intervalLoading && (
                <div className="p-3 bg-red-900/40 border border-red-700 rounded text-sm text-red-300 mb-3">
                  {intervalError}
                </div>
              )}

              {!intervalLoading && !intervalError && intervalBillData && intervalBillData.archive_warnings && intervalBillData.archive_warnings.length > 0 && (
                <div className="p-3 bg-amber-900/40 border border-amber-700 rounded text-sm text-amber-300 mb-3">
                  {intervalBillData.archive_warnings.join(' ')}
                </div>
              )}

              {!intervalLoading && !intervalError && intervalBillData && (
                <div className="overflow-auto max-h-[28rem]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b border-gray-700">
                        <th className="text-left pb-2 pr-4 font-medium">Time (local)</th>
                        <th className="text-right pb-2 pr-4 font-medium">Import kWh</th>
                        <th className="text-right pb-2 pr-4 font-medium">Export kWh</th>
                        <th className="text-right pb-2 pr-4 font-medium">Import rate</th>
                        <th className="text-right pb-2 pr-4 font-medium">Export rate</th>
                        <th className="text-right pb-2 pr-4 font-medium">Import $</th>
                        <th className="text-right pb-2 pr-4 font-medium">Export $</th>
                        <th className="text-right pb-2 font-medium">Net $</th>
                      </tr>
                    </thead>
                    <tbody>
                      {intervalBillData.intervals.map((row) => (
                        <tr key={row.ts_utc} className="border-b border-gray-800 hover:bg-gray-700/30">
                          <td className="py-2 pr-4 text-gray-300">{row.ts_local}</td>
                          <td className="py-2 pr-4 text-right text-amber-500">{row.import_kwh.toFixed(4)}</td>
                          <td className="py-2 pr-4 text-right text-green-500">{row.export_kwh.toFixed(4)}</td>
                          <td className="py-2 pr-4 text-right text-red-400">{row.import_rate_cents_per_kwh.toFixed(3)}c</td>
                          <td className="py-2 pr-4 text-right text-green-400">{row.export_rate_cents_per_kwh.toFixed(3)}c</td>
                          <td className="py-2 pr-4 text-right text-red-400">{fmtCurrency(row.import_cost)}</td>
                          <td className="py-2 pr-4 text-right text-green-400">{fmtCurrency(row.export_credit)}</td>
                          <td className="py-2 text-right text-white font-medium">{fmtCurrency(row.net_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
