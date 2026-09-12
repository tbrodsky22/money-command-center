(()=>{
const labels={overview:'Home',budget:'Budget',afford:'Can I Afford It?',networth:'Net Worth',debt:'Debt & Credit',goals:'Goals',tax:'Taxes',protection:'Security',ai:'Money Guide',profile:'Money Setup'};
const meta={overview:['Home','Your money, priorities, and next steps in one place.'],budget:['Budget','Plan this month and see what is truly safe to spend.'],afford:['Can I Afford It?','See how a purchase fits your real cash flow before you commit.'],networth:['Net Worth','Track what you own and what you owe.'],debt:['Debt & Credit','See your balances, payments, and payoff priorities.'],goals:['Goals','Turn the things you want into a clear savings plan.'],tax:['Taxes','Stay organized and prepare ahead of tax season.'],protection:['Security','Credit, identity, and account protection features.'],ai:['Money Guide','Ask questions using the financial picture saved in your account.'],profile:['Money Setup','Keep the numbers behind your recommendations up to date.']};
function activeId(){return document.querySelector('.nav button.active')?.dataset.tab||'overview'}
function friendlyHeader(){
 const id=activeId(),m=meta[id];
 const title=document.getElementById('pageTitle'),sub=document.getElementById('pageSub');
 if(m&&title&&sub){title.textContent=m[0];sub.textContent=m[1]}
 const sel=document.querySelector('.mobileSectionSelect');if(sel)sel.value=id;
}
function go(id){document.querySelector(`.nav button[data-tab="${id}"]`)?.click();setTimeout(friendlyHeader,0);window.scrollTo({top:0,behavior:'smooth'})}
function init(){
 const nav=document.querySelector('.nav');if(!nav||document.getElementById('ux-ready'))return;
 const marker=document.createElement('span');marker.id='ux-ready';marker.hidden=true;document.body.appendChild(marker);
 document.querySelectorAll('.nav button').forEach(b=>{b.textContent=labels[b.dataset.tab]||b.textContent});
 const groups=[['PLAN',['budget','afford','goals']],['TRACK',['networth','debt']],['TOOLS',['tax','protection','ai']],['ACCOUNT',['profile']]];
 groups.forEach(([name,ids])=>{const first=document.querySelector(`.nav button[data-tab="${ids[0]}"]`);if(first){const d=document.createElement('div');d.className='navGroup';d.textContent=name;nav.insertBefore(d,first)}});
 const wrap=document.createElement('div');wrap.className='mobileSectionWrap';wrap.innerHTML=`<select class="mobileSectionSelect" aria-label="Choose section">${Object.entries(labels).map(([id,l])=>`<option value="${id}">${l}</option>`).join('')}</select>`;document.getElementById('welcome')?.after(wrap);wrap.querySelector('select').onchange=e=>go(e.target.value);
 const pill=document.querySelector('.topbar .pill');if(pill)pill.textContent='Saved account';
 const overview=document.getElementById('overview');if(overview){const q=document.createElement('div');q.className='quickStart card';q.innerHTML=`<span class="pill">Start here</span><h2>Make this your money home base</h2><p class="muted">Set up the basics once, then use the app to plan spending, track progress, and check big decisions before they become monthly payments.</p><div class="quickStartActions"><button class="quickAction" data-go="profile">Finish money setup<span>Add income, bills, savings, and credit</span></button><button class="quickAction" data-go="budget">Build my budget<span>Know what is safe to spend</span></button><button class="quickAction" data-go="afford">Check a purchase<span>Test a car, home, trip, or other expense</span></button><button class="quickAction" data-go="networth">Add what I own<span>Build your net worth picture</span></button></div>`;overview.prepend(q);q.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go))}
 const profile=document.querySelector('#profile .card');if(profile){const hint=document.createElement('div');hint.className='setupHint';hint.innerHTML='<strong>Why this matters</strong><span class="muted small">These numbers power your health score, budget, purchase checks, and personalized guidance. You can update them anytime.</span>';const firstRow=profile.querySelector('.row');if(firstRow)profile.insertBefore(hint,firstRow);const h=profile.querySelector('h2');if(h)h.textContent='Tell us about your money'}
 const budgetH=document.querySelector('#budget .card h2');if(budgetH)budgetH.textContent='Plan this month';
 const assetH=document.querySelector('#networth .grid2 .card h2');if(assetH)assetH.textContent='Add what you own';
 const debtH=document.querySelector('#debt .grid2 .card h2');if(debtH)debtH.textContent='Add what you owe';
 const goalH=document.querySelector('#goals .grid2 .card h2');if(goalH)goalH.textContent='Create a goal';
 const aiH=document.querySelector('#ai .grid2 .card h2');if(aiH)aiH.textContent='Ask Money Guide';
 document.querySelectorAll('.nav button').forEach(b=>b.addEventListener('click',()=>setTimeout(friendlyHeader,0)));
 friendlyHeader();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();