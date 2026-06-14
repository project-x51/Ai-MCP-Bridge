// Transport — TCP + WebSocket leaves (default). Length-prefixed (uint32 BE) JSON frames over TCP for
// the bridge mesh; a ws server for page leaves. A TLS profile would swap net->tls here and nothing else.
import net from 'node:net'
import http from 'node:http'
import { WebSocketServer } from 'ws'
export const meta = { facet: 'transport', name: 'tcp' }
export function create(ctx) {
  function send(sock, obj) {
    try {
      const body = Buffer.from(JSON.stringify(obj), 'utf8')
      const head = Buffer.alloc(4); head.writeUInt32BE(body.length)
      sock.write(Buffer.concat([head, body]))
    } catch {}
  }
  function onFrames(sock, cb) {
    let buf = Buffer.alloc(0)
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (len > 8 * 1024 * 1024) { sock.destroy(); return }
        if (buf.length < 4 + len) break
        let obj = null
        try { obj = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) } catch {}
        buf = buf.subarray(4 + len)
        if (obj) cb(obj)
      }
    })
  }
  return {
    frame: { send, onFrames },
    createServer(onConnection) { return net.createServer(onConnection) },
    connect(port, host) { return net.connect(port, host) },
    createHttpServer(handler) { return http.createServer(handler) },
    // attach to an existing http server (opts.server) so HTTP + WS share a port, else listen standalone
    createWsServer(opts) { return new WebSocketServer(opts.server ? { server: opts.server } : opts) },
  }
}
