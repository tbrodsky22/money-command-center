const n=v=>Number(v||0);
const clean=(v,max=120)=>String(v??'').replace(/[\r\n]+/g,' ').trim().slice(0,max);

export function wantsTransactionContext(message=''){
  return /(transaction|spent|spend|merchant|restaurant|food|grocery|subscription|recurring|bill|charge|deposit|paycheck|payroll|income|transfer|payment|last month|this month|where did|money go|purchase|bought|coffee|gas|fuel|uber|lyft)/i.test(String(message));
}

export async function buildBankGuideContext(pool,userId,message,{mode='auto'}={}){
  if(mode==='never')return '';
  if(mode!=='always'&&!wantsTransactionContext(message))return '';
  const [accountsQ,txQ]=await Promise.all([
    pool.query('SELECT name,account_type,account_subtype,current_balance,available_balance,is_hidden FROM financial_accounts WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 20',[userId]),
    pool.query('SELECT posted_date,merchant_name,name,amount,category,pending,excluded FROM transactions WHERE user_id=$1 ORDER BY posted_date DESC,created_at DESC LIMIT 60',[userId])
  ]);
  const accounts=accountsQ.rows.filter(a=>!a.is_hidden).slice(0,12).map(a=>`${clean(a.name)}: current $${n(a.current_balance).toFixed(2)}${a.available_balance==null?'':`, available $${n(a.available_balance).toFixed(2)}`}`);
  const tx=txQ.rows.filter(t=>!t.pending).slice(0,40);
  const categories={};
  for(const t of tx){if(t.excluded||n(t.amount)<=0)continue;const c=clean(t.category||'Uncategorized');categories[c]=(categories[c]||0)+n(t.amount)}
  const top=Object.entries(categories).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([c,v])=>`${c}: $${v.toFixed(2)}`);
  const lines=tx.map(t=>`${String(t.posted_date||'').slice(0,10)} | ${clean(t.merchant_name||t.name)} | ${n(t.amount)>=0?'outflow':'inflow'} $${Math.abs(n(t.amount)).toFixed(2)} | ${clean(t.category||'Uncategorized')}${t.excluded?' | excluded':''}`);
  if(!accounts.length&&!lines.length)return '';
  return `CONNECTED BANK SUMMARY\nAccounts: ${accounts.join('; ')||'none'}\nRecent transaction sample (${lines.length}, newest first):\n${lines.join('\n')||'none'}\nTop categories in this sample: ${top.join('; ')||'none'}`;
}
