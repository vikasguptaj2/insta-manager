import {locked,sourceCode,text,validMedia} from './domain.mjs';

export const ACTIVE_EXECUTION_STATUSES=new Set(['running','new','waiting']);
export const TERMINAL_EXECUTION_STATUSES=new Set(['success','error','crashed','canceled','cancelled']);
const IN_FLIGHT_POST_STATUSES=new Set(['INGESTING','PROCESSING','AI_PROCESSING']);
const ISO_TZ_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function readExecStatus(execOrStatus){
  if(typeof execOrStatus==='string')return {raw:execOrStatus.trim().toLowerCase(),obj:null};
  return {raw:String(execOrStatus?.status??'').trim().toLowerCase(),obj:execOrStatus??null};
}

/** Return true only when an execution is still active in n8n. */
export function isActiveExecStatus(execOrStatus){
  const {raw,obj}=readExecStatus(execOrStatus);
  if(obj&&(obj.finished===true||(Boolean(obj.stoppedAt)&&obj.finished!==false)))return false;
  if(ACTIVE_EXECUTION_STATUSES.has(raw))return true;
  if(obj&&obj.finished===false&&(!raw||raw==='unknown'))return true;
  return false;
}

/** Return true once an execution has reached a terminal state or completed in n8n. */
export function isTerminalExecStatus(execOrStatus){
  const {raw,obj}=readExecStatus(execOrStatus);
  if(TERMINAL_EXECUTION_STATUSES.has(raw))return true;
  if(!obj)return false;
  if(obj.finished===true)return true;
  if(obj.stoppedAt&&obj.finished!==false&&(!raw||raw==='unknown'))return true;
  return false;
}

/** Reconcile active client job state against fresh overview execution history. */
export function reconcileJob(job,runs=[]){
  if(!job?.id||job.done)return job;
  const matched=(runs??[]).find(r=>String(r.id)===String(job.id));
  if(job.detail&&isTerminalExecStatus(job.detail))return {...job,done:true};
  if(matched&&isTerminalExecStatus(matched)){
    return {
      ...job,
      done:true,
      pollError:'',
      detail:{
        ...(job.detail??{}),
        id:String(matched.id),
        status:String(matched.status??'success').toLowerCase(),
        stoppedAt:matched.stoppedAt??job.detail?.stoppedAt??null,
        finished:matched.finished??true
      }
    };
  }
  if(matched&&!job.detail){
    return {
      ...job,
      detail:{
        id:String(matched.id),
        status:String(matched.status??'').toLowerCase()||'unknown',
        startedAt:matched.startedAt,
        stoppedAt:matched.stoppedAt,
        finished:matched.finished
      }
    };
  }
  return job;
}

/** Compute per-post pipeline progress and active execution attribution. */
export function postProgress(row,{job=null,runs=[]}={}){
  const id=text(row?.post_id);
  const status=text(row?.status).toUpperCase()||'DRAFT';
  const hasCaption=!!text(row?.caption||row?.original_caption);
  const hasValidMedia=validMedia(row?.media_url,row?.media_type);
  const stages=[
    {key:'draft',label:'1 · Draft stored in Google Sheets',done:true},
    {key:'caption',label:'2 · Original caption available',done:hasCaption},
    {key:'media',label:'3 · Media saved to Cloudinary',done:hasValidMedia},
    {key:'approved',label:'4 · Approved for publication (READY)',done:['READY','PUBLISHED'].includes(status)},
    {key:'published',label:'5 · Published on Instagram',done:status==='PUBLISHED'}
  ];
  const completed=stages.filter(s=>s.done).length;
  const total=stages.length;
  const activeRun=(runs??[]).find(isActiveExecStatus)||null;
  let activeExec=null;
  if(job&&!job.done&&id&&job.post_id===id){
    activeExec={id:String(job.id),mode:job.mode||'',status:String(job.detail?.status||'accepted').toLowerCase()};
  }else if(activeRun&&IN_FLIGHT_POST_STATUSES.has(status)){
    activeExec={id:String(activeRun.id),mode:'',status:String(activeRun.status||'running').toLowerCase()};
  }
  let summary=`${completed}/${total} · Ready to extract`;
  if(activeExec)summary=`Running #${activeExec.id} (${activeExec.mode||activeExec.status})`;
  else if(status==='PUBLISHED')summary=`${completed}/${total} · Published`;
  else if(status==='VERIFY_MANUALLY')summary='Verify manually on Instagram';
  else if(IN_FLIGHT_POST_STATUSES.has(status))summary=`In progress (${status})`;
  else if(hasValidMedia&&status==='READY')summary=`${completed}/${total} · Approved (READY)`;
  else if(hasValidMedia&&hasCaption)summary=`${completed}/${total} · Extracted · Ready to publish`;
  else if(hasValidMedia)summary=`${completed}/${total} · Media stored · Add caption`;
  else if(status==='ERROR')summary=`${completed}/${total} · Extraction error · Inspect`;
  return {stages,completed,total,activeExec,summary};
}

/** Determine per-post Extract and Publish eligibility with explicit disabled reasons. */
export function postEligibility(row,{rows=[],canWrite=false,pipelineReady=false,cooldown={blocked:false},now=Date.now()}={}){
  const id=text(row?.post_id);
  const status=text(row?.status).toUpperCase()||'DRAFT';
  const code=sourceCode(row?.source_instagram_url);
  const duplicateId=id?rows.filter(x=>text(x.post_id)===id).length>1:false;
  const duplicateSource=!!code&&rows.some(x=>text(x.post_id)!==id&&sourceCode(x.source_instagram_url)===code);
  const isDuplicate=duplicateId||duplicateSource;
  const isLocked=locked(row);
  const hasMedia=!!text(row?.media_url);
  const prepared=validMedia(row?.media_url,row?.media_type);
  const captionText=text(row?.caption||row?.original_caption);
  const pm=text(row?.publish_mode).toUpperCase()||'NOW';
  const scheduleMs=Date.parse(row?.publish_at);
  const validSchedule=pm==='NOW'||(pm==='LATER'&&ISO_TZ_RE.test(text(row?.publish_at))&&Number.isFinite(scheduleMs));
  const scheduled=pm==='LATER'&&Number.isFinite(scheduleMs)&&scheduleMs>now;
  const rowError=text(row?.error);

  const extractLabel='Extract & upload to Cloudinary';
  const publishLabel=scheduled?'Publish to Instagram (Schedule)':'Publish to Instagram';

  let extractReason='';
  if(isLocked)extractReason=status==='PUBLISHED'?'Already published to Instagram.':`Post is locked (${status}); inspect active execution first.`;
  else if(isDuplicate)extractReason=duplicateId?'Duplicate post ID in Google Sheets.':'Duplicate Instagram source URL in Google Sheets.';
  else if(hasMedia)extractReason='Media already stored in Cloudinary.';
  else if(!code)extractReason='Enter a valid Instagram post or Reel URL first.';
  else if(!['DRAFT','NEW','READY','RETRY','ERROR'].includes(status))extractReason=`Post status (${status}) cannot extract media.`;
  else if(cooldown?.blocked)extractReason=cooldown.unknown?'Instagram extraction paused (inspect rate-limit record with missing timestamp). Prepared posts can still publish.':'Instagram extraction paused during cooldown; prepared posts can still publish.';
  else if(!pipelineReady)extractReason='Activate the two-step v10 dashboard workflow first.';
  else if(!canWrite)extractReason='Wait for active execution or reconnect Google Sheets.';

  let publishReason='';
  if(isLocked)publishReason=status==='PUBLISHED'?'Already published to Instagram.':`Post is locked (${status}); inspect active execution first.`;
  else if(isDuplicate)publishReason=duplicateId?'Duplicate post ID in Google Sheets.':'Duplicate Instagram source URL in Google Sheets.';
  else if(!prepared)publishReason='Extract & upload media to Cloudinary first.';
  else if(rowError&&!/^(OpenRouter|AI:)/i.test(rowError))publishReason="Resolve this post's error before publishing.";
  else if(!captionText)publishReason='Review and supply a final or original caption first.';
  else if(captionText.length>2200)publishReason='Caption must be at most 2200 characters.';
  else if(!['DRAFT','NEW','READY','AI_ERROR','AI_RETRY'].includes(status))publishReason=`Post status (${status}) cannot publish.`;
  else if(!validSchedule)publishReason='Scheduled publish time must include timezone.';
  else if(!pipelineReady)publishReason='Activate the two-step v10 dashboard workflow first.';
  else if(!canWrite)publishReason='Wait for active execution or reconnect Google Sheets.';

  return {
    duplicateId,
    duplicateSource,
    isDuplicate,
    isLocked,
    hasMedia,
    prepared,
    captionText,
    extract:{enabled:!extractReason,reason:extractReason,label:extractLabel},
    publish:{enabled:!publishReason,reason:publishReason,label:publishLabel,scheduled}
  };
}
