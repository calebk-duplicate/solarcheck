import { useState, useEffect } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceArea,
} from 'recharts'
import { fetchEnergy5m, getRates } from '../api/client'
import type { RatePeriod } from '../types'

// ── helpers ──────────────────────────────────────────────────────────────────

function localHHMM(tsMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(tsMs))
}

function isWeekendTs(tsMs: number, timezone: string): boolean {
  const day = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    weekday: 'short',
  }).format(new Date(tsMs))
  return day === 'Sat' || day === 'Sun'
}

/**
 * Returns the applicable import rate (cents/kWh) for tsMs.
 * Period times are HH:mm strings; "24:00" is a valid end-of-day sentinel.
 * String comparison is safe because all times are zero-padded HH:MM.
 * Returns 0 if no period matches.
 */
function getImportRateCents(tsMs: number, importPeriods: RatePeriod[], timezone: string): number {
  const hhmm = localHHMM(tsMs, timezone)
  const dayType = isWeekendTs(tsMs, timezone) ? 'weekend' : 'weekday'

  for (const p of importPeriods) {
    const applies = !p.days || p.days === 'all' || p.days === dayType
    if (!applies) continue
    if (hhmm >= p.start && hhmm < p.end) return p.cents_per_kwh
  }
  return 0
}

interface ShadedBand { x1: number; x2: number }

/**
 * Walks chartData points and merges contiguous zero-rate points into bands
 * suitable for <ReferenceArea x1={…} x2={…} />.
 */
function buildShadedBands(
  chartData: ChartPoint[],
  importPeriods: RatePeriod[],
  timezone: string,
): ShadedBand[] {
  if (importPeriods.length === 0 || chartData.length === 0) return []

  const bands: ShadedBand[] = []
  let bandStart: number | null = null

  for (const point of chartData) {
    if (getImportRateCents(point.ts, importPeriods, timezone) === 0) {
      if (bandStart === null) bandStart = point.ts
    } else if (bandStart !== null) {
      bands.push({ x1: bandStart, x2: point.ts })
      bandStart = null
    }
  }
  if (bandStart !== null) {
    bands.push({ x1: bandStart, x2: chartData[chartData.length - 1].ts })
  }

  return bands
}

// ── chart data type ───────────────────────────────────────────────────────────

interface ChartPoint {
  ts: number      // epoch ms — XAxis dataKey and ReferenceArea bounds
  Import: number  // kWh
  Export: number  // kWh
  Cost: number    // dollars (import only)
}

// ── component ─────────────────────────────────────────────────────────────────

interface EnergyChartProps {
  fromIso: string
  toIso: string
}

export function EnergyChart({ fromIso, toIso }: EnergyChartProps) {
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [shadedBands, setShadedBands] = useState<ShadedBand[]>([])
  const [ticks, setTicks] = useState<number[]>([])
  const [timezone, setTimezone] = useState('UTC')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCost, setShowCost] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)

    Promise.all([fetchEnergy5m(fromIso, toIso), getRates()])
      .then(([energy, rates]) => {
        const tz = rates.timezone
        const importPeriods = rates.import_periods

        const points: ChartPoint[] = energy.data.map((pt) => {
          const tsMs = new Date(pt.ts_utc).getTime()
          const importKwh = Number(pt.import_kwh) || 0
          const exportKwh = Number(pt.export_kwh) || 0
          const rateCents = getImportRateCents(tsMs, importPeriods, tz)
          return {
            ts: tsMs,
            Import: +importKwh.toFixed(4),
            Export: +exportKwh.toFixed(4),
            Cost: +(importKwh * rateCents / 100).toFixed(6),
          }
        })

        // One tick per hour — where local time is HH:00
        const hourlyTicks = points
          .filter((p) => localHHMM(p.ts, tz).endsWith(':00'))
          .map((p) => p.ts)

        setTimezone(tz)
        setChartData(points)
        setTicks(hourlyTicks)
        setShadedBands(buildShadedBands(points, importPeriods, tz))
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [fromIso, toIso])

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Energy (5-min buckets)</h3>
        {!loading && !error && (
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showCost}
              onChange={(e) => setShowCost(e.target.checked)}
              className="accent-blue-400"
            />
            Show import cost
          </label>
        )}
      </div>

      {loading && <p className="text-gray-400 text-sm">Loading…</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {!loading && !error && chartData.length === 0 && (
        <p className="text-gray-400 text-sm">No 5-minute energy data for this selected day.</p>
      )}
      {!loading && !error && chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />

            {/* Shaded bands for zero-import-rate windows */}
            {shadedBands.map((band, i) => (
              <ReferenceArea
                key={i}
                x1={band.x1}
                x2={band.x2}
                fill="#FBBF24"
                fillOpacity={0.08}
                ifOverflow="visible"
              />
            ))}

            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={ticks}
              tickFormatter={(ts: number) => localHHMM(ts, timezone)}
              stroke="#9CA3AF"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
            />

            {/* Left Y-axis: kWh */}
            <YAxis
              yAxisId="energy"
              stroke="#9CA3AF"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
              label={{ value: 'kWh', angle: -90, position: 'insideLeft', fill: '#9CA3AF' }}
            />

            {/* Right Y-axis: cost — only mounted when overlay is active */}
            {showCost && (
              <YAxis
                yAxisId="cost"
                orientation="right"
                stroke="#60A5FA"
                tick={{ fill: '#60A5FA', fontSize: 12 }}
                tickFormatter={(v: number) => `$${v.toFixed(3)}`}
                label={{ value: 'Cost ($)', angle: 90, position: 'insideRight', fill: '#60A5FA', offset: 10 }}
              />
            )}

            <Tooltip
              contentStyle={{
                backgroundColor: '#1F2937',
                border: '1px solid #374151',
                borderRadius: '0.5rem',
                color: '#F9FAFB',
              }}
              labelStyle={{ color: '#F9FAFB' }}
              labelFormatter={(ts: number) => localHHMM(ts, timezone)}
              formatter={(value: number, name: string) => {
                if (name === 'Cost') return [`$${value.toFixed(4)}`, 'Cost']
                return [`${value.toFixed(4)} kWh`, name]
              }}
            />
            <Legend wrapperStyle={{ color: '#F9FAFB' }} />

            <Area
              yAxisId="energy"
              type="monotone"
              dataKey="Import"
              stroke="#EF4444"
              fill="#EF4444"
              fillOpacity={0.3}
              strokeWidth={1.5}
              dot={false}
            />
            <Area
              yAxisId="energy"
              type="monotone"
              dataKey="Export"
              stroke="#22C55E"
              fill="#22C55E"
              fillOpacity={0.3}
              strokeWidth={1.5}
              dot={false}
            />

            {showCost && (
              <Line
                yAxisId="cost"
                type="monotone"
                dataKey="Cost"
                stroke="#60A5FA"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
