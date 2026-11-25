import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyDashboard} from '../lib/workflow-safety.mjs';
export {verifyDashboard};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const marker='INSTAOPS_TWO_STEP_V1';
const clone=x=>structuredClone(x);
const node=(w,name)=>{const n=w.nodes.find(x=>x.name===name);if(!n)throw Error('Missing expected node: '+name);return n};
const code=(w,name)=>node(w,name).parameters.jsCode;
const set=(w,name,s)=>{new Function(s);node(w,name).parameters.jsCode=s};
function replace(s,a,b){if(!s.includes(a))throw Error('Workflow differs from reviewed version: '+a.slice(0,90));return s.replace(a,b)}
function approve(s){if(s.includes('Extract and upload media before approval'))return s;s=replace(s,"const next=validateDraft(r);if(!text(next.caption||next.original_caption))","const next=validateDraft(r);if(!next.media_url)throw Error('Extract and upload media before approval');if(rows.some(x=>text(x.post_id)!==id&&sourceCode(x.source_instagram_url)&&sourceCode(x.source_instagram_url)===sourceCode(next.source_instagram_url)))throw Error('Source already exists in queue');if(!text(next.caption||next.original_caption))");return replace(s,"status:next.media_url?'READY':'NEW'","status:'READY'")}
export function patchBridge(w){w=clone(w);if(node(w,'Dashboard bridge').parameters.path!=='instagram-manager-sheet-v1')throw Error('Wrong Sheets bridge');set(w,'Validate sheet operation',approve(code(w,'Validate sheet operation')));node(w,'SHEET | Append draft').retryOnFail=false;const n='Validate sheet operation';let c=code(w,n);if(!c.includes('Review snapshot mismatch')){c=replace(c,"if(!next.media_url)throw Error('Extract and upload media before approval');","if(!next.media_url)throw Error('Extract and upload media before approval');if(input.reviewed!==JSON.stringify([next.post_id,next.source_instagram_url,next.media_url,next.media_type,next.caption.trim()||next.original_caption,next.publish_mode,next.publish_at,next.account_key,next.ig_user_id].map(text)))throw Error('Review snapshot mismatch');");set(w,n,c);}return w}
export function patchDashboard(w){w=clone(w);if(node(w,'DASHBOARD | Run request').parameters.path!=='instagram-manager-run-v1')throw Error('Wrong dashboard workflow');
 if(code(w,'DASHBOARD | Validate command').includes(marker)){hardenDashboard(w);verifyDashboard(w);return w;}
 // Keep the schedule node and exact graph. Scheduled mode can publish only READY LATER posts when due.
 set(w,'CONFIG | Scheduled AUTO',`// ${marker}: scheduled publication only; never ingest drafts or publish NOW rows.\nreturn [{json:{mode:'PUBLISH',post_id:'',manual:false,max_rows:5,fallback:false,started:Date.now()}}];`);
 for(const name of ['QUEUE | Plan and explain','CURRENT | Revalidate row']){
  let s=code(w,name);s=replace(s,"const protectedSources=new Set", "const sourceCounts=new Map();for(const r of rows){const k=sc(r.source_instagram_url);if(k)sourceCounts.set(k,(sourceCounts.get(k)||0)+1);}\n const protectedSources=new Set");
  s=replace(s,"else if(short&&protectedSources.has(short))", "else if(short&&sourceCounts.get(short)>1)reason='Duplicate source; keep one row per Reel/image';\n  else if(!cfg.manual&&(status!=='READY'||pm!=='LATER'||cfg.mode!=='PUBLISH'))reason='Scheduled execution only publishes approved LATER posts';\n  else if(short&&protectedSources.has(short))");
  s=replace(s,"const intent=['NEW','READY'].includes(status)?status:status==='ERROR'||status==='RETRY'?old.intent:'DRAFT';", "const intent=cfg.mode==='INGEST'?'DRAFT':['NEW','READY'].includes(status)?status:status==='ERROR'||status==='RETRY'?old.intent:'DRAFT';");
  s=replace(s,"const allowed=r=>cfg.mode==='AUTO'?['PUBLISH','INGEST'].includes(r.action):r.action===cfg.mode;", "const allowed=r=>cfg.mode!=='AUTO'&&r.action===cfg.mode&&(!cfg.manual||!['INGEST','PUBLISH','AI_RETRY'].includes(cfg.mode)||!!cfg.post_id&&r.post_id===cfg.post_id);");
  set(w,name,s);
 }
 for(const name of ['VALIDATE | Cloudinary result','VALIDATE | Retry result'])set(w,name,replace(code(w,name),"status:ok?(approved?'READY':'DRAFT'):'ERROR'","status:ok?'DRAFT':'ERROR'"));
 set(w,'GUARD | Saved media',replace(code(w,'GUARD | Saved media'),"action:s.mode==='AUTO'&&r.status==='READY'&&due&&caption&&caption.length<=2200?'PUBLISH':'MEDIA_SAVED'","action:'MEDIA_SAVED'"));
 let s=approve(code(w,'DASHBOARD | Validate command'));s=replace(s,'const cfg=runInput(body);return',`// ${marker}\nconst cfg=runInput(body);if(cfg.mode==='AUTO')throw Error('Bulk AUTO disabled');if(['INGEST','PUBLISH','AI_RETRY'].includes(cfg.mode)){if(!cfg.post_id||body.authorized!==true)throw Error('Select one authorized post');cfg.max_rows=1;}if(cfg.mode==='PUBLISH'&&body.confirm!==true)throw Error('Confirm publication');return`);set(w,'DASHBOARD | Validate command',s);
 // Manual editor entry remains diagnostic; if later changed to a mutation, require a target.
 s=code(w,'CONFIG | Manual mode');s=replace(s,"if(mode==='AI_RETRY'&&!post_id)throw Error('AI_RETRY requires POST_ID');","if(mode==='AUTO')throw Error('Bulk AUTO disabled');if(['INGEST','PUBLISH','AI_RETRY'].includes(mode)&&!post_id)throw Error('POST_ID is required');");s=replace(s,'max_rows:Math.min(10,Math.max(1,MAX_ROWS))','max_rows:post_id?1:Math.min(10,Math.max(1,MAX_ROWS))');set(w,'CONFIG | Manual mode',s);
 hardenDashboard(w);return w;
}
function hardenDashboard(w){
 const n='DASHBOARD | Validate command';let c=code(w,n);if(!c.includes('Reviewed content required')){c=replace(c,"if(cfg.mode==='PUBLISH'&&body.confirm!==true)throw Error('Confirm publication');","if(cfg.mode==='PUBLISH'&&body.confirm!==true)throw Error('Confirm publication');if(cfg.mode==='PUBLISH'&&typeof body.reviewed!=='string')throw Error('Reviewed content required');");c=replace(c,'trigger_source:"DASHBOARD"','reviewed:body.reviewed,trigger_source:"DASHBOARD"');set(w,n,c);}
 set(w,'PUBLISH | Validate approved context',`const r=$input.first().json,cfg=$('CONFIG | Run context').first().json;if(r.action!=='PUBLISH'||cfg.mode!=='PUBLISH'||r.source_status!=='READY'||!r.media_url||!r.caption||r.caption.length>2200||!['REEL','IMAGE'].includes(r.media_type)||!r.due)throw Error('Publish guard failed');if(cfg.manual){if(cfg.post_id!==r.post_id||cfg.reviewed!==JSON.stringify([r.post_id,r.source,r.media_url,r.media_type,r.caption,r.publish_mode,r.publish_at,r.account_key,r.ig_user_id].map(v=>String(v??'').trim())))throw Error('Reviewed content changed or target mismatch');}else if(r.publish_mode!=='LATER')throw Error('Scheduled NOW publication forbidden');return [{pairedItem:{item:0},json:r}];`);
}

const payload=w=>{const {name,nodes,connections,settings}=w;return {name,nodes,connections,settings};};
export async function applyLiveChanges(api,changes){
 const ref=c=>'workflows/'+encodeURIComponent(c.wid);
 const idle=async c=>{const r=await api('executions?workflowId='+encodeURIComponent(c.wid)+'&limit=50');if(!Array.isArray(r.data)||r.data.some(e=>['running','waiting','new','unknown'].includes(e.status)))throw Error('Executions not confirmed idle: '+c.name);};
 const pause=async c=>{if((await api(ref(c))).active)await api(ref(c)+'/deactivate','POST');if((await api(ref(c))).active)throw Error('Could not pause '+c.name);};
 const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b)); // compare critical graph fields independent of server metadata
 const verify=(a,b)=>{for(const n of b.nodes){const m=a.nodes.find(x=>x.id===n.id);if(!m||m.name!==n.name||!!m.disabled!==!!n.disabled||!!m.retryOnFail!==!!n.retryOnFail||!same(m.credentials,n.credentials)||!same(m.parameters,n.parameters))throw Error('Updated node differs: '+n.name);}if(a.nodes.length!==b.nodes.length||!same(a.connections,b.connections))throw Error('Updated graph differs');};
 const attempted=[];let began=false;
 try{
  for(const c of changes)await idle(c);
  began=true;for(const c of [...changes].reverse())await pause(c);
  for(const c of changes)await idle(c);
  for(const c of changes){attempted.push(c);await api(ref(c),'PUT',payload(c.next));const checked=await api(ref(c));verify(checked,c.next);if(c.name==='dashboard')verifyDashboard(checked);else if(node(checked,'SHEET | Append draft').retryOnFail!==false)throw Error('Bridge append retry still enabled');console.log('Updated existing '+c.name+' workflow '+c.wid);}
  const bridge=changes[0];if(bridge.current.active){await api(ref(bridge)+'/activate','POST');if(!(await api(ref(bridge))).active)throw Error('Bridge reactivation not confirmed');}
 }catch(e){
  if(!began)throw e;
  const errors=[];for(const c of [...changes].reverse())try{await pause(c);await idle(c);}catch(x){errors.push(c.name+': '+x.message);}
  if(!errors.length){for(const c of [...attempted].reverse())try{await api(ref(c),'PUT',payload(c.current));verify(await api(ref(c)),c.current);}catch(x){errors.push(c.name+' rollback: '+x.message);}}
  // Never reactivate the legacy dashboard automatically. Restore bridge only after successful rollback.
  if(!errors.length&&changes[0].current.active)try{await api(ref(changes[0])+'/activate','POST');if(!(await api(ref(changes[0]))).active)throw Error('Bridge reactivation not confirmed');}catch(x){errors.push('bridge: '+x.message);}
  throw Error(e.message+(errors.length?'; rollback incomplete: '+errors.join('; '):'; prior definitions restored where changed; dashboard intentionally inactive.'));
 }
}
async function main(){
 const live=process.argv.includes('--live');const date=new Date().toISOString().replace(/[:.]/g,'-');const backup=path.join(root,'.local-data','two-step-backup-'+date);await fs.mkdir(backup,{recursive:true});
 const files=[['sheets-bridge.json',patchBridge],['v10-dashboard.json',patchDashboard]];
 const prepared=[];for(const [name,patch] of files){const file=path.join(root,'n8n',name),raw=await fs.readFile(file,'utf8');const next=patch(JSON.parse(raw));await fs.writeFile(path.join(backup,name),raw);prepared.push({file,next});}
 if(live){
  const base=(process.env.N8N_BASE_URL||'http://localhost:5678').replace(/\/$/,'');const url=new URL(base);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only local n8n supported');const key=process.env.N8N_API_KEY,id=process.env.N8N_WORKFLOW_ID,bridge=process.env.N8N_BRIDGE_WORKFLOW_ID||'zLmbbNHZIih9X3Hz';if(!key||!id||id===bridge)throw Error('Check .env.local workflow IDs and API key');
  async function api(p,method='GET',body){const r=await fetch(base+'/api/v1/'+p,{method,headers:{'X-N8N-API-KEY':key,...(method==='GET'?{}:{'Content-Type':'application/json'})},...(method==='GET'?{}:{body:JSON.stringify(body??{})}),signal:AbortSignal.timeout(60000)});const raw=await r.text();if(!r.ok)throw Error(`${method} ${p} returned HTTP ${r.status}. Inspect n8n locally (no credentials printed).`);return JSON.parse(raw)}
  const changes=[];for(const [wid,patch,name] of [[bridge,patchBridge,'bridge'],[id,patchDashboard,'dashboard']]){const current=await api('workflows/'+encodeURIComponent(wid));const runs=await api('executions?workflowId='+encodeURIComponent(wid)+'&limit=50');if(runs.data?.some(r=>['running','waiting','new'].includes(r.status)))throw Error('Wait for running executions to finish: '+name);const next=patch(current);if(name==='dashboard')node(next,'SCHEDULE | Every 30 minutes').disabled=true;await fs.writeFile(path.join(backup,name+'-LIVE.json'),JSON.stringify(current,null,2));changes.push({wid,current,next,name});}
  // Verify original v10 is inactive if it is present; do not change it.
  const original=await api('workflows/0ma9ONqTpdlUhJ8j');if(original?.active)throw Error('Deactivate original v10 first');
  await applyLiveChanges(api,changes);
  console.log('Live update complete. Dashboard intentionally inactive. Verify credentials and publish in n8n.');
 }
 for(const {file,next} of prepared){await fs.writeFile(file,JSON.stringify(next,null,2)+'\n');}
 console.log('Workflow exports updated. Local backups: '+backup);console.log('Do not commit these exports or backups; they may contain credentials.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);console.error('Do not blindly retry. Check live workflow state and local backups.');process.exitCode=1});