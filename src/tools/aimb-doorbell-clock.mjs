// Doorbell clock helpers (#67 hourly chime, #69 6-hour inbox check-in) — pure functions, no I/O, so the
// boundary / label / check-in-mark maths is unit-testable without waiting for a real hour to pass.
// Imported by tools/aimb-doorbell.mjs (keep the two files side by side) and by tests/doorbell/test_doorbell_live.mjs.

// #67: the next chime boundary, strictly after `now` — the top of the next LOCAL hour (setHours handles DST and
// non-whole-hour offsets), or with a test period the next multiple of periodSec on the local clock.
export function nextBoundary(now = Date.now(), periodSec = 3600) {
  if (periodSec === 3600) { const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d.getTime() }
  const offMs = -new Date(now).getTimezoneOffset() * 60000, p = periodSec * 1000
  return (Math.floor((now + offMs) / p) + 1) * p - offMs
}

// the boundary's local wall time — "14:00" (with :SS only when a test period lands off the minute); midnight = "00:00"
export function hhmm(ms) {
  const d = new Date(ms), pad = n => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}` + (d.getSeconds() ? `:${pad(d.getSeconds())}` : '')
}

// #69: is this chime boundary a check-in mark? Judged from the BOUNDARY's own local wall time (never Date.now(),
// which can sit a few ms either side of it): the boundary's seconds since local midnight must be divisible by
// every × periodSec. With the real 1-hour period and every = 6 that is local hour % 6 === 0, i.e. 00:00, 06:00,
// 12:00 and 18:00. A test period p lands the check-in on every `every`-th multiple of p since local midnight.
export function isCheckinMark(boundaryMs, periodSec = 3600, every = 6) {
  const d = new Date(boundaryMs)
  const secOfDay = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
  return secOfDay % (periodSec * every) === 0
}
