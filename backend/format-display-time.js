const displayTimeZone = require('./display-timezone');

/**
 * d/m/y (no leading zeros on date parts), HH:MM:SS (24h), DISPLAY_TIME_ZONE / TZ.
 * @param {Date|string|number} input
 * @param {{ shortYear?: boolean }} [options]
 */
function formatDisplayDateTime(input = new Date(), options = {}) {
  const { shortYear = false } = options;
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);

  const tz = displayTimeZone();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'numeric',
    year: shortYear ? '2-digit' : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const val = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const dm = (type) => {
    const raw = val(type);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? String(n) : raw;
  };
  return `${dm('day')}/${dm('month')}/${val('year')}, ${val('hour')}:${val('minute')}:${val('second')}`;
}

module.exports = { formatDisplayDateTime };
