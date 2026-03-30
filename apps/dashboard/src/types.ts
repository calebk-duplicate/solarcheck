export interface LiveResponse {
  ts_utc: string
  pv_w: number
  load_w: number
  grid_import_w: number
  grid_export_w: number
  grid_net_w: number
  self_consumed_w: number
  explanation?: string
}

export interface HistoryPoint {
  ts_utc: string
  pv_w: number
  load_w: number
  grid_import_w: number
  grid_export_w: number
}

export interface HistoryResponse {
  data: HistoryPoint[]
}

export interface DailyResponse {
  day: string
  pv_kwh: number
  load_kwh: number
  import_kwh: number
  export_kwh: number
  self_kwh: number
  import_cost?: number
  export_credit?: number
  net_cost?: number
}

export type SystemStatus = 'exporting' | 'importing' | 'neutral'

export interface BillDayRow {
  day_local: string
  import_kwh: number
  free_import_kwh: number
  export_kwh: number
  import_cost: number
  export_credit: number
  fixed_charge: number
  net_cost: number
}

export interface BillSummary {
  from_utc: string
  to_utc: string
  days: number
  total_import_kwh: number
  total_free_import_kwh: number
  total_export_kwh: number
  total_import_cost: number
  total_export_credit: number
  total_fixed_charge: number
  total_net_cost: number
}

export interface BillResponse {
  summary: BillSummary
  days: BillDayRow[]
}

export interface BillIntervalRow {
  ts_utc: string
  ts_local: string
  import_kwh: number
  export_kwh: number
  import_rate_cents_per_kwh: number
  export_rate_cents_per_kwh: number
  import_cost: number
  export_credit: number
  net_cost: number
}

export interface BillIntervalsSummary {
  from_utc: string
  to_utc: string
  interval_minutes: number
  timezone: string
  count: number
  total_import_kwh: number
  total_free_import_kwh: number
  total_export_kwh: number
  total_import_cost: number
  total_export_credit: number
  total_net_cost: number
}

export interface BillIntervalsResponse {
  summary: BillIntervalsSummary
  intervals: BillIntervalRow[]
  source: 'energy_5m'
  archive_warnings?: string[]
}

export interface Energy5mPoint {
  ts_utc: string
  import_kwh: number
  export_kwh: number
}

export interface Energy5mResponse {
  from: string
  to: string
  count: number
  data: Energy5mPoint[]
}

export interface RatePeriod {
  days?: 'all' | 'weekday' | 'weekend'
  start: string
  end: string
  cents_per_kwh: number
}

export interface RatesResponse {
  daily_fixed_cents: number
  timezone: string
  import_periods: RatePeriod[]
  export_periods: RatePeriod[]
}
