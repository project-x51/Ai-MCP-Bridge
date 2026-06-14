// Research client — an example Ai MCP Bridge page leaf.
// Inject into ANY website tab. Joins the mesh as a page leaf:
//   on web.archive.org  -> page_kind "wayback-research", title "Wayback Research"   (unchanged behaviour)
//   on any other site   -> page_kind "site-research",    title "Site Research — <host>"
// A session sends research_run {questions[], jobs[]}; events stream back to the requester
// (research_event / research_done), exactly as before.
//
// JOB TYPES
//   Wayback (only on web.archive.org): cdx_bounds | cdx_list | snapshot_contains | bisect_presence | snapshot_text
//   Any site (same-origin fetches against the HOST site):
//     site_fetch_contains {id, path, needles[]}        — fetch a path, search content
//     site_fetch_text     {id, path, max_chars}        — fetch a path, return tag-stripped text
//     site_links          {id, path, pattern}          — harvest hrefs (absolute), optional regex filter
//     dom_text            {id, selector, max_chars}    — text of the CURRENT rendered DOM (post-JS; great for SPAs / logged-in views)
//     dom_contains        {id, needles[]}              — search the current rendered DOM
//   paths resolve against location.origin; cross-origin URLs are refused (browser CORS reality).
//
// LIMITS: a tab researches ITS OWN site (one leaf per site, as many tabs as you like);
// strict-CSP sites may block ws://127.0.0.1 — overlay will show "ws error" (fall back to Chrome-driving).
(function(){
  const WSURL = window.__AIMB_WS__ || "ws://127.0.0.1:7001", TOKEN = window.__AIMB_TOKEN__ || "change-me";
  const WB = /(^|\.)web\.archive\.org$/.test(location.hostname);
  const KIND = WB ? "wayback-research" : "site-research";
  const TITLE = WB ? "Wayback Research" : ("Site Research — " + location.hostname.replace(/^www\./,""));
  const SUBJECT = WB ? "research/wayback-tab" : ("research/site/" + location.hostname.replace(/^www\./,""));
  const INSTANCE = (WB ? "wayback-" : "site-") + Math.random().toString(16).slice(2,8);
  let sock, requester = null;
  function raw(o){ try{ sock.send(JSON.stringify(o)); }catch(e){} }
  let evN = 0;
  function send(evt){
    if(!requester) return;
    raw({type:"send", to:requester, subject:("research: "+(evt.type||"event")+" "+(evt.id||"")+" ("+TITLE+")").trim(),
         verb: evt.type==="__done" ? "research_done" : "research_event",
         body: JSON.stringify(Object.assign({seq:++evN, instance:INSTANCE}, evt)), ref:"e"+evN, page_kind:KIND});
  }
  function box(){ document.getElementById("aimb-overlay")?.remove();
    const b=document.createElement("div");b.id="aimb-overlay";
    b.style.cssText=["position:fixed","top:10px","right:10px","width:460px","max-height:94vh","z-index:2147483647","background:#0f7a3d","color:#eafff1","font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif","border:2px solid #0a5e2e","border-radius:10px","box-shadow:0 8px 28px rgba(0,0,0,.4)","display:flex","flex-direction:column","overflow:hidden"].join(";");
    b.innerHTML='<div style="padding:10px 12px;background:#0a5e2e;font-weight:600">Research <span style="font-weight:400;color:#bff5d2">('+TITLE+')</span><div id="aimb-sub" style="font-weight:400;margin-top:3px;color:#bff5d2">connecting…</div></div><div id="aimb-work" style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.18)"></div><div style="padding:8px 12px 2px;font-size:11px;color:#bff5d2;text-transform:uppercase">Tasks</div><div id="aimb-list" style="margin:4px 10px 10px;padding:4px 10px;background:#eaf7ee;color:#0a3d20;border-radius:8px;overflow:auto"></div>';
    document.body.appendChild(b);return b; }
  const B=box(), sub=B.querySelector("#aimb-sub"), work=B.querySelector("#aimb-work"), list=B.querySelector("#aimb-list");
  const oc=c=>({correct:"#7CFFB0",wrong:"#ff9b9b",warn:"#ffe9b0",neutral:"#eafff1"}[c])||c||"#eafff1";
  const rows={};
  function mk(id,label,tag){const r=document.createElement("div");r.style.cssText="padding:5px 0;border-top:1px solid rgba(10,90,46,.18)";r.innerHTML='<span class="bx" style="color:#0a7a3d">☐</span> <span style="opacity:.6;font-size:11px">'+tag+'</span> <b>'+label+'</b><div class="cm" style="font-size:12px;color:#2e6b47;margin-left:18px"></div>';list.appendChild(r);rows[id]=r;}
  function done(id,c,ok){const r=rows[id];if(!r)return;const x=r.querySelector(".bx");x.textContent=ok?"☑":"⚠";x.style.color=ok?"#0a7a3d":"#b8860b";r.querySelector(".cm").textContent=c||"";}
  const openPages=q=>(q.pages||[]).map(u=>{let w=null;try{w=window.open(u,"aimb_research");}catch(e){}return{u,ok:!!w};});
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  // ---- wayback engine (archive.org only) ----
  const CDX="https://web.archive.org/cdx/search/cdx";
  async function cdx(url,opt={}){const p=new URLSearchParams({url,output:"json",fl:"timestamp,original,statuscode",collapse:"digest"});
    if(opt.from)p.set("from",opt.from);if(opt.to)p.set("to",opt.to);if(opt.match)p.set("matchType",opt.match);if(opt.filter)p.set("filter",opt.filter);if(opt.limit)p.set("limit",String(opt.limit));
    for(let a=0;a<3;a++){try{const r=await fetch(CDX+"?"+p);const t=await r.text();if(t.trim().startsWith("<")){await sleep(2000*(a+1));continue;}const rows=JSON.parse(t);return rows.length>1?rows.slice(1):[];}catch(e){await sleep(2000*(a+1));}}return{error:"blocked (after retries)"};}
  async function cdxEnds(url,opt){const f=await cdx(url,Object.assign({},opt,{limit:1})),l=await cdx(url,Object.assign({},opt,{limit:-1}));if(f.error||l.error)return f.error?f:l;return{first:f.length?f[0][0]:null,last:l.length?l[0][0]:null};}
  async function snap(ts,url){const r=await fetch(`https://web.archive.org/web/${ts}id_/${url}`);return{u:r.url,t:await r.text()};}

  // ---- site engine (any host, same-origin) ----
  function sameOrigin(path){
    const u = new URL(path, location.origin);
    if(u.origin !== location.origin) throw new Error("cross-origin refused: "+u.origin+" (this tab researches "+location.origin+")");
    return u;
  }
  function stripHtml(t){return t.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&amp;|&#\d+;/g," ").replace(/\s+/g," ").trim();}
  async function siteFetch(path){const u=sameOrigin(path);const r=await fetch(u.href,{credentials:"include"});return{u:r.url,status:r.status,t:await r.text()};}

  async function runJob(j){
    let data,label,ok=true;
    try{
      // wayback family
      if(["cdx_bounds","cdx_list","snapshot_contains","bisect_presence","snapshot_text"].indexOf(j.type)>=0 && !WB)
        throw new Error("wayback job on non-archive.org tab — open a web.archive.org research tab for this");
      if(j.type==="cdx_bounds"){const e=await cdxEnds(j.url,j);data=e;ok=!e.error;label=e.error?("error: "+e.error):((e.first?e.first.slice(0,6):"?")+" → "+(e.last?e.last.slice(0,6):"?"));}
      else if(j.type==="cdx_list"){const d=await cdx(j.url,Object.assign({limit:40},j));data=d.error?d:d.slice(0,j.limit||40).map(r=>[r[0],r[1]]);ok=!d.error;label=d.error?("error: "+d.error):(d.length+" matched");}
      else if(j.type==="snapshot_contains"){const s=await snap(j.ts,j.url);const low=s.t.toLowerCase();const f=(j.needles||[]).filter(n=>low.includes(n.toLowerCase()));data={finalUrl:s.u.replace(/\?.*$/,""),bytes:s.t.length,found:f};label=f.length?("found: "+f.join(", ")):"none found";}
      else if(j.type==="bisect_presence"){const d=await cdx(j.url,{from:j.from,to:j.to,match:j.match||"prefix",limit:400});if(d.error||!d.length){data={count:0,error:d.error};ok=false;label="no snapshots";}else{const has=async ts=>{const r=d.find(x=>x[0]===ts);const s=await snap(ts,r?r[1]:j.url);return s.t.toLowerCase().includes(j.needle.toLowerCase());};let lo=0,hi=d.length-1,lt=-1,c=0;while(lo<=hi&&c<12){const m=(lo+hi)>>1;const o=await has(d[m][0]);c++;if(o){lt=m;lo=m+1;}else hi=m-1;}data={first:d[0][0],last:d[d.length-1][0],count:d.length,last_present_ts:lt>=0?d[lt][0]:null,checks:c};label="last present "+(lt>=0?d[lt][0].slice(0,6):"never");}}
      else if(j.type==="snapshot_text"){const s=await snap(j.ts,j.url);const t=stripHtml(s.t);const max=j.max_chars||30000;data={finalUrl:s.u.replace(/\?.*$/,""),bytes:s.t.length,chars:t.length,text:t.slice(0,max),truncated:t.length>max};label="text "+t.length+" chars";}
      // site family
      else if(j.type==="site_fetch_contains"){const s=await siteFetch(j.path);const low=s.t.toLowerCase();const f=(j.needles||[]).filter(n=>low.includes(n.toLowerCase()));data={url:s.u,status:s.status,bytes:s.t.length,found:f};label=(s.status>=400?("HTTP "+s.status+" · "):"")+(f.length?("found: "+f.join(", ")):"none found");ok=s.status<400;}
      else if(j.type==="site_fetch_text"){const s=await siteFetch(j.path);const t=stripHtml(s.t);const max=j.max_chars||5000;data={url:s.u,status:s.status,chars:t.length,text:t.slice(0,max),truncated:t.length>max};label="text "+t.length+" chars";ok=s.status<400;}
      else if(j.type==="site_links"){const s=await siteFetch(j.path);const doc=new DOMParser().parseFromString(s.t,"text/html");let links=Array.prototype.slice.call(doc.querySelectorAll("a[href]")).map(a=>{try{return new URL(a.getAttribute("href"),s.u).href}catch(e){return null}}).filter(Boolean);links=[...new Set(links)];if(j.pattern){const re=new RegExp(j.pattern,"i");links=links.filter(h=>re.test(h));}data={url:s.u,count:links.length,links:links.slice(0,j.limit||50)};label=links.length+" links";}
      else if(j.type==="dom_text"){const el=j.selector?document.querySelector(j.selector):document.body;if(!el)throw new Error("selector not found: "+j.selector);const t=(el.innerText||el.textContent||"").replace(/\s+/g," ").trim();const max=j.max_chars||5000;data={url:location.href,selector:j.selector||"body",chars:t.length,text:t.slice(0,max),truncated:t.length>max};label="dom text "+t.length+" chars";}
      else if(j.type==="dom_contains"){const t=(document.body.innerText||"").toLowerCase();const f=(j.needles||[]).filter(n=>t.includes(n.toLowerCase()));data={url:location.href,found:f};label=f.length?("found: "+f.join(", ")):"none found";}
      else{data={error:"unknown type "+j.type};ok=false;label="unknown type";}
    }catch(e){data={error:String(e).slice(0,160)};ok=false;label="error: "+String(e).slice(0,60);}
    return {data,label,ok};
  }

  async function runQuestions(QUESTIONS){
    const answers={};
    for(let i=0;i<QUESTIONS.length;i++){const q=QUESTIONS[i];sub.textContent="question "+(i+1)+" / "+QUESTIONS.length;
      const opened=q._opened||openPages(q);
      await new Promise(res=>{work.innerHTML="";
        const t=document.createElement("div");t.style.cssText="font-weight:600;margin-bottom:3px";t.textContent="Q"+(i+1)+". "+q.topic;work.appendChild(t);
        const qt=document.createElement("div");qt.style.cssText="margin-bottom:6px;color:#dffaea";qt.textContent=q.question;work.appendChild(qt);
        opened.forEach(o=>{const d=document.createElement("div");d.style.cssText="font-size:12px;margin:2px 0;color:"+(o.ok?"#bff5d2":"#FFD27C");d.innerHTML=(o.ok?"📂 Opened: ":"⚠ blocked — ")+'<a href="'+o.u+'" target="aimb_research" style="color:#cfeede">'+o.u.replace(/^https?:\/\//,"")+'</a>';work.appendChild(d);});
        const btn=(x,bg)=>{const e=document.createElement("button");e.textContent=x;e.style.cssText="display:block;width:100%;text-align:left;margin:5px 0;padding:9px 11px;border:0;border-radius:7px;cursor:pointer;font:13px inherit;background:"+bg+";color:#0a3d20";return e;};
        const finish=(value,label,comment)=>{answers[q.id]={value,label,comment:comment||null};done(q.id,comment?('Other — "'+comment+'"'):label,true);send({type:"answer",id:q.id,value,label,comment:comment||null});if(QUESTIONS[i+1])QUESTIONS[i+1]._opened=openPages(QUESTIONS[i+1]);res();};
        (q.options||[]).forEach(o=>{const e=btn(o.label||o.value,oc(o.color));e.onclick=()=>finish(o.value,o.label||o.value);work.appendChild(e);});
        if(q.allow_other!==false){const ob=btn("✎ Other… (type a comment)","#ffe9b0");ob.onclick=()=>{ob.remove();const ta=document.createElement("textarea");ta.style.cssText="width:100%;height:52px;margin:4px 0;border-radius:6px;border:0;padding:7px;font:13px inherit;background:#fff;color:#0a3d20";ta.placeholder="type your answer…";const sb=btn("Save comment","#7CFFB0");sb.onclick=()=>{const v=ta.value.trim();if(v)finish("other","Other",v);};work.appendChild(ta);work.appendChild(sb);ta.focus();};work.appendChild(ob);}
      });
    }
    return answers;
  }

  async function runJobs(JOBS){
    const research={};work.innerHTML='<div style="height:10px;background:#0a5e2e;border-radius:6px;overflow:hidden"><div id="aimb-bar" style="height:100%;width:0%;background:#7CFFB0"></div></div><div id="aimb-c" style="font-size:12px;margin-top:4px;color:#bff5d2"></div>';
    const bar=work.querySelector("#aimb-bar"),pc=work.querySelector("#aimb-c");
    for(let i=0;i<JOBS.length;i++){const j=JOBS[i];sub.textContent="research "+(i+1)+" / "+JOBS.length+"  "+j.id;
      const r=await runJob(j);
      research[j.id]=r.data;done(j.id,r.label,r.ok);
      send({type:"result",id:j.id,data:r.data});
      send({type:"progress",phase:"research",index:i+1,total:JOBS.length,id:j.id});
      if(bar){bar.style.width=Math.round((i+1)/JOBS.length*100)+"%";pc.textContent=(i+1)+" / "+JOBS.length;}
      await sleep(800);
    }
    return research;
  }

  let running=false;
  async function run(msg){
    if(running){send({type:"refused",reason:"run already active"});return;}
    running=true;
    try{
      const Q=msg.questions||[],J=msg.jobs||[];
      Object.keys(rows).forEach(k=>delete rows[k]);list.innerHTML="";
      Q.forEach(q=>mk(q.id,q.topic,"Q"));J.forEach(j=>mk(j.id,j.id,"J"));
      send({type:"started",questions:Q.length,jobs:J.length,site:location.origin,kind:KIND});
      const answers=await runQuestions(Q);
      const research=await runJobs(J);
      sub.textContent="done — "+Q.length+" answered, "+J.length+" researched";
      send({type:"__done",answers,research});
    }finally{running=false;}
  }
  function onEnvelope(env){
    let body={}; try{ body=JSON.parse(env.body); }catch(e){ body={}; }
    const verb=env.verb||"message";
    if(verb==="research_run"){
      requester=(env.from&&env.from.session)||requester;
      sub.textContent="run received from "+((env.from&&env.from.name)||"?");
      run(body);
    } else if(verb==="ping"){
      requester=(env.from&&env.from.session)||requester;
      send({type:"pong",ua:navigator.userAgent,running:running,site:location.origin,kind:KIND});
    }
  }
  function connect(){
    sub.textContent="connecting to Ai MCP Bridge…";
    sock=new WebSocket(WSURL);
    sock.onopen=()=>{raw({type:"hello",kind:"page",page_kind:KIND,title:TITLE,subject:SUBJECT,instance:INSTANCE,token:TOKEN});};
    sock.onclose=()=>{sub.textContent="disconnected — reconnecting…";setTimeout(connect,2000);};
    sock.onerror=()=>{sub.textContent="ws error (bridge down, or this site's CSP blocks localhost sockets)";};
    sock.onmessage=ev=>{let m;try{m=JSON.parse(ev.data);}catch(e){return;}
      if(m.type==="welcome"){sub.textContent="connected — waiting for a research_run ("+INSTANCE+")";}
      else if(m.type==="envelope"&&m.envelope){onEnvelope(m.envelope);}};
  }
  connect();
  INSTANCE;
})();
