const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const cors = require('cors');
const express = require('express');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

const DEFAULT_DAILY_FIXED_CENTS = 0;
const DEFAULT_TIMEZONE = 'Pacific/Auckland';
const DEFAULT_IMPORT_PERIODS = [
	{ days: 'all', start: '00:00', end: '21:00', cents_per_kwh: 32 },
	{ days: 'all', start: '21:00', end: '24:00', cents_per_kwh: 0 },
];
const DEFAULT_EXPORT_PERIODS = [
	{ days: 'all', start: '00:00', end: '24:00', cents_per_kwh: 12 },
];

const INVERTER_BASE_URL = (process.env.INVERTER_BASE_URL || '').replace(/\/$/, '');
const POLL_SECONDS = Number.parseInt(process.env.POLL_SECONDS || '15', 10);
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const ARCHIVE_BACKFILL_MINUTES = Number.parseInt(process.env.ARCHIVE_BACKFILL_MINUTES || '30', 10);
const ARCHIVE_LOOKBACK_DAYS = Number.parseInt(process.env.ARCHIVE_LOOKBACK_DAYS || '2', 10);
const MANUAL_ARCHIVE_MAX_MONTHS = Number.parseInt(process.env.MANUAL_ARCHIVE_MAX_MONTHS || '24', 10);
const MANUAL_ARCHIVE_CHUNK_DAYS = Number.parseInt(process.env.MANUAL_ARCHIVE_CHUNK_DAYS || '2', 10);
const ARCHIVE_DEBUG_LOG = String(process.env.ARCHIVE_DEBUG_LOG || '1') !== '0';

const ARCHIVE_IMPORT_CHANNEL_CANDIDATES = [
	{ key: 'EnergyReal_WAC_Plus_Absolute', kind: 'absolute' },
	{ key: 'EnergyReal_WAC_Sum_Consumed', kind: 'delta' },
];

const ARCHIVE_EXPORT_CHANNEL_CANDIDATES = [
	{ key: 'EnergyReal_WAC_Minus_Absolute', kind: 'absolute' },
	{ key: 'EnergyReal_WAC_Sum_Produced', kind: 'delta' },
];

const ARCHIVE_CHANNEL_PROBE_LIST = Array.from(
	new Set([
		...ARCHIVE_IMPORT_CHANNEL_CANDIDATES.map((item) => item.key),
		...ARCHIVE_EXPORT_CHANNEL_CANDIDATES.map((item) => item.key),
	]),
);

if (!INVERTER_BASE_URL) {
	throw new Error('Missing required environment variable: INVERTER_BASE_URL');
}

if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS <= 0) {
	throw new Error('POLL_SECONDS must be a positive integer');
}

if (!Number.isFinite(PORT) || PORT <= 0) {
	throw new Error('PORT must be a positive integer');
}

if (!Number.isFinite(ARCHIVE_BACKFILL_MINUTES) || ARCHIVE_BACKFILL_MINUTES <= 0) {
	throw new Error('ARCHIVE_BACKFILL_MINUTES must be a positive integer');
}

if (!Number.isFinite(ARCHIVE_LOOKBACK_DAYS) || ARCHIVE_LOOKBACK_DAYS <= 0) {
	throw new Error('ARCHIVE_LOOKBACK_DAYS must be a positive integer');
}

if (!Number.isFinite(MANUAL_ARCHIVE_MAX_MONTHS) || MANUAL_ARCHIVE_MAX_MONTHS <= 0) {
	throw new Error('MANUAL_ARCHIVE_MAX_MONTHS must be a positive integer');
}

if (!Number.isFinite(MANUAL_ARCHIVE_CHUNK_DAYS) || MANUAL_ARCHIVE_CHUNK_DAYS <= 0) {
	throw new Error('MANUAL_ARCHIVE_CHUNK_DAYS must be a positive integer');
}

const app = express();
app.use(cors());
app.use(express.json());
const DB_FILE = path.join(__dirname, 'solarcheck.db');
const db = new Database(DB_FILE);
const DASHBOARD_DIST_DIR = path.resolve(__dirname, '../dashboard/dist');
const DASHBOARD_INDEX_FILE = path.join(DASHBOARD_DIST_DIR, 'index.html');
const DASHBOARD_DIST_EXISTS = fs.existsSync(DASHBOARD_DIST_DIR);
const DASHBOARD_INDEX_EXISTS = fs.existsSync(DASHBOARD_INDEX_FILE);

const state = {
	startedAtMs: Date.now(),
	lastPollAtUtc: null,
	lastSuccessAtUtc: null,
	lastError: null,
	lastReadingTsUtc: null,
	lastArchiveBackfillAtUtc: null,
	lastArchiveBackfillSuccessAtUtc: null,
	lastArchiveBackfillError: null,
	pollingInProgress: false,
	archiveBackfillInProgress: false,
	manualArchiveBackfill: {
		running: false,
		startedAtUtc: null,
		completedAtUtc: null,
		lastError: null,
		range: null,
		progress: {
			total_days: 0,
			completed_days: 0,
			total_requests: 0,
			completed_requests: 0,
			rows_upserted: 0,
		},
	},
	consecutiveZeroLoadWithPv: 0,
	liveDataWarning: null,
	archiveDiagnostics: {
		last_probe_at_utc: null,
		last_probe_start_local: null,
		last_probe_end_local: null,
		import_history_present: false,
		export_history_present: false,
		selected_import_channels: [],
		selected_export_channels: [],
		all_channels: [],
		nodes: [],
		warnings: [],
	},
};

initializeDatabase(db);

const statements = prepareStatements(db);
ensureDefaultSettings(statements);

const api = express.Router();

api.get('/health', (_req, res) => {
	res.json({
		ok: true,
		uptime_s: Math.floor((Date.now() - state.startedAtMs) / 1000),
		poll_seconds: POLL_SECONDS,
		inverter_base_url: INVERTER_BASE_URL,
		last_poll_at_utc: state.lastPollAtUtc,
		last_success_at_utc: state.lastSuccessAtUtc,
		last_reading_ts_utc: state.lastReadingTsUtc,
		last_error: state.lastError,
		last_archive_backfill_at_utc: state.lastArchiveBackfillAtUtc,
		last_archive_backfill_success_at_utc: state.lastArchiveBackfillSuccessAtUtc,
		last_archive_backfill_error: state.lastArchiveBackfillError,
	});
});

api.get('/settings', (_req, res) => {
	const rates = getRatesSettings(statements);
	res.json({
		...rates,
		archive_backfill_minutes: ARCHIVE_BACKFILL_MINUTES,
		archive_lookback_days: ARCHIVE_LOOKBACK_DAYS,
		archive_backfill: {
			last_attempt_at_utc: state.lastArchiveBackfillAtUtc,
			last_success_at_utc: state.lastArchiveBackfillSuccessAtUtc,
			last_error: state.lastArchiveBackfillError,
			in_progress: state.archiveBackfillInProgress,
		},
	});
});

api.get('/live', (_req, res) => {
	const row = statements.getLatestReading.get();
	if (!row) {
		return res.json({
			data: null,
			data_warning: null,
			explanation: null,
			message: 'No readings yet',
		});
	}

	const rates = getRatesSettings(statements);
	const nowLocal = DateTime.now().setZone(rates.timezone);
	const hhmm = nowLocal.isValid ? nowLocal.toFormat('HH:mm') : '00:00';
	const dayGroup = nowLocal.isValid ? dayGroupFromLocalDateTime(nowLocal) : 'weekday';
	const importRate = findRateForTime(rates.import_periods, dayGroup, hhmm);
	const exportRate = findRateForTime(rates.export_periods, dayGroup, hhmm);
	const importCostPerHour = (row.grid_import_w / 1000) * importRate;
	const exportCreditPerHour = (row.grid_export_w / 1000) * exportRate;
	const netCostPerHour = importCostPerHour - exportCreditPerHour + rates.daily_fixed_cents / 24;

	const data = withDerivedValues(row);
	const explanation = getLiveExplanation(data);

	return res.json({
		data: {
			...data,
			import_cost_per_hour: round3(importCostPerHour),
			export_credit_per_hour: round3(exportCreditPerHour),
			net_cost_per_hour: round3(netCostPerHour),
			explanation,
		},
		data_warning: state.liveDataWarning,
		explanation,
	});
});

api.get('/rates', (_req, res) => {
	const rates = getRatesSettings(statements);
	res.json(rates);
});

api.put('/rates', (req, res) => {
	try {
		if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
			return res.status(400).json({ error: 'Request body must be a JSON object' });
		}

		const current = getRatesSettings(statements);
		const next = { ...current };

		if (Object.prototype.hasOwnProperty.call(req.body, 'daily_fixed_cents')) {
			const dailyFixed = Number(req.body.daily_fixed_cents);
			if (!Number.isFinite(dailyFixed) || dailyFixed < 0) {
				return res.status(400).json({ error: 'daily_fixed_cents must be a number >= 0' });
			}
			next.daily_fixed_cents = dailyFixed;
		}

		if (Object.prototype.hasOwnProperty.call(req.body, 'timezone')) {
			if (typeof req.body.timezone !== 'string' || !isValidTimezone(req.body.timezone)) {
				return res.status(400).json({ error: 'timezone must be a valid IANA timezone string' });
			}
			next.timezone = req.body.timezone;
		}

		if (Object.prototype.hasOwnProperty.call(req.body, 'import_periods')) {
			next.import_periods = validateRatePeriods(req.body.import_periods, 'import_periods');
		}

		if (Object.prototype.hasOwnProperty.call(req.body, 'export_periods')) {
			next.export_periods = validateRatePeriods(req.body.export_periods, 'export_periods');
		}

		statements.upsertSetting.run('daily_fixed_cents', JSON.stringify(next.daily_fixed_cents));
		statements.upsertSetting.run('timezone', JSON.stringify(next.timezone));
		statements.upsertSetting.run('import_periods_json', JSON.stringify(next.import_periods));
		statements.upsertSetting.run('export_periods_json', JSON.stringify(next.export_periods));

		return res.json(next);
	} catch (error) {
		return res.status(400).json({ error: error?.message || String(error) });
	}
});

api.get('/history', (req, res) => {
	const range = parseRange(req.query.from, req.query.to, 24);

	const rows = statements.getHistoryInRange.all(range.from, range.to).map(withDerivedValues);
	res.json({
		from: range.from,
		to: range.to,
		count: rows.length,
		data: rows,
	});
});

api.get('/energy5m', (req, res) => {
	const range = parseRange(req.query.from, req.query.to, 24 * 7);
	const rows = statements.getEnergy5mInRange.all(range.from, range.to);

	res.json({
		from: range.from,
		to: range.to,
		count: rows.length,
		data: rows.map((row) => ({
			ts_utc: row.ts_utc,
			import_kwh: Math.round(((Number(row.import_wh) || 0) / 1000) * 10000) / 10000,
			export_kwh: Math.round(((Number(row.export_wh) || 0) / 1000) * 10000) / 10000,
		})),
	});
});

api.get('/energy-hourly', (req, res) => {
	const range = parseRange(req.query.from, req.query.to, 24 * 7);
	const rows = statements.getEnergy5mInRange.all(range.from, range.to);
	const rates = getRatesSettings(statements);
	const timezone = rates.timezone;
	const hourly = new Map();

	for (const row of rows) {
		const utc = DateTime.fromISO(row.ts_utc, { zone: 'utc' });
		if (!utc.isValid) {
			continue;
		}

		const localHour = utc.setZone(timezone).startOf('hour');
		if (!localHour.isValid) {
			continue;
		}

		const key = localHour.toISO({ suppressMilliseconds: true });
		if (!key) {
			continue;
		}

		if (!hourly.has(key)) {
			hourly.set(key, {
				ts_local: key,
				ts_utc: localHour.toUTC().toISO({ suppressMilliseconds: true }),
				import_kwh: 0,
				export_kwh: 0,
			});
		}

		const bucket = hourly.get(key);
		bucket.import_kwh += (Number(row.import_wh) || 0) / 1000;
		bucket.export_kwh += (Number(row.export_wh) || 0) / 1000;
	}

	const data = Array.from(hourly.values())
		.sort((a, b) => a.ts_local.localeCompare(b.ts_local))
		.map((item) => ({
			...item,
			import_kwh: Math.round(item.import_kwh * 10000) / 10000,
			export_kwh: Math.round(item.export_kwh * 10000) / 10000,
		}));

	res.json(data);
});

api.get('/daily', (req, res) => {
	const range = parseRange(req.query.from, req.query.to, 24 * 7);
	const readings = statements.getHistoryInRange.all(range.from, range.to);
	const daily = aggregateDailyFromReadings(readings);

	res.json(daily);
});

api.get('/bill', (req, res) => {
	try {
		const range = parseRange(req.query.from, req.query.to, 24 * 7);
		const rates = getRatesSettings(statements);
		const sourceQuery = req.query.source;

		if (sourceQuery === 'energy_5m') {
			const energyRows = statements.getEnergy5mInRange.all(range.from, range.to);
			if (energyRows.length < 1) {
				return res.status(400).json({
					error: 'No energy_5m data found for requested range',
				});
			}

			const bill = aggregateBillFromEnergy5m(energyRows, rates, range.from, range.to);
			return res.json({ ...bill, source: 'energy_5m' });
		}

		if (sourceQuery === 'readings') {
			const readings = statements.getHistoryInRange.all(range.from, range.to);
			const bill = aggregateBillFromReadings(readings, rates, range.from, range.to);
			return res.json({ ...bill, source: 'readings' });
		}

		if (sourceQuery !== undefined && sourceQuery !== null && sourceQuery !== '') {
			return res.status(400).json({
				error: 'Invalid source query param; expected readings|energy_5m',
			});
		}

		const energyRows = statements.getEnergy5mInRange.all(range.from, range.to);
		if (energyRows.length >= 1) {
			const bill = aggregateBillFromEnergy5m(energyRows, rates, range.from, range.to);
			return res.json({ ...bill, source: 'energy_5m' });
		}

		const readings = statements.getHistoryInRange.all(range.from, range.to);
		const bill = aggregateBillFromReadings(readings, rates, range.from, range.to);
		return res.json({ ...bill, source: 'readings' });
	} catch (error) {
		return res.status(400).json({ error: error?.message || String(error) });
	}
});

api.get('/bill-intervals', (req, res) => {
	try {
		const range = parseRange(req.query.from, req.query.to, 24 * 7);
		const rates = getRatesSettings(statements);
		const sourceQuery = req.query.source;

		if (sourceQuery === 'readings') {
			return res.status(400).json({
				error: 'Interval billing is only supported with energy_5m source',
			});
		}

		if (sourceQuery !== undefined && sourceQuery !== null && sourceQuery !== '' && sourceQuery !== 'energy_5m') {
			return res.status(400).json({
				error: 'Invalid source query param; expected energy_5m',
			});
		}

		const energyRows = statements.getEnergy5mInRange.all(range.from, range.to);
		if (energyRows.length < 1) {
			return res.status(400).json({
				error: 'No energy_5m data found for requested range',
			});
		}

		const intervalBill = aggregateBillIntervalsFromEnergy5m(energyRows, rates, range.from, range.to);
		return res.json({
			...intervalBill,
			source: 'energy_5m',
			archive_warnings: state.archiveDiagnostics?.warnings || [],
		});
	} catch (error) {
		return res.status(400).json({ error: error?.message || String(error) });
	}
});

api.post('/archive/backfill', async (req, res) => {
	try {
		if (state.archiveBackfillInProgress) {
			return res.status(409).json({
				error: 'busy',
				message: 'Automatic archive backfill is running',
				automatic_running: true,
				manual_status: getManualArchiveBackfillStatus(),
			});
		}

		if (state.manualArchiveBackfill.running) {
			return res.status(409).json(getManualArchiveBackfillStatus());
		}

		if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
			return res.status(400).json({ error: 'Request body must be a JSON object' });
		}

		const { start_month: startMonth, months } = req.body;
		const settings = getRatesSettings(statements);
		const timezone = settings.timezone || DEFAULT_TIMEZONE;
		const requestedRange = buildManualArchiveBackfillRange(startMonth, months, timezone);
		const range = await clampManualArchiveRangeToAvailableData(requestedRange, timezone);

		state.manualArchiveBackfill = {
			running: true,
			startedAtUtc: new Date().toISOString(),
			completedAtUtc: null,
			lastError: null,
			range,
			progress: {
				total_days: range.total_days,
				completed_days: 0,
				total_requests: range.total_requests,
				completed_requests: 0,
				rows_upserted: 0,
			},
		};

		void runManualArchiveBackfillJob(range).catch((error) => {
			const message = error?.message || String(error);
			state.manualArchiveBackfill.lastError = message;
			state.manualArchiveBackfill.completedAtUtc = new Date().toISOString();
			state.manualArchiveBackfill.running = false;
			console.error('[archive-manual] failed:', error);
		});

		return res.status(202).json(getManualArchiveBackfillStatus());
	} catch (error) {
		return res.status(400).json({ error: error?.message || String(error) });
	}
});

api.get('/archive/backfill/status', (_req, res) => {
	res.json(getManualArchiveBackfillStatus());
});

api.get('/archive/diagnostics', async (req, res) => {
	try {
		const range = parseRange(req.query.from, req.query.to, 24 * 7);
		const rates = getRatesSettings(statements);
		const timezone = rates.timezone || DEFAULT_TIMEZONE;

		const startLocalDate = DateTime.fromISO(range.from, { zone: 'utc' }).setZone(timezone).toFormat('yyyy-LL-dd');
		const endLocalDate = DateTime.fromISO(range.to, { zone: 'utc' }).setZone(timezone).toFormat('yyyy-LL-dd');

		if (!startLocalDate || !endLocalDate) {
			throw new Error('Failed to compute local archive diagnostic range');
		}

		await fetchArchiveDetail(INVERTER_BASE_URL, startLocalDate, endLocalDate, {
			context: 'diagnostics',
			emitDiagnosticsLog: true,
		});

		const readings = statements.getHistoryInRange.all(range.from, range.to);
		const energyRows = statements.getEnergy5mInRange.all(range.from, range.to);
		const energyImportNonZeroCount = energyRows.filter((row) => (Number(row.import_wh) || 0) > 0).length;
		const energyExportNonZeroCount = energyRows.filter((row) => (Number(row.export_wh) || 0) > 0).length;

		return res.json({
			from_utc: range.from,
			to_utc: range.to,
			timezone,
			archive: state.archiveDiagnostics,
			coverage: {
				readings_count: readings.length,
				readings_present: readings.length >= 2,
				energy_5m_count: energyRows.length,
				energy_5m_import_non_zero_count: energyImportNonZeroCount,
				energy_5m_export_non_zero_count: energyExportNonZeroCount,
			},
		});
	} catch (error) {
		return res.status(400).json({ error: error?.message || String(error) });
	}
});

app.use('/api', api);

app.get('/health', (_req, res) => {
	res.redirect(307, '/api/health');
});

if (DASHBOARD_DIST_EXISTS) {
	app.use(express.static(DASHBOARD_DIST_DIR));
}

app.use((req, res, next) => {
	if (req.path.startsWith('/api')) {
		return next();
	}

	if (DASHBOARD_INDEX_EXISTS) {
		return res.sendFile(DASHBOARD_INDEX_FILE);
	}

	return res.status(503).json({
		error: 'Dashboard build not found',
		expected: DASHBOARD_INDEX_FILE,
	});
});

app.use((err, _req, res, _next) => {
	res.status(500).json({
		error: 'Internal server error',
		details: err?.message || String(err),
	});
});

app.listen(PORT, '0.0.0.0', () => {
	console.log(`Solar monitor listening on http://0.0.0.0:${PORT}`);
	console.log(`Polling ${INVERTER_BASE_URL} every ${POLL_SECONDS}s`);
	if (!DASHBOARD_DIST_EXISTS || !DASHBOARD_INDEX_EXISTS) {
		console.warn(`Dashboard build not found at ${DASHBOARD_DIST_DIR}; SPA serving is disabled until it exists.`);
	}
	startPolling();
	startArchiveBackfill();
});

function initializeDatabase(database) {
	database.pragma('journal_mode = WAL');
	database.pragma('synchronous = NORMAL');

	database.exec(`
		CREATE TABLE IF NOT EXISTS readings (
			ts_utc TEXT PRIMARY KEY,
			pv_w INTEGER NOT NULL,
			load_w INTEGER NOT NULL,
			grid_import_w INTEGER NOT NULL,
			grid_export_w INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS energy_5m (
			ts_utc TEXT PRIMARY KEY,
			import_wh REAL NOT NULL,
			export_wh REAL NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_energy_5m_ts_utc ON energy_5m(ts_utc);

		CREATE TABLE IF NOT EXISTS daily_agg (
			day TEXT PRIMARY KEY,
			pv_kwh REAL,
			load_kwh REAL,
			import_kwh REAL,
			export_kwh REAL,
			self_kwh REAL
		);

		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
}

function prepareStatements(database) {
	return {
		insertReading: database.prepare(`
			INSERT OR IGNORE INTO readings (
				ts_utc,
				pv_w,
				load_w,
				grid_import_w,
				grid_export_w
			) VALUES (?, ?, ?, ?, ?)
		`),
		getLatestReading: database.prepare(`
			SELECT ts_utc, pv_w, load_w, grid_import_w, grid_export_w
			FROM readings
			ORDER BY ts_utc DESC
			LIMIT 1
		`),
		getHistoryInRange: database.prepare(`
			SELECT ts_utc, pv_w, load_w, grid_import_w, grid_export_w
			FROM readings
			WHERE ts_utc >= ? AND ts_utc <= ?
			ORDER BY ts_utc ASC
		`),
		upsertDailyAgg: database.prepare(`
			INSERT INTO daily_agg (day, pv_kwh, load_kwh, import_kwh, export_kwh, self_kwh)
			VALUES (@day, @pv_kwh, @load_kwh, @import_kwh, @export_kwh, @self_kwh)
			ON CONFLICT(day) DO UPDATE SET
				pv_kwh = excluded.pv_kwh,
				load_kwh = excluded.load_kwh,
				import_kwh = excluded.import_kwh,
				export_kwh = excluded.export_kwh,
				self_kwh = excluded.self_kwh
		`),
		getDailyRange: database.prepare(`
			SELECT day, pv_kwh, load_kwh, import_kwh, export_kwh, self_kwh
			FROM daily_agg
			WHERE day >= ? AND day <= ?
			ORDER BY day ASC
		`),
		getReadingsForDay: database.prepare(`
			SELECT ts_utc, pv_w, load_w, grid_import_w, grid_export_w
			FROM readings
			WHERE ts_utc >= ? AND ts_utc < ?
			ORDER BY ts_utc ASC
		`),
		upsertEnergy5m: database.prepare(`
			INSERT INTO energy_5m (ts_utc, import_wh, export_wh)
			VALUES (@ts_utc, @import_wh, @export_wh)
			ON CONFLICT(ts_utc) DO UPDATE SET
				import_wh = excluded.import_wh,
				export_wh = excluded.export_wh
		`),
		getEnergy5mInRange: database.prepare(`
			SELECT ts_utc, import_wh, export_wh
			FROM energy_5m
			WHERE ts_utc >= ? AND ts_utc <= ?
			ORDER BY ts_utc ASC
		`),
		getLatestEnergy5mTs: database.prepare(`
			SELECT ts_utc
			FROM energy_5m
			ORDER BY ts_utc DESC
			LIMIT 1
		`),
		getSetting: database.prepare(`
			SELECT value
			FROM settings
			WHERE key = ?
		`),
		upsertSetting: database.prepare(`
			INSERT INTO settings (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET
				value = excluded.value
		`),
	};
}

function ensureDefaultSettings(prepared) {
	const defaults = [
		['daily_fixed_cents', JSON.stringify(DEFAULT_DAILY_FIXED_CENTS)],
		['timezone', JSON.stringify(DEFAULT_TIMEZONE)],
		['import_periods_json', JSON.stringify(DEFAULT_IMPORT_PERIODS)],
		['export_periods_json', JSON.stringify(DEFAULT_EXPORT_PERIODS)],
	];

	for (const [key, defaultValue] of defaults) {
		const existing = prepared.getSetting.get(key);
		if (!existing) {
			prepared.upsertSetting.run(key, defaultValue);
		}
	}
}

function getRatesSettings(prepared) {
	const dailyFixedRaw = parseJsonSetting(prepared.getSetting.get('daily_fixed_cents')?.value, DEFAULT_DAILY_FIXED_CENTS);
	const timezoneRaw = parseJsonSetting(prepared.getSetting.get('timezone')?.value, DEFAULT_TIMEZONE);
	const importRaw = parseJsonSetting(prepared.getSetting.get('import_periods_json')?.value, DEFAULT_IMPORT_PERIODS);
	const exportRaw = parseJsonSetting(prepared.getSetting.get('export_periods_json')?.value, DEFAULT_EXPORT_PERIODS);

	const dailyFixed = Number(dailyFixedRaw);
	const timezone = typeof timezoneRaw === 'string' && isValidTimezone(timezoneRaw) ? timezoneRaw : DEFAULT_TIMEZONE;

	return {
		daily_fixed_cents: Number.isFinite(dailyFixed) && dailyFixed >= 0 ? dailyFixed : DEFAULT_DAILY_FIXED_CENTS,
		timezone,
		import_periods: validateRatePeriods(importRaw, 'import_periods'),
		export_periods: validateRatePeriods(exportRaw, 'export_periods'),
	};
}

function parseJsonSetting(rawValue, fallback) {
	if (typeof rawValue !== 'string') {
		return fallback;
	}

	try {
		return JSON.parse(rawValue);
	} catch {
		return fallback;
	}
}

function isValidTimezone(zone) {
	return DateTime.now().setZone(zone).isValid;
}

function validateRatePeriods(periods, label) {
	if (!Array.isArray(periods) || periods.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}

	const normalized = periods.map((period, index) => {
		if (!period || typeof period !== 'object') {
			throw new Error(`${label}[${index}] must be an object`);
		}

		const days = normalizeDayGroup(period.days);
		const { start, end } = period;
		const cents = Number(period.cents_per_kwh);
		if (typeof start !== 'string' || typeof end !== 'string') {
			throw new Error(`${label}[${index}] start and end must be HH:mm strings`);
		}
		if (!Number.isFinite(cents) || cents < 0) {
			throw new Error(`${label}[${index}] cents_per_kwh must be >= 0`);
		}

		const startMinutes = parseTimeToMinutes(start, false);
		const endMinutes = parseTimeToMinutes(end, true);
		if (endMinutes <= startMinutes) {
			throw new Error(`${label}[${index}] end must be after start`);
		}

		return {
			days,
			start,
			end,
			cents_per_kwh: cents,
		};
	});

	for (const dayGroup of ['all', 'weekday', 'weekend']) {
		const sorted = normalized
			.filter((period) => period.days === dayGroup)
			.map((period) => ({
				start: parseTimeToMinutes(period.start, false),
				end: parseTimeToMinutes(period.end, true),
			}))
			.sort((a, b) => a.start - b.start);

		for (let index = 1; index < sorted.length; index += 1) {
			if (sorted[index - 1].end > sorted[index].start) {
				console.warn(`[rates] ${label} contains overlapping periods for ${dayGroup}; first matching period will be used`);
				break;
			}
		}
	}

	return normalized;
}

function normalizeDayGroup(days) {
	if (days === undefined || days === null || days === '') {
		return 'all';
	}

	if (days !== 'all' && days !== 'weekday' && days !== 'weekend') {
		throw new Error(`Invalid days value: ${days}; expected all|weekday|weekend`);
	}

	return days;
}

function parseTimeToMinutes(hhmm, allow2400) {
	if (!/^\d{2}:\d{2}$/.test(hhmm)) {
		throw new Error(`Invalid time format: ${hhmm}; expected HH:mm`);
	}

	const [hourRaw, minuteRaw] = hhmm.split(':');
	const hour = Number(hourRaw);
	const minute = Number(minuteRaw);

	if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
		throw new Error(`Invalid time value: ${hhmm}`);
	}

	if (allow2400 && hour === 24 && minute === 0) {
		return 24 * 60;
	}

	if (hour < 0 || hour > 23) {
		throw new Error(`Invalid hour in time: ${hhmm}`);
	}

	return hour * 60 + minute;
}

function findRateForTime(periods, dayGroup, hhmm) {
	const timeMinutes = parseTimeToMinutes(hhmm, false);
	const exactMatchRate = findRateForDayGroup(periods, dayGroup, timeMinutes);
	if (exactMatchRate !== null) {
		return exactMatchRate;
	}

	const allDaysRate = findRateForDayGroup(periods, 'all', timeMinutes);
	if (allDaysRate !== null) {
		return allDaysRate;
	}

	return Number(periods[periods.length - 1].cents_per_kwh);
}

function findRateForDayGroup(periods, dayGroup, timeMinutes) {
	for (const period of periods) {
		if (normalizeDayGroup(period.days) !== dayGroup) {
			continue;
		}

		const startMinutes = parseTimeToMinutes(period.start, false);
		const endMinutes = parseTimeToMinutes(period.end, true);
		if (timeMinutes >= startMinutes && timeMinutes < endMinutes) {
			return Number(period.cents_per_kwh);
		}
	}

	return null;
}

function dayGroupFromLocalDateTime(localDateTime) {
	return localDateTime.weekday === 6 || localDateTime.weekday === 7 ? 'weekend' : 'weekday';
}

function aggregateBillFromReadings(rows, rates, fromUtc, toUtc) {
	const timezone = rates.timezone;
	const dailyMap = new Map();

	const rateBoundaryMinutes = collectRateBoundaryMinutes(rates);

	if (rows && rows.length >= 2) {
		for (let index = 1; index < rows.length; index += 1) {
			const prev = rows[index - 1];
			const curr = rows[index];

			const prevUtc = DateTime.fromISO(prev.ts_utc, { zone: 'utc' });
			const currUtc = DateTime.fromISO(curr.ts_utc, { zone: 'utc' });
			if (!prevUtc.isValid || !currUtc.isValid || currUtc <= prevUtc) {
				continue;
			}

			const importW = Math.max(0, Number(prev.grid_import_w) || 0);
			const exportW = Math.max(0, Number(prev.grid_export_w) || 0);

			let cursorUtc = prevUtc;
			while (cursorUtc < currUtc) {
				const cursorLocal = cursorUtc.setZone(timezone);
				if (!cursorLocal.isValid) {
					break;
				}

				const nextBoundaryUtc = nextBillBoundaryUtc(cursorLocal, rateBoundaryMinutes);
				const segmentEndUtc = nextBoundaryUtc < currUtc ? nextBoundaryUtc : currUtc;
				if (!(segmentEndUtc > cursorUtc)) {
					break;
				}

				const dayLocal = cursorLocal.toFormat('yyyy-LL-dd');
				if (!dailyMap.has(dayLocal)) {
					dailyMap.set(dayLocal, {
						day_local: dayLocal,
						import_kwh: 0,
						free_import_kwh: 0,
						export_kwh: 0,
						import_cost: 0,
						export_credit: 0,
						fixed_charge: Number(rates.daily_fixed_cents),
						net_cost: 0,
					});
				}

				const hours = segmentEndUtc.diff(cursorUtc, 'hours').hours;
				if (hours > 0) {
					const dayGroup = dayGroupFromLocalDateTime(cursorLocal);
					const hhmm = cursorLocal.toFormat('HH:mm');
					const importRate = findRateForTime(rates.import_periods, dayGroup, hhmm);
					const exportRate = findRateForTime(rates.export_periods, dayGroup, hhmm);

					const importKwh = (importW / 1000) * hours;
					const exportKwh = (exportW / 1000) * hours;

					const bucket = dailyMap.get(dayLocal);
					bucket.import_kwh += importKwh;
					if (importRate === 0) {
						bucket.free_import_kwh += importKwh;
					}
					bucket.export_kwh += exportKwh;
					bucket.import_cost += importKwh * importRate;
					bucket.export_credit += exportKwh * exportRate;
				}

				cursorUtc = segmentEndUtc;
			}
		}
	}

	const days = Array.from(dailyMap.values())
		.sort((a, b) => a.day_local.localeCompare(b.day_local))
		.map((item) => {
			const netCost = item.import_cost - item.export_credit + item.fixed_charge;
			return {
				day_local: item.day_local,
				import_kwh: round3(item.import_kwh),
				free_import_kwh: round3(item.free_import_kwh),
				export_kwh: round3(item.export_kwh),
				import_cost: round3(item.import_cost),
				export_credit: round3(item.export_credit),
				fixed_charge: round3(item.fixed_charge),
				net_cost: round3(netCost),
			};
		});

	const summary = {
		from_utc: fromUtc,
		to_utc: toUtc,
		days: days.length,
		total_import_kwh: round3(days.reduce((sum, day) => sum + day.import_kwh, 0)),
		total_free_import_kwh: round3(days.reduce((sum, day) => sum + day.free_import_kwh, 0)),
		total_export_kwh: round3(days.reduce((sum, day) => sum + day.export_kwh, 0)),
		total_import_cost: round3(days.reduce((sum, day) => sum + day.import_cost, 0)),
		total_export_credit: round3(days.reduce((sum, day) => sum + day.export_credit, 0)),
		total_fixed_charge: round3(days.reduce((sum, day) => sum + day.fixed_charge, 0)),
		total_net_cost: round3(days.reduce((sum, day) => sum + day.net_cost, 0)),
	};

	return {
		summary,
		days,
	};
}

function aggregateBillFromEnergy5m(rows, rates, fromUtcIso, toUtcIso) {
	const timezone = rates.timezone;
	const dailyMap = new Map();

	for (const dayLocal of enumerateLocalDaysInRange(fromUtcIso, toUtcIso, timezone)) {
		dailyMap.set(dayLocal, {
			day_local: dayLocal,
			import_kwh: 0,
			free_import_kwh: 0,
			export_kwh: 0,
			import_cost: 0,
			export_credit: 0,
			fixed_charge: Number(rates.daily_fixed_cents),
			net_cost: 0,
		});
	}

	for (const row of rows || []) {
		const utc = DateTime.fromISO(row.ts_utc, { zone: 'utc' });
		if (!utc.isValid) {
			continue;
		}

		const local = utc.setZone(timezone);
		if (!local.isValid) {
			continue;
		}

		const dayLocal = local.toFormat('yyyy-LL-dd');
		if (!dailyMap.has(dayLocal)) {
			dailyMap.set(dayLocal, {
				day_local: dayLocal,
				import_kwh: 0,
				free_import_kwh: 0,
				export_kwh: 0,
				import_cost: 0,
				export_credit: 0,
				fixed_charge: Number(rates.daily_fixed_cents),
				net_cost: 0,
			});
		}

		const dayGroup = dayGroupFromLocalDateTime(local);
		const hhmm = local.toFormat('HH:mm');
		const importRate = findRateForTime(rates.import_periods, dayGroup, hhmm);
		const exportRate = findRateForTime(rates.export_periods, dayGroup, hhmm);

		const importKwh = Math.max(0, Number(row.import_wh) || 0) / 1000;
		const exportKwh = Math.max(0, Number(row.export_wh) || 0) / 1000;

		const bucket = dailyMap.get(dayLocal);
		bucket.import_kwh += importKwh;
		if (importRate === 0) {
			bucket.free_import_kwh += importKwh;
		}
		bucket.export_kwh += exportKwh;
		bucket.import_cost += importKwh * importRate;
		bucket.export_credit += exportKwh * exportRate;
	}

	const days = Array.from(dailyMap.values())
		.sort((a, b) => a.day_local.localeCompare(b.day_local))
		.map((item) => {
			const netCost = item.import_cost - item.export_credit + item.fixed_charge;
			return {
				day_local: item.day_local,
				import_kwh: round3(item.import_kwh),
				free_import_kwh: round3(item.free_import_kwh),
				export_kwh: round3(item.export_kwh),
				import_cost: round3(item.import_cost),
				export_credit: round3(item.export_credit),
				fixed_charge: round3(item.fixed_charge),
				net_cost: round3(netCost),
			};
		});

	const summary = {
		from_utc: fromUtcIso,
		to_utc: toUtcIso,
		days: days.length,
		total_import_kwh: round3(days.reduce((sum, day) => sum + day.import_kwh, 0)),
		total_free_import_kwh: round3(days.reduce((sum, day) => sum + day.free_import_kwh, 0)),
		total_export_kwh: round3(days.reduce((sum, day) => sum + day.export_kwh, 0)),
		total_import_cost: round3(days.reduce((sum, day) => sum + day.import_cost, 0)),
		total_export_credit: round3(days.reduce((sum, day) => sum + day.export_credit, 0)),
		total_fixed_charge: round3(days.reduce((sum, day) => sum + day.fixed_charge, 0)),
		total_net_cost: round3(days.reduce((sum, day) => sum + day.net_cost, 0)),
	};

	return {
		summary,
		days,
	};
}

function aggregateBillIntervalsFromEnergy5m(rows, rates, fromUtcIso, toUtcIso) {
	const timezone = rates.timezone;
	const intervals = [];

	for (const row of rows || []) {
		const utc = DateTime.fromISO(row.ts_utc, { zone: 'utc' });
		if (!utc.isValid) {
			continue;
		}

		const local = utc.setZone(timezone);
		if (!local.isValid) {
			continue;
		}

		const dayGroup = dayGroupFromLocalDateTime(local);
		const hhmm = local.toFormat('HH:mm');
		const importRate = findRateForTime(rates.import_periods, dayGroup, hhmm);
		const exportRate = findRateForTime(rates.export_periods, dayGroup, hhmm);

		const importKwh = Math.max(0, Number(row.import_wh) || 0) / 1000;
		const exportKwh = Math.max(0, Number(row.export_wh) || 0) / 1000;
		const importCost = importKwh * importRate;
		const exportCredit = exportKwh * exportRate;

		intervals.push({
			ts_utc: row.ts_utc,
			ts_local: local.toISO({ suppressMilliseconds: true }),
			import_kwh: Math.round(importKwh * 10000) / 10000,
			export_kwh: Math.round(exportKwh * 10000) / 10000,
			import_rate_cents_per_kwh: round3(importRate),
			export_rate_cents_per_kwh: round3(exportRate),
			import_cost: round3(importCost),
			export_credit: round3(exportCredit),
			net_cost: round3(importCost - exportCredit),
		});
	}

	const summary = {
		from_utc: fromUtcIso,
		to_utc: toUtcIso,
		interval_minutes: 5,
		timezone,
		count: intervals.length,
		total_import_kwh: round3(intervals.reduce((sum, row) => sum + row.import_kwh, 0)),
		total_free_import_kwh: round3(
			intervals.reduce(
				(sum, row) => sum + (row.import_rate_cents_per_kwh === 0 ? row.import_kwh : 0),
				0,
			),
		),
		total_export_kwh: round3(intervals.reduce((sum, row) => sum + row.export_kwh, 0)),
		total_import_cost: round3(intervals.reduce((sum, row) => sum + row.import_cost, 0)),
		total_export_credit: round3(intervals.reduce((sum, row) => sum + row.export_credit, 0)),
		total_net_cost: round3(intervals.reduce((sum, row) => sum + row.net_cost, 0)),
	};

	return {
		summary,
		intervals,
	};
}

function enumerateLocalDaysInRange(fromUtc, toUtc, timezone) {
	const fromLocal = DateTime.fromISO(fromUtc, { zone: 'utc' }).setZone(timezone);
	const toLocal = DateTime.fromISO(toUtc, { zone: 'utc' }).setZone(timezone);
	if (!fromLocal.isValid || !toLocal.isValid || toLocal < fromLocal) {
		return [];
	}

	const days = [];
	let cursor = fromLocal.startOf('day');
	const end = toLocal.startOf('day');

	while (cursor <= end) {
		days.push(cursor.toFormat('yyyy-LL-dd'));
		cursor = cursor.plus({ days: 1 });
	}

	return days;
}

function collectRateBoundaryMinutes(rates) {
	const boundaries = new Set();
	const addBoundary = (hhmm, allow2400) => {
		const minute = parseTimeToMinutes(hhmm, allow2400);
		if (minute > 0 && minute < 24 * 60) {
			boundaries.add(minute);
		}
	};

	for (const period of rates.import_periods) {
		addBoundary(period.start, false);
		addBoundary(period.end, true);
	}

	for (const period of rates.export_periods) {
		addBoundary(period.start, false);
		addBoundary(period.end, true);
	}

	return Array.from(boundaries).sort((a, b) => a - b);
}

function nextBillBoundaryUtc(localDateTime, boundaryMinutes) {
	const dayStart = localDateTime.startOf('day');
	const currentMinute = localDateTime.hour * 60 + localDateTime.minute;

	for (const minute of boundaryMinutes) {
		if (minute <= currentMinute) {
			continue;
		}

		const candidateLocal = dayStart.plus({ minutes: minute });
		if (candidateLocal.isValid) {
			return candidateLocal.setZone('utc');
		}
	}

	return dayStart.plus({ days: 1 }).setZone('utc');
}

function parseRange(fromRaw, toRaw, fallbackHours) {
	const toDate = toRaw ? new Date(toRaw) : new Date();
	if (Number.isNaN(toDate.getTime())) {
		throw new Error('Invalid query param: to');
	}

	const fromDate = fromRaw
		? new Date(fromRaw)
		: new Date(toDate.getTime() - fallbackHours * 60 * 60 * 1000);

	if (Number.isNaN(fromDate.getTime())) {
		throw new Error('Invalid query param: from');
	}

	if (fromDate > toDate) {
		throw new Error('Invalid range: from must be <= to');
	}

	return {
		from: fromDate.toISOString(),
		to: toDate.toISOString(),
	};
}

function withDerivedValues(row) {
	const gridNet = row.grid_import_w - row.grid_export_w;
	const selfConsumed = Math.max(0, row.load_w - row.grid_import_w);

	return {
		...row,
		grid_net_w: gridNet,
		self_consumed_w: selfConsumed,
	};
}

function aggregateDailyFromReadings(rows) {
	const dailyMap = new Map();

	for (let index = 1; index < rows.length; index += 1) {
		const prev = rows[index - 1];
		const curr = rows[index];

		const prevTs = Date.parse(prev.ts_utc);
		const currTs = Date.parse(curr.ts_utc);
		if (!Number.isFinite(prevTs) || !Number.isFinite(currTs) || currTs <= prevTs) {
			continue;
		}

		const deltaSeconds = (currTs - prevTs) / 1000;
		const factor = deltaSeconds / 3600 / 1000;
		const day = curr.ts_utc.slice(0, 10);

		if (!dailyMap.has(day)) {
			dailyMap.set(day, {
				day,
				pv_kwh: 0,
				load_kwh: 0,
				import_kwh: 0,
				export_kwh: 0,
				self_kwh: 0,
			});
		}

		const bucket = dailyMap.get(day);
		const selfW = Math.max(0, prev.load_w - prev.grid_import_w);

		bucket.pv_kwh += prev.pv_w * factor;
		bucket.load_kwh += prev.load_w * factor;
		bucket.import_kwh += prev.grid_import_w * factor;
		bucket.export_kwh += prev.grid_export_w * factor;
		bucket.self_kwh += selfW * factor;
	}

	return Array.from(dailyMap.values())
		.sort((a, b) => a.day.localeCompare(b.day))
		.map((item) => ({
			day: item.day,
			pv_kwh: round3(item.pv_kwh),
			load_kwh: round3(item.load_kwh),
			import_kwh: round3(item.import_kwh),
			export_kwh: round3(item.export_kwh),
			self_kwh: round3(item.self_kwh),
		}));
}

function getLiveExplanation(reading) {
	if (reading.pv_w > 500 && reading.grid_import_w > 200 && reading.load_w > reading.pv_w) {
		return `Importing because load (${reading.load_w}W) exceeds solar (${reading.pv_w}W).`;
	}

	if (reading.grid_export_w > 0) {
		return `Exporting surplus solar (${reading.grid_export_w}W).`;
	}

	if (reading.grid_import_w > 0) {
		return `Importing from grid (${reading.grid_import_w}W).`;
	}

	return null;
}

function startPolling() {
	pollOnce();
	setInterval(() => {
		pollOnce();
	}, POLL_SECONDS * 1000);
}

function startArchiveBackfill() {
	backfillArchiveOnce();
	setInterval(() => {
		backfillArchiveOnce();
	}, ARCHIVE_BACKFILL_MINUTES * 60 * 1000);
}

async function backfillArchiveOnce() {
	if (state.manualArchiveBackfill.running) {
		console.log('[archive] skipped: manual backfill is in progress');
		return;
	}

	if (state.archiveBackfillInProgress) {
		console.log('[archive] skipped: previous backfill still in progress');
		return;
	}

	state.archiveBackfillInProgress = true;
	state.lastArchiveBackfillAtUtc = new Date().toISOString();

	try {
		const settings = getRatesSettings(statements);
		const timezone = settings.timezone || DEFAULT_TIMEZONE;
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) {
			throw new Error(`Invalid timezone for archive backfill: ${timezone}`);
		}

		const localStart = nowLocal.minus({ days: ARCHIVE_LOOKBACK_DAYS - 1 }).startOf('day');
		const localEnd = nowLocal.endOf('day');

		const startLocalDate = localStart.toFormat('yyyy-LL-dd');
		const endLocalDate = localEnd.toFormat('yyyy-LL-dd');
		if (!startLocalDate || !endLocalDate) {
			throw new Error('Failed to compute archive backfill range');
		}

		const buckets = await fetchArchiveDetail(INVERTER_BASE_URL, startLocalDate, endLocalDate, {
			context: 'auto-backfill',
			emitDiagnosticsLog: ARCHIVE_DEBUG_LOG,
		});
		let upsertedCount = 0;

		for (const bucket of buckets) {
			const totalOffsetSeconds = Number.parseInt(String(bucket.offsetSeconds), 10);
			if (!Number.isInteger(totalOffsetSeconds) || totalOffsetSeconds < 0) {
				continue;
			}

			const bucketLocal = localStart.plus({ seconds: totalOffsetSeconds });
			if (!bucketLocal.isValid) {
				continue;
			}

			const tsUtc = bucketLocal.toUTC().toISO({ suppressMilliseconds: true });
			if (!tsUtc) {
				continue;
			}

			const result = statements.upsertEnergy5m.run({
				ts_utc: tsUtc,
				import_wh: bucket.importWh,
				export_wh: bucket.exportWh,
			});

			if (result.changes > 0) {
				upsertedCount += 1;
			}
		}

		state.lastArchiveBackfillError = null;
		state.lastArchiveBackfillSuccessAtUtc = new Date().toISOString();
		state.lastArchiveBackfillAtUtc = new Date().toISOString();
		console.log(
			`[archive] upserted ${upsertedCount} buckets for ${startLocalDate} -> ${endLocalDate} (${timezone})`,
		);
	} catch (error) {
		state.lastArchiveBackfillError = error?.message || String(error);
		state.lastArchiveBackfillAtUtc = new Date().toISOString();
		console.error('Archive backfill failed:', error);
	} finally {
		state.archiveBackfillInProgress = false;
	}
}

function getManualArchiveBackfillStatus() {
	const status = state.manualArchiveBackfill;
	return {
		running: Boolean(status.running),
		started_at_utc: status.startedAtUtc,
		completed_at_utc: status.completedAtUtc,
		last_error: status.lastError,
		range: status.range,
		progress: status.progress,
	};
}

function buildManualArchiveBackfillRange(startMonth, months, timezone) {
	if (typeof startMonth !== 'string' || !/^\d{4}-\d{2}$/.test(startMonth)) {
		throw new Error('start_month must be in YYYY-MM format');
	}

	const monthsNumber = Number(months);
	if (!Number.isInteger(monthsNumber) || monthsNumber < 1 || monthsNumber > 24) {
		throw new Error('months must be an integer in range 1..24');
	}

	const startLocal = DateTime.fromFormat(`${startMonth}-01 00:00:00`, 'yyyy-LL-dd HH:mm:ss', { zone: timezone });
	if (!startLocal.isValid) {
		throw new Error(`Invalid start_month for timezone ${timezone}`);
	}

	const nowLocal = DateTime.now().setZone(timezone);
	if (!nowLocal.isValid) {
		throw new Error(`Invalid timezone for manual archive backfill: ${timezone}`);
	}

	if (startLocal > nowLocal) {
		throw new Error('start_month cannot be in the future for the selected timezone');
	}

	const requestedEndLocal = startLocal.plus({ months: monthsNumber }).minus({ seconds: 1 });
	const endLocal = requestedEndLocal < nowLocal ? requestedEndLocal : nowLocal;

	const totalDays = Math.floor(endLocal.startOf('day').diff(startLocal.startOf('day'), 'days').days) + 1;
	const totalRequests = Math.ceil(totalDays / MANUAL_ARCHIVE_CHUNK_DAYS);

	return {
		start_month: startMonth,
		months: monthsNumber,
		timezone,
		start_local: startLocal.toISO({ suppressMilliseconds: true }),
		end_local: endLocal.toISO({ suppressMilliseconds: true }),
		requested_start_local: startLocal.toISO({ suppressMilliseconds: true }),
		requested_end_local: endLocal.toISO({ suppressMilliseconds: true }),
		total_days: totalDays,
		total_requests: totalRequests,
	};
}

async function clampManualArchiveRangeToAvailableData(range, timezone) {
	const requestedStart = DateTime.fromISO(range.start_local, { zone: timezone });
	const requestedEnd = DateTime.fromISO(range.end_local, { zone: timezone });
	if (!requestedStart.isValid || !requestedEnd.isValid || requestedEnd < requestedStart) {
		throw new Error('Invalid manual archive backfill range');
	}

	const availability = await probeArchiveAvailableRange(requestedStart, requestedEnd, timezone);
	if (!availability.found) {
		throw new Error(
			`No archive data available for requested range ${requestedStart.toFormat('yyyy-LL-dd')} to ${requestedEnd.toFormat('yyyy-LL-dd')}`,
		);
	}

	const effectiveStart = availability.firstDataLocal > requestedStart ? availability.firstDataLocal : requestedStart;
	const effectiveEnd = availability.lastDataLocal < requestedEnd ? availability.lastDataLocal : requestedEnd;
	if (effectiveEnd < effectiveStart) {
		throw new Error(
			`No archive data available after clamping to detected data window ${availability.firstDataLocal.toFormat('yyyy-LL-dd')} to ${availability.lastDataLocal.toFormat('yyyy-LL-dd')}`,
		);
	}

	const totalDays = Math.floor(effectiveEnd.startOf('day').diff(effectiveStart.startOf('day'), 'days').days) + 1;
	const totalRequests = Math.ceil(totalDays / MANUAL_ARCHIVE_CHUNK_DAYS);

	return {
		...range,
		start_local: effectiveStart.toISO({ suppressMilliseconds: true }),
		end_local: effectiveEnd.toISO({ suppressMilliseconds: true }),
		available_start_local: availability.firstDataLocal.toISO({ suppressMilliseconds: true }),
		available_end_local: availability.lastDataLocal.toISO({ suppressMilliseconds: true }),
		clamped: effectiveStart > requestedStart || effectiveEnd < requestedEnd,
		total_days: totalDays,
		total_requests: totalRequests,
	};
}

async function probeArchiveAvailableRange(startLocal, endLocal, timezone) {
	const chunkDays = Math.max(1, Math.min(14, MANUAL_ARCHIVE_CHUNK_DAYS * 3));

	let firstDataLocal = null;
	let forwardCursor = startLocal.startOf('day');
	while (forwardCursor <= endLocal) {
		const chunkEnd = minLocalDateTime(
			forwardCursor.plus({ days: chunkDays }).minus({ seconds: 1 }),
			endLocal,
		);

		const buckets = await fetchArchiveDetail(
			INVERTER_BASE_URL,
			forwardCursor.toFormat('yyyy-LL-dd'),
			chunkEnd.toFormat('yyyy-LL-dd'),
			{ context: 'manual-backfill-probe-forward', emitDiagnosticsLog: false },
		);

		if (buckets.length > 0) {
			for (let dayCursor = forwardCursor.startOf('day'); dayCursor <= chunkEnd; dayCursor = dayCursor.plus({ days: 1 })) {
				const dayBuckets = await fetchArchiveDetail(
					INVERTER_BASE_URL,
					dayCursor.toFormat('yyyy-LL-dd'),
					dayCursor.toFormat('yyyy-LL-dd'),
					{ context: 'manual-backfill-probe-first-day', emitDiagnosticsLog: false },
				);

				if (dayBuckets.length > 0) {
					firstDataLocal = dayCursor.startOf('day');
					break;
				}
			}

			if (firstDataLocal) {
				break;
			}
		}

		forwardCursor = chunkEnd.plus({ seconds: 1 }).startOf('day');
	}

	if (!firstDataLocal) {
		return { found: false };
	}

	let lastDataLocal = null;
	let backwardCursor = endLocal.endOf('day');
	while (backwardCursor >= firstDataLocal) {
		const chunkStart = maxLocalDateTime(
			backwardCursor.minus({ days: chunkDays }).plus({ seconds: 1 }).startOf('day'),
			firstDataLocal,
		);

		const buckets = await fetchArchiveDetail(
			INVERTER_BASE_URL,
			chunkStart.toFormat('yyyy-LL-dd'),
			backwardCursor.toFormat('yyyy-LL-dd'),
			{ context: 'manual-backfill-probe-backward', emitDiagnosticsLog: false },
		);

		if (buckets.length > 0) {
			for (let dayCursor = backwardCursor.startOf('day'); dayCursor >= chunkStart; dayCursor = dayCursor.minus({ days: 1 })) {
				const dayBuckets = await fetchArchiveDetail(
					INVERTER_BASE_URL,
					dayCursor.toFormat('yyyy-LL-dd'),
					dayCursor.toFormat('yyyy-LL-dd'),
					{ context: 'manual-backfill-probe-last-day', emitDiagnosticsLog: false },
				);

				if (dayBuckets.length > 0) {
					lastDataLocal = dayCursor.endOf('day');
					break;
				}
			}

			if (lastDataLocal) {
				break;
			}
		}

		backwardCursor = chunkStart.minus({ seconds: 1 }).endOf('day');
	}

	if (!lastDataLocal) {
		lastDataLocal = endLocal;
	}

	return {
		found: true,
		firstDataLocal,
		lastDataLocal,
	};
}

function minLocalDateTime(a, b) {
	return a < b ? a : b;
}

function maxLocalDateTime(a, b) {
	return a > b ? a : b;
}

async function runManualArchiveBackfillJob(range) {
	const timezone = range.timezone || DEFAULT_TIMEZONE;
	const startLocal = DateTime.fromISO(range.start_local, { zone: timezone });
	const endLocal = DateTime.fromISO(range.end_local, { zone: timezone });

	if (!startLocal.isValid || !endLocal.isValid || endLocal < startLocal) {
		throw new Error('Invalid manual archive backfill range');
	}

	let chunkStart = startLocal.startOf('day');
	let rowsUpserted = 0;
	let completedDays = 0;
	let completedRequests = 0;

	while (chunkStart <= endLocal) {
		const chunkStartedAtMs = Date.now();
		const chunkEndCandidate = chunkStart.plus({ days: MANUAL_ARCHIVE_CHUNK_DAYS }).minus({ seconds: 1 });
		const chunkEnd = chunkEndCandidate < endLocal ? chunkEndCandidate : endLocal;

		const chunkStartDate = chunkStart.toFormat('yyyy-LL-dd');
		const chunkEndDate = chunkEnd.toFormat('yyyy-LL-dd');
		const buckets = await fetchArchiveDetail(INVERTER_BASE_URL, chunkStartDate, chunkEndDate, {
			context: 'manual-backfill',
			emitDiagnosticsLog: ARCHIVE_DEBUG_LOG,
		});

		let chunkUpserts = 0;
		for (const bucket of buckets) {
			const totalOffsetSeconds = Number.parseInt(String(bucket.offsetSeconds), 10);
			if (!Number.isInteger(totalOffsetSeconds) || totalOffsetSeconds < 0) {
				continue;
			}

			const bucketLocal = chunkStart.startOf('day').plus({ seconds: totalOffsetSeconds });
			if (!bucketLocal.isValid || bucketLocal < startLocal || bucketLocal > endLocal) {
				continue;
			}

			const tsUtc = bucketLocal.toUTC().toISO({ suppressMilliseconds: true });
			if (!tsUtc) {
				continue;
			}

			const result = statements.upsertEnergy5m.run({
				ts_utc: tsUtc,
				import_wh: bucket.importWh,
				export_wh: bucket.exportWh,
			});

			if (result.changes > 0) {
				chunkUpserts += 1;
			}
		}

		rowsUpserted += chunkUpserts;
		completedRequests += 1;

		const chunkDays = Math.floor(chunkEnd.startOf('day').diff(chunkStart.startOf('day'), 'days').days) + 1;
		completedDays = Math.min(range.total_days, completedDays + chunkDays);

		state.manualArchiveBackfill.progress = {
			total_days: range.total_days,
			completed_days: completedDays,
			total_requests: range.total_requests,
			completed_requests: completedRequests,
			rows_upserted: rowsUpserted,
		};

		const durationMs = Date.now() - chunkStartedAtMs;
		console.log(
			`[archive-manual] chunk ${chunkStartDate} -> ${chunkEndDate}, upserts=${chunkUpserts}, duration_ms=${durationMs}`,
		);

		chunkStart = chunkEnd.plus({ seconds: 1 }).startOf('day');
	}

	state.manualArchiveBackfill.lastError = null;
	state.manualArchiveBackfill.completedAtUtc = new Date().toISOString();
	state.manualArchiveBackfill.running = false;
}

async function pollOnce() {
	if (state.pollingInProgress) {
		console.log('[poll] skipped: previous poll still in progress');
		return;
	}

	state.pollingInProgress = true;
	state.lastPollAtUtc = new Date().toISOString();
	console.log(`[poll] start ${state.lastPollAtUtc}`);

	try {
		const reading = await fetchPowerFlowReading(INVERTER_BASE_URL);
		const insertResult = statements.insertReading.run(
			reading.ts_utc,
			reading.pv_w,
			reading.load_w,
			reading.grid_import_w,
			reading.grid_export_w,
		);
		console.log(
			`[poll] parsed ts=${reading.ts_utc} pv=${reading.pv_w}W load=${reading.load_w}W import=${reading.grid_import_w}W export=${reading.grid_export_w}W`,
		);

		state.lastSuccessAtUtc = new Date().toISOString();
		state.lastError = null;
		state.lastReadingTsUtc = reading.ts_utc;

		if (reading.pv_w > 0 && reading.load_w === 0) {
			state.consecutiveZeroLoadWithPv += 1;
		} else {
			state.consecutiveZeroLoadWithPv = 0;
		}

		state.liveDataWarning = getDataWarning(reading, state.consecutiveZeroLoadWithPv);

		if (insertResult.changes > 0) {
			console.log(`[db] inserted reading ${reading.ts_utc}`);
			recomputeDailyAggForRange(db, statements, reading.ts_utc, reading.ts_utc);
		} else {
			console.log(`[db] skipped duplicate reading ${reading.ts_utc}`);
		}
	} catch (error) {
		state.lastError = error?.message || String(error);
		console.error('Poll failed:', error);
	} finally {
		state.pollingInProgress = false;
	}
}

async function fetchPowerFlowReading(baseUrl) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);

	try {
		const url = `${baseUrl}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`;
		console.log(`[poll] fetch ${url}`);
		const response = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) {
			throw new Error(`Fronius API error: HTTP ${response.status}`);
		}

		const payload = await response.json();
		console.log(JSON.stringify(payload.Body.Data, null, 2));
		return parseFroniusPayload(payload);
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchArchiveEnergyBuckets(baseUrl, startLocalIso, endLocalIso) {
	const buckets = await fetchArchiveDetail(baseUrl, startLocalIso, endLocalIso, {
		context: 'fetchArchiveEnergyBuckets',
		emitDiagnosticsLog: ARCHIVE_DEBUG_LOG,
	});
	return buckets.map((bucket) => ({
		offset_seconds: bucket.offsetSeconds,
		import_wh: bucket.importWh,
		export_wh: bucket.exportWh,
	}));
}

async function fetchArchiveDetail(baseUrl, startLocalIso, endLocalIso, options = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);
	const context = options.context || 'archive';
	const emitDiagnosticsLog = Boolean(options.emitDiagnosticsLog);

	try {
		const url = new URL(`${baseUrl}/solar_api/v1/GetArchiveData.cgi`);
		url.searchParams.append('Scope', 'System');
		url.searchParams.append('SeriesType', 'Detail');
		url.searchParams.append('HumanReadable', 'True');
		url.searchParams.append('StartDate', startLocalIso);
		url.searchParams.append('EndDate', endLocalIso);

		for (const channel of ARCHIVE_CHANNEL_PROBE_LIST) {
			url.searchParams.append('Channel', channel);
		}

		const response = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});

		if (response.status !== 200) {
			throw new Error(`Fronius archive API error: HTTP ${response.status}`);
		}

		const payload = await response.json();
		const statusCode = Number(payload?.Head?.Status?.Code);
		if (!Number.isFinite(statusCode) || statusCode !== 0) {
			const statusReason = payload?.Head?.Status?.Reason;
			throw new Error(`Fronius archive API status error: ${payload?.Head?.Status?.Code}${statusReason ? ` ${statusReason}` : ''}`);
		}

		try {
			const parsed = parseArchiveDetail(payload);
			state.archiveDiagnostics = {
				last_probe_at_utc: new Date().toISOString(),
				last_probe_start_local: startLocalIso,
				last_probe_end_local: endLocalIso,
				...parsed.diagnostics,
			};

			if (emitDiagnosticsLog) {
				console.log(
					`[archive-diagnostics] ${JSON.stringify({
						context,
						start_local: startLocalIso,
						end_local: endLocalIso,
						import_history_present: parsed.diagnostics.import_history_present,
						export_history_present: parsed.diagnostics.export_history_present,
						selected_import_channels: parsed.diagnostics.selected_import_channels,
						selected_export_channels: parsed.diagnostics.selected_export_channels,
						all_channels: parsed.diagnostics.all_channels,
						warnings: parsed.diagnostics.warnings,
						nodes: parsed.diagnostics.nodes,
					})}`,
				);
			}

			return parsed.buckets;
		} catch (error) {
			console.error('[archive] failed to parse payload:', JSON.stringify(payload, null, 2));
			throw error;
		}
	} finally {
		clearTimeout(timeout);
	}
}

function parseFroniusArchiveDetail(payload) {
	const buckets = parseArchiveDetail(payload);
	return buckets.map((bucket) => ({
		offset_seconds: bucket.offsetSeconds,
		import_wh: bucket.importWh,
		export_wh: bucket.exportWh,
	}));
}

function parseArchiveDetail(payload) {
	const bodyData = payload?.Body?.Data;
	if (!bodyData || typeof bodyData !== 'object') {
		throw new Error('Invalid archive payload: missing Body.Data');
	}

	const nodeEntries = Object.entries(bodyData).filter(([, node]) => node && typeof node === 'object');
	if (nodeEntries.length < 1) {
		return {
			buckets: [],
			diagnostics: {
				import_history_present: false,
				export_history_present: false,
				selected_import_channels: [],
				selected_export_channels: [],
				all_channels: [],
				nodes: [],
				warnings: ['Archive payload contains no data nodes for requested range.'],
			},
		};
	}

	const mergedByChannel = {};
	const allChannels = new Set();
	const nodeDiagnostics = [];

	for (const [nodeName, node] of nodeEntries) {
		const nodeData = node?.Data;
		if (!nodeData || typeof nodeData !== 'object') {
			continue;
		}

		const channelNames = Object.keys(nodeData);
		for (const channelName of channelNames) {
			allChannels.add(channelName);
		}

		for (const channelName of channelNames) {
			const series = nodeData?.[channelName];
			if (!series || typeof series !== 'object') {
				continue;
			}

			if (series.Unit !== undefined && series.Unit !== 'Wh') {
				continue;
			}

			const values = series?.Values && typeof series.Values === 'object' ? series.Values : {};
			if (!Object.prototype.hasOwnProperty.call(mergedByChannel, channelName)) {
				mergedByChannel[channelName] = {};
			}

			accumulateByOffset(mergedByChannel[channelName], values);
		}

		nodeDiagnostics.push({
			node: nodeName,
			channels: summarizeArchiveChannels(nodeData),
		});
	}

	const selectedImportSeries = pickArchiveSeries(mergedByChannel, ARCHIVE_IMPORT_CHANNEL_CANDIDATES);
	const selectedExportSeries = pickArchiveSeries(mergedByChannel, ARCHIVE_EXPORT_CHANNEL_CANDIDATES);

	const normalizedImportValues = normalizeArchiveSeries(
		selectedImportSeries ? mergedByChannel[selectedImportSeries.key] : {},
		selectedImportSeries?.kind || 'delta',
	);

	const normalizedExportValues = normalizeArchiveSeries(
		selectedExportSeries ? mergedByChannel[selectedExportSeries.key] : {},
		selectedExportSeries?.kind || 'delta',
	);

	const offsets = new Set([...Object.keys(normalizedImportValues), ...Object.keys(normalizedExportValues)]);
	const buckets = Array.from(offsets)
		.map((offsetKey) => {
			const offsetSeconds = Number.parseInt(offsetKey, 10);
			if (!Number.isInteger(offsetSeconds) || offsetSeconds < 0) {
				return null;
			}

			const importWh = safeNumber(normalizedImportValues[offsetKey], 0);
			const exportWh = safeNumber(normalizedExportValues[offsetKey], 0);

			return {
				offsetSeconds,
				importWh,
				exportWh,
			};
		})
		.filter((bucket) => bucket !== null)
		.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

	const importHistoryPresent = Boolean(selectedImportSeries?.key);
	const exportHistoryPresent = Boolean(selectedExportSeries?.key);
	const warnings = [];

	if (!importHistoryPresent) {
		warnings.push(
			'No historical import channel found in archive payload. Import history cannot be populated from archive for this range/device.',
		);
	}

	if (!exportHistoryPresent) {
		warnings.push('No historical export channel found in archive payload.');
	}

	return {
		buckets,
		diagnostics: {
			import_history_present: importHistoryPresent,
			export_history_present: exportHistoryPresent,
			selected_import_channels: selectedImportSeries
				? [{ key: selectedImportSeries.key, kind: selectedImportSeries.kind }]
				: [],
			selected_export_channels: selectedExportSeries
				? [{ key: selectedExportSeries.key, kind: selectedExportSeries.kind }]
				: [],
			all_channels: Array.from(allChannels).sort((a, b) => a.localeCompare(b)),
			nodes: nodeDiagnostics,
			warnings,
		},
	};
}

function pickArchiveSeries(channelMap, candidates) {
	for (const candidate of candidates) {
		const values = channelMap?.[candidate.key];
		if (!values || typeof values !== 'object') {
			continue;
		}

		return {
			key: candidate.key,
			kind: candidate.kind,
		};
	}

	return null;
}

function normalizeArchiveSeries(valuesByOffset, kind) {
	if (!valuesByOffset || typeof valuesByOffset !== 'object') {
		return {};
	}

	if (kind === 'absolute') {
		const sortedEntries = Object.entries(valuesByOffset)
			.map(([offsetKey, value]) => ({
				offset: Number.parseInt(offsetKey, 10),
				value: safeNumber(value, 0),
			}))
			.filter((entry) => Number.isInteger(entry.offset) && entry.offset >= 0)
			.sort((a, b) => a.offset - b.offset);

		const normalized = {};
		let previousValue = null;
		for (const entry of sortedEntries) {
			let delta = 0;
			if (previousValue !== null) {
				delta = entry.value - previousValue;
				if (!Number.isFinite(delta) || delta < 0) {
					delta = 0;
				}
			}

			normalized[String(entry.offset)] = delta;
			previousValue = entry.value;
		}

		return normalized;
	}

	const normalized = {};
	for (const [offsetKey, value] of Object.entries(valuesByOffset)) {
		normalized[offsetKey] = Math.max(0, safeNumber(value, 0));
	}

	return normalized;
}

function accumulateByOffset(target, values) {
	for (const [offsetKey, rawValue] of Object.entries(values || {})) {
		if (!Object.prototype.hasOwnProperty.call(target, offsetKey)) {
			target[offsetKey] = 0;
		}

		target[offsetKey] += safeNumber(rawValue, 0);
	}
}

function summarizeArchiveChannels(nodeData) {
	return Object.entries(nodeData).map(([channelName, series]) => {
		const unit = series?.Unit;
		const values = series?.Values && typeof series.Values === 'object' ? series.Values : {};
		const numericValues = Object.values(values).map((value) => safeNumber(value, 0));
		const nonZeroCount = numericValues.filter((value) => value > 0).length;
		const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : 0;
		const sample = Object.entries(values)
			.slice(0, 3)
			.map(([offsetSeconds, value]) => ({ offset_seconds: offsetSeconds, value: safeNumber(value, 0) }));

		return {
			channel: channelName,
			unit,
			value_count: numericValues.length,
			non_zero_count: nonZeroCount,
			max_value: maxValue,
			sample,
		};
	});
}

function parseFroniusPayload(payload) {
	const body = payload?.Body;
	const head = payload?.Head;
	const data = body?.Data;
	const site = data?.Site || {};

	const inverterMap = data?.Inverters || {};
	const inverter1Pv = inverterMap?.['1']?.P;
	const inverterPvSum = Object.values(inverterMap).reduce((sum, item) => {
		return sum + safeNumber(item?.P, 0);
	}, 0);

	const pvSource = [site.P_PV, inverter1Pv, data?.P_PV, inverterPvSum].find((value) => Number.isFinite(Number(value)));
	const loadSource = [site.P_Load, data?.P_Load].find((value) => Number.isFinite(Number(value)));
	const gridSource = [site.P_Grid].find((value) => Number.isFinite(Number(value)));

	const tsSource = head?.Timestamp || new Date().toISOString();
	const tsUtc = new Date(tsSource).toISOString();

	const pvW = Math.max(0, Math.round(safeNumber(pvSource, 0)));
	// Some Fronius payloads report load as negative by convention; use absolute watts for household consumption.
	const loadW = Math.max(0, Math.round(Math.abs(safeNumber(loadSource, 0))));

	const gridNetW = gridSource !== undefined
		? Math.round(safeNumber(gridSource, 0))
		: Math.round(loadW - pvW);

	const gridImportW = Math.max(0, gridNetW);
	const gridExportW = Math.max(0, -gridNetW);

	return {
		ts_utc: tsUtc,
		pv_w: pvW,
		load_w: loadW,
		grid_import_w: gridImportW,
		grid_export_w: gridExportW,
	};
}

function safeNumber(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function getDataWarning(reading, consecutiveZeroLoadWithPv) {
	if (consecutiveZeroLoadWithPv > 5) {
		return 'pv_w > 0 and load_w === 0 for more than 5 consecutive polls';
	}

	if (reading.load_w > reading.pv_w && reading.grid_export_w > 0) {
		return 'load_w > pv_w and grid_export_w > 0';
	}

	if (reading.grid_import_w > 0 && reading.grid_export_w > 0) {
		return 'grid_import_w > 0 and grid_export_w > 0';
	}

	return null;
}

function recomputeDailyAggForRange(database, prepared, fromIsoUtc, toIsoUtc) {
	const fromDay = fromIsoUtc.slice(0, 10);
	const toDay = toIsoUtc.slice(0, 10);
	const days = enumerateDays(fromDay, toDay);

	const tx = database.transaction((dayList) => {
		for (const day of dayList) {
			const dayStart = `${day}T00:00:00.000Z`;
			const nextDay = addDaysIso(day, 1);
			const dayEnd = `${nextDay}T00:00:00.000Z`;
			const rows = prepared.getReadingsForDay.all(dayStart, dayEnd);
			const agg = computeEnergyAggForRows(rows);
			prepared.upsertDailyAgg.run({ day, ...agg });
		}
	});

	tx(days);
}

function computeEnergyAggForRows(rows) {
	if (!rows || rows.length < 2) {
		return {
			pv_kwh: 0,
			load_kwh: 0,
			import_kwh: 0,
			export_kwh: 0,
			self_kwh: 0,
		};
	}

	let pvWh = 0;
	let loadWh = 0;
	let importWh = 0;
	let exportWh = 0;
	let selfWh = 0;

	for (let index = 0; index < rows.length - 1; index += 1) {
		const current = rows[index];
		const next = rows[index + 1];

		const t1 = Date.parse(current.ts_utc);
		const t2 = Date.parse(next.ts_utc);
		if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 <= t1) {
			continue;
		}

		const hours = (t2 - t1) / 3600000;

		const pvAvg = (current.pv_w + next.pv_w) / 2;
		const loadAvg = (current.load_w + next.load_w) / 2;
		const importAvg = (current.grid_import_w + next.grid_import_w) / 2;
		const exportAvg = (current.grid_export_w + next.grid_export_w) / 2;
		const selfAvg = Math.max(0, loadAvg - importAvg);

		pvWh += pvAvg * hours;
		loadWh += loadAvg * hours;
		importWh += importAvg * hours;
		exportWh += exportAvg * hours;
		selfWh += selfAvg * hours;
	}

	return {
		pv_kwh: round3(pvWh / 1000),
		load_kwh: round3(loadWh / 1000),
		import_kwh: round3(importWh / 1000),
		export_kwh: round3(exportWh / 1000),
		self_kwh: round3(selfWh / 1000),
	};
}

function round3(value) {
	return Math.round(value * 1000) / 1000;
}

function enumerateDays(fromDay, toDay) {
	const list = [];
	let cursor = fromDay;
	while (cursor <= toDay) {
		list.push(cursor);
		cursor = addDaysIso(cursor, 1);
	}
	return list;
}

function addDaysIso(day, daysToAdd) {
	const date = new Date(`${day}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + daysToAdd);
	return date.toISOString().slice(0, 10);
}
