import fs from 'node:fs/promises';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
export const MAX_BODY=1024*1024;
const hosts=new Set(['localhost:3000','127.0.0.1:3000']);
export function checkLocal(req,write=false){
 const host=req.headers.get('host');
 if(!hosts.has(host))throw Object.assign(Error('Untrusted Host'),{status:403});
 const origin=req.headers.get('origin');
 if((write||origin!==null)&&origin!==`http://${host}`)throw Object.assign(Error('Same-origin request required'),{status:403});
 if(req.headers.get('sec-fetch-site')==='cross-site')throw Object.assign(Error('Cross-site request rejected'),{status:403});
 if(write&&req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Object.assign(Error('JSON required'),{status:415});
}
export async function readBody(req){
 const len=req.headers.get('content-length');if(len!==null&&(!/^\d+$/.test(len)||Number(len)>MAX_BODY))throw Object.assign(Error('Request too large'),{status:413});
 if(!req.body)throw Error('JSON body required');const reader=req.body.getReader();let size=0;const chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw Object.assign(Error('Request too large'),{status:413});}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error('JSON object required');return data;
}
const terminal=new Set(['success','error','crashed','canceled','cancelled']);
const activeDir=new AsyncLocalStorage();
export const defaultLockDir=()=>process.env.INSTAOPS_LOCK_DIR||path.join(process.cwd(),'.local-data');
const isTerminalDetail=d=>{
 const s=String(d?.status??'').trim().toLowerCase();
 if(terminal.has(s))return true;
 if(d?.finished===true&&!['running','new','waiting'].includes(s))return true;
 if(d?.stoppedAt&&(!s||s==='unknown'))return true;
 return false;
};
/** Read local lock and pending command marker without clearing or altering lock state. */
export async function readLockStatus(directory=defaultLockDir()){
 const dir=path.resolve(directory),lock=path.join(dir,'command.lock'),pending=path.join(dir,'pending-command.json');
 let locked=false;try{await fs.access(lock);locked=true;}catch{}
 let pendingData=null,corrupt=false;
 try{pendingData=JSON.parse(await fs.readFile(pending,'utf8'));}catch(e){if(e.code!=='ENOENT')corrupt=true;}
 return {locked,pending:pendingData,corrupt};
}
// Local dashboard only. A crashed command never expires automatically; inspect n8n before clearing it.
export async function guardedCommand(fn,{directory=defaultLockDir(),inspect,operation='command'}={}){
 const dir=path.resolve(directory);
 if(activeDir.getStore()===dir)return fn();
 await fs.mkdir(dir,{recursive:true});const lock=path.join(dir,'command.lock'),pending=path.join(dir,'pending-command.json');let fd;
 try{fd=await fs.open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('Another command is running or interrupted. Inspect n8n before clearing command.lock.'),{status:409});throw e;}
 return activeDir.run(dir,async()=>{
  try{
   let prior;try{prior=JSON.parse(await fs.readFile(pending,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Pending command record unreadable; inspect before recovery');}
   if(prior){if(!prior.execution_id||!inspect)throw Object.assign(Error('Previous command outcome unknown. Inspect n8n and Sheets before clearing pending-command.json.'),{status:409});let d;try{d=await inspect(prior.execution_id)}catch{throw Object.assign(Error(`Previous execution #${prior.execution_id} not yet confirmed; inspect n8n before retrying.`),{status:409});}if(!isTerminalDetail(d))throw Object.assign(Error(`Previous execution #${prior.execution_id} still running or unconfirmed (status: ${String(d?.status||'unknown').toLowerCase()}).`),{status:409});await fs.unlink(pending);}
   // Write intent before external side effects. On process crash, both files remain for manual reconciliation.
   await fs.writeFile(pending,JSON.stringify({operation,started:new Date().toISOString(),state:'pending'}),{flag:'wx',mode:0o600});
   let result;try{result=await fn();}catch(e){if(!/outcome unknown|not confirmed|timed out|timeout|Cannot reach|HTTP 5\d\d|non-JSON|State not confirmed/i.test(e.message))await fs.unlink(pending).catch(()=>{});throw e;}
   if(result?.accepted&&result.execution_id&&!result.demo){const tmp=pending+'.tmp';await fs.writeFile(tmp,JSON.stringify({operation,execution_id:String(result.execution_id),state:'accepted'}),{mode:0o600});await fs.rename(tmp,pending);}else await fs.unlink(pending);return result;
  }finally{await fd.close();await fs.unlink(lock).catch(()=>{});}
 });
}