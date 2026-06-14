// aimb-page-bridge.js — leaf client for static web pages.
// Embedded by renderers with: window.AIMB_BRIDGE_CFG = {wsUrl, token, pageKind, title, subject, subscribe, icon}
//   subject (Topics amendment T12): the page's topic path, e.g. "retail/contact-energy" — the
//   gateway auto-claims it (shared) AND auto-subscribes the leaf. subscribe: optional array of
//   extra topic patterns ("retail/#") the page wants events from. icon: optional markdown icon.
//   project / user: this page's mandatory classification. seeAll: opt out of visibility filtering
//   (default false ⇒ the roster is filtered to the projects this page may reach; true ⇒ see all).
// API: aimbBridge.onUpdate(cb) -> cb({status, sessions, pages, topics});
//      aimbBridge.send({to, subject, verb, body}) -> Promise(ack); to may be a session/sub-peer id,
//      "page:<instance>", or "topic:<topic>" (delivered to the topic OWNERS only). subject REQUIRED.
//      aimbBridge.publish({topic, subject, verb, body}) -> Promise(ack) — event to ALL subscribers.
//      aimbBridge.onMessage(cb) -> cb(envelope) for inbound envelopes ({from, verb, subject, body, id, ...})
window.aimbBridge = (function () {
  var cfg = window.AIMB_BRIDGE_CFG || {};
  var ws = null, status = 'offline', sessions = [], pages = [], topics = [], cbs = [], msgCbs = [], pending = {}, refN = 1, backoff = 1000;
  var instance = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : String(Math.random()).slice(2, 10);
  function notify() { cbs.forEach(function (cb) { try { cb({ status: status, sessions: sessions, pages: pages, topics: topics }); } catch (e) {} }); }
  function connect() {
    try { ws = new WebSocket(cfg.wsUrl || 'ws://127.0.0.1:7001'); } catch (e) { retry(); return; }
    ws.onopen = function () {
      ws.send(JSON.stringify({ type: 'hello', kind: 'page', page_kind: cfg.pageKind || 'page',
        title: cfg.title || document.title, subject: cfg.subject || '', subscribe: cfg.subscribe || [],
        icon: cfg.icon || '', project: cfg.project || '', user: cfg.user || '',
        seeAll: cfg.seeAll === true,            /* visibility: default false = roster filtered to reachable projects */
        instance: instance, token: cfg.token || '' }));
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'welcome' || m.type === 'roster') {
        status = 'connected'; backoff = 1000;
        // Named conversations only:
        //  - a process with sub-peers (shared Cowork bridge) is represented BY its sub-peers;
        //  - a process without sub-peers appears only if it carries a human-given name
        //    (set_name / AI_BRIDGE_NAME), never under its default hex session id.
        sessions = []; pages = []; topics = [];
        (m.sessions || []).forEach(function (s) {
          if (s.kind !== 'session') return;
          var sps = s.subpeers || [];
          if (sps.length) sps.forEach(function (sp) {
            sessions.push({ session: sp.id, name: sp.name || sp.id, kind: 'subpeer', parent: s.session, client_kind: sp.client_kind || null,
              project: sp.project || null, user: sp.user || null, realm: sp.realm || null });
          });
          else if (s.name && s.name !== s.session && s.name !== String(s.session).split('/').pop()) sessions.push(s);
          (s.topics || []).forEach(function (r) {
            if (r.role !== 'owner') return;             /* dropdown targets owners; subscriptions are not addresses */
            topics.push({ topic: r.pattern, description: r.description || '', exclusive: !!r.exclusive,
              icon: r.icon || '', holder: r.holder, holder_name: r.holder_name || '', source: 'ai' });
          });
        });
        (m.pages || []).forEach(function (p) {
          if (p.instance === instance) return;                      /* not ourselves */
          pages.push({ instance: p.instance, page_kind: p.page_kind, title: p.title || p.page_kind, subject: p.subject || '' });
          if (p.subject) topics.push({ topic: p.subject, description: 'Page: ' + (p.title || p.page_kind), exclusive: false,
            icon: p.icon || '', holder: 'page:' + p.instance, holder_name: p.title || p.page_kind, source: 'browser' });
        });
        notify();
      } else if (m.type === 'sent' && pending[m.ref]) { pending[m.ref](m); delete pending[m.ref]; }
      else if (m.type === 'envelope' && m.envelope) { msgCbs.forEach(function (cb) { try { cb(m.envelope); } catch (e) {} }); }
    };
    ws.onclose = function () { status = 'offline'; sessions = []; notify(); retry(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function retry() { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); }
  connect();
  function wsCall(payload) {
    return new Promise(function (resolve, reject) {
      if (!ws || ws.readyState !== 1) { reject(new Error('bridge offline')); return; }
      if (!payload.subject || !String(payload.subject).trim()) { reject(new Error('subject required')); return; }
      var ref = 'r' + (refN++);
      pending[ref] = resolve;
      payload.ref = ref; payload.page_kind = cfg.pageKind;
      ws.send(JSON.stringify(payload));
      setTimeout(function () { if (pending[ref]) { delete pending[ref]; reject(new Error('ack timeout')); } }, 5000);
    });
  }
  return {
    onUpdate: function (cb) { cbs.push(cb); cb({ status: status, sessions: sessions, pages: pages, topics: topics }); },
    onMessage: function (cb) { msgCbs.push(cb); },
    send: function (o) { return wsCall({ type: 'send', to: o.to, subject: o.subject, verb: o.verb, body: o.body }); },
    publish: function (o) { return wsCall({ type: 'publish', topic: o.topic, subject: o.subject, verb: o.verb, body: o.body }); },
    /* re-open the socket with patched config (e.g. {project:"AIMB"}) — same instance, new hello identity */
    reconnect: function (patch) {
      if (patch) for (var k in patch) cfg[k] = patch[k];
      if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (e) {} ws = null; }
      status = 'offline'; sessions = []; pages = []; topics = []; notify();
      backoff = 1000; connect();
    },
    cfg: function () { return cfg; }
  };
})();
