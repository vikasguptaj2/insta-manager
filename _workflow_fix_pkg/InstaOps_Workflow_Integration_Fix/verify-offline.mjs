import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const names=fs.readdirSync(path.join(dir,'workflows')).filter(s=>s.endsWith('.json')).sort();
let total=0,ifs=0,expressions=0,code=0,tests=0;
const all=new Map();
function check(x){assert.ok(x);tests++}
function visit(v){if(typeof v==='string'&&v.includes('{{')){if(v.startsWith('={{')&&v.endsWith('}}')){new Function('$json','$input','$','$vars','$now',`return (${v.slice(3,-2)});`);expressions++;}else if(v.startsWith('{{'))throw new Error('Missing expression prefix');}else if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')Object.values(v).forEach(visit);}
for(const file of [...names,'../00-manual-credential-check.json']){
 const w=JSON.parse(fs.readFileSync(path.join(dir,'workflows',file),'utf8'));all.set(file,w);total+=w.nodes.length;
 check(w.active===false);const map=new Map(w.nodes.map(n=>[n.name,n]));check(map.size===w.nodes.length);check(new Set(w.nodes.map(n=>n.id)).size===w.nodes.length);
 const starts=w.nodes.filter(n=>/webhook$|scheduleTrigger$|manualTrigger$/.test(n.type));check(starts.length===1);const todo=[starts[0].name],seen=new Set();
 while(todo.length){const name=todo.pop();if(seen.has(name))continue;seen.add(name);for(const b of w.connections[name]?.main||[])for(const e of b){check(map.has(e.node));todo.push(e.node)}}check(seen.size===w.nodes.length);
 for(const n of w.nodes){const p=n.parameters||{};
  if(n.type.endsWith('.if')){ifs++;check(n.typeVersion===2);check(Array.isArray(p.conditions.conditions)&&p.conditions.conditions.length>0);check(!p.conditions.boolean&&!p.conditions.string)}
  if(n.type.endsWith('.code')){new Function('$input','$json','$vars','$env','$execution','$',p.jsCode);code++;check(!/\bfetch\s*\(|helpers\.httpRequest|cldSecCfg|cldKeyCfg/.test(p.jsCode))}else visit(p);
  if(n.type.endsWith('.webhook'))check(p.authentication==='headerAuth'&&n.credentials.httpHeaderAuth.id==='CONFIGURE_WEBHOOK');
  if(n.type.endsWith('.scheduleTrigger'))check(n.disabled===true);
  if(p.genericAuthType){check(!!n.credentials?.[p.genericAuthType]);if(p.genericAuthType==='httpHeaderAuth'){const role=(p.url.includes('graph.facebook.com')||p.url.includes('graph_url')||p.url.includes('poll_url'))?'META':p.url.includes('/api/n8n/resolve')?'DOWNLOADER':'WEBHOOK';check(n.credentials.httpHeaderAuth.id===`CONFIGURE_${role}`)}}
  if(n.name==='HTTP | Cloudinary Upload Asset'||n.name==='HTTP | Cloudinary Destroy Asset'){check(p.genericAuthType==='httpBasicAuth');check(p.bodyParameters.parameters.every(x=>!['signature','api_key','timestamp'].includes(x.name)))}
 }
 console.log(file+': '+w.nodes.length+' nodes; graph, syntax and credential schema checks passed (header credentials require binding)');
}
const get=(prefix,name)=>[...all].find(([f])=>f.startsWith(prefix))[1].nodes.find(n=>n.name===name).parameters.jsCode;
function run(js,raw,refs={}){return new Function('$input','$json','$vars','$env','$execution','$',js)({first:()=>({json:raw}),all:()=>[{json:raw}]},raw,{},{},{id:'test'},name=>({first:()=>({json:refs[name]}),last:()=>({json:refs[name]})}));}
for(const [prefix,name,good,bad] of [['01','CHECK | Renew Extract Lock',{statusCode:200,body:[{renewed:true}]},{statusCode:200,body:[{renewed:false}]}],['02','CHECK | Renew Lock Before Publish',{statusCode:200,body:[{renewed:true}]},{statusCode:200,body:[{renewed:false}]}],['02','CHECK | Persist Published ID Immediately',{statusCode:200,body:[{id:'post',published_id:'123456789',status:'PUBLISHED'}]},{statusCode:200,body:[]}],['01','CHECK | Supabase Finalize Extraction',{statusCode:200,body:{id:'post',status:'DRAFT'}},{statusCode:500,body:{}}]]){
 const js=get(prefix,name);run(js,good,{'CODE | Classify Media Publish Outcome':{published_id:'123456789'}});tests++;assert.throws(()=>run(js,bad));tests++;assert.throws(()=>run(js,{statusCode:503,body:{}}));tests++;
}
let js=get('02','CODE | Verify Auth & Approval Gate');const denied=run(js,{body:{confirm:true,post_uuid:'11111111-1111-4111-8111-111111111111',post_id:'TEST',reviewed_revision:'1'}})[0].json;check(!denied.valid&&denied.httpStatus===409);
js=get('03','CODE | Check Schedule Gate & Read Config');check(run(js,{})[0].json.enabled===false);
js=get('04','CODE | Validate Content & Sync Action');check(run(js,{body:{action:'DELETE_POST',confirm:true}})[0].json.valid===false);
js=get('05','CODE | Strict Container & Publication Match');check(run(js,{}, {'CODE | Route Reconciliation Mode':{row:{id:'x',post_id:'P'}}})[0].json.verified===false);
console.log(`PASS: ${total} nodes, ${ifs} IF conditions, ${code} Code-node syntax checks, ${expressions} expression checks, ${tests} assertions. Offline checks only; actual n8n runtime and credential contents not verified.`);
