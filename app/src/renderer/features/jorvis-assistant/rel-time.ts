const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function rel(ts: number): string {
  const diffMs = ts - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < hour) return RELATIVE.format(Math.round(diffMs / minute), 'minute');
  if (abs < day) return RELATIVE.format(Math.round(diffMs / hour), 'hour');
  if (abs < 14 * day) return RELATIVE.format(Math.round(diffMs / day), 'day');
  return new Date(ts).toLocaleDateString();
}
