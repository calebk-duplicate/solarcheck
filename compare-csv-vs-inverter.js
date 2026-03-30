const fs = require('fs');
const { DateTime } = require('luxon');

async function main() {
  const tz = 'Pacific/Auckland';
  const csvPath = 'd:/Source/solarcheck/CTCT_E_CUST_ICPCONS_202603_20260302_0000034034WE3F920260302144547.CSV';

  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const detRows = lines.filter((line) => line.startsWith('DET,'));

  const csvMap = new Map();
  let minStart = null;
  let maxEnd = null;

  for (const line of detRows) {
    const cols = line.split(',');
    if (cols.length < 14) continue;

    const start = DateTime.fromFormat(cols[9], 'dd/LL/yyyy HH:mm:ss', { zone: tz });
    const end = DateTime.fromFormat(cols[10], 'dd/LL/yyyy HH:mm:ss', { zone: tz });
    const importKwh = Number(cols[12] || 0);
    const exportKwh = Number(cols[13] || 0);

    if (!start.isValid || !end.isValid) continue;

    if (!minStart || start < minStart) minStart = start;
    if (!maxEnd || end > maxEnd) maxEnd = end;

    const key = end.toISO({ suppressMilliseconds: true });
    csvMap.set(key, { import_kwh: importKwh, export_kwh: exportKwh, endLocal: end });
  }

  if (!minStart || !maxEnd) throw new Error('No DET rows parsed from CSV');

  const from = minStart.toUTC().minus({ minutes: 30 }).toISO();
  const to = maxEnd.toUTC().toISO();
  const url = 'http://localhost:8080/api/energy5m?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);

  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error('API error: ' + response.status + ' ' + JSON.stringify(payload));

  const inverterMap = new Map();

  for (const row of payload.data || []) {
    const local = DateTime.fromISO(row.ts_utc, { zone: 'utc' }).setZone(tz);
    if (!local.isValid) continue;

    const minuteMod = local.minute % 30;
    const minutesToEnd = minuteMod === 0 ? 0 : 30 - minuteMod;
    const intervalEndLocal = local.plus({ minutes: minutesToEnd }).set({ second: 0, millisecond: 0 });

    const key = intervalEndLocal.toISO({ suppressMilliseconds: true });
    const current = inverterMap.get(key) || { import_kwh: 0, export_kwh: 0 };
    current.import_kwh += Number(row.import_kwh || 0);
    current.export_kwh += Number(row.export_kwh || 0);
    inverterMap.set(key, current);
  }

  const round = (value) => Math.round(value * 10000) / 10000;
  let overlap = 0;
  let csvOnly = 0;
  let inverterOnly = 0;
  let overlapMin = null;
  let overlapMax = null;

  let sumCsvImport = 0;
  let sumInvImport = 0;
  let sumAbsImportErr = 0;
  let maxAbsImportErr = 0;

  let sumCsvExport = 0;
  let sumInvExport = 0;
  let sumAbsExportErr = 0;
  let maxAbsExportErr = 0;

  const importDeltaByWindow = {
    free_21_24_kwh: 0,
    other_hours_kwh: 0,
  };

  const worstImport = [];

  for (const [key, csv] of csvMap) {
    const inv = inverterMap.get(key);
    if (!inv) {
      csvOnly += 1;
      continue;
    }

    overlap += 1;
    if (!overlapMin || key < overlapMin) overlapMin = key;
    if (!overlapMax || key > overlapMax) overlapMax = key;
    const importDiff = Math.abs((csv.import_kwh || 0) - (inv.import_kwh || 0));
    const exportDiff = Math.abs((csv.export_kwh || 0) - (inv.export_kwh || 0));
    const signedImportDelta = (inv.import_kwh || 0) - (csv.import_kwh || 0);
    const endHour = csv.endLocal.hour;
    if (endHour >= 21 && endHour < 24) {
      importDeltaByWindow.free_21_24_kwh += signedImportDelta;
    } else {
      importDeltaByWindow.other_hours_kwh += signedImportDelta;
    }

    sumCsvImport += csv.import_kwh || 0;
    sumInvImport += inv.import_kwh || 0;
    sumAbsImportErr += importDiff;
    if (importDiff > maxAbsImportErr) maxAbsImportErr = importDiff;

    sumCsvExport += csv.export_kwh || 0;
    sumInvExport += inv.export_kwh || 0;
    sumAbsExportErr += exportDiff;
    if (exportDiff > maxAbsExportErr) maxAbsExportErr = exportDiff;

    if (worstImport.length < 10 || importDiff > worstImport[worstImport.length - 1].abs_import_diff) {
      worstImport.push({
        interval_end_local: key,
        csv_import: round(csv.import_kwh || 0),
        inverter_import: round(inv.import_kwh || 0),
        abs_import_diff: round(importDiff),
      });
      worstImport.sort((a, b) => b.abs_import_diff - a.abs_import_diff);
      if (worstImport.length > 10) worstImport.pop();
    }
  }

  for (const key of inverterMap.keys()) {
    if (!csvMap.has(key)) inverterOnly += 1;
  }

  const result = {
    csv_range_local: {
      from: minStart.toISO({ suppressMilliseconds: true }),
      to: maxEnd.toISO({ suppressMilliseconds: true }),
    },
    overlap_range_local: overlap > 0 ? { from: overlapMin, to: overlapMax } : null,
    csv_intervals: csvMap.size,
    inverter_intervals_30m: inverterMap.size,
    overlap_intervals: overlap,
    csv_only_intervals: csvOnly,
    inverter_only_intervals: inverterOnly,
    import_totals_kwh: {
      csv: round(sumCsvImport),
      inverter: round(sumInvImport),
      delta: round(sumInvImport - sumCsvImport),
      delta_pct: sumCsvImport ? round(((sumInvImport - sumCsvImport) / sumCsvImport) * 100) : null,
    },
    export_totals_kwh: {
      csv: round(sumCsvExport),
      inverter: round(sumInvExport),
      delta: round(sumInvExport - sumCsvExport),
      delta_pct: sumCsvExport ? round(((sumInvExport - sumCsvExport) / sumCsvExport) * 100) : null,
    },
    import_interval_error_kwh: {
      mae: overlap ? round(sumAbsImportErr / overlap) : null,
      max: round(maxAbsImportErr),
    },
    import_delta_by_window_kwh: {
      free_21_24: round(importDeltaByWindow.free_21_24_kwh),
      other_hours: round(importDeltaByWindow.other_hours_kwh),
      free_window_share_pct:
        sumInvImport - sumCsvImport
          ? round((importDeltaByWindow.free_21_24_kwh / (sumInvImport - sumCsvImport)) * 100)
          : null,
    },
    export_interval_error_kwh: {
      mae: overlap ? round(sumAbsExportErr / overlap) : null,
      max: round(maxAbsExportErr),
    },
    sample_worst_import_intervals: worstImport,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
