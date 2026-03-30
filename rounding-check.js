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
    if (!start.isValid || !end.isValid) continue;

    if (!minStart || start < minStart) minStart = start;
    if (!maxEnd || end > maxEnd) maxEnd = end;

    const key = end.toISO({ suppressMilliseconds: true });
    csvMap.set(key, Number(cols[12] || 0));
  }

  const from = minStart.toUTC().minus({ minutes: 30 }).toISO();
  const to = maxEnd.toUTC().toISO();
  const url = 'http://localhost:8080/api/energy5m?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);

  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error('API error: ' + response.status + ' ' + JSON.stringify(payload));

  const invMap = new Map();
  for (const row of payload.data || []) {
    const local = DateTime.fromISO(row.ts_utc, { zone: 'utc' }).setZone(tz);
    if (!local.isValid) continue;

    const minuteMod = local.minute % 30;
    const add = minuteMod === 0 ? 0 : 30 - minuteMod;
    const endLocal = local.plus({ minutes: add }).set({ second: 0, millisecond: 0 });
    const key = endLocal.toISO({ suppressMilliseconds: true });

    invMap.set(key, (invMap.get(key) || 0) + Number(row.import_kwh || 0));
  }

  let overlap = 0;
  let sumCsv = 0;
  let sumInvExact = 0;
  let sumInvRounded2dp = 0;
  let sumDiffExact = 0;
  let sumDiffRounded = 0;
  let pos = 0;
  let neg = 0;
  let zero = 0;

  const byWindow = {
    free_21_24: {
      exact_delta: 0,
      rounded_delta: 0,
      overlap: 0,
    },
    other_hours: {
      exact_delta: 0,
      rounded_delta: 0,
      overlap: 0,
    },
  };

  for (const [key, csvVal] of csvMap) {
    const inv = invMap.get(key);
    if (inv === undefined) continue;
    overlap += 1;

    const invRounded2 = Math.round(inv * 100) / 100;
    const dExact = inv - csvVal;
    const dRounded = invRounded2 - csvVal;

    const hour = DateTime.fromISO(key, { zone: tz }).hour;
    const bucket = hour >= 21 && hour < 24 ? byWindow.free_21_24 : byWindow.other_hours;
    bucket.exact_delta += dExact;
    bucket.rounded_delta += dRounded;
    bucket.overlap += 1;

    sumCsv += csvVal;
    sumInvExact += inv;
    sumInvRounded2dp += invRounded2;
    sumDiffExact += dExact;
    sumDiffRounded += dRounded;

    if (dRounded > 0.000001) pos += 1;
    else if (dRounded < -0.000001) neg += 1;
    else zero += 1;
  }

  const round = (n) => Math.round(n * 1000000) / 1000000;

  console.log(
    JSON.stringify(
      {
        overlap_intervals: overlap,
        csv_sum_kwh: round(sumCsv),
        inverter_sum_exact_kwh: round(sumInvExact),
        inverter_sum_if_rounded_each_interval_2dp_kwh: round(sumInvRounded2dp),
        delta_exact_kwh: round(sumDiffExact),
        delta_if_2dp_rounding_kwh: round(sumDiffRounded),
        rounding_component_kwh: round(sumInvExact - sumInvRounded2dp),
        rounded_interval_signs: {
          positive: pos,
          negative: neg,
          zero: zero,
        },
        by_window: {
          free_21_24: {
            overlap_intervals: byWindow.free_21_24.overlap,
            exact_delta_kwh: round(byWindow.free_21_24.exact_delta),
            delta_if_2dp_rounding_kwh: round(byWindow.free_21_24.rounded_delta),
          },
          other_hours: {
            overlap_intervals: byWindow.other_hours.overlap,
            exact_delta_kwh: round(byWindow.other_hours.exact_delta),
            delta_if_2dp_rounding_kwh: round(byWindow.other_hours.rounded_delta),
          },
        },
        theoretical_max_abs_rounding_kwh: round(overlap * 0.005),
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
