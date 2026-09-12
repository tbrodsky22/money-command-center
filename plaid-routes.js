import crypto from 'crypto';

const PLAID_BASES={sandbox:'https://sandbox.plaid.com',production:'https://production.plaid.com'};
const clean=(v,max=180)=>String(v??'').trim().slice(0,max);
const safeDate=v=>{if(!v)return null;const s=String(v).slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:null};

function config(){
  const env=(process.env.PLAID_ENV||'sandbox').toLowerCase();
  const base=PLAID_BASES[env];
  if(!base||!process.env.PLAID_CLIENT_ID||!process.env.PLAID_SECRET)throw new Error('Plaid is not configured');
  if(!process.env.PLAID_TOKEN_ENCRYPTION_KEY)throw new Error('Plaid token encryption is not configured');
  return{env,base};
}

function key(){return crypto.createHash('sha256').update(process.env.PLAID_TOKEN_ENCRYPTION_KEY).digest()}
function encrypt(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv),enc=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]),tag=cipher.getAuthTag();return['v1',iv.toString('base64'),tag.toString('base64'),enc.toString('base64')].join('.')}
function decrypt(value){const [v,ivb,tagb,encb]=String(value||'').split('.');if(v!=='v1'||!ivb||!tagb||!encb)throw new Error('Stored Plaid token is invalid');const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(ivb,'base64'));decipher.setAuthTag(Buffer.from(tagb,'base64'));return Buffer.concat([decipher.update(Buffer.from(encb,'base64')),decipher.final()]).toString('utf8')}

async function plaid(path,body={}){
  const {base}=config();
  const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SECRET,...body})});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(data?.error_message||data?.display_message||data?.error_code||'Plaid request failed');e.plaid=data;e.status=r.status;throw e}
  return data;
}

function webhookUrl(req){if(process.env.PLAID_WEBHOOK_URL)return process.env.PLAID_WEBHOOK_URL;const domain=process.env.RAILWAY_PUBLIC_DOMAIN;if(domain)return `https://${domain}/api/plaid/webhook`;const proto=req.get('x-forwarded-proto')||req.protocol||'https';return `${proto}://${req.get('host')}/api/plaid/webhook`}

async function upsertAccounts(pool,userId,connectionId,accessToken){
  const data=await plaid('/accounts/get',{access_token:accessToken});
  for(const a of data.accounts||[]){
    const b=a.balances||{};
    await pool.query(`INSERT INTO financial_accounts(user_id,connection_id,provider_account_id,name,official_name,account_type,account_subtype,mask,current_balance,available_balance,currency,last_synced_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
      ON CONFLICT(user_id,provider_account_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,name=EXCLUDED.name,official_name=EXCLUDED.official_name,account_type=EXCLUDED.account_type,account_subtype=EXCLUDED.account_subtype,mask=EXCLUDED.mask,current_balance=EXCLUDED.current_balance,available_balance=EXCLUDED.available_balance,currency=EXCLUDED.currency,last_synced_at=now(),updated_at=now()`,
      [userId,connectionId,a.account_id,clean(a.name,120)||'Account',clean(a.official_name,160)||null,clean(a.type,50)||'other',clean(a.subtype,80)||null,clean(a.mask,8)||null,Number(b.current??b.available??0),b.available===null||b.available===undefined?null:Number(b.available),clean(b.iso_currency_code||b.unofficial_currency_code,3).toUpperCase()||'USD']);
  }
  return data.accounts||[];
}

async function syncTransactions(pool,connection){
  const accessToken=decrypt(connection.encrypted_access_token);
  await upsertAccounts(pool,connection.user_id,connection.id,accessToken);
  let cursor=connection.sync_cursor||null,hasMore=true,loops=0,added=0,modified=0,removed=0;
  while(hasMore&&loops<20){
    const data=await plaid('/transactions/sync',{access_token:accessToken,cursor:cursor||undefined,count:500});
    const accountRows=(await pool.query('SELECT id,provider_account_id FROM financial_accounts WHERE user_id=$1 AND connection_id=$2',[connection.user_id,connection.id])).rows;
    const accountMap=new Map(accountRows.map(a=>[a.provider_account_id,a.id]));
    for(const t of [...(data.added||[]),...(data.modified||[])]){
      const accountId=accountMap.get(t.account_id);if(!accountId)continue;
      const pfc=t.personal_finance_category||{};
      const category=clean(pfc.detailed||pfc.primary||((t.category||[]).join(' > ')),120)||null;
      await pool.query(`INSERT INTO transactions(user_id,account_id,provider_transaction_id,posted_date,authorized_date,merchant_name,name,amount,category,pending,recurring,excluded,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,now())
        ON CONFLICT(user_id,provider_transaction_id) DO UPDATE SET account_id=EXCLUDED.account_id,posted_date=EXCLUDED.posted_date,authorized_date=EXCLUDED.authorized_date,merchant_name=EXCLUDED.merchant_name,name=EXCLUDED.name,amount=EXCLUDED.amount,category=EXCLUDED.category,pending=EXCLUDED.pending,updated_at=now()`,
        [connection.user_id,accountId,t.transaction_id,safeDate(t.date)||new Date().toISOString().slice(0,10),safeDate(t.authorized_date),clean(t.merchant_name,160)||null,clean(t.name,180)||'Transaction',Number(t.amount||0),category,Boolean(t.pending)]);
    }
    for(const t of data.removed||[])await pool.query('DELETE FROM transactions WHERE user_id=$1 AND provider_transaction_id=$2',[connection.user_id,t.transaction_id]);
    added+=(data.added||[]).length;modified+=(data.modified||[]).length;removed+=(data.removed||[]).length;
    cursor=data.next_cursor||cursor;hasMore=Boolean(data.has_more);loops++;
  }
  await pool.query(`UPDATE financial_connections SET sync_cursor=$1,last_synced_at=now(),status='active',error_code=NULL,updated_at=now() WHERE id=$2`,[cursor,connection.id]);
  return{added,modified,removed,cursor};
}

async function loadConnection(pool,id,userId=null){const q=userId?await pool.query('SELECT * FROM financial_connections WHERE id=$1 AND user_id=$2 AND provider=$3',[id,userId,'plaid']):await pool.query('SELECT * FROM financial_connections WHERE id=$1 AND provider=$2',[id,'plaid']);return q.rows[0]}

export function registerPlaidRoutes(app,{pool,auth}){
  app.get('/api/plaid/status',auth,async(req,res)=>{
    try{const q=await pool.query(`SELECT id,institution_name,institution_id,status,last_synced_at,created_at,error_code FROM financial_connections WHERE user_id=$1 AND provider='plaid' ORDER BY created_at DESC`,[req.user.sub]);res.json({configured:Boolean(process.env.PLAID_CLIENT_ID&&process.env.PLAID_SECRET),environment:(process.env.PLAID_ENV||'sandbox'),connections:q.rows})}catch(e){console.error('Plaid status',e);res.status(500).json({error:'Could not load bank connection status'})}
  });

  app.post('/api/plaid/link-token',auth,async(req,res)=>{
    try{const {env}=config(),data=await plaid('/link/token/create',{user:{client_user_id:req.user.sub},client_name:'Money Command Center',products:['transactions'],country_codes:['US'],language:'en',webhook:webhookUrl(req),transactions:{days_requested:180}});res.json({link_token:data.link_token,expiration:data.expiration,environment:env})}catch(e){console.error('Plaid link token',e.plaid||e);res.status(502).json({error:e.message})}
  });

  app.post('/api/plaid/exchange-token',auth,async(req,res)=>{
    const publicToken=clean(req.body?.public_token,500),institution=req.body?.institution||{};
    if(!publicToken)return res.status(400).json({error:'Missing Plaid public token'});
    try{
      const exchanged=await plaid('/item/public_token/exchange',{public_token:publicToken}),accessToken=exchanged.access_token,itemId=exchanged.item_id;
      let institutionId=clean(institution.institution_id||institution.institutionId,120)||null,institutionName=clean(institution.name,160)||'Connected institution';
      if(!institutionId){try{const item=await plaid('/item/get',{access_token:accessToken});institutionId=item?.item?.institution_id||null}catch{}}
      if(institutionId&&institutionName==='Connected institution'){try{const inst=await plaid('/institutions/get_by_id',{institution_id:institutionId,country_codes:['US']});institutionName=clean(inst?.institution?.name,160)||institutionName}catch{}}
      const q=await pool.query(`INSERT INTO financial_connections(user_id,provider,provider_item_id,institution_id,institution_name,status,encrypted_access_token,updated_at)
        VALUES($1,'plaid',$2,$3,$4,'active',$5,now())
        ON CONFLICT(user_id,provider,provider_item_id) DO UPDATE SET institution_id=EXCLUDED.institution_id,institution_name=EXCLUDED.institution_name,status='active',encrypted_access_token=EXCLUDED.encrypted_access_token,error_code=NULL,updated_at=now() RETURNING *`,
        [req.user.sub,itemId,institutionId,institutionName,encrypt(accessToken)]),connection=q.rows[0];
      const accounts=await upsertAccounts(pool,req.user.sub,connection.id,accessToken);
      let sync={added:0,modified:0,removed:0};try{sync=await syncTransactions(pool,connection)}catch(err){console.warn('Initial Plaid transaction sync pending',err.plaid||err);}
      res.status(201).json({connection:{id:connection.id,institution_name:institutionName,status:'active'},accounts:accounts.length,sync});
    }catch(e){console.error('Plaid exchange',e.plaid||e);res.status(502).json({error:e.message})}
  });

  app.post('/api/plaid/sync',auth,async(req,res)=>{
    try{const q=await pool.query(`SELECT * FROM financial_connections WHERE user_id=$1 AND provider='plaid' AND status<>'removed'`,[req.user.sub]),results=[];for(const c of q.rows){try{results.push({connection_id:c.id,...await syncTransactions(pool,c)})}catch(e){await pool.query(`UPDATE financial_connections SET status='error',error_code=$1,updated_at=now() WHERE id=$2`,[clean(e?.plaid?.error_code||e.message,120),c.id]);results.push({connection_id:c.id,error:e.message})}}res.json({results})}catch(e){console.error('Plaid sync',e);res.status(500).json({error:'Could not refresh bank data'})}
  });

  app.delete('/api/plaid/connections/:id',auth,async(req,res)=>{
    try{const c=await loadConnection(pool,req.params.id,req.user.sub);if(!c)return res.status(404).json({error:'Connection not found'});try{await plaid('/item/remove',{access_token:decrypt(c.encrypted_access_token)})}catch(e){console.warn('Plaid item remove',e.plaid||e)}await pool.query('DELETE FROM financial_accounts WHERE user_id=$1 AND connection_id=$2',[req.user.sub,c.id]);await pool.query('DELETE FROM financial_connections WHERE id=$1 AND user_id=$2',[c.id,req.user.sub]);res.status(204).end()}catch(e){res.status(500).json({error:'Could not disconnect bank'})}
  });

  app.post('/api/plaid/webhook',async(req,res)=>{
    res.status(200).json({received:true});
    const itemId=clean(req.body?.item_id,180),code=clean(req.body?.webhook_code,120);if(!itemId||code!=='SYNC_UPDATES_AVAILABLE')return;
    try{const q=await pool.query(`SELECT * FROM financial_connections WHERE provider='plaid' AND provider_item_id=$1 LIMIT 1`,[itemId]),c=q.rows[0];if(c)await syncTransactions(pool,c)}catch(e){console.error('Plaid webhook sync',e.plaid||e)}
  });
}
