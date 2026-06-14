// Transport facet — TEMPLATE. Copy to "<name>.js" and implement. Owns the on-the-wire mechanics:
// message framing, how to open a listener, how to dial a peer, and the page-leaf WS ingress. Swap this
// to change transport (e.g. TLS, a message queue) without touching mesh logic. (Default: TCP + ws.)
//
// Interface:
//   frame.send(sock, obj) -> void           serialize + write one framed message
//   frame.onFrames(sock, cb) -> void        parse the stream, call cb(obj) per message
//   createServer(onConnection) -> server          a listener (caller calls server.listen(port, host, cb))
//   connect(port, host) -> socket                 an outbound connection (caller adds handlers)
//   createHttpServer(handler) -> httpServer       serves the dashboard (caller calls .listen)
//   createWsServer({host,port} | {server}) -> wss the WS leaf-ingress; pass {server} to share a port
export const meta = { facet: 'transport', name: 'template' }
export function create(ctx) {
  return {
    frame: {
      send(sock, obj) { throw new Error('transport.frame.send not implemented') },
      onFrames(sock, cb) { throw new Error('transport.frame.onFrames not implemented') },
    },
    createServer(onConnection) { throw new Error('transport.createServer not implemented') },
    connect(port, host) { throw new Error('transport.connect not implemented') },
    createHttpServer(handler) { throw new Error('transport.createHttpServer not implemented') },
    createWsServer(opts) { throw new Error('transport.createWsServer not implemented') },
  }
}
