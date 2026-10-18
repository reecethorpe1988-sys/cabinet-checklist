// time.js — posting slots in the owner's time zone (handles daylight saving).

// Minutes the time zone is ahead of UTC at a given instant, e.g. +660 for AEDT.
export function offsetMinutes(date, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName').value; // "GMT+11:00" or "GMT"
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

// "YYYY-MM-DD" for an instant, in the given time zone.
export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function localDateTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

// The instant at which it is `hhmm` on `ymd` in the time zone.
export function zonedTime(ymd, hhmm, timeZone) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  // Re-check with the offset at the candidate instant (matters on DST change days).
  return new Date(guess - offsetMinutes(new Date(first), timeZone) * 60_000);
}

// The next `count` posting slots after `now` (at least 15 minutes away).
export function upcomingSlots({ now = new Date(), timeZone, slots, count = 6, days = 14 }) {
  const out = [];
  for (let i = 0; i <= days && out.length < count; i++) {
    const ymd = localDate(new Date(now.getTime() + i * 86400_000), timeZone);
    for (const s of slots) {
      const t = zonedTime(ymd, s, timeZone);
      if (t - now >= 15 * 60_000 && !out.some((x) => x.getTime() === t.getTime())) out.push(t);
      if (out.length >= count) break;
    }
  }
  return out.sort((a, b) => a - b);
}
