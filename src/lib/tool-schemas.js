// MCP tool schemas (the `tools/list` payload) — pure static data, extracted from bridge.mjs to keep the
// orchestrator focused on behaviour. Edit a tool's contract here; the handler logic stays in bridge.mjs's
// CallTool switch. Keep the two in sync (a tool listed here must have a `case` there, and vice-versa).
export const TOOLS = [
  { name: 'my_identity', description: 'This bridge identity: session id, friendly name, mesh role, client info, local sub-peers.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'set_name', description: 'Set this session\'s friendly name on the mesh roster (e.g. "Scout"). NOTE: in a shared (Cowork) bridge this renames the PROCESS node — conversations should use register_self instead.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'register_self', description: 'Register THIS conversation (or subagent) as a sub-peer with its own identity and private inbox on a shared bridge. Invent a secret and keep it; same (name, secret) re-attaches after idle/expiry. Returns peer_id + queue_epoch (epoch change ⇒ reset your cursor). RESYNC: the response also returns `topics` (the owned + subscribed topics you currently hold, rehydrated from durable state — so a reconnecting/compacted session relearns what it is responsible for without re-claiming/re-subscribing), `access` (the projects you may reach), and an `inbox` hint (unread parked mail waiting). The bridge is the source of truth for your state across a restart.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'friendly name, e.g. "Scout" or "scout/worker-1"' },
      secret: { type: 'string', description: 'self-invented bearer secret; only its hash is stored' },
      parent: { type: 'string', description: 'parent sub-peer handle (for subagents): full id, handle suffix, or unique name' },
      client: { type: 'string', description: 'your client kind, e.g. "claude-code" or "cowork" — code clients default to push (streaming) delivery' },
      project: { type: 'string', description: 'the project this conversation is for (classifies the session; inherited from parent if omitted)' },
      user: { type: 'string', description: 'IGNORED — the human is taken from the OS-authenticated login, not session-declared (prevents fabrication/misalignment).' },
      mode: { type: 'string', description: 'optional override: push | poll' },
      ttl_minutes: { type: 'number', description: 'idle liveness TTL; default 720, or 60 when parent is set' } }, required: ['name', 'secret'] } },
  { name: 'deregister', description: 'Remove a sub-peer (subagents: call before returning). Children are removed too; unread messages dead-letter to the parent (or the process inbox).',
    inputSchema: { type: 'object', properties: {
      peer_id: { type: 'string' }, secret: { type: 'string' } }, required: ['peer_id', 'secret'] } },
  { name: 'list_sessions', description: 'List AI sessions (with their sub-peers) and page leaves currently on the mesh.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'claim_topic', description: 'Claim ownership of (responsibility for) a CONCRETE topic (no wildcards — owning a subtree is unsendable). Topics are /-separated paths (e.g. "bridge/admin", "retail/contact-energy"). exclusive:true = ONE owner mesh-wide; a claim overlapping a held exclusive topic returns code "held" — negotiate via verb request_responsibility (grant/refuse/ask-operator), never seize. With persistence on, a claim is DURABLE by default (persistent:false opts out) and survives a restart. While the owner is offline, directed sends park for its return; set announce_offline to have senders told it is offline (else parked silently). Taking over your OWN offline (dormant) topic needs presence confirmation (authorizer/Windows Hello); a DIFFERENT user may take over only after a grace window and only if allowed. Re-claiming a topic you already hold PATCHES it: any field you omit keeps its current value (the per-field defaults apply only to a NEW claim), so pass just the fields you want to change; an explicit value (incl. false, "" or null) replaces it. Owners are auto-subscribed. Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      topic: { type: 'string', description: 'concrete topic path (no wildcards)' },
      description: { type: 'string', description: 'one line on what the responsibility covers (a re-claim keeps the current description unless passed; "" or null clears it)' },
      exclusive: { type: 'boolean', description: 'true = single owner mesh-wide; an overlapping claim on a held exclusive topic returns "held" (new claim default TRUE — pass false for a shared/multi-owner topic; a re-claim keeps the current value unless passed)' },
      icon: { type: 'string', description: 'optional short markdown icon (e.g. an emoji) shown wherever the topic renders (a re-claim keeps the current icon unless passed; "" or null clears it)' },
      persistent: { type: 'boolean', description: 'durable claim — survives a restart (new claim default true when persistence is on; set false for an ephemeral claim — on a re-claim that also drops the durable record)' },
      announce_offline: { type: 'boolean', description: 'when you are offline, tell senders their message was parked because you are away (new claim default TRUE; pass false to park silently)' },
      grace_minutes: { type: 'number', description: 'how long after you go offline before a DIFFERENT user may take this topic over (default: realm config; null clears a per-claim value)' },
      allow_other_user: { type: 'boolean', description: 'may a different user take this responsibility over (after grace)? default: realm config; null clears a per-claim value' },
      keep_alive: { type: 'boolean', description: 'mark this topic to SURVIVE HANDOFFS: if released it stays alive (ownerless) so directed sends PARK against it until reclaimed, instead of bouncing no-owner (new claim default false, or inherited when claiming a kept-alive topic). Abandoned ownerless topics expire after a safety TTL.' },
      force: { type: 'boolean', description: 'RESERVED: operator-authorised immediate takeover — returns unsupported for now' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } }, required: ['topic'] } },
  { name: 'release_topic', description: 'Give up ownership of a topic you hold. By default the topic is gone (directed sends then bounce no-owner). Pass keep_alive:true (or claim it keep_alive) to KEEP IT ALIVE ownerless during a handoff: directed sends PARK and are delivered to the next session that claims it. Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      topic: { type: 'string' },
      keep_alive: { type: 'boolean', description: 'keep the topic alive (ownerless) after release so directed sends park until someone reclaims it (default = the claim\'s keep_alive setting; explicit value wins)' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } }, required: ['topic'] } },
  { name: 'subscribe', description: 'Subscribe to a topic pattern — open to everyone on any topic (exclusivity is about accountability, never watching). Wildcards: "+" one level, "#" subtree (e.g. "retail/#"). Publishes to matching topics land in your inbox. Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      pattern: { type: 'string', description: 'topic path or wildcard pattern' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } }, required: ['pattern'] } },
  { name: 'unsubscribe', description: 'Remove a subscription. Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      pattern: { type: 'string' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } }, required: ['pattern'] } },
  { name: 'set_behavior', description: 'Register a short REMINDER of how YOU want to behave at a bridge OPERATION that matches a scope. Default operation is "receive" (a message arrives) — those reminders ride each received message (channel meta + inbox items). OUTBOUND operations (send, publish, claim_topic, release_topic, subscribe, allow_project, revoke_project, request_project_access) instead echo the matching reminders in that TOOL\'S RESPONSE — which is post-hoc for the message CONTENT but lands exactly when you compose your transcript line / follow-up. For receive, scope matches the SENDER; for outbound operations it matches the TARGET (the project/topic/host the action concerns). Reminders come back as reminders:[{operation,scope,match,behavior}], most-specific first (topic > subscription > project > host > all). Durable + per-identity (rehydrated on register_self). Re-registering the same operation+scope+match replaces it. An operation with no reminder and no operator default is silent. Topic-scoped RECEIVE reminders ride a kept-alive topic on handoff. The bridge may also attach an operator DEFAULT (tagged default:true) — your own reminder for the same operation+scope+match overrides it. NOTE the operator default is usually all-scope ("Summarize but don\'t act without user permission"): scope your own reminders NARROWER (project/topic) so you do not clobber it. ("deliver" is still accepted as a legacy alias for "receive".) Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['receive', 'send', 'publish', 'claim_topic', 'release_topic', 'subscribe', 'allow_project', 'revoke_project', 'request_project_access', 'connect'], description: 'which bridge action fires the reminder (default "receive" = when a message arrives; legacy alias "deliver" also accepted). Outbound ops echo the reminder in that tool\'s response. "connect" fires ONCE in the register_self response — pin connect-time guidance to a session.' },
      scope: { type: 'string', enum: ['topic', 'host', 'project', 'subscription', 'client', 'all'], description: 'for receive: topic = a topic you OWN, host/project = messages FROM that host/project, subscription = messages matching your pattern, all = every message. For outbound ops the same scopes match the TARGET. "client" (match = client kind: code|agent|cowork|other) targets a session TYPE — pair with operation "connect". all = every instance of the operation.' },
      match: { type: 'string', description: 'the topic / host / project / subscription-pattern this applies to (omit for scope=all)' },
      behavior: { type: 'string', description: 'the reminder prompt (short; max 365 chars) returned to you when the operation matches' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } }, required: ['scope', 'behavior'] } },
  { name: 'list_behaviors', description: 'List the behaviour reminders you have registered. Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } } } },
  { name: 'clear_behavior', description: 'Remove a behaviour reminder (operation + scope + match), or ALL of them if both operation and scope are omitted. A scope with no operation targets operation "receive". Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['receive', 'send', 'publish', 'claim_topic', 'release_topic', 'subscribe', 'allow_project', 'revoke_project', 'request_project_access', 'connect'], description: 'the operation to clear (default "receive" when a scope is given; legacy alias "deliver" also accepted); omit with scope to clear every reminder' },
      scope: { type: 'string', enum: ['topic', 'host', 'project', 'subscription', 'client', 'all'], description: 'the scope to clear; omit (with operation) to clear every reminder' },
      match: { type: 'string', description: 'the match to clear (for scope other than all)' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } } } },
  { name: 'publish', description: 'Publish an event to a concrete topic: delivered to ALL subscribers (wildcard matches included; owners are auto-subscribed). Nobody is obliged to act — for directed work send to "topic:<topic>" instead. Zero subscribers is ok. subject is REQUIRED: short public one-line description (NOT encrypted — no private info).',
    inputSchema: { type: 'object', properties: {
      topic: { type: 'string', description: 'concrete topic path (no wildcards)' },
      subject: { type: 'string', description: 'short PUBLIC one-line description of the event' },
      message: { type: 'string', description: 'the message body (encrypted in transit)' },
      verb: { type: 'string', description: 'advisory verb, default "message"' },
      retain: { type: 'boolean', description: 'keep this as the topic\'s retained "last value" (persistence on); a new/returning subscriber gets it immediately on subscribe. Concrete topics only.' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } }, required: ['topic', 'subject', 'message'] } },
  { name: 'send_to_peer', description: 'Send a directed message: target = id from list_sessions, a unique friendly name, or "topic:<topic>" to message the topic\'s OWNER(S) only (the prefix is required; subscribers do not see sends). With persistence on, a send to a name (or topic owner) that is OFFLINE but has a durable registration/claim PARKS and is delivered when it returns; a name that was never registered still errors unknown-target. subject is REQUIRED: short public one-line description (NOT encrypted — no private info; the body is encrypted). from_topic sends ON BEHALF OF a topic you currently own: receivers see from_topic (+ from_topic_icon) beside the real sender, which is still `from` — replies still go to you. Registered sub-peers must pass as + secret.',
    inputSchema: { type: 'object', properties: {
      target: { type: 'string', description: 'session/sub-peer id, unique friendly name, or topic:<topic>. A bare topic resolves to an owner in YOUR project; if none, it resolves cross-project to a grant-reachable owner in another project (auto-routed when exactly one — else code cross-project-no-grant / cross-project-ambiguous). Use topic:@<project>/<topic> to target a specific project explicitly.' },
      subject: { type: 'string', description: 'short PUBLIC one-line description of the action' },
      message: { type: 'string', description: 'the message body (encrypted in transit)' },
      verb: { type: 'string', description: 'advisory verb, default "message"' },
      reply_to: { type: 'string', description: 'envelope_id being replied to' },
      from_topic: { type: 'string', description: 'send on behalf of this topic: a concrete topic YOU currently own (claim_topic; any co-owner of a shared topic may). Carried as envelope from_topic (+ from_topic_icon = the claim icon), ADDED to `from` (never replacing it). Not an owner / not claimed → code not-topic-owner, nothing sent; a wildcard → wildcard-from-topic. Receivers wanting continuity across an owner handoff can reply to topic:<from_topic> instead of the peer.' },
      park: { type: 'boolean', description: 'RESERVED (offline delivery): park for a known-but-offline agent — returns unsupported for now' },
      as: { type: 'string', description: 'your registered sub-peer handle (id, suffix, or name)' },
      secret: { type: 'string', description: 'the secret used at register_self' } }, required: ['target', 'subject', 'message'] } },
  { name: 'allow_project', description: 'Open YOUR project to inbound messages from another project (receiver-controlled consent). The caller\'s project grants `project` permission to initiate to it. mode "send" (one-way) or "bidirectional". As the operator you may set ttl_minutes to expire the grant (and may shorten what a requester asked for); omit for forever. Every grant CHANGE is announced to the granted project: its live sessions/sub-peers mesh-wide get a project_access_granted notice (mode, TTL/expiry, who granted) and offline durable registrations get it parked; a pending request_project_access requester copy also echoes its request_id. An identical re-grant (same mode + TTL) is not re-announced. Returns notified (all notices) = notified_pending + announced + parked. Durable across restart when persistence is on; for a permanent static edge add it to config.json projects.allow. Sub-peers pass as + secret.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'the foreign project being granted access to yours' },
      mode: { type: 'string', description: 'send (default) | bidirectional' },
      ttl_minutes: { type: ['number', 'string'], description: 'grant lifetime: minutes (number) or a duration like "24h"/"7d"; omit / 0 / "forever" = no expiry. May only shorten a requester\'s asked-for TTL.' },
      as: { type: 'string' }, secret: { type: 'string' } }, required: ['project'] } },
  { name: 'revoke_project', description: 'Revoke a runtime grant created with allow_project (drops the durable edge too; does not affect static config edges). If the grant was live, the granted project is told with a project_access_revoked notice (live members now, parked for offline ones); returns notified / announced / parked.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, as: { type: 'string' }, secret: { type: 'string' } }, required: ['project'] } },
  { name: 'request_project_access', description: 'Ask another project for permission to reach it. The bridge delivers a project_access_request to that project\'s sessions (by name, even though you cannot see them); an operator there approves by calling allow_project. You will then receive a project_access_granted message echoing your request_id + the permitted TTL. Returns a request_id.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'the project you want to reach' },
      reason: { type: 'string', description: 'why (shown to the target operator)' },
      ttl_minutes: { type: ['number', 'string'], description: 'how long you want the access for: minutes (number) or a duration like "24h"/"7d"; omit / "forever" = indefinite. The operator may grant a shorter TTL.' },
      as: { type: 'string' }, secret: { type: 'string' } }, required: ['to'] } },
  { name: 'set_wake', description: 'RESERVED (wake feature): arm a wake listener for an idle session, with filters (sends always; publishes per pattern). Returns unsupported for now.',
    inputSchema: { type: 'object', properties: {
      for: { type: 'string' }, secret: { type: 'string' },
      mode: { type: 'string', description: 'off | exit-on-message' },
      filter: { type: 'object', description: '{sends?: bool, publishes?: pattern[] | false}' } } } },
  { name: 'inbox', description: 'Poll received messages. Registered sub-peers pass for + secret (+ cursor from the previous call); response carries queue_epoch — if it changed, reset cursor to 0. Without for: the shared process inbox.',
    inputSchema: { type: 'object', properties: {
      cursor: { type: 'number' },
      for: { type: 'string', description: 'your registered sub-peer handle' },
      secret: { type: 'string' } } } },
  { name: 'recover_secret', description: 'RECOVER a lost inbox secret via the user\'s PRESENCE (Windows Hello), for when a session forgot its secret (e.g. after a compact). No secret is required — the bridge sealed it to the user\'s TPM at registration, so only the real human at their own machine can unseal it. On approval it returns the original secret; re-register with name + that secret to reattach and get your topics + parked mail back. Requires the vault facet (returns unsupported otherwise).',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'the session name whose secret to recover' },
      project: { type: 'string', description: 'optional — disambiguate if the name exists in more than one project' } }, required: ['name'] } },
  { name: 'log', description: 'Report status to the AGENT ACTIVITY BOARD (#70) as a registered session (as + secret; register_self first). Each session holds a TREE of nodes: AGENTS (actors — they start, finish, can go stale) and CONTEXTS (pieces of work with a current line, progress and an ETA); either kind may contain either. Agents never register. ' +
      'Address a node with path: "/"-separated segments, "@name" = a context, anything else an agent — "spec-70" (an agent), "spec-70/research" (a sub-agent), "spec-70/@Tharsis" (its context), "spec-70/@Tharsis/@z12" (nested), "@#70/spec-70" (an agent grouped under your context #70), "@#70/@step4/spec-70"; quote names with spaces: @"CTX strip 17"; at most 6 segments. Omit path to report as the session itself. ' +
      '"@~" on the LAST segment makes the message that node\'s CURRENT line (its headline) — "spec-70/@~Tharsis", or "spec-70/@~root" for the agent\'s own headline; without @~ the message is only logged. The old form still works and combines: agent:"a/b" + text "@~Ctx …" (or context:"@~Ctx") = path a/b/@~Ctx; a text prefix may itself be a relative path ("@Tharsis/@~z12 …"). ' +
      'state (running|blocked|failed|done|idle) changes only with an @~ line; done|failed on an AGENT\'s own line finishes it (stale is computed, never reported; a context shows its nearest agent\'s staleness). progress ("4812/12000 tiles", "3/6", "61%") and eta ("15m", "1h25m", "19:27") move the node\'s bar from ANY message and stick until changed ("none" clears); a node without its own progress shows the rollup of its children. ' +
      'TEXT IS A TEMPLATE rendered when read: {progress} {pct} {done} {total} {unit} {eta} ({{ and }} are literal braces); a message with progress/eta but no text gets "{progress}" ("{eta}"). ' +
      'log:false updates the board WITHOUT appending to the log — for frequent progress updates (a script every second); keep log:true (the default) for milestones. Your own tool calls cost tokens: report at milestones, not every step. ' +
      'PLANS (todos): plan:["Spec", "Build", "Test"] creates ☐ PLAN ITEMS under the node you address (path "@#70" → @#70/@Spec, @#70/@Build, …), shown in the GIVEN order; text is optional with a plan. Re-sending a plan keeps existing items exactly as they are and adds new names at the END (names you leave out stay). A plan item\'s states: todo ☐, running/blocked (in progress), done ☑, skipped (struck through; plan items only), failed. Tick one with path "@#70/@~Build" + state "done" (no text needed: the line keeps its text). todo/skipped are never valid for an agent (bad-agent-state); skipped on an ordinary context is not-a-plan-item. A plan item never goes stale; a node with plan items shows an "N of M done" bar (skipped items left out of M). Open items (todo/running/blocked) never expire and are never evicted; a finished plan stays 7 days. ' +
      'BATCH: items:[{ path?, agent?, text, context?, state?, progress?, eta?, stale_after?, details?, data?, log?, plan?, ref? }, …] (≤64 items, ≤64 KB) logs several in ONE call, in order → { ok, results:[one per item, its ref echoed], applied, failed } — a bad item fails alone; log beside items is a default for every item; an item\'s own path/agent is RELATIVE to the path/agent beside items (like folders: path "@#70" + item path "@B/@~x" = @#70/@B/@x), a leading "/" makes it absolute from the session root; context beside items applies only to items naming no path/agent. ' +
      'stale_after ("60m", max 24h) lets a long silent step stay non-stale until your next message. Limits: text 240 chars (longer is truncated), context name 60, depth 6, 128 agents and 4096 nodes per session (the oldest finished agent is evicted, with everything under it, to make room), details 4 KB, data 16 KB of JSON — keep details and data small. ' +
      'Status text is PLAINTEXT and visible realm-wide: never put secrets in it. Returns { ok, id, ts, session, path, agent, context, current, state, stale_at, logged } (+ plan:[{ name, path, created?, adopted?, plan_item, state }] with a plan).',
    inputSchema: { type: 'object', properties: {
      as: { type: 'string', description: 'your registered sub-peer handle (peer id or name)' },
      secret: { type: 'string' },
      path: { type: 'string', description: 'the node: "spec-70", "spec-70/@Tharsis", "@#70/@step4/spec-70", "@\\"CTX strip 17\\"" (@ = context, else agent; @~ on the last segment = set its current line; ≤6 segments); omit = the session itself' },
      agent: { type: 'string', description: 'old form: an agent path (agent segments only, e.g. "spec-70/research"); combines as agent + path + context' },
      text: { type: 'string', description: 'one line ≤240 chars; may start with an @ctx / @~ctx prefix (a relative path); a template ({progress} {pct} {done} {total} {unit} {eta}); optional with progress / eta, a plan, or a state on an @~ line (a tick keeps the text)' },
      context: { type: 'string', description: 'old form: "@root" | "@Ctx" | "@~Ctx" — ONE trailing context; overrides a prefix in text (the text is then taken literally)' },
      state: { type: 'string', enum: ['running', 'blocked', 'failed', 'done', 'idle', 'todo', 'skipped'], description: 'applies with an @~ line; default: the node\'s current state, else running (an @~ line on a ☐ item starts it: running). todo / skipped: plan items only (contexts; never agents)' },
      progress: { type: ['string', 'number'], description: '"4812/12000 tiles" | "4812/12000:tiles" | "3/6" | "61%" | "none"' },
      eta: { type: ['string', 'number'], description: '"15m" | "1h25m" | "19:27" (local clock) | "none"' },
      stale_after: { type: ['string', 'number'], description: 'how long this may stay quiet before it counts as stale, e.g. "60m" (max 24h); lasts until your next message' },
      details: { type: 'string', description: 'optional text ≤4 KB, fetched on demand (activity entry:{id}) — keep it small' },
      data: { type: ['object', 'array', 'string'], description: 'optional JSON ≤16 KB, fetched on demand — keep it small' },
      log: { type: 'boolean', description: 'true (default) = append to the log + the host\'s daily file; false = update the board only (frequent progress updates). Plan items are always logged' },
      plan: { type: 'array', items: { type: 'string' }, description: 'create ☐ plan items under the addressed node, in this order (≤64 names, each one context name ≤60 chars); re-sending adds only new names, at the end, and never resets an item' },
      items: { type: 'array', description: 'a BATCH (≤64 items, ≤64 KB): each item has the message fields above incl. plan (+ ref, echoed in its result); an item path is relative to the path/agent given beside items ("/…" = absolute); applied in order, one result each', items: { type: 'object' } } },
      required: ['as', 'secret'] } },
  { name: 'activity', description: 'Read the mesh-wide AGENT ACTIVITY BOARD (#70): sessions, each with `self` (the session\'s own node) and `nodes` — every node of its tree, flat, with its `path`, `kind` (agent | context), `depth`, `parent` and `host`; its current line (`text` = the raw template, `rendered` = filled from the live bar), the effective state (stale / gone computed here — agents by their own activity, contexts by their nearest agent ancestor; `was` = the reported state), `progress` = its bar (reported, or rolled up from its children through any depth), ETA, visibility and log counts. ' +
      'Every host\'s nodes are on it (gossiped): a session is grouped across hosts by realm + project + user + name, every node carries its `host`, and a session on several hosts lists `hosts`. A host that went down shows its agents as gone with `host_down` (a session that left: gone without it); `bell` = a doorbell is armed for the session. ' +
      'Plan items carry plan_item:true and never show stale or gone; a node with plan items has an "N of M done" bar (progress.todos, progress.skipped). A session on several hosts takes its headline (`self`) from the host that most recently SET one (`selves` = each host\'s own line). ' +
      'Filters: project, session, path (that node and everything under it; `agent` is the old name), host, active_only (hide finished/gone agents and what is under them — unless it holds an open plan item — and plans whose items are all done/skipped). ' +
      'log:{ session, project?, user?, host?, path?, agent?, context?, own?, limit?, cursor? } returns a node\'s log NEWEST FIRST — by default the MERGED log of its whole subtree (each entry with its `path` and `rel` to the node), own:true for the node\'s own entries; omit path = the session root (everything). Each entry is rendered against the progress/ETA recorded on it. Paged (pass next_cursor as cursor): once memory runs out the pages continue into the owning host\'s daily log files; another host\'s pages are fetched from that host, queued at its fetch rate. ' +
      'entry:{ id, host? } returns one entry in full with its details/data (pass host for another host\'s older log entry). Codes: owner-unreachable (that host is down), busy (too many fetches queued — retry_after_ms), ambiguous-session (pass project/user/host), unknown-node. Times are ms epochs.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, session: { type: 'string' }, path: { type: 'string' }, agent: { type: 'string' }, host: { type: 'string' },
      active_only: { type: 'boolean' },
      log: { type: 'object', description: '{ session, project?, user?, host?, path?, agent?, context?, own?, limit?, cursor? } — a node\'s (subtree-merged) log, newest first, paged', properties: {
        session: { type: 'string' }, project: { type: 'string' }, user: { type: 'string' }, host: { type: 'string' }, path: { type: 'string' }, agent: { type: 'string' }, context: { type: 'string' },
        own: { type: 'boolean' }, limit: { type: 'number' }, cursor: { type: 'string' } } },
      entry: { type: 'object', description: '{ id, host? } — one entry with its details/data', properties: { id: { type: 'string' }, host: { type: 'string' } } },
      as: { type: 'string' }, secret: { type: 'string' } } } },
]
