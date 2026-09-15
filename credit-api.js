import {experianConfigured,pullExperianReport,encryptJson} from './credit-provider.js';
const clean=(v,max=240)=>String(v??'').trim().slice(0,max);
const num=(v,min=0,max=1e12)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw new Error('Invalid numeric value');return n};
const day=v=>v===null||v===undefined||v===''?null:Math.max(1,Math.min(31,Math.round(Number(v)||0)));
const date=v=>{if(!v)return null;const s=String(v).slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:null};
const statuses=new Set(['draft','submitted','investigating','resolved','rejected','closed']);

function accountBody(p={}){const name=clean(p.name,120);if(!name)throw new Error('Account name is required');const credit_limit=num(p.credit_limit||0),balance=num(p.balance||0),apr=num(p.apr||0,0,100);return{name,balance,credit_limit,apr,statement_day:day(p.statement_day),due_day:day(p.due_day)}}
function disputeBody(p={}){const bureau=clean(p.bureau,40),issue_type=clean(p.issue_type,120),reason=clean(p.reason,2000);if(!bureau||!issue_type||!reason)throw new Error('Bureau, issue type, and reason are required');const status=statuses.has(clean(p.status,30))?clean(p.status,30):'draft';return{bureau,furnisher:clean(p.furnisher,160)||null,account_name:clean(p.account_name,160)||null,issue_type,reason,status,date_submitted:date(p.date_submitted),notes:clean(p.notes,2000)||null}}
function publicReport(r){if(!r)return null;return{id:r.id,provider:r.provider,score:r.score,score_model:r.score_model,reason_codes:r.reason_codes||[],tradelines:r.tradelines||[],inquiries:r.inquiries||[],negative_items:r.negative_items||[],public_records:r.public_records||[],collections:r.collections||[],pulled_at:r.pulled_at}}

export async function handleCreditApi(req,res,body,{pool,userId,sendJson}){
 const url=new URL(req.url,'http://local');if(!url.pathname.startsWith('/api/credit'))return false;const uid=userId(req);if(!uid){sendJson(res,401,{error:'Authentication required'});return true}
 const parts=url.pathname.split('/').filter(Boolean);
 try{
  if(req.method==='GET'&&url.pathname==='/api/credit/provider-status'){
   const q=await pool.query('SELECT * FROM credit_reports WHERE user_id=$1 ORDER BY pulled_at DESC LIMIT 1',[uid]);sendJson(res,200,{provider:'experian',configured:experianConfigured(),environment:process.env.EXPERIAN_ENV||'sandbox',latest:publicReport(q.rows[0])});return true
  }
  if(req.method==='GET'&&url.pathname==='/api/credit/report'){
   const q=await pool.query('SELECT * FROM credit_reports WHERE user_id=$1 ORDER BY pulled_at DESC LIMIT 1',[uid]);sendJson(res,200,{report:publicReport(q.rows[0])});return true
  }
  if(req.method==='POST'&&url.pathname==='/api/credit/pull-report'){
   if(!experianConfigured()){sendJson(res,503,{error:'Experian sandbox/production credentials and report endpoint are not configured yet.'});return true}
   const p=JSON.parse(body?.toString('utf8')||'{}');if(p.consent!==true){sendJson(res,400,{error:'You must explicitly authorize this credit report request.'});return true}
   const required=['firstName','lastName','dob','ssn','address1','city','state','zip'];for(const k of required)if(!clean(p[k],200)){sendJson(res,400,{error:`${k} is required`});return true}
   const ssn=String(p.ssn).replace(/\D/g,'');if(!/^\d{9}$/.test(ssn)){sendJson(res,400,{error:'SSN must contain 9 digits'});return true}
   const subject={firstName:clean(p.firstName,80),lastName:clean(p.lastName,80),dob:clean(p.dob,10),ssn,address1:clean(p.address1,160),address2:clean(p.address2,160),city:clean(p.city,100),state:clean(p.state,2).toUpperCase(),zip:clean(p.zip,10)};
   const report=await pullExperianReport(subject);const q=await pool.query(`INSERT INTO credit_reports(user_id,provider,score,score_model,reason_codes,tradelines,inquiries,negative_items,public_records,collections,encrypted_raw) VALUES($1,'experian',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[uid,report.score,report.score_model,JSON.stringify(report.reason_codes||[]),JSON.stringify(report.tradelines||[]),JSON.stringify(report.inquiries||[]),JSON.stringify(report.negative_items||[]),JSON.stringify(report.public_records||[]),JSON.stringify(report.collections||[]),encryptJson(report.raw||{})]);
   if(Number(report.score)>=300&&Number(report.score)<=850){await pool.query('INSERT INTO credit_score_history(user_id,score,score_model,source) VALUES($1,$2,$3,$4)',[uid,report.score,report.score_model,'Experian']);await pool.query('INSERT INTO financial_profiles(user_id,credit_score,updated_at) VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET credit_score=EXCLUDED.credit_score,updated_at=now()',[uid,report.score])}
   sendJson(res,200,{report:publicReport(q.rows[0])});return true
  }
  if(req.method==='GET'&&url.pathname==='/api/credit/overview'){
   const [profile,accounts,disputes,scores,debts,report]=await Promise.all([
    pool.query('SELECT credit_score FROM financial_profiles WHERE user_id=$1',[uid]),
    pool.query('SELECT * FROM credit_accounts WHERE user_id=$1 ORDER BY created_at',[uid]),
    pool.query('SELECT * FROM credit_disputes WHERE user_id=$1 ORDER BY created_at DESC',[uid]),
    pool.query('SELECT * FROM credit_score_history WHERE user_id=$1 ORDER BY recorded_at DESC LIMIT 24',[uid]),
    pool.query("SELECT id,name,category,balance,apr,minimum_payment FROM debts WHERE user_id=$1 ORDER BY apr DESC",[uid]),
    pool.query('SELECT * FROM credit_reports WHERE user_id=$1 ORDER BY pulled_at DESC LIMIT 1',[uid])
   ]);
   const cards=accounts.rows,totalLimit=cards.reduce((s,x)=>s+Number(x.credit_limit||0),0),totalBalance=cards.reduce((s,x)=>s+Number(x.balance||0),0),utilization=totalLimit>0?totalBalance/totalLimit*100:0;
   const payTo30=Math.max(0,totalBalance-totalLimit*.30),payTo10=Math.max(0,totalBalance-totalLimit*.10);
   sendJson(res,200,{credit_score:profile.rows[0]?.credit_score||null,accounts:cards,disputes:disputes.rows,score_history:scores.rows,debts:debts.rows,provider_report:publicReport(report.rows[0]),metrics:{total_limit:totalLimit,total_balance:totalBalance,utilization:Number(utilization.toFixed(1)),pay_to_30:Number(payTo30.toFixed(2)),pay_to_10:Number(payTo10.toFixed(2)),open_disputes:disputes.rows.filter(x=>!['resolved','closed'].includes(x.status)).length}});return true
  }
  if(req.method==='POST'&&url.pathname==='/api/credit/accounts'){
   const p=accountBody(JSON.parse(body?.toString('utf8')||'{}')),q=await pool.query(`INSERT INTO credit_accounts(user_id,name,balance,credit_limit,apr,statement_day,due_day) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[uid,p.name,p.balance,p.credit_limit,p.apr,p.statement_day,p.due_day]);sendJson(res,201,q.rows[0]);return true
  }
  if(parts[2]==='accounts'&&parts[3]){const id=parts[3];if(req.method==='PUT'){const p=accountBody(JSON.parse(body?.toString('utf8')||'{}')),q=await pool.query(`UPDATE credit_accounts SET name=$1,balance=$2,credit_limit=$3,apr=$4,statement_day=$5,due_day=$6,updated_at=now() WHERE id=$7 AND user_id=$8 RETURNING *`,[p.name,p.balance,p.credit_limit,p.apr,p.statement_day,p.due_day,id,uid]);if(!q.rowCount){sendJson(res,404,{error:'Account not found'});return true}sendJson(res,200,q.rows[0]);return true}if(req.method==='DELETE'){await pool.query('DELETE FROM credit_accounts WHERE id=$1 AND user_id=$2',[id,uid]);res.statusCode=204;res.end();return true}}
  if(req.method==='POST'&&url.pathname==='/api/credit/disputes'){
   const p=disputeBody(JSON.parse(body?.toString('utf8')||'{}')),q=await pool.query(`INSERT INTO credit_disputes(user_id,bureau,furnisher,account_name,issue_type,reason,status,date_submitted,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[uid,p.bureau,p.furnisher,p.account_name,p.issue_type,p.reason,p.status,p.date_submitted,p.notes]);sendJson(res,201,q.rows[0]);return true
  }
  if(parts[2]==='disputes'&&parts[3]){const id=parts[3];if(req.method==='PUT'){const p=disputeBody(JSON.parse(body?.toString('utf8')||'{}')),q=await pool.query(`UPDATE credit_disputes SET bureau=$1,furnisher=$2,account_name=$3,issue_type=$4,reason=$5,status=$6,date_submitted=$7,notes=$8,updated_at=now() WHERE id=$9 AND user_id=$10 RETURNING *`,[p.bureau,p.furnisher,p.account_name,p.issue_type,p.reason,p.status,p.date_submitted,p.notes,id,uid]);if(!q.rowCount){sendJson(res,404,{error:'Dispute not found'});return true}sendJson(res,200,q.rows[0]);return true}if(req.method==='DELETE'){await pool.query('DELETE FROM credit_disputes WHERE id=$1 AND user_id=$2',[id,uid]);res.statusCode=204;res.end();return true}}
  if(req.method==='POST'&&url.pathname==='/api/credit/score'){
   const p=JSON.parse(body?.toString('utf8')||'{}'),score=Math.round(num(p.score,300,850)),model=clean(p.score_model,80)||null,source=clean(p.source,120)||null;await pool.query('INSERT INTO credit_score_history(user_id,score,score_model,source) VALUES($1,$2,$3,$4)',[uid,score,model,source]);await pool.query('INSERT INTO financial_profiles(user_id,credit_score,updated_at) VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET credit_score=EXCLUDED.credit_score,updated_at=now()',[uid,score]);sendJson(res,201,{score,score_model:model,source});return true
  }
  if(req.method==='POST'&&url.pathname==='/api/credit/dispute-letter'){
   const p=disputeBody(JSON.parse(body?.toString('utf8')||'{}'));const today=new Date().toLocaleDateString('en-US');const subject=`Dispute of inaccurate credit information${p.account_name?` — ${p.account_name}`:''}`;const text=`${today}\n\nTo: ${p.bureau}\n\nRe: ${subject}\n\nI am writing to dispute information in my credit file that I believe is inaccurate or incomplete.\n\nFurnisher / creditor: ${p.furnisher||'[enter furnisher]'}\nAccount: ${p.account_name||'[enter account]'}\nIssue: ${p.issue_type}\n\nReason for dispute:\n${p.reason}\n\nPlease investigate this item and correct or remove any information that cannot be verified as accurate. I am including copies of supporting documents where applicable.\n\nPlease send me the results of your investigation and an updated copy of my credit report if changes are made.\n\nSincerely,\n[Your name]\n[Your address]\n[City, State ZIP]\n\nNote: Only dispute information you genuinely believe is inaccurate or incomplete. Keep copies of everything you send.`;sendJson(res,200,{subject,text});return true
  }
  sendJson(res,404,{error:'Credit endpoint not found'});return true
 }catch(e){console.error('Credit API error',e);sendJson(res,400,{error:e.message||'Could not process credit request'});return true}
}
