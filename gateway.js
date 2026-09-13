import http from 'http';
import {spawn} from 'child_process';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import {buildBankGuideContext} from './money-guide-context.js';

const {Pool}=pg;
const outerPort=Number(process.env.PORT||3000);
const innerPort=outerPort===3001?3002:3001;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(innerPort)},stdio:'inherit'});
child.on('exit',code=>{console.error('Inner app exited',code);process.exit(code||1)});

function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>2_000_000){reject(new Error('Request too large'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function userId(req){try{const h=req.headers.authorization||'',t=h.startsWith('Bearer ')?h.slice(7):'';if(!t)return null;return jwt.verify(t,process.env.JWT_SECRET)?.sub||null}catch{return null}}
function copyHeaders(source){const h={};for(const [k,v] of Object.entries(source)){if(v==null)continue;const key=k.toLowerCase();if(['host','content-length','connection','transfer-encoding','content-encoding'].includes(key))continue;h[k]=Array.isArray(v)?v.join(', '):v}return h}
async function forward(req,res,body){
 const r=await fetch(`http://127.0.0.1:${innerPort}${req.url}`,{method:req.method,headers:copyHeaders(req.headers),body:['GET','HEAD'].includes(req.method)?undefined:body,redirect:'manual'});
 res.statusCode=r.status;for(const [k,v] of r.headers.entries()){if(['content-encoding','content-length','transfer-encoding','connection'].includes(k.toLowerCase()))continue;res.setHeader(k,v)}
 let b=Buffer.from(await r.arrayBuffer());const ct=String(r.headers.get('content-type')||'');if(req.method==='GET'&&ct.includes('text/html')){let html=b.toString('utf8');if(!html.includes('/command-center-pro.js'))html=html.replace('</body>','<script src="/command-center-pro.js?v=1"></script>\n</body>');b=Buffer.from(html)}res.setHeader('content-length',String(b.length));res.end(b)
}

const server=http.createServer(async(req,res)=>{
 try{
  let body=['GET','HEAD'].includes(req.method)?null:await readBody(req);
  if(req.method==='POST'&&req.url?.startsWith('/api/money-guide/chat')&&body?.length){
   const uid=userId(req);if(uid){
    try{
     const parsed=JSON.parse(body.toString('utf8')),message=String(parsed.message||''),requested=['always','never','auto'].includes(parsed.transaction_access)?parsed.transaction_access:'auto';
     const ctx=await buildBankGuideContext(pool,uid,message,{mode:requested});
     if(ctx){parsed.message=`${message}\n\nMONEY COMMAND CENTER BANK CONTEXT:\n${ctx}`;body=Buffer.from(JSON.stringify(parsed));req.headers['content-length']=String(body.length)}
    }catch(e){console.warn('Money Guide context enrichment skipped',e.message)}
   }
  }
  await forward(req,res,body)
 }catch(e){console.error('Gateway error',e);if(!res.headersSent){res.statusCode=502;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'Temporary gateway error'}))}else res.end()}
});
server.listen(outerPort,'0.0.0.0',()=>console.log(`Money Command Center gateway listening on ${outerPort}`));
