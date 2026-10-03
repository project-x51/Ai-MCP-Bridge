// The test manifest (#81): every test script, its GROUP (= its folder under tests/), and the order.
//
// ORDER is the historical `npm test` chain order (the serial suite runs it as-is). It is also the PORT-BLOCK order
// (helpers/ports.mjs gives the file at index i the block PORT_BASE + i * 100), so it is APPEND-ONLY: a new test goes at
// the END (and into one group), never in the middle, or every later file's ports move.
//
// Groups are functional areas; a group's files run one at a time inside that group's driver
// (tests/<group>/<group>.test.mjs), and the groups run in parallel (`npm test`, --test-concurrency).
//   unit         pure modules: no bridge, no sockets (seconds)
//   mesh         one host: election, routing, sub-peers, topics, identity, ids, claims
//   security     consent + grants, secrets (vault, token file, roster), cap keys, facet probes, egress
//   persistence  durable mailboxes, parking, retained values across restarts
//   federation   cross-host links: delivery, healing, grants / realm defaults / retained values / caps mesh-wide
//   behaviors    behaviour + operation + connect reminders
//   doorbell     the doorbell script (wake / chime / watch)
//   dashboard    dashboard.html + the page widget (jsdom), dashboard persistence, remote pages
//   activity     the #70 activity board: log tool + script, gossip, the Activity view, carry-forward, 6c / 6d

export const ORDER = Object.freeze([
  'test_lib_unit', 'test_mesh', 'test_subpeers', 'test_topics', 'test_identity', 'test_consent', 'test_dashboard',
  'test_page_e2e', 'test_federation', 'test_dashboard_multihost', 'test_dashboard_persistence', 'test_dashboard_collapse',
  'test_persistence', 'test_persist_live', 'test_grants_live', 'test_offline_park_live', 'test_parked_live',
  'test_keepalive_live', 'test_behaviors_live', 'test_default_behavior_live', 'test_http_egress_live', 'test_retain_live',
  'test_vault_live', 'test_doorbell_live', 'test_stable_ids_live', 'test_facet_probe_live', 'test_capkey_restart_live',
  'test_caps_propagate_live', 'test_op_reminders_live', 'test_toollist_changed_live', 'test_token_file_live',
  'test_receive_rename_live', 'test_gateway_subpeer_delivery_live', 'test_connect_reminders_live',
  'test_delivery_outcome_live', 'test_federation_heal_live', 'test_grants_federate_live', 'test_realm_defaults_live',
  'test_retain_federate_live', 'test_page_remote_live', 'test_roster_secrets_live', 'test_reclaim_preserve_live',
  'test_from_topic_live', 'test_grant_notice_live', 'test_project_case_live', 'test_activity_unit', 'test_log_live',
  'test_log_script_live', 'test_activity_gossip_live', 'test_dashboard_activity', 'test_activity_dashboard_live',
  'test_activity_carry_live', 'test_activity_6c_live', 'test_activity_actions_live', 'test_activity_notices_live',
  'test_activity_plan82_live', 'test_activity_msg_live', 'test_activity_ask_live', 'test_activity_detail_live',
  'test_realm_guides_live',
])

export const GROUPS = Object.freeze({
  unit: ['test_lib_unit', 'test_persistence', 'test_activity_unit'],
  mesh: ['test_mesh', 'test_subpeers', 'test_topics', 'test_identity', 'test_keepalive_live', 'test_stable_ids_live',
    'test_toollist_changed_live', 'test_receive_rename_live', 'test_reclaim_preserve_live', 'test_from_topic_live'],
  security: ['test_consent', 'test_grants_live', 'test_http_egress_live', 'test_vault_live', 'test_facet_probe_live',
    'test_capkey_restart_live', 'test_token_file_live', 'test_roster_secrets_live', 'test_grant_notice_live'],
  persistence: ['test_persist_live', 'test_offline_park_live', 'test_parked_live', 'test_retain_live'],
  federation: ['test_federation', 'test_caps_propagate_live', 'test_gateway_subpeer_delivery_live',
    'test_delivery_outcome_live', 'test_federation_heal_live', 'test_grants_federate_live', 'test_realm_defaults_live',
    'test_retain_federate_live', 'test_project_case_live'],
  behaviors: ['test_behaviors_live', 'test_default_behavior_live', 'test_op_reminders_live'],
  doorbell: ['test_doorbell_live', 'test_connect_reminders_live'],
  dashboard: ['test_dashboard', 'test_page_e2e', 'test_dashboard_multihost', 'test_dashboard_persistence',
    'test_dashboard_collapse', 'test_page_remote_live'],
  activity: ['test_log_live', 'test_log_script_live', 'test_activity_gossip_live', 'test_dashboard_activity',
    'test_activity_dashboard_live', 'test_activity_carry_live', 'test_activity_6c_live', 'test_activity_actions_live',
    'test_activity_notices_live', 'test_activity_plan82_live', 'test_activity_msg_live', 'test_activity_ask_live',
    'test_activity_detail_live', 'test_realm_guides_live'],
})

/** name → group */
export const GROUP_OF = Object.freeze(Object.fromEntries(Object.entries(GROUPS).flatMap(([g, fs]) => fs.map(f => [f, g]))))

/** "activity/test_log_live" — a file's id (its path under tests/, no extension); test names and plan items use it */
export const fileId = name => `${GROUP_OF[name]}/${name}`

/** a group's files in ORDER (the serial order) */
export const groupFiles = group => ORDER.filter(f => GROUP_OF[f] === group)

/**
 * The AIMB_TEST_SELECT filter (set by tests/run.mjs for `test:file`): a comma list of names. A name that IS a file's
 * name or id selects that file alone ("test_dashboard"); otherwise it selects every file whose id CONTAINS it
 * (case-insensitive): "activity_6c", "dashboard/", "federat". Empty = everything.
 */
export function selected(name, spec = process.env.AIMB_TEST_SELECT) {
  const want = String(spec || '').split(/[,\s]+/).map(s => s.trim().toLowerCase().replace(/\\/g, '/').replace(/^(\.\/)?(tests\/)?/, '').replace(/\.mjs$/, '')).filter(Boolean)
  if (!want.length) return true
  const id = fileId(name).toLowerCase()
  const exact = w => ORDER.some(f => f.toLowerCase() === w || fileId(f).toLowerCase() === w)
  return want.some(w => exact(w) ? (id === w || name.toLowerCase() === w) : id.includes(w))
}
