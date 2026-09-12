import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()),
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));

async function initDb(){
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

function sign(user){
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '14d' });
}

function auth(req,res,next){
  const h=req.headers.authorization||'';
  const token=h.startsWith('Bearer ')?h.slice(7):null;
  if(!token) return res.status(401).json({error:'Authentication required'});
  try{ req.user=jwt.verify(token,process.env.JWT_SECRET); next(); }
  catch{ return res.status(401).json({error:'Invalid or expired session'}); }
}

const num=v=>Number(v||0);

async function getDashboard(userId){
  const [p,a,d,b,g,s]=await Promise.all([
    pool.query('SELECT * FROM financial_profiles WHERE user_id=$1',[userId]),
    pool.query('SELECT * FROM assets WHERE user_id=$1 ORDER BY created_at',[userId]),
    pool.query('SELECT * FROM debts WHERE user_id=$1 ORDER BY apr DESC, created_at',[userId]),
    pool.query('SELECT * FROM budget_categories WHERE user_id=$1 ORDER BY sort_order,name',[userId]),
    pool.query('SELECT * FROM goals WHERE user_id=$1 ORDER BY created_at',[userId]),
    pool.query('SELECT * FROM scenarios WHERE user_id=$1 ORDER BY created_at DESC',[userId])
  ]);
  const profile=p.rows[0]||{};
  const assets=a.rows, debts=d.rows, budget=b.rows;
  const totalAssets=assets.reduce((x,r)=>x+num(r.value),0);
  const totalDebt=debts.reduce((x,r)=>x+num(r.balance),0);
  const debtMinimums=debts.reduce((x,r)=>x+num(r.minimum_payment),0);
  const planned=budget.reduce((x,r)=>x+num(r.planned),0);
  const actual=budget.reduce((x,r)=>x+num(r.actual),0);
  const takeHome=num(profile.monthly_take_home);
  const gross=num(profile.monthly_gross_income);
  const housing=num(profile.monthly_housing);
  const essential=num(profile.monthly_essential_expenses);
  const recurringDebt=Math.max(num(profile.monthly_debt_payments),debtMinimums);
  const emergency=num(profile.emergency_savings);
  const reserveBase=Math.max(1,housing+essential+recurringDebt);
  const emergencyMonths=emergency/reserveBase;
  const dti=gross>0?((housing+recurringDebt)/gross)*100:0;
  const safeToSpend=Math.max(0,takeHome-planned);
  const cashFlow=takeHome-(housing+essential+recurringDebt);
  let score=100;
  if(cashFlow<0) score-=35; else if(takeHome && cashFlow/takeHome<.1) score-=20; else if(takeHome && cashFlow/takeHome<.2) score-=10;
  if(dti>50) score-=30; else if(dti>43) score-=20; else if(dti>36) score-=10;
  if(emergencyMonths<1) score-=25; else if(emergencyMonths<3) score-=15; else if(emergencyMonths<6) score-=5;
  score=Math.max(0,Math.min(100,Math.round(score)));
  const moves=[];
  if(debts.some(x=>num(x.apr)>=20)) moves.push('Prioritize high-interest revolving debt.');
  if(emergencyMonths<3) moves.push('Build your emergency reserve toward at least 3 months of core expenses.');
  if(planned>takeHome) moves.push('Your monthly budget plan exceeds take-home income. Reduce planned categories.');
  if(!moves.length) moves.push('Keep your savings plan automated and review spending weekly.');
  moves.push('Use Can I Afford It? before adding any new recurring payment.');
  moves.push('Review net worth and goal progress monthly.');
  return {profile,assets,debts,budget,goals:g.rows,scenarios:s.rows,metrics:{totalAssets,totalDebt,netWorth:totalAssets-totalDebt,debtMinimums,planned,actual,takeHome,cashFlow,dti:Number(dti.toFixed(1)),emergencyMonths:Number(emergencyMonths.toFixed(1)),safeToSpend,healthScore:score},nextMoves:moves.slice(0,3)};
}

app.get('/health',(req,res)=>res.json({ok:true,service:'money-command-center-api'}));

app.post('/api/auth/register',async(req,res)=>{
  const {email,password,name}=req.body||{};
  if(!email||!password||password.length<8) return res.status(400).json({error:'Email and password of at least 8 characters are required'});
  try{
    const hash=await bcrypt.hash(password,12);
    const q=await pool.query('INSERT INTO users(email,password_hash,name) VALUES(lower($1),$2,$3) RETURNING id,email,name,created_at',[email,hash,name||null]);
    const user=q.rows[0];
    await pool.query('INSERT INTO financial_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING',[user.id]);
    const defaults=['Housing','Utilities & subscriptions','Food & household','Transportation','Debt payments','Lifestyle & fun','Savings & goals'];
    for(let i=0;i<defaults.length;i++) await pool.query('INSERT INTO budget_categories(user_id,name,sort_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[user.id,defaults[i],i]);
    res.status(201).json({token:sign(user),user});
  }catch(e){
    if(e.code==='23505') return res.status(409).json({error:'An account with that email already exists'});
    console.error(e); res.status(500).json({error:'Could not create account'});
  }
});

app.post('/api/auth/login',async(req,res)=>{
  const {email,password}=req.body||{};
  const q=await pool.query('SELECT * FROM users WHERE email=lower($1)',[email||'']);
  const user=q.rows[0];
  if(!user || !(await bcrypt.compare(password||'',user.password_hash))) return res.status(401).json({error:'Invalid email or password'});
  res.json({token:sign(user),user:{id:user.id,email:user.email,name:user.name,created_at:user.created_at}});
});

app.get('/api/me',auth,async(req,res)=>{
  const q=await pool.query('SELECT id,email,name,created_at FROM users WHERE id=$1',[req.user.sub]);
  res.json(q.rows[0]);
});

app.get('/api/dashboard',auth,async(req,res)=>res.json(await getDashboard(req.user.sub)));

app.put('/api/profile',auth,async(req,res)=>{
  const x=req.body||{};
  const q=await pool.query(`INSERT INTO financial_profiles(user_id,monthly_take_home,monthly_gross_income,monthly_housing,monthly_essential_expenses,monthly_debt_payments,emergency_savings,credit_score,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(user_id) DO UPDATE SET monthly_take_home=EXCLUDED.monthly_take_home,monthly_gross_income=EXCLUDED.monthly_gross_income,monthly_housing=EXCLUDED.monthly_housing,monthly_essential_expenses=EXCLUDED.monthly_essential_expenses,monthly_debt_payments=EXCLUDED.monthly_debt_payments,emergency_savings=EXCLUDED.emergency_savings,credit_score=EXCLUDED.credit_score,updated_at=now() RETURNING *`,
  [req.user.sub,num(x.monthly_take_home),num(x.monthly_gross_income),num(x.monthly_housing),num(x.monthly_essential_expenses),num(x.monthly_debt_payments),num(x.emergency_savings),x.credit_score||null]);
  res.json(q.rows[0]);
});

app.put('/api/budget',auth,async(req,res)=>{
  const rows=Array.isArray(req.body?.categories)?req.body.categories:[];
  for(let i=0;i<rows.length;i++){
    const r=rows[i]; if(!r.name) continue;
    await pool.query(`INSERT INTO budget_categories(user_id,name,planned,actual,sort_order) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id,name) DO UPDATE SET planned=EXCLUDED.planned,actual=EXCLUDED.actual,sort_order=EXCLUDED.sort_order`,[req.user.sub,r.name,num(r.planned),num(r.actual),i]);
  }
  res.json((await getDashboard(req.user.sub)).budget);
});

function crud(table, fields){
  app.post('/api/'+table,auth,async(req,res)=>{
    const vals=fields.map(f=>req.body?.[f] ?? null);
    const placeholders=fields.map((_,i)=>'$'+(i+2)).join(',');
    const q=await pool.query(`INSERT INTO ${table}(user_id,${fields.join(',')}) VALUES($1,${placeholders}) RETURNING *`,[req.user.sub,...vals]);
    res.status(201).json(q.rows[0]);
  });
  app.delete('/api/'+table+'/:id',auth,async(req,res)=>{
    await pool.query(`DELETE FROM ${table} WHERE id=$1 AND user_id=$2`,[req.params.id,req.user.sub]);
    res.status(204).end();
  });
}
crud('assets',['name','category','value']);
crud('debts',['name','category','balance','apr','minimum_payment']);
crud('goals',['name','target_amount','current_amount','target_date']);
crud('scenarios',['name','scenario_type','payload']);

app.use(express.static(path.join(process.cwd(),'public')));
app.get('*',(req,res,next)=>{
  if(req.path.startsWith('/api/')||req.path==='/health') return next();
  res.sendFile(path.join(process.cwd(),'public','index.html'));
});
app.use((err,req,res,next)=>{ console.error(err); res.status(500).json({error:'Unexpected server error'}); });

initDb().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Money Command Center API listening on ${port}`))).catch(e=>{console.error('DB init failed',e);process.exit(1)});
