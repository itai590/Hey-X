const displayTimeZone =
  (import.meta.env.VITE_TZ || 'UTC').trim() || 'UTC';

function partsFromDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: displayTimeZone,
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
}

function partValue(parts, type) {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** Drop Intl leading zeros so logs show 2/5/… not 02/05/… (still numeric month, never "May"). */
function dayOrMonthNumeric(parts, type) {
  const raw = partValue(parts, type);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? String(n) : raw;
}

/** Current/specified time as d/m/yyyy, HH:MM:SS (24h), for console prefixes. */
export function formatConsoleTimestamp(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '?';
  const parts = partsFromDate(date);
  const val = (type) => partValue(parts, type);
  const day = dayOrMonthNumeric(parts, 'day');
  const month = dayOrMonthNumeric(parts, 'month');
  return `${day}/${month}/${val('year')}, ${val('hour')}:${val('minute')}:${val('second')}`;
}

/** Bark list: same rules as formatConsoleTimestamp, from an ISO string. */
export function formatBarkTimestamp(isoStr) {
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return String(isoStr ?? '');
  return formatConsoleTimestamp(date);
}
