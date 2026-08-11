/**
 * Flexible duration parser for polls & giveaways.
 * Returns milliseconds.
 *
 * Supported:
 *   30s, 5m, 2h, 1d, 1w, 2mo, 1y
 *   combinations: 1d12h, 2h30m, 1w2d
 *   1:30  → 1 minute 30 seconds
 *   bare number → minutes (legacy)
 */
export function parseFlexibleDuration(str, { minMs = 10_000, maxMs = 365 * 86_400_000 } = {}) {
  const raw = String(str || '').trim().toLowerCase();
  if (!raw) throw new Error('Duration is required');

  const colon = raw.match(/^(\d+)\s*:\s*(\d+)$/);
  if (colon) {
    const ms = (parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10)) * 1000;
    if (ms < minMs) throw new Error('Minimum duration is 10 seconds');
    if (ms > maxMs) throw new Error('Duration is too long');
    return ms;
  }

  if (/^\d+$/.test(raw)) {
    const ms = parseInt(raw, 10) * 60_000;
    if (ms < minMs) throw new Error('Minimum duration is 10 seconds');
    if (ms > maxMs) throw new Error('Duration is too long');
    return ms;
  }

  const unitMs = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 7 * 86_400_000, wk: 7 * 86_400_000, week: 7 * 86_400_000, weeks: 7 * 86_400_000,
    mo: 30 * 86_400_000, mon: 30 * 86_400_000, month: 30 * 86_400_000, months: 30 * 86_400_000,
    y: 365 * 86_400_000, yr: 365 * 86_400_000, year: 365 * 86_400_000, years: 365 * 86_400_000,
  };

  let total = 0;
  let matched = false;
  const re = /(\d+)\s*([a-z]+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = parseInt(m[1], 10);
    const u = m[2];
    const mult = unitMs[u];
    if (!mult) throw new Error(`Unknown unit "${u}". Use s, m, h, d, w, mo, y`);
    total += n * mult;
    matched = true;
  }

  if (!matched) {
    throw new Error('Use duration like 30m, 2h, 1d, 1w, 2mo, 1y (or 1d12h)');
  }
  if (total < minMs) throw new Error('Minimum duration is 10 seconds');
  if (total > maxMs) throw new Error(`Maximum duration is ${Math.floor(maxMs / 86_400_000)} days`);
  return total;
}

export function parseFlexibleDurationSeconds(str, opts) {
  return Math.floor(parseFlexibleDuration(str, opts) / 1000);
}
