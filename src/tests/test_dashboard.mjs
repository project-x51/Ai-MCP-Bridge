import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const SRCDIR = fileURLToPath(new URL('../', import.meta.url))
import { JSDOM } from 'jsdom'
import WebSocket from 'ws'
import fs from 'fs'
import os from 'os'

const PORT='7100', WSPORT='7101', TOKEN='testtok'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let pass=0,fail=0
const check=(n,c,x='')=>{ c?(pass++,console.log('PASS',n)):(fail++,console.log('FAIL',n,x)) }

async function spawnBridge(name){
  const t=new StdioClientTransport({command:'node',args:[SRCDIR + 'bridge.mjs'],cwd:SRCDIR,
    env:{...process.env,AI_BRIDGE_NAME:name,AI_BRIDGE_PORT:PORT,AI_BRIDGE_WS_PORT:WSPORT,AI_BRIDGE_TOKEN:TOKEN,AI_BRIDGE_PERSISTENCE:'none',AI_BRIDGE_BIND:'127.0.0.1',AI_BRIDGE_DISCOVERY:'none'},stderr:'pipe'})
  const c=new Client({name:'t-'+name,version:'0'},{capabilities:{}})
  await c.connect(t); return {c,t}
}
const call=async(b,n,a={})=>JSON.parse((await b.c.callTool({name:n,arguments:a})).content[0].text)

// reset aliases in config copy
const cfg=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)),'utf8')); delete cfg.aliases
fs.writeFileSync(fileURLToPath(new URL('../config.json', import.meta.url)),JSON.stringify(cfg,null,2))

const A=await spawnBridge('Alpha'); await sleep(400)
const B=await spawnBridge('Bravo'); await sleep(600)
const idA=await call(A,'my_identity'), idB=await call(B,'my_identity')

// page leaf so the map has a page node
const wsPage=new WebSocket(`ws://127.0.0.1:${WSPORT}`)
await new Promise(r=>wsPage.on('open',r))
wsPage.send(JSON.stringify({type:'hello',kind:'page',page_kind:'demo',title:'Demo Page',instance:'pgX',token:TOKEN}))
await sleep(300)

// dashboard in jsdom
const DASH = process.env.AIMB_DASHBOARD || fileURLToPath(new URL('../dashboard.html', import.meta.url))
const html=fs.readFileSync(DASH,'utf8')
const dom=new JSDOM(html,{runScripts:'dangerously',url:`file:///dash.html?token=${TOKEN}&ws=ws://127.0.0.1:${WSPORT}`})
const doc=dom.window.document
await sleep(1000)

check('pip green', doc.getElementById('pip').classList.contains('on'))
const map=doc.getElementById('map')
check('session nodes drawn', !!doc.getElementById('n-'+idA.session) && !!doc.getElementById('n-'+idB.session))
check('gateway tagged', [...map.querySelectorAll('.n-tag')].some(t=>t.textContent==='GATEWAY'))
check('follower edge drawn', !!doc.getElementById('e-'+idB.session))
check('page node drawn', !!doc.getElementById('n-page:pgX'))
check('page edge dashed', !!doc.getElementById('e-page:pgX'))
const hostLabel=[...map.querySelectorAll('.n-host-label')][0]
check('host box labeled', hostLabel && hostLabel.textContent.includes(os.hostname()), hostLabel&&hostLabel.textContent)

// rename session B via node click
dom.window.prompt=()=> 'Renamed-B'
doc.getElementById('n-'+idB.session).dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}))
await sleep(500)
const ls=await call(A,'list_sessions')
check('session alias applied', ls.sessions.some(s=>s.name==='Renamed-B'), JSON.stringify(ls.sessions.map(s=>s.name)))
check('map label updated', [...map.querySelectorAll('.n-label')].some(t=>t.textContent==='Renamed-B'))

// host alias persists
dom.window.prompt=()=> 'Lab PC'
;[...map.querySelectorAll('.n-host-label')][0].dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}))
await sleep(500)
const cfg2=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)),'utf8'))
check('host alias persisted to config.json', cfg2.aliases && cfg2.aliases[os.hostname()]==='Lab PC', JSON.stringify(cfg2.aliases))
const hostLabel2=[...doc.getElementById('map').querySelectorAll('.n-host-label')][0]
check('host label shows alias', hostLabel2.textContent.includes('Lab PC'), hostLabel2.textContent)
check('token survived persist', cfg2.token===cfg.token)

// rename the GATEWAY node specifically
dom.window.prompt=()=> 'Gateway-Prime'
doc.getElementById('n-'+idA.session).dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}))
await sleep(500)
const lsG=await call(B,'list_sessions')
check('gateway alias applied', lsG.sessions.some(s=>s.name==='Gateway-Prime'), JSON.stringify(lsG.sessions.map(s=>s.name)))
check('gateway map label updated', [...doc.getElementById('map').querySelectorAll('.n-label')].some(t=>t.textContent==='Gateway-Prime'))
const idA2=await call(A,'my_identity')
check('gateway own NAME updated', idA2.name==='Gateway-Prime', idA2.name)
// follower NAME propagation: A sends to B; envelope from_name should be the alias
const rB=await call(B,'send_to_peer',{target:'Gateway-Prime',subject:'rename probe (test)',message:'who am I now'})
check('send by gateway alias works', rB.ok===true, JSON.stringify(rB))
const idB3=await call(B,'my_identity')
check('follower NAME updated by earlier rename', idB3.name==='Renamed-B', idB3.name)

// trace pulse on activity
await call(A,'send_to_peer',{target:'Renamed-B',subject:'pulse probe (test)',message:'ping for pulse'})
await sleep(300)
const pulsed=doc.getElementById('n-'+idB.session).classList.contains('pulse') || doc.getElementById('n-'+idA.session).classList.contains('pulse')
check('node pulsed on trace', pulsed)

// --- sub-peer rendering (v1.1)
const reg=await call(B,'register_self',{name:'cowork-conv1',secret:'dash-sec'})
const regC=await call(B,'register_self',{name:'scout-9',secret:'dash-sec2',parent:'cowork-conv1'})
await sleep(700)
check('sub-peer node drawn', !!doc.getElementById('n-'+reg.peer_id), reg.peer_id)
check('sub-peer edge drawn', !!doc.getElementById('e-'+reg.peer_id))
check('child sub-peer node drawn', !!doc.getElementById('n-'+regC.peer_id))
check('sub-peer in sessions table', doc.getElementById('sessions').textContent.includes('cowork-conv1'))
check('client badge in table', doc.getElementById('sessions').textContent.includes('t-Alpha'))
await call(B,'deregister',{peer_id:regC.peer_id,secret:'dash-sec2'})
await sleep(600)
check('deregistered sub-peer removed from map', !doc.getElementById('n-'+regC.peer_id))

// page auto-claim guard (§6): a wildcard subject is NOT auto-claimed; a wildcard subscribe IS kept
const wsWild=new WebSocket(`ws://127.0.0.1:${WSPORT}`)
await new Promise(r=>wsWild.on('open',r))
wsWild.send(JSON.stringify({type:'hello',kind:'page',page_kind:'demo',title:'Wild Page',instance:'pgWild',subject:'retail/#',subscribe:['news/#'],project:'alpha',user:'u',token:TOKEN}))
await sleep(300)
const wp=((await call(A,'list_sessions')).pages||[]).find(p=>p.instance==='pgWild')
check('page wildcard subject not auto-claimed', !!wp && !wp.subject, JSON.stringify(wp&&wp.subject))
check('page wildcard subscribe kept', !!wp && (wp.subscriptions||[]).includes('news/#'), JSON.stringify(wp&&wp.subscriptions))
try{wsWild.close()}catch{}

// a local-agent client classifies as the new 'agent' kind (not lumped into cowork)
await call(B,'register_self',{name:'agent-conv',secret:'ag-sec',client:'local-agent-mode'})
await sleep(400)
const agSp=(await call(A,'list_sessions')).sessions.flatMap(s=>s.subpeers||[]).find(sp=>sp.name==='agent-conv')
check('local-agent client classified as agent kind', agSp && agSp.client_kind==='agent', JSON.stringify(agSp))

console.log(`\n${pass} passed, ${fail} failed`)
dom.window.close(); try{wsPage.close()}catch{}
await A.t.close(); await B.t.close()
process.exit(fail?1:0)
