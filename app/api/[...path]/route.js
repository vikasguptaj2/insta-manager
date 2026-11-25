import {overview,detail,mutate,trigger,setActive} from '../../../lib/server.mjs';
import {checkLocal,readBody,guardedCommand} from '../../../lib/local-guard.mjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function GET(req,{params}){try{checkLocal(req);const {path}=await params;if(path[0]==='overview'&&path.length===1)return response(await overview());if(path[0]==='executions'&&path.length===2)return response(await detail(path[1]));return response({error:'Not found'},404);}catch(e){return response({error:e.message},e.status||502);}}
export async function POST(req,{params}){try{checkLocal(req,true);const {path}=await params;if(path.length!==1||!['run','workflow','posts'].includes(path[0]))return response({error:'Not found'},404);const b=await readBody(req);return response(await guardedCommand(()=>path[0]==='run'?trigger(b):path[0]==='workflow'?setActive(b):mutate(b.action,b.input??{}),{inspect:detail,operation:path[0]}));}catch(e){return response({error:e.message},e.status||400);}}