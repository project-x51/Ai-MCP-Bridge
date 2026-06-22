// Trace collector (the observation plane) as an encapsulated module that OWNS the recent-traces ring buffer
// and fans new traces out to the watching dashboards. The gateway funnels every trace here via collect();
// a dashboard that connects late is caught up with history(). The EMIT side — deciding gateway-collect vs
// forward-to-gateway, and building a trace from an envelope (which reads mesh state for display names) —
// stays in bridge.mjs; only the buffer + fan-out (the owned state) live here.

/** @param {{ broadcast: (msg: string) => void, cap?: number }} ctx — broadcast sends a JSON string to every dashboard sink. */
export function createTraces({ broadcast, cap = 200 }) {
  const ring = []   // recent traces, capped — replayed to a late-joining dashboard
  return {
    /** Append a trace and push it live to the dashboards. */
    collect(trace) {
      ring.push(trace); if (ring.length > cap) ring.shift()
      broadcast(JSON.stringify({ type: 'trace', trace }))
    },
    /** A snapshot of the recent traces (for the trace_history sent on dashboard connect). */
    history() { return ring.slice() },
  }
}
