import http from 'http';
import {spawn} from 'child_process';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import {handleCreditApi} from './credit-api.js';

const {Pool}=pg;
const outerPort=Number(process.env.PORT||3000);
const innerPort=outerPort===3100?3101:3100;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const child=spawn(process.execPath,['gateway.js'],{env:{...process.env,PORT:String(innerPort)},stdio:'inherit'});
child.on('exit',code=>{console.error('Secure gateway exited',code);process.exit(code||1)});

async function init(){const sql=fs.readFileSync(new URL('./security-schema.sql',import.meta.url),'utf8');for(let i=0;i<30;i++){try{await pool.query(sql);return}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,500))}}}
await init();

function cookies(req){const out={};for(const p of String(req.headers.cookie||'').split(';')){const i=p.indexOf('=');if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function userId(req){try{const c=cookies(req).mcc_session,h=String(req.headers.authorization||''),b=h.startsWith('Bearer ')?h.slice(7):'',t=c||((b&&b!=='cookie-session')?b:'');return t?jwt.verify(t,process.env.JWT_SECRET)?.sub||null:null}catch{return null}}
function sendJson(res,status,obj){res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');const b=Buffer.from(JSON.stringify(obj));res.setHeader('content-length',String(b.length));res.end(b)}
function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>2_000_000){reject(new Error('Request too large'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function copyHeaders(source){const h={};for(const [k,v] of Object.entries(source)){if(v==null)continue;const key=k.toLowerCase();if(['host','content-length','connection','transfer-encoding','content-encoding'].includes(key))continue;h[k]=Array.isArray(v)?v.join(', '):v}return h}
async function forward(req,res,body){const r=await fetch(`http://127.0.0.1:${innerPort}${req.url}`,{method:req.method,headers:copyHeaders(req.headers),body:['GET','HEAD'].includes(req.method)?undefined:body,redirect:'manual'});res.statusCode=r.status;for(const [k,v] of r.headers.entries()){if(['content-encoding','content-length','transfer-encoding','connection'].includes(k.toLowerCase()))continue;res.setHeader(k,v)}const b=Buffer.from(await r.arrayBuffer());res.setHeader('content-length',String(b.length));res.end(b)}

const server=http.createServer(async(req,res)=>{try{const body=['GET','HEAD'].includes(req.method)?null:await readBody(req);if(req.url?.startsWith('/api/credit')){await handleCreditApi(req,res,body,{pool,userId,sendJson});return}await forward(req,res,body)}catch(e){console.error('Credit gateway error',e);if(!res.headersSent)sendJson(res,502,{error:'Temporary gateway error'});else res.end()}});
server.listen(outerPort,'0.0.0.0',()=>console.log(`Money Command Center credit gateway listening on ${outerPort}`));
