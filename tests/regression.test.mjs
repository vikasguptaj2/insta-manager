import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reviewSnapshot} from '../lib/domain.mjs';
import {guardedCommand} from '../lib/local-guard.mjs';
import {extractionCooldown} from '../lib/rate-limit.mjs';
import {postEligibility,postProgress,reconcileJob,isActiveExecStatus,isTerminalExecStatus} from '../lib/post-ui.mjs';
import {detail,mutate,overview,runs,trigger,normalizeExecutionStatus} from '../lib/server.mjs';

const prevLock=process.env.INSTAOPS_LOCK_DIR;
const lockDir=fs.mkdtempSync(path.join(os.tmpdir(),'instaops-regression-'));
process.env.INSTAOPS_LOCK_DIR=lockDir;
process.env.N8N_API_KEY='mock-api';
process.env.N8N_WORKFLOW_ID='wf-two-step';
process.env.N8N_WEBHOOK_SECRET='mock-secret';
process.env.N8N_BASE_URL='http://127.0.0.1:5678';
process.env.DEMO_MODE='false';

const workflow={...JSON.parse(fs.readFileSync(new URL('../n8n/v10-dashboard.json',import.meta.url))),id:'wf-two-step',active:true};
const mediaUrl='https://res.cloudinary.com/djkkknb9k/video/upload/v1/sm_new_08.mp4';
const basePost=(id,sc,extra={})=>({
  post_id:id,
  source_instagram_url:`https://www.instagram.com/reel/${sc}/`,
  media_url:'',
  media_type:'REEL',
  original_caption:'',
  caption:'',
  account_key:'',
  ig_user_id:'',
  publish_mode:'NOW',
  publish_at:'',
  status:'DRAFT',
  published_id:'',
  published_url:'',
  error:'',
  processed_at:'',
  ...extra
});

test('extraction completion & post progress indicate 3/5 DRAFT ready for caption review/publish',()=>{
  const extracted=basePost('SM-NEW-08','SMNEW08',{
    media_url:mediaUrl,
    original_caption:'Extracted original caption',
    status:'DRAFT'
  });
  const prog=postProgress(extracted);
  assert.equal(prog.completed,3);
  assert.equal(prog.total,5);
  assert.match(prog.summary,/Ready to publish/);

  const elig=postEligibility(extracted,{rows:[extracted],canWrite:true,pipelineReady:true});
  assert.equal(elig.extract.enabled,false);
  assert.equal(elig.extract.reason,'Media already stored in Cloudinary.');
  assert.equal(elig.publish.enabled,true);
  assert.equal(elig.publish.label,'Publish to Instagram');
});

test('historical error and rate limit on unrelated post do not block publication of prepared post',async()=>{
  const prepared=basePost('SM-NEW-08','SMNEW08',{
    media_url:mediaUrl,
    original_caption:'Extracted original caption',
    status:'DRAFT',
    publish_mode:'NOW',
    publish_at:'stale-not-used-in-now-mode'
  });
  const unrelatedErr=basePost('SM-OLD-01','SMOLD01',{
    status:'ERROR',
    error:'Downloader RATE_LIMIT retry-until=2099-01-01T00:00:00.000Z',
    processed_at:new Date().toISOString()
  });
  const dupA=basePost('DUP-1','SAME111');
  const dupB=basePost('DUP-2','SAME111');
  const rows=[prepared,unrelatedErr,dupA,dupB];
  const cooldown=extractionCooldown(rows);
  assert.equal(cooldown.blocked,true);

  const eligPrepared=postEligibility(prepared,{rows,canWrite:true,pipelineReady:true,cooldown});
  assert.equal(eligPrepared.publish.enabled,true);
  assert.equal(eligPrepared.extract.enabled,false);

  const eligErr=postEligibility(unrelatedErr,{rows,canWrite:true,pipelineReady:true,cooldown});
  assert.equal(eligErr.extract.enabled,false);
  assert.match(eligErr.extract.reason,/cooldown/);
  assert.equal(eligErr.publish.enabled,false);
  assert.equal(eligErr.publish.reason,'Extract & upload media to Cloudinary first.');

  const eligDup=postEligibility(dupA,{rows,canWrite:true,pipelineReady:true});
  assert.equal(eligDup.extract.enabled,false);
  assert.equal(eligDup.publish.enabled,false);
  assert.match(eligDup.extract.reason,/Duplicate Instagram source URL/);
  assert.match(eligDup.publish.reason,/Duplicate Instagram source URL/);

  const origFetch=globalThis.fetch;
  let sheetRows=structuredClone(rows);
  const ops=[];
  globalThis.fetch=async(url,opts)=>{
    const p=new URL(url).pathname;
    const body=opts?.body?JSON.parse(opts.body):null;
    if(p.endsWith('/executions'))return Response.json({data:[]});
    if(p.endsWith('/executions/701'))return Response.json({id:'701',workflowId:'wf-two-step',status:'success',finished:true});
    if(p.endsWith('/workflows/wf-two-step'))return Response.json(workflow);
    if(p.endsWith('/instagram-manager-sheet-v1')){
      if(body.action==='LIST')return Response.json({ok:true,rows:sheetRows});
      if(body.action==='APPROVE'){
        const targetRow=sheetRows.find(r=>r.post_id===body.input.post_id);
        const snap=reviewSnapshot(targetRow);
        assert.equal(body.input.reviewed,snap);
        const updated={...targetRow,status:'READY',account_key:'A',ig_user_id:'17841453414532595',publish_at:''};
        sheetRows=sheetRows.map(r=>r.post_id===updated.post_id?updated:r);
        ops.push('APPROVE:'+updated.post_id);
        return Response.json({ok:true,row:updated});
      }
    }
    if(p.endsWith('/instagram-manager-run-v1')){
      ops.push(`${body.mode}:${body.post_id}:${body.max_rows}`);
      return Response.json({accepted:true,execution_id:'701'});
    }
    throw Error('Unexpected URL '+p);
  };
  try{
    const res=await trigger({
      mode:'PUBLISH',
      post_id:'SM-NEW-08',
      authorized:true,
      confirm:true,
      reviewed:reviewSnapshot(prepared)
    });
    assert.equal(res.accepted,true);
    assert.equal(res.execution_id,'701');
    assert.deepEqual(ops,['APPROVE:SM-NEW-08','PUBLISH:SM-NEW-08:1']);
    assert.equal(sheetRows.find(r=>r.post_id==='SM-NEW-08').status,'READY');
  }finally{
    globalThis.fetch=origFetch;
  }
});

test('stale execution status & finished-without-status handling plus active execution preservation',async()=>{
  assert.equal(normalizeExecutionStatus({finished:true,stoppedAt:'2026-11-26T10:00:00Z'}),'success');
  assert.equal(normalizeExecutionStatus({status:'running',finished:true,stoppedAt:'2026-11-26T10:00:00Z'}),'success');
  assert.equal(normalizeExecutionStatus({status:'running',finished:true,data:{resultData:{error:{message:'Boom'}}}}),'error');
  assert.equal(normalizeExecutionStatus({status:'running',finished:false,stoppedAt:null}),'running');

  assert.equal(isTerminalExecStatus({status:'running',finished:true}),true);
  assert.equal(isActiveExecStatus({status:'running',finished:true}),false);
  assert.equal(isActiveExecStatus({status:'running',finished:false}),true);

  const reconciled=reconcileJob(
    {id:'432',post_id:'SM-NEW-08',mode:'INGEST',done:false},
    [{id:'432',status:'success',finished:true,stoppedAt:'2026-11-26T10:00:00Z'}]
  );
  assert.equal(reconciled.done,true);
  assert.equal(reconciled.detail.status,'success');

  const origFetch=globalThis.fetch;
  let exec432={id:'432',workflowId:'wf-two-step',status:'running',finished:false,stoppedAt:null};
  globalThis.fetch=async(url,opts)=>{
    const p=new URL(url).pathname;
    if(p.endsWith('/executions/432'))return Response.json(exec432);
    if(p.endsWith('/executions'))return Response.json({data:[exec432]});
    if(p.endsWith('/workflows/wf-two-step'))return Response.json(workflow);
    if(p.endsWith('/instagram-manager-sheet-v1'))return Response.json({ok:true,rows:[]});
    throw Error('Unexpected URL '+p);
  };
  try{
    const live=await detail('432');
    assert.equal(live.status,'running');
    assert.equal(isActiveExecStatus(live),true);

    exec432={id:'432',workflowId:'wf-two-step',finished:true,stoppedAt:'2026-11-26T10:01:00Z'};
    const finished=await detail('432');
    assert.equal(finished.status,'success');
    assert.equal(isTerminalExecStatus(finished),true);
    const list=await runs();
    assert.equal(list[0].status,'success');
  }finally{
    globalThis.fetch=origFetch;
  }
});

test('durable command lock operates directly inside lib/server.mjs and preserves running lock',async()=>{
  const subDir=fs.mkdtempSync(path.join(os.tmpdir(),'instaops-durable-'));
  const prev=process.env.INSTAOPS_LOCK_DIR;
  process.env.INSTAOPS_LOCK_DIR=subDir;
  const origFetch=globalThis.fetch;
  const pendingPath=path.join(subDir,'pending-command.json');
  let status432='running';

  globalThis.fetch=async(url,opts)=>{
    const p=new URL(url).pathname;
    const body=opts?.body?JSON.parse(opts.body):null;
    if(p.endsWith('/executions/432'))return Response.json({id:'432',workflowId:'wf-two-step',status:status432,finished:status432!=='running'});
    if(p.endsWith('/executions'))return Response.json({data:[]});
    if(p.endsWith('/workflows/wf-two-step'))return Response.json(workflow);
    if(p.endsWith('/instagram-manager-sheet-v1'))return Response.json(body.action==='LIST'?{ok:true,rows:[]}:{ok:true,row:{...body.input,status:'DRAFT'}});
    throw Error('Unexpected URL '+p);
  };

  try{
    fs.writeFileSync(pendingPath,JSON.stringify({operation:'run',execution_id:'432',state:'accepted'}));
    const ov=await overview();
    assert.equal(ov.pendingCommand.pending.execution_id,'432');

    // Direct call to mutate (bypassing route.js) must respect pending-command.json without clearing active run #432
    await assert.rejects(
      mutate('CREATE',{post_id:'NEW-1',source_instagram_url:'https://www.instagram.com/reel/NEW001/',media_type:'REEL',publish_mode:'NOW',authorized:true}),
      /Previous execution #432 still running or unconfirmed/
    );
    assert.equal(fs.existsSync(pendingPath),true);

    // Once #432 reaches terminal status in n8n, direct server write reconciles lock & executes cleanly
    status432='success';
    const createdDirect=await mutate('CREATE',{post_id:'NEW-1',source_instagram_url:'https://www.instagram.com/reel/NEW001/',media_type:'REEL',publish_mode:'NOW',authorized:true});
    assert.equal(createdDirect.ok,true);
    assert.equal(fs.existsSync(pendingPath),false);

    // Nested route.js guardedCommand -> server.mjs exclusive composition must not self-deadlock
    const createdNested=await guardedCommand(
      ()=>mutate('CREATE',{post_id:'NEW-2',source_instagram_url:'https://www.instagram.com/reel/NEW002/',media_type:'REEL',publish_mode:'NOW',authorized:true}),
      {directory:subDir,inspect:detail,operation:'posts'}
    );
    assert.equal(createdNested.ok,true);
    assert.equal(fs.existsSync(pendingPath),false);
  }finally{
    globalThis.fetch=origFetch;
    fs.rmSync(subDir,{recursive:true,force:true});
    process.env.INSTAOPS_LOCK_DIR=prev;
  }
});

test.after(()=>{
  fs.rmSync(lockDir,{recursive:true,force:true});
  if(prevLock===undefined)delete process.env.INSTAOPS_LOCK_DIR;
  else process.env.INSTAOPS_LOCK_DIR=prevLock;
});
