// aimb-bridge-ui.js — reusable Ai MCP Bridge UI for web pages (no framework).
// Requires aimb-page-bridge.js (window.aimbBridge) inlined first. Injects its own CSS.
//
// Usage:
//   aimbBridgeUI.init({
//     mount:   "#aimb-mount",            // element or selector: where the pip + session dropdown render
//     buttons: "button.aimb-discuss",    // optional: send-buttons to wire (enabled only with a live selection)
//     verb:    "discuss_issue",         // bridge verb for button sends (default "message";
//                                       //  a button's data-verb attribute overrides per button)
//     subject: function(btn){ return "..."; },   // REQUIRED for buttons (T7): short PUBLIC one-line
//                                       // description of the action; string or function(btn).
//                                       // A button's data-subject attribute overrides per button.
//     payload: function(btn){ return {...}; },  // builds the JSON body for a clicked button
//     onSent:  function(btn, ack){...},          // optional: called after a button send is acked
//     label:   "Bridge",                // optional widget label
//     groups:  ["ai-sessions","ai-topics"]        // which dropdown groups to show, in this fixed
//                                       // order: ai-sessions, ai-topics, browser-sessions,
//                                       // browser-topics. Default AI-only (T13/R8) — pages opt in
//                                       // to browser targets explicitly.
//   });
//
// Behaviour: named conversations only (sub-peers = Cowork, named processes = Code);
// no auto-selection; selection persisted by NAME in ?session= (hash fallback on file://);
// pip 🟢 online / 🟠 online-no-conversations / ⚪ offline; per-option status circles;
// dropdown tinted to match the selected session's type. Topics (green, claim icon shown) target
// "topic:<topic>" — delivered to the topic's OWNER(S); shared topics fan out to every co-owner.
window.aimbBridgeUI = (function () {
  var ON = "🟢", IDLE = "🟠", OFF = "⚪";
  var CSS = [
    ".aimb-nav { display: inline-flex; align-items: center; gap: 6px; }",
    ".aimb-label { font-size: 11.25px; font-weight: 600; color: #6B7280; }",
    ".aimb-pip { font-size: 11.25px; line-height: 1; }",
    "#aimb-target { font-size: 11.25px; padding: 3px 6px; border: 1px solid #D1D5DB; border-radius: 6px; background: #FFFFFF; }",
    "#aimb-target.aimb-cw { background: #FEF9C3; }",
    "#aimb-target.aimb-code { background: #DBEAFE; }",
    "#aimb-target.aimb-resp { background: #DCFCE7; }",
    "#aimb-target.aimb-page { background: #FCE7F3; }",
    "#aimb-target.aimb-offline { color: #9CA3AF; }",
    "#aimb-target option.aimb-cw { background: #FEF9C3; }",
    "#aimb-target option.aimb-code { background: #DBEAFE; }",
    "#aimb-target option.aimb-resp { background: #DCFCE7; }",
    "#aimb-target option.aimb-excl { font-weight: 700; }",
    "#aimb-target.aimb-excl { font-weight: 700; }",
    "#aimb-target option.aimb-page { background: #FCE7F3; }",
    "#aimb-target option.aimb-offline { color: #9CA3AF; }",
    ".aimb-discuss { font-size: 11px; font-weight: 600; padding: 1px 10px; border-radius: 10px; border: 1px solid #93C5FD; background: #EFF6FF; color: #1E40AF; cursor: pointer; flex: 0 0 auto; }",
    ".aimb-discuss:hover { background: #DBEAFE; }",
    ".aimb-discuss.sent { background: #DCFCE7; border-color: #86EFAC; color: #14532D; }",
    ".aimb-discuss.err { background: #FEE2E2; border-color: #FCA5A5; color: #991B1B; }",
    ".aimb-discuss:disabled { opacity: .45; cursor: not-allowed; background: #F3F4F6; border-color: #E5E7EB; color: #6B7280; }",
    ".aimb-discuss:disabled:hover { background: #F3F4F6; }",
    ".aimb-discuss.aimb-selected { background: #BFDBFE; border-color: #3B82F6; color: #1E3A8A; font-weight: 700; }"
  ].join("\n");

  function injectCss() {
    if (document.getElementById("aimb-ui-css")) return;
    var st = document.createElement("style");
    st.id = "aimb-ui-css"; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function init(opts) {
    opts = opts || {};
    var mount = typeof opts.mount === "string" ? document.querySelector(opts.mount) : opts.mount;
    if (!mount) return null;
    injectCss();
    mount.classList.add("aimb-nav");
    mount.innerHTML = '<span class="aimb-label">' + (opts.label || "Bridge") + '</span>' +
      '<span class="aimb-pip" id="aimb-pip">' + OFF + '</span>' +
      '<select id="aimb-target" title="Send to AI session"></select>';
    var pip = mount.querySelector("#aimb-pip");
    var sel = mount.querySelector("#aimb-target");
    var btns = opts.buttons ? Array.prototype.slice.call(document.querySelectorAll(opts.buttons)) : [];
    btns.forEach(function (b) { if (!("noicon" in b.dataset) && b.textContent.indexOf("\u2728") !== 0) b.textContent = "\u2728 " + b.textContent; });  /* AI-action affordance (data-noicon opts out) */
    pip.title = "Bridge offline"; sel.disabled = true;

    /* selection persisted by NAME so a refresh re-selects it */
    var want = ""; try { want = new URLSearchParams(location.search).get("session") || ""; } catch (e) {}
    if (!want) { var mh = /[#&]session=([^&]*)/.exec(location.hash || ""); if (mh) want = decodeURIComponent(mh[1]); }
    var bridgeOn = false, roster = [], topicsL = [], pagesL = [];
    var groups = opts.groups || ["ai-sessions", "ai-topics"];   /* fixed render order below; this just filters (T13) */

    function addGroup(label) { var og = document.createElement("optgroup"); og.label = label; sel.appendChild(og); return og; }
    function apply() {
      sel.innerHTML = "";
      var ph = document.createElement("option"); ph.value = ""; ph.textContent = "— send to —"; sel.appendChild(ph);
      var found = null;
      function opt(grp, value, name, text, cls) {
        var o = document.createElement("option");
        o.value = value; o.dataset.name = name; o.textContent = text; o.className = cls;
        grp.appendChild(o);
        /* names/topics compare case-INSENSITIVELY (display keeps original case): a persisted target like
           "topic:Bills" matches the live "topic:bills" instead of dangling as a separate offline entry */
        if (!found && String(name).toLowerCase() === String(want).toLowerCase()) found = o;
        return o;
      }
      if (groups.indexOf("ai-sessions") >= 0 && roster.length) {
        var g1 = addGroup("Ai Sessions");
        roster.forEach(function (s) {
          /* truth = client_kind from the bridge roster; fall back to the old structural heuristic */
          var ck = s.client_kind || (s.kind === "subpeer" ? "cowork" : "code");
          var cw = (ck !== "code");
          opt(g1, s.session, s.name, ON + " " + s.name + "  — " + (cw ? "Coworker" : "Coder"), cw ? "aimb-cw" : "aimb-code");
        });
      }
      /* topics dedupe by path: one option per topic, owner fan-out handled bridge-side */
      function topicOpts(grp, source) {
        var byTopic = {};
        topicsL.forEach(function (r) {
          if (r.source !== source) return;
          var k = r.topic.toLowerCase();
          var e = (byTopic[k] = byTopic[k] || { topic: r.topic, exclusive: r.exclusive, icon: "", holders: [] });
          e.holders.push(r.holder_name || r.holder);
          if (r.icon && !e.icon) e.icon = r.icon;
          if (r.exclusive) e.exclusive = true;
        });
        Object.keys(byTopic).forEach(function (k) {
          var r = byTopic[k];
          var nm = "topic:" + r.topic;
          opt(grp, nm, nm, (r.icon || ON) + " " + r.topic + "  — " + (r.exclusive ? "Topic" : "Topic ×" + r.holders.length),
              "aimb-resp" + (r.exclusive ? " aimb-excl" : ""));   /* exclusive topics render bold */
        });
      }
      if (groups.indexOf("ai-topics") >= 0 && topicsL.some(function (r) { return r.source === "ai"; })) topicOpts(addGroup("Ai Topics"), "ai");
      if (groups.indexOf("browser-sessions") >= 0 && pagesL.length) {
        var g3 = addGroup("Browser Sessions");
        pagesL.forEach(function (p) {
          opt(g3, "page:" + p.instance, p.title, ON + " " + p.title + "  — Browser", "aimb-page");
        });
      }
      if (groups.indexOf("browser-topics") >= 0 && topicsL.some(function (r) { return r.source === "browser"; })) topicOpts(addGroup("Browser Topics"), "browser");
      if (found) want = found.dataset.name;   /* snap to the live entry's canonical case once matched */
      if (want && !found) {
        var off = document.createElement("option"); off.value = ""; off.dataset.name = want;
        off.textContent = OFF + " " + want.replace(/^topic:/, "") + "  — offline"; off.className = "aimb-offline";
        sel.appendChild(off); off.selected = true;
      } else if (found) { found.selected = true; } else { ph.selected = true; }
      var liveSel = !!found && bridgeOn;
      sel.className = !want ? "" : (liveSel ? (found.className || "") : "aimb-offline");
      pip.className = "aimb-pip" + (!bridgeOn ? "" : (roster.length ? " on" : " idle"));
      pip.textContent = !bridgeOn ? OFF : (roster.length ? ON : IDLE);
      pip.title = !bridgeOn ? "Bridge offline"
        : (!roster.length ? "Bridge online — no conversations"
        : (want ? ((want.indexOf("topic:") === 0 ? "Topic " : "Session ") + want.replace(/^topic:/, "") + (liveSel ? " online" : " offline")) : "Bridge online — select a target"));
      sel.disabled = !bridgeOn;
      btns.forEach(function (b) { b.disabled = !liveSel; });
    }

    sel.addEventListener("change", function () {
      var o = sel.selectedOptions[0];
      want = (o && o.dataset.name) || "";
      var ok = false;
      try {
        var u = new URL(location.href);
        if (want) u.searchParams.set("session", want); else u.searchParams.delete("session");
        history.replaceState(null, "", u.href); ok = (location.href === u.href);
      } catch (e) {}
      if (!ok) { /* file:// pages may refuse replaceState — fall back to the hash */
        try { location.hash = want ? "session=" + encodeURIComponent(want) : ""; } catch (e) {}
      }
      apply();
    });
    apply();

    btns.forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (btn.disabled || !sel.value || !window.aimbBridge) return;
        var orig = btn.textContent;
        var subj = btn.dataset.subject || (typeof opts.subject === "function" ? opts.subject(btn) : opts.subject) || "";
        window.aimbBridge.send({ to: sel.value, verb: btn.dataset.verb || opts.verb || "message",
          subject: subj,
          body: JSON.stringify(opts.payload ? opts.payload(btn) : {}) })
        .then(function (ack) { btn.classList.add(ack.ok ? "sent" : "err");
          if (ack.ok) {                                   /* radio-style selection per row */
            var tr = btn.closest("tr");
            if (tr) Array.prototype.slice.call(tr.querySelectorAll(".aimb-discuss.aimb-selected")).forEach(function (x) { x.classList.remove("aimb-selected"); });
            btn.classList.add("aimb-selected");
          }
          if (!("noicon" in btn.dataset)) btn.textContent = ack.ok ? "Sent ✓" : "Failed";
          setTimeout(function () { btn.classList.remove("sent", "err"); btn.textContent = orig; }, 2500);
          if (opts.onSent) { try { opts.onSent(btn, ack); } catch (e) {} } })
        .catch(function () { btn.classList.add("err"); if (!("noicon" in btn.dataset)) btn.textContent = "Offline";
          setTimeout(function () { btn.classList.remove("err"); btn.textContent = orig; }, 2500); });
      });
    });

    if (window.aimbBridge) window.aimbBridge.onUpdate(function (st) {
      bridgeOn = (st.status === "connected");
      roster = st.sessions || [];
      topicsL = st.topics || [];                /* owner/subscriber entries from the roster */
      pagesL = st.pages || [];
      apply();
    });
    return { selectedName: function () { return want; }, targetId: function () { return sel.value; } };
  }

  return { init: init };
})();
