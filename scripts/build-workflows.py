import json,copy,uuid,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
env_file = root / '.env.local' if (root / '.env.local').exists() else root / '.env.example'
w = json.loads((root / 'n8n/v10-original.json').read_text(encoding='utf-8'))
secret = next(x.split('=', 1)[1].strip('"\'') for x in env_file.read_text(encoding='utf-8').splitlines() if x.startswith('N8N_WEBHOOK_SECRET='))
def node(name,type,params,pos,version=2,**kw):return dict(name=name,type='n8n-nodes-base.'+type,parameters=params,position=pos,typeVersion=version,id=str(uuid.uuid4()),**kw)
def link(c,a,b,branch=0):
 x=c.setdefault(a,{'main':[]})['main'];
 while len(x)<=branch:x.append([])
 x[branch].append({'node':b,'type':'main','index':0})
def webhook(name,path,mode):return node(name,'webhook',{'httpMethod':'POST','path':path,'responseMode':mode,'options':{}},[-700,0],2,webhookId=str(uuid.uuid4()))
def code(name,js,pos):return node(name,'code',{'jsCode':js},pos)
def condition(name,expr,pos):return node(name,'if',{'conditions':{'options':{'caseSensitive':True,'leftValue':'','typeValidation':'strict','version':2},'conditions':[{'id':str(uuid.uuid4()),'leftValue':expr,'rightValue':True,'operator':{'type':'boolean','operation':'true','singleValue':True}}],'combinator':'and'},'options':{}},pos,2.2)
def auth():return 'const request=$input.first().json; if(request.headers?.["x-dashboard-secret"]!=='+json.dumps(secret)+') throw Error("Unauthorized local dashboard request"); const body=request.body??{};\n'
domain = (root / 'lib/domain.mjs').read_text(encoding='utf-8').replace('export ', '')
# the source functions are shared with the backend and tested independently
r=copy.deepcopy(w);r['name']='Instagram v10 | Dashboard + Manual + Schedule';r['active']=False
# safer default: old errors need explicit approval; manual and schedule unchanged otherwise
for n in r['nodes']:
 if n['name']=='CONFIG | Manual mode':n['parameters']['jsCode']=n['parameters']['jsCode'].replace("const MODE = 'AUTO'","const MODE = 'CHECK'").replace('ALLOW_READY_AI_FALLBACK = true','ALLOW_READY_AI_FALLBACK = false')
 if n['name']=='CONFIG | Scheduled AUTO':n['parameters']['jsCode']=n['parameters']['jsCode'].replace('fallback:true','fallback:false')
wh=webhook('DASHBOARD | Run request','instagram-manager-run-v1','responseNode');wh['position']=[-720,-620]
validate=code('DASHBOARD | Validate command',auth()+domain+'\nconst cfg=runInput(body);return [{json:{...cfg,manual:true,started:Date.now(),request_id:String(body.request_id??""),trigger_source:"DASHBOARD"}}];',[-480,-620])
respond=node('DASHBOARD | Acknowledge','respondToWebhook',{'respondWith':'json','responseBody':'={{ JSON.stringify({accepted:true,execution_id:String($execution.id),request_id:$json.request_id}) }}','options':{}},[-240,-620],1.4)
restore=code('DASHBOARD | Restore command',"return [{json:$('DASHBOARD | Validate command').first().json}];",[0,-620])
r['nodes'] += [wh,validate,respond,restore];c=r['connections'];link(c,wh['name'],validate['name']);link(c,validate['name'],respond['name']);link(c,respond['name'],restore['name']);link(c,restore['name'],'CONFIG | Run context')
(root / 'n8n/v10-dashboard.json').write_text(json.dumps(r, indent=2), encoding='utf-8')
# separate sheet bridge. read-only list or validated mutation. n8n credential references reused.
read=copy.deepcopy(next(n for n in w['nodes'] if n['name']=='SHEETS | Read initial queue'));read.update(name='SHEET | Read rows',id=str(uuid.uuid4()),position=[-240,0]);read['alwaysOutputData']=True
wh=webhook('Dashboard bridge','instagram-manager-sheet-v1','lastNode');wh['parameters']['responseData']='firstEntryJson'
a=code('Validate secret',auth()+"return [{json:{action:String(body.action??''),input:body.input??{}}}];",[-480,0])
plan=code('Validate sheet operation',domain+'''\nconst req=$('Validate secret').first().json;const rows=$input.all().map(i=>i.json).filter(x=>text(x.post_id));if(req.action==='LIST')return [{json:{kind:'LIST',ok:true,rows:rows.map(normalize)}}];try{const next=applyMutation(req.action,req.input,rows);return [{json:{kind:req.action==='CREATE'?'CREATE':'UPDATE',...next}}];}catch(e){return [{json:{kind:'REPORT',ok:false,error:e.message}}];}''',[0,0])
mut=condition('Mutation?',"={{ ['CREATE','UPDATE'].includes($json.kind) }}",[240,0]);create=condition('Create?',"={{ $json.kind === 'CREATE' }}",[480,0]);report=code('Return list or validation',"const {kind,...r}=$input.first().json;return [{json:r}];",[480,240])
base=copy.deepcopy(next(n for n in w['nodes'] if n['name']=='SHEETS | Save media immediately'));fields=['post_id','source_instagram_url','media_url','media_type','original_caption','caption','account_key','ig_user_id','publish_mode','publish_at','status','published_id','published_url','error','processed_at'];
def writer(name,op,pos,cols):
 n=copy.deepcopy(base);n.update(name=name,id=str(uuid.uuid4()),position=pos);n['parameters']['operation']=op;n['parameters']['columns']['value']={k:'={{ $json.'+k+' }}' for k in cols};n['parameters']['columns']['matchingColumns']=['post_id'] if op=='update' else [];n['alwaysOutputData']=True;n['retryOnFail']=False;return n
append=writer('SHEET | Append draft','append',[720,-100],fields);update=writer('SHEET | Update draft','update',[720,100],[k for k in fields if k not in ['published_id','published_url','processed_at']]);result=code('Confirm write',"const r=$input.first().json;const expected=$('Validate sheet operation').first().json;if(String(r.post_id??'')!==expected.post_id||String(r.status??'')!==expected.status)throw Error('Sheet write not confirmed; refresh before retry');return [{json:{ok:true,row:r}}];",[960,0]);c={}
for x,y in [(wh,a),(a,read),(read,plan),(plan,mut),(mut,create),(create,append),(append,result),(update,result)]:link(c,x['name'],y['name'])
link(c,mut['name'],report['name'],1);link(c,create['name'],update['name'],1)
b={'name':'Instagram Manager | Existing Google Sheets bridge','nodes':[wh,a,read,plan,mut,create,report,append,update,result],'connections':c,'active':False,'settings':{'executionOrder':'v1','timezone':'Asia/Kolkata','saveDataSuccessExecution':'none','saveDataErrorExecution':'all'},'pinData':{}}
(root / 'n8n/sheets-bridge.json').write_text(json.dumps(b, indent=2), encoding='utf-8')
