import http from 'http';
import {spawn} from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import {buildBankGuideContext} from './money-guide-context.js';

const {Pool}=pg;
const outerPort=Number(process.env.PORT||3000);
const innerPort=outerPort===3001?3002:3001;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(innerPort)},stdio:'inherit'});
child.on('exit',code=>{console.error('Inner app exited',code);process.exit(code||1)});

async function initSecuritySchema(){const sql=fs.readFileSync(new URL('./security-schema.sql',import.meta.url),'utf8');for(let i=0;i<30;i++){try{await pool.query(sql);return}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,500))}}}
await initSecuritySchema();

const limits=new Map();
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function ipHash(req){return crypto.createHash('sha256').update(clientIp(req)+'|'+String(process.env.JWT_SECRET||'')).digest('hex').slice(0,24)}
function rateLimit(req,res,key,max,windowMs){const now=Date.now(),id=key+':'+clientIp(req),old=limits.get(id);if(!old||old.reset<=now){limits.set(id,{count:1,reset:now+windowMs});return false}old.count++;if(old.count<=max)return false;res.statusCode=429;res.setHeader('content-type','application/json');res.setHeader('retry-after',String(Math.max(1,Math.ceil((old.reset-now)/1000))));res.end(JSON.stringify({error:'Too many requests. Please try again shortly.'}));return true}
setInterval(()=>{const now=Date.now();for(const [k,v] of limits)if(v.reset<=now)limits.delete(k)},300000).unref();

function cookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}return out}
function bearer(req){const h=String(req.headers.authorization||'');return h.startsWith('Bearer ')?h.slice(7):''}
function validJwt(token){try{return jwt.verify(token,process.env.JWT_SECRET)}catch{return null}}
function realToken(req){const c=cookies(req).mcc_session;if(c&&validJwt(c))return c;const b=bearer(req);if(b&&b!=='cookie-session'&&validJwt(b))return b;return ''}
function userId(req){return validJwt(realToken(req))?.sub||null}
function applySession(req){const t=realToken(req);if(t)req.headers.authorization='Bearer '+t}
function secureCookie(req,value,maxAge=1209600){const secure=String(req.headers['x-forwarded-proto']||'https').includes('https')||process.env.NODE_ENV==='production';return `mcc_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`}
function setSession(res,req,token){res.setHeader('set-cookie',secureCookie(req,token))}
function clearSession(res,req){res.setHeader('set-cookie',secureCookie(req,'',0))}

function setSecurityHeaders(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), geolocation=(), microphone=(self)');res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.plaid.com https://*.plaid.com https://plaid.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.plaid.com https://plaid.com https://api.openai.com wss://api.openai.com; frame-src https://*.plaid.com https://plaid.com; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'")}
function allowedOrigin(req){const origin=String(req.headers.origin||'');if(!origin)return true;try{const u=new URL(origin),host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();if(u.host===host)return true;const configured=String(process.env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);return configured.includes('*')||configured.includes(origin)}catch{return false}}
function sendJson(res,status,obj){res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');const b=Buffer.from(JSON.stringify(obj));res.setHeader('content-length',String(b.length));res.end(b)}
function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>2_000_000){reject(new Error('Request too large'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function parseJson(body){try{return JSON.parse(body?.toString('utf8')||'{}')}catch{return{}}}
function copyHeaders(source){const h={};for(const [k,v] of Object.entries(source)){if(v==null)continue;const key=k.toLowerCase();if(['host','content-length','connection','transfer-encoding','content-encoding','cookie'].includes(key))continue;h[k]=Array.isArray(v)?v.join(', '):v}return h}
async function securityEvent(user,event,req,metadata={}){try{await pool.query('INSERT INTO security_events(user_id,event_type,ip_hash,metadata) VALUES($1,$2,$3,$4)',[user||null,event,ipHash(req),JSON.stringify(metadata)])}catch{}}

function tokenHash(t){return crypto.createHash('sha256').update(t).digest('hex')}
async function issueAuthToken(userId,purpose,minutes){const raw=crypto.randomBytes(32).toString('base64url');await pool.query('DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2',[userId,purpose]);await pool.query(`INSERT INTO auth_tokens(user_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,now()+($4||' minutes')::interval)`,[userId,purpose,tokenHash(raw),String(minutes)]);return raw}
function appBase(req){return String(process.env.APP_BASE_URL||`${String(req.headers['x-forwarded-proto']||'https').split(',')[0]}://${String(req.headers['x-forwarded-host']||req.headers.host||'localhost').split(',')[0]}`).replace(/\/$/,'')}
function emailConfigured(){return Boolean(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM)}
async function sendMail(to,subject,text){if(!emailConfigured())return false;const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[to],subject,text})});if(!r.ok){console.warn('Email delivery failed',await r.text().catch(()=>''));return false}return true}
async function sendVerification(user,req){const raw=await issueAuthToken(user.id,'verify-email',1440);return sendMail(user.email,'Verify your Money Command Center email',`Verify your email by opening this link:\n\n${appBase(req)}/api/auth/verify-email?token=${encodeURIComponent(raw)}\n\nThis link expires in 24 hours.`)}

function b64url(s){return Buffer.from(String(s).replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(String(s).length/4)*4,'='),'base64')}
async function verifyPlaidWebhook(raw,header){if(!header||!process.env.PLAID_CLIENT_ID||!process.env.PLAID_SECRET)return false;try{const [h,p,s]=String(header).split('.'),head=JSON.parse(b64url(h)),payload=JSON.parse(b64url(p));if(head.alg!=='ES256'||!head.kid)return false;const env=(process.env.PLAID_ENV||'sandbox').toLowerCase(),base=env==='production'?'https://production.plaid.com':'https://sandbox.plaid.com';const kr=await fetch(base+'/webhook_verification_key/get',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SECRET,key_id:head.kid})});const kd=await kr.json();if(!kr.ok||!kd?.key)return false;const pub=crypto.createPublicKey({key:kd.key,format:'jwk'}),ok=crypto.verify('sha256',Buffer.from(`${h}.${p}`),{key:pub,dsaEncoding:'ieee-p1363'},b64url(s));if(!ok)return false;const iat=Number(payload.iat||0);if(!iat||Math.abs(Date.now()/1000-iat)>300)return false;const hash=crypto.createHash('sha256').update(raw||Buffer.alloc(0)).digest('hex');return crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(String(payload.request_body_sha256||'').toLowerCase()))}catch(e){console.warn('Plaid webhook verification failed',e.message);return false}}

async function forward(req,res,body){
 const headers=copyHeaders(req.headers);const t=realToken(req);if(t)headers.authorization='Bearer '+t;
 const r=await fetch(`http://127.0.0.1:${innerPort}${req.url}`,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body,redirect:'manual'});
 res.statusCode=r.status;for(const [k,v] of r.headers.entries()){if(['content-encoding','content-length','transfer-encoding','connection','set-cookie'].includes(k.toLowerCase()))continue;res.setHeader(k,v)}
 let b=Buffer.from(await r.arrayBuffer()),ct=String(r.headers.get('content-type')||'');
 if(r.ok&&req.method==='POST'&&(req.url==='/api/auth/login'||req.url==='/api/auth/register')&&ct.includes('json')){try{const data=JSON.parse(b.toString('utf8'));if(data.token){setSession(res,req,data.token);const claims=validJwt(data.token);if(claims?.sub){await pool.query('UPDATE users SET last_login_at=now() WHERE id=$1',[claims.sub]);await securityEvent(claims.sub,req.url.endsWith('register')?'account_registered':'login_success',req);if(req.url.endsWith('register')&&data.user)sendVerification(data.user,req).catch(()=>{})}data.token='cookie-session';b=Buffer.from(JSON.stringify(data))}}catch{}}
 if(req.method==='GET'&&ct.includes('text/html')){let html=b.toString('utf8');const inject='<script src="/secure-auth.js?v=1"></script>\n<script src="/security-center.js?v=1"></script>\n';if(!html.includes('/command-center-pro.js'))html=html.replace('</body>','<script src="/command-center-pro.js?v=1"></script>\n</body>');if(!html.includes('/secure-auth.js'))html=html.replace('</body>',inject+'</body>');b=Buffer.from(html)}
 res.setHeader('content-length',String(b.length));res.end(b)
}

async function handleEdge(req,res,body){const url=new URL(req.url,'http://local');
 if(req.method==='POST'&&url.pathname==='/api/auth/migrate-session'){const old=bearer(req),claims=validJwt(old);if(!claims)return sendJson(res,401,{error:'Invalid or expired session'});setSession(res,req,old);await securityEvent(claims.sub,'session_migrated',req);return sendJson(res,200,{token:'cookie-session'})}
 if(req.method==='POST'&&url.pathname==='/api/auth/logout'){const uid=userId(req);clearSession(res,req);if(uid)await securityEvent(uid,'logout',req);return sendJson(res,200,{ok:true})}
 if(req.method==='GET'&&url.pathname==='/api/security/status'){const uid=userId(req);if(!uid)return sendJson(res,401,{error:'Authentication required'});const q=await pool.query('SELECT email,email_verified_at,last_login_at FROM users WHERE id=$1',[uid]);return sendJson(res,200,{...q.rows[0],session:'httpOnly-cookie',emailDeliveryConfigured:emailConfigured(),plaidEnvironment:process.env.PLAID_ENV||'sandbox'})}
 if(req.method==='POST'&&url.pathname==='/api/auth/request-verification'){const uid=userId(req);if(!uid)return sendJson(res,401,{error:'Authentication required'});const q=await pool.query('SELECT id,email,email_verified_at FROM users WHERE id=$1',[uid]),u=q.rows[0];if(!u)return sendJson(res,404,{error:'Account not found'});if(u.email_verified_at)return sendJson(res,200,{ok:true,alreadyVerified:true});const delivered=await sendVerification(u,req);await securityEvent(uid,'verification_requested',req);return sendJson(res,200,{ok:true,deliveryConfigured:emailConfigured(),delivered})}
 if(req.method==='GET'&&url.pathname==='/api/auth/verify-email'){const raw=url.searchParams.get('token')||'',q=await pool.query(`SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='verify-email' AND used_at IS NULL AND expires_at>now()`,[tokenHash(raw)]),row=q.rows[0];if(!row){res.statusCode=400;res.setHeader('content-type','text/html');return res.end('<h2>Verification link is invalid or expired.</h2><p><a href="/">Return to Money Command Center</a></p>')}await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[row.user_id]);await pool.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1',[row.id]);res.statusCode=200;res.setHeader('content-type','text/html');return res.end('<h2>Email verified.</h2><p>Your Money Command Center email is confirmed.</p><p><a href="/">Open Money Command Center</a></p>')}
 if(req.method==='POST'&&url.pathname==='/api/auth/request-password-reset'){const p=parseJson(body),email=String(p.email||'').trim().toLowerCase();const q=await pool.query('SELECT id,email FROM users WHERE email=$1',[email]),u=q.rows[0];if(u){const raw=await issueAuthToken(u.id,'reset-password',60);await sendMail(u.email,'Reset your Money Command Center password',`Reset your password here:\n\n${appBase(req)}/reset-password.html?token=${encodeURIComponent(raw)}\n\nThis link expires in 60 minutes.`);await securityEvent(u.id,'password_reset_requested',req)}return sendJson(res,200,{ok:true,message:'If that email exists, a reset link has been sent.',deliveryConfigured:emailConfigured()})}
 if(req.method==='POST'&&url.pathname==='/api/auth/reset-password'){const p=parseJson(body),raw=String(p.token||''),password=String(p.password||'');if(password.length<8||password.length>200)return sendJson(res,400,{error:'Password must be 8-200 characters'});const q=await pool.query(`SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='reset-password' AND used_at IS NULL AND expires_at>now()`,[tokenHash(raw)]),row=q.rows[0];if(!row)return sendJson(res,400,{error:'Reset link is invalid or expired'});const hash=await bcrypt.hash(password,12);await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,row.user_id]);await pool.query('UPDATE auth_tokens SET used_at=now() WHERE user_id=$1',[row.user_id]);await securityEvent(row.user_id,'password_reset_completed',req);clearSession(res,req);return sendJson(res,200,{ok:true})}
 if(req.method==='GET'&&url.pathname==='/api/account/export'){const uid=userId(req);if(!uid)return sendJson(res,401,{error:'Authentication required'});const tables=['financial_profiles','assets','debts','budget_categories','goals','scenarios','financial_accounts','transactions','recurring_items'];const out={exported_at:new Date().toISOString()};out.user=(await pool.query('SELECT id,email,name,email_verified_at,created_at FROM users WHERE id=$1',[uid])).rows[0];for(const t of tables)out[t]=(await pool.query(`SELECT * FROM ${t} WHERE user_id=$1`,[uid])).rows;await securityEvent(uid,'data_exported',req);return sendJson(res,200,out)}
 if(req.method==='DELETE'&&url.pathname==='/api/account'){const uid=userId(req),tok=realToken(req);if(!uid)return sendJson(res,401,{error:'Authentication required'});const p=parseJson(body);if(p.confirm!=='DELETE')return sendJson(res,400,{error:'Type DELETE to confirm'});const conns=(await pool.query("SELECT id FROM financial_connections WHERE user_id=$1 AND provider='plaid'",[uid])).rows;for(const c of conns){try{await fetch(`http://127.0.0.1:${innerPort}/api/plaid/connections/${c.id}`,{method:'DELETE',headers:{Authorization:'Bearer '+tok}})}catch{}}await securityEvent(uid,'account_deleted',req);await pool.query('DELETE FROM users WHERE id=$1',[uid]);clearSession(res,req);return sendJson(res,200,{ok:true})}
 return false}

const server=http.createServer(async(req,res)=>{
 setSecurityHeaders(res);
 try{
  if(rateLimit(req,res,'global',240,60000))return;
  const url=new URL(req.url,'http://local');
  if(url.pathname.startsWith('/api/auth/login')||url.pathname.startsWith('/api/auth/register')||url.pathname.startsWith('/api/auth/request-password-reset')){if(rateLimit(req,res,'auth',12,900000))return}
  if(url.pathname.startsWith('/api/money-guide/')){if(rateLimit(req,res,'guide',60,60000))return}
  if(url.pathname.startsWith('/api/plaid/')){if(rateLimit(req,res,'plaid',90,60000))return}
  let body=['GET','HEAD'].includes(req.method)?null:await readBody(req);
  applySession(req);
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&cookies(req).mcc_session&&url.pathname!=='/api/plaid/webhook'&&!allowedOrigin(req))return sendJson(res,403,{error:'Request origin was not allowed'});
  if(req.method==='POST'&&url.pathname==='/api/plaid/webhook'){const ok=await verifyPlaidWebhook(body,req.headers['plaid-verification']);if(!ok)return sendJson(res,401,{error:'Invalid Plaid webhook signature'})}
  const handled=await handleEdge(req,res,body);if(handled!==false)return;
  if(req.method==='POST'&&url.pathname==='/api/money-guide/chat'&&body?.length){const uid=userId(req);if(uid){try{const parsed=parseJson(body),message=String(parsed.message||''),requested=['always','never','auto'].includes(parsed.transaction_access)?parsed.transaction_access:'auto',ctx=await buildBankGuideContext(pool,uid,message,{mode:requested});if(ctx){parsed.message=`${message}\n\nMONEY COMMAND CENTER BANK CONTEXT:\n${ctx}`;body=Buffer.from(JSON.stringify(parsed))}}catch(e){console.warn('Money Guide context enrichment skipped',e.message)}}}
  await forward(req,res,body)
 }catch(e){console.error('Gateway error',e);if(!res.headersSent)sendJson(res,502,{error:'Temporary gateway error'});else res.end()}
});
server.listen(outerPort,'0.0.0.0',()=>console.log(`Money Command Center secure gateway listening on ${outerPort}`));
