const fs = require('fs');
const { DateTime } = require('luxon');

async function main() {
  const tz = 'Pacific/Auckland';
  const csvPath = 'd:/Source/solarcheck/CTCT_E_CUST_ICPCONS_202603_20260302_0000034034WE3F920260302144547.CSV';

  const janStartLocal = DateTime.fromISO('2026-01-01T00:00:00', { zone: tz });
  const febStartLocal = DateTime.fromISO('2026-02-01T00:00:00', { zone: tz });

  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const detRows = lines.filter((line) => line.startsWith('DET,'));

  let csvImport = 0;
  let csvExport = 0;
  let csvCount = 0;

  for (const line of detRows) {
    const cols = line.split(',');
    if (cols.length < 14) continue;

    const end = DateTime.fromFormat(cols[10], 'dd/LL/yyyy HH:mm:ss', { zone: tz });
    if (!end.isValid) continue;

    if (end >= janStartLocal && end < febStartLocal) {
      csvImport += Number(cols[12] || 0);
      csvExport += Number(cols[13] || 0);
      csvCount += 1;
    }
  }

  const fromUtc = janStartLocal.toUTC().toISO();
  const toUtc = febStartLocal.toUTC().toISO();
  const url = 'http://localhost:8080/api/energy5m?from=' + encodeURIComponent(fromUtc) + '&to=' + encodeURIComponent(toUtc);

  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error('API error: ' + response.status + ' ' + JSON.stringify(payload));
  }

  let invImport = 0;
  let invExport = 0;
  let invCount5m = 0;
  let invFirstLocal = null;
  let invLastLocal = null;

  for (const row of payload.data || []) {
    invImport += Number(row.import_kwh || 0);
    invExport += Number(row.export_kwh || 0);
    invCount5m += 1;

    const tsLocal = DateTime.fromISO(row.ts_utc, { zone: 'utc' }).setZone(tz);
    if (tsLocal.isValid) {
      if (!invFirstLocal || tsLocal < invFirstLocal) invFirstLocal = tsLocal;
      if (!invLastLocal || tsLocal > invLastLocal) invLastLocal = tsLocal;
    }
  }

  const round = (n) => Math.round(n * 10000) / 10000;

  console.log(
    JSON.stringify(
      {
        period_local: {
          from: janStartLocal.toISO({ suppressMilliseconds: true }),
          to_exclusive: febStartLocal.toISO({ suppressMilliseconds: true }),
        },
        csv: {
          interval_count_30m: csvCount,
          import_kwh: round(csvImport),
          export_kwh: round(csvExport),
        },
        inverter: {
          interval_count_5m: invCount5m,
          import_kwh: round(invImport),
          export_kwh: round(invExport),
          first_record_local: invFirstLocal ? invFirstLocal.toISO({ suppressMilliseconds: true }) : null,
          last_record_local: invLastLocal ? invLastLocal.toISO({ suppressMilliseconds: true }) : null,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
