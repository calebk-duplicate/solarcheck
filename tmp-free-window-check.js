const fs = require(''fs'');
const { DateTime } = require(''luxon'');

(async () => {
  const tz = ''Pacific/Auckland'';
  const csvPath = ''d:/Source/solarcheck/CTCT_E_CUST_ICPCONS_202603_20260302_0000034034WE3F920260302144547.CSV'';
  const text = fs.readFileSync(csvPath, ''utf8'');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const detRows = lines.filter((l) => l.startsWith(''DET,''));

  const csvMap = new Map();
  let minStart = null;
  let maxEnd = null;

  for (const line of detRows) {
    const c = line.split('','');
    if (c.length < 14) continue;
    const start = DateTime.fromFormat(c[9], ''dd/LL/yyyy HH:mm:ss'', { zone: tz });
    const end = DateTime.fromFormat(c[10], ''dd/LL/yyyy HH:mm:ss'', { zone: tz });
    if (!start.isValid || !end.isValid) continue;
    const importKwh = Number(c[12] || 0);
    const exportKwh = Number(c[13] || 0);
    const key = end.toISO({ suppressMilliseconds: true });
    csvMap.set(key, { import_kwh: importKwh, export_kwh: exportKwh, endLocal: end });
    if (!minStart || start < minStart) minStart = start;
    if (!maxEnd || end > maxEnd) maxEnd = end;
  }

  const from = minStart.toUTC().minus({ minutes: 30 }).toISO();
  const to = maxEnd.toUTC().toISO();
  const url = ''http://localhost:8080/api/energy5m?from='' + encodeURIComponent(from) + ''&to='' + encodeURIComponent(to);
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(''API error: '' + response.status);

  const invMap = new Map();
  for (const row of payload.data || []) {
    const local = DateTime.fromISO(row.ts_utc, { zone: ''utc'' }).setZone(tz);
    if (!local.isValid) continue;
    const minuteMod = local.minute % 30;
    const add = minuteMod === 0 ? 0 : 30 - minuteMod;
    const endLocal = local.plus({ minutes: add }).set({ second: 0, millisecond: 0 });
    const key = endLocal.toISO({ suppressMilliseconds: true });
    const cur = invMap.get(key) || { import_kwh: 0, export_kwh: 0 };
    cur.import_kwh += Number(row.import_kwh || 0);
    cur.export_kwh += Number(row.export_kwh || 0);
    invMap.set(key, cur);
  }

  const stats = {
    free_21_24: { overlap: 0, csvImport: 0, invImport: 0, delta: 0 },
    other_hours: { overlap: 0, csvImport: 0, invImport: 0, delta: 0 },
  };

  for (const [key, csv] of csvMap) {
    const inv = invMap.get(key);
    if (!inv) continue;
    const h = csv.endLocal.hour;
    const bucket = (h >= 21 && h < 24) ? stats.free_21_24 : stats.other_hours;
    bucket.overlap += 1;
    bucket.csvImport += csv.import_kwh || 0;
    bucket.invImport += inv.import_kwh || 0;
    bucket.delta += (inv.import_kwh || 0) - (csv.import_kwh || 0);
  }

  const totalDelta = stats.free_21_24.delta + stats.other_hours.delta;
  const pctFree = totalDelta ? (stats.free_21_24.delta / totalDelta) * 100 : 0;

  const round = (n) => Math.round(n * 10000) / 10000;
  console.log(JSON.stringify({
    free_21_24: {
      overlap_intervals: stats.free_21_24.overlap,
      csv_import_kwh: round(stats.free_21_24.csvImport),
      inverter_import_kwh: round(stats.free_21_24.invImport),
      delta_kwh: round(stats.free_21_24.delta),
    },
    other_hours: {
      overlap_intervals: stats.other_hours.overlap,
      csv_import_kwh: round(stats.other_hours.csvImport),
      inverter_import_kwh: round(stats.other_hours.invImport),
      delta_kwh: round(stats.other_hours.delta),
    },
    total_delta_kwh: round(totalDelta),
    free_window_share_of_delta_pct: round(pctFree),
  }, null, 2));
})();
