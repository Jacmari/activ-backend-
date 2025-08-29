// server.js — ACTIV backend (Plaid + JAMARI AI Fusion) — Node 18+, no npm deps.
// Works on Heroku. Uses built-in fetch. CORS + hard timeouts + Plaid product update.

const http = require('http');
const url  = require('url');

/* ---------- ENV ---------- */
const PORT = process.env.PORT || 3000;

// Plaid
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET    = process.env.PLAID_SECRET    || '';
const PLAID_ENV       = (process.env.PLAID_ENV || 'production').toLowerCase();
const COUNTRY_CODES   = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());
const BASES = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// Preferred Plaid products (auto-trim to only enabled)
const VALID_PRODUCTS = new Set([
  'auth','transactions','identity','assets','investments',
  'liabilities','income','payment_initiation','transfer','signal','credit_details'
]);
const PREFERRED_PRODUCTS = ['transactions','auth','identity','liabilities','investments'];

// AI (optional — use whatever keys exist)
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
const OPENAI_MODEL       = process.env.OPENAI_MODEL       || 'gpt-4o-mini';
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const ANTHROPIC_MODEL    = process.env.ANTHROPIC_MODEL    || 'claude-3-haiku-20240307';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';
const GEMINI_MODEL       = process.env.GEMINI_MODEL       || 'gemini-1.5-flash';

// Optional: webhook + redirect
const WEBHOOK_URL        = process.env.WEBHOOK_URL || '';
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

/* ---------- Simple in-memory token store (userId -> access_token) ---------- */
const tokens = new Map();

/* ---------- Helpers ---------- */
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
}
function json(res, code, obj){ cors(res); res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
function readJSON(req){ return new Promise(resolve=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{ resolve(JSON.parse(d||'{}')) }catch{ resolve({}) } }); }); }

// hard timeout to avoid Heroku H12
function fetchWithTimeout(resource, options={}, ms=12000){
  const controller = new AbortController();
  const t=setTimeout(()=>controller.abort(),ms);
  return fetch(resource,{...options,signal:controller.signal}).finally(()=>clearTimeout(t));
}

// Plaid call with normalized error
async function plaidPost(path, body){
  const started = Date.now();
  try{
    const r = await fetchWithTimeout(`${BASE}${path}`,{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'PLAID-CLIENT-ID':PLAID_CLIENT_ID,
        'PLAID-SECRET':PLAID_SECRET,
      },
      body:JSON.stringify(body)
    },12000);
    const text = await r.text();
    let data; try{ data=text?JSON.parse(text):{} }catch{ data={ raw:text } }
    if(!r.ok){ const err=data||{}; err.http_status=r.status; err.ms=Date.now()-started; throw err; }
    return data;
  }catch(e){
    const isAbort = e && (e.name==='AbortError'||e.message==='The operation was aborted');
    const out={ error:isAbort?'UPSTREAM_TIMEOUT':(e?.error_code||e?.error||'PLAID_ERROR'), details:e, ms:Date.now()-started, path };
    console.error('plaidPost fail:', out);
    throw out;
  }
}

function cleanProducts(list){
  return (list||PREFERRED_PRODUCTS).map(s=>String(s).trim().toLowerCase()).filter(p=>VALID_PRODUCTS.has(p));
}
function parseInvalidProducts(err){
  const m=(err?.error_message||'').match(/\[([^\]]+)\]/); if(!m) return [];
  return m[1].split(',').map(s=>s.trim().toLowerCase());
}
async function linkTokenCreateSmart(baseReq, prods){
  let products = cleanProducts(prods); if(!products.length) products=['transactions'];
  let attempts=0;
  while(products.length && attempts<4){
    attempts++;
    try{
      const body={...baseReq, products};
      const out = await plaidPost('/link/token/create', body);
      return {...out, products_used:products};
    }catch(e){
      const code=e?.error_code||e?.error||'';
      if(code==='INVALID_PRODUCT'){
        const bad=new Set(parseInvalidProducts(e)); products=products.filter(p=>!bad.has(p)); if(!products.length) break; continue;
      }
      if(code==='PRODUCTS_NOT_SUPPORTED'||code==='PRODUCTS_NOT_ENABLED'){
        products=['transactions','auth'].filter(p=>products.includes(p)); if(!products.length) products=['transactions']; continue;
      }
      throw e;
    }
  }
  const out = await plaidPost('/link/token/create', {...baseReq, products:['transactions']});
  return {...out, products_used:['transactions']};
}

function needToken(res, userId){ const t=tokens.get(userId); if(!t) json(res,401,{error:'NO_LINKED_ITEM_FOR_USER'}); return t; }
function safePlaid(res, fn){ return fn().catch(err=>{ console.error('Plaid error:',err); const code=err?.error||err?.error_code||'PLAID_ERROR'; const status=(err?.http_status>=400&&err?.http_status<=599)?err.http_status:500; json(res,status,{error:code,details:err}); }); }
function daysAgo(n){ const d=new Date(Date.now()-n*24*3600*1000); return d.toISOString().slice(0,10); }

const money = n => Math.round((+n||0)*100)/100;
const sum   = a => (a||[]).reduce((x,y)=>x+(+y||0),0);

/* ---------- Plaid helpers ---------- */
const getAccounts   = t => plaidPost('/accounts/balance/get',{ access_token:t }).catch(()=>null);
const getLiabilities= t => plaidPost('/liabilities/get',{ access_token:t }).catch(()=>null);
const getHoldings   = t => plaidPost('/investments/holdings/get',{ access_token:t }).catch(()=>null);
const getTxRange    = (t,start,end)=> plaidPost('/transactions/get',{
  access_token:t,start_date:start,end_date:end,options:{count:250,offset:0}
}).catch(()=>null);

/* ---------- Needs/Wants/Savings classifier (from Plaid categories) ---------- */
const NEED_KEYS = [
  'rent','mortgage','utilities','service','telecom','phone','internet','insurance','health','medical',
  'transportation','fuel','public transport','childcare','education','tuition','groceries','supermarkets',
  'loan','debt','credit card','payment','tax'
];
const SAVE_KEYS = ['savings','transfer','investment','retirement','brokerage','deposit'];
function classifyTxn(t){
  const name = (t.name||'').toLowerCase();
  const cats = (t.category||[]).join(' ').toLowerCase();
  const hay  = `${name} ${cats}`;
  const isNeed   = NEED_KEYS.some(k=>hay.includes(k));
  const isSaving = SAVE_KEYS.some(k=>hay.includes(k));
  return isSaving ? 'S' : (isNeed ? 'N' : 'W');
}

/* ---------- Build live KPIs + 50/30/20 from Plaid ---------- */
async function buildSummary(userId='default'){
  const access = tokens.get(userId); if(!access) return { linked:false };

  const [acc, liab, inv, tx] = await Promise.all([
    getAccounts(access),
    getLiabilities(access),
    getHoldings(access),
    getTxRange(access, daysAgo(30), daysAgo(0))
  ]);

  // Accounts / Cash (treat "Emergency Fund" as savings)
  const accounts = (acc?.accounts)||[];
  const cashAccts = accounts.filter(a=>a.type==='depository');
  const isEmergency = a => /emergency/i.test(a.name||a.official_name||'');
  const checking = money(sum(cashAccts.filter(a=>a.subtype==='checking').map(a=>a.balances?.available ?? a.balances?.current ?? 0)));
  const savings  = money(sum(cashAccts.filter(a=>a.subtype==='savings'||isEmergency(a)).map(a=>a.balances?.available ?? a.balances?.current ?? 0)));
  const cashOther= money(sum(cashAccts.filter(a=>a.subtype!=='checking' && !(a.subtype==='savings'||isEmergency(a))).map(a=>a.balances?.available ?? a.balances?.current ?? 0)));
  const totalCash= money(checking+savings+cashOther);

  // Liabilities (Plaid Liabilities API; fallback: loan-type accounts)
  let totalLiabilities = 0;
  if(liab?.liabilities){
    const L=liab.liabilities;
    totalLiabilities = money(
      sum((L.credit||[]).map(x=>x.balance?.current ?? 0)) +
      sum((L.student||[]).map(x=>x.outstanding_balance ?? 0)) +
      sum((L.mortgage||[]).map(x=>x.principal_balance ?? 0)) +
      sum((L.auto||[]).map(x=>x.outstanding_balance ?? 0))
    );
  }else{
    totalLiabilities = money(
      sum(accounts.filter(a=>a.type==='loan' || /loan|liability/i.test(a.subtype||'')).map(a=>a.balances?.current ?? 0))
    );
  }

  // Investments total (institution_value first; else price*qty)
  let totalInvestments=0;
  if(inv?.holdings && inv?.securities){
    const h=inv.holdings, secMap=new Map(); (inv.securities||[]).forEach(s=>secMap.set(s.security_id,s));
    totalInvestments = money(sum(h.map(x=>{
      if(typeof x.institution_value==='number') return x.institution_value;
      const s=secMap.get(x.security_id)||{}; const px = s.close_price ?? s.price ?? 0;
      return (+x.quantity||0)*(+px||0);
    })));
  }

  // Transactions → 50/30/20 + income/spend
  let income30=0, spend30=0, nNeed=0, nWant=0, nSave=0;
  if(tx?.transactions){
    // Normalize sign (some banks invert)
    const t = tx.transactions.slice(0,500);
    const totalAmt = sum(t.map(x=>x.amount));
    const posAsSpend = totalAmt >= 0; // common Plaid: + = outflow
    for(const x of t){
      const amt = Math.abs(+x.amount||0);
      if(posAsSpend){
        if(x.amount>0) spend30 += amt; else income30 += amt;
      }else{
        if(x.amount<0) spend30 += amt; else income30 += amt;
      }
      const bucket = classifyTxn(x);
      if(bucket==='N') nNeed += amt;
      else if(bucket==='W') nWant += amt;
      else nSave += amt;
    }
  }

  // SavingsRate, Net cashflow, Runway
  const netCashFlow = money(income30 - spend30);
  const monthlySpend= spend30 || 2000;
  const savingsRate = income30 ? Math.max(0, Math.min(1, netCashFlow/income30)) : 0;
  const runwayMonths= monthlySpend ? money(totalCash/monthlySpend) : 0;

  // 50/30/20 percentages
  const totalClassified = nNeed+nWant+nSave || 1;
  const pctNeeds = Math.round((nNeed/totalClassified)*100);
  const pctWants = Math.round((nWant/totalClassified)*100);
  const pctSaves = Math.round((nSave/totalClassified)*100);

  // Net worth (approx)
  const netWorth = money(totalCash + totalInvestments - totalLiabilities);

  return {
    linked:true,
    userId,
    accounts: accounts.map(a=>({
      account_id: a.account_id,
      name: a.name || a.official_name || 'Account',
      mask: a.mask || '',
      type: a.type, subtype: a.subtype,
      available: a.balances?.available ?? null,
      current:   a.balances?.current   ?? null,
      currency:  a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || 'USD'
    })),
    kpis:{
      netWorth, totalCash, checking, savings, cashOther,
      totalInvestments, totalLiabilities,
      income30: money(income30), spend30: money(spend30),
      netCashFlow, monthlySpend, savingsRate, runwayMonths
    },
    analyzer:{
      needs: money(nNeed), wants: money(nWant), saves: money(nSave),
      pctNeeds, pctWants, pctSaves, classifiedTotal: money(nNeed+nWant+nSave)
    }
  };
}

/* ---------- AI Fusion ---------- */
function withTimeout(p,ms=14000){ return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('TIMEOUT')),ms))]); }
async function askOpenAI(prompt,system){ if(!OPENAI_API_KEY) return null; try{
  const r=await withTimeout(fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,temperature:0.3,messages:[{role:'system',content:system},{role:'user',content:prompt}]})}));
  const j=await r.json(); return j?.choices?.[0]?.message?.content?.trim()||null;
}catch{ return null; } }
async function askAnthropic(prompt,system){ if(!ANTHROPIC_API_KEY) return null; try{
  const r=await withTimeout(fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:ANTHROPIC_MODEL,max_tokens:1024,system,messages:[{role:'user',content:[{type:'text',text:prompt}]}]})}));
  const j=await r.json(); return j?.content?.[0]?.text?.trim()||null;
}catch{ return null; } }
async function askGemini(prompt,system){ if(!GEMINI_API_KEY) return null; try{
  const r=await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:`${system}\n\n${prompt}`}] }],generationConfig:{temperature:0.3,maxOutputTokens:1024}})}));
  const j=await r.json(); return (j?.candidates?.[0]?.content?.parts||[]).map(p=>p.text).join(' ').trim()||null;
}catch{ return null; } }
function fuseReplies(list){
  const texts=list.filter(Boolean).map(s=>String(s).trim()).filter(Boolean);
  if(!texts.length) return "I'm ready, but no AI providers responded. Check your AI keys.";
  const first=texts[0]; const seen=new Set(first.split(/(?<=\.)\s+/).map(s=>s.trim().toLowerCase())); const extra=[];
  for(let i=1;i<texts.length;i++){ for(const p of texts[i].split(/(?<=\.)\s+/)){ const k=p.trim().toLowerCase(); if(k && !seen.has(k)){ extra.push(p.trim()); if(extra.length>=3) break; } } if(extra.length>=3) break; }
  return [first,...extra].join(' ');
}

/* ---------- HTTP Server ---------- */
const server = http.createServer(async (req,res)=>{
  cors(res); if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }
  const parsed=url.parse(req.url,true); const path=parsed.pathname;

  try{
    // Health
    if(req.method==='GET' && path==='/'){ return json(res,200,{ok:true,env:PLAID_ENV,countries:COUNTRY_CODES}); }
    if(req.method==='GET' && path==='/ping'){ return json(res,200,{ok:true,env:PLAID_ENV}); }

    /* ---- Plaid: Link token create (initial) ---- */
    if(req.method==='POST' && path==='/plaid/link_token/create'){
      const body=await readJSON(req);
      const userId=body.userId||body.user_id||'default';
      const baseReq={ user:{client_user_id:userId}, client_name:'ACTIV', language:'en', country_codes:COUNTRY_CODES };
      if(PLAID_REDIRECT_URI) baseReq.redirect_uri=PLAID_REDIRECT_URI;
      if(WEBHOOK_URL) baseReq.webhook=WEBHOOK_URL;
      return safePlaid(res, async ()=>{
        const data=await linkTokenCreateSmart(baseReq, body.products||PREFERRED_PRODUCTS);
        json(res,200,{ link_token:data.link_token, expiration:data.expiration, userId, products_used:data.products_used });
      });
    }

    /* ---- 2A: Plaid Link update-mode to add investments to current Item ---- */
    if(req.method==='POST' && path==='/plaid/link_token/update'){
      const body=await readJSON(req); const userId=(body.userId||'default').toString();
      const access=tokens.get(userId); if(!access) return json(res,400,{error:'NO_ACCESS_TOKEN'});
      const cfg={
        access_token: access,
        user:{ client_user_id:userId },
        products:['investments'],
        client_name:'ACTIV Finance',
        country_codes: COUNTRY_CODES,
        language:'en'
      };
      if(PLAID_REDIRECT_URI) cfg.redirect_uri=PLAID_REDIRECT_URI;
      return safePlaid(res, async ()=>{
        const data = await plaidPost('/link/token/create', cfg);
        json(res,200,{ link_token:data.link_token, expiration:data.expiration });
      });
    }

    /* ---- Exchange public_token ---- */
    if(req.method==='POST' && path==='/plaid/exchange_public_token'){
      const body=await readJSON(req); if(!body.public_token) return json(res,400,{error:'MISSING_PUBLIC_TOKEN'});
      const userId=(body.userId||'default').toString();
      return safePlaid(res, async ()=>{
        const data=await plaidPost('/item/public_token/exchange',{ public_token:body.public_token });
        tokens.set(userId, data.access_token);
        json(res,200,{ item_id:data.item_id, stored_for_user:userId });
      });
    }

    /* ---- Data endpoints (unchanged) ---- */
    if(req.method==='GET' && path==='/plaid/accounts'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/accounts/balance/get',{ access_token:t })); });
    }
    if(req.method==='GET' && path==='/plaid/balances'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/accounts/balance/get',{ access_token:t })); });
    }
    if(req.method==='GET' && path==='/plaid/transactions'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      const end=(parsed.query.end||daysAgo(0)), start=(parsed.query.start||daysAgo(30));
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/transactions/get',{ access_token:t, start_date:start, end_date:end, options:{count:250,offset:0} })); });
    }
    if(req.method==='POST' && path==='/plaid/transactions/sync'){
      const body=await readJSON(req); const userId=(body.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/transactions/sync',{ access_token:t, cursor:body.cursor||null, count:500 })); });
    }
    if(req.method==='GET' && path==='/plaid/liabilities'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/liabilities/get',{ access_token:t })); });
    }
    if(req.method==='GET' && path==='/plaid/investments/holdings'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/investments/holdings/get',{ access_token:t })); });
    }
    if(req.method==='GET' && path==='/plaid/investments/transactions'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      const end=(parsed.query.end||daysAgo(0)), start=(parsed.query.start||daysAgo(90));
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/investments/transactions/get',{ access_token:t, start_date:start, end_date:end })); });
    }
    if(req.method==='GET' && path==='/plaid/auth'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/auth/get',{ access_token:t })); });
    }
    if(req.method==='GET' && path==='/plaid/identity'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/identity/get',{ access_token:t })); });
    }
    if(req.method==='GET' && path==='/plaid/item'){
      const userId=(parsed.query.userId||'default').toString(); const t=needToken(res,userId); if(!t) return;
      return safePlaid(res, async ()=>{ json(res,200, await plaidPost('/item/get',{ access_token:t })); });
    }

    // Unlink & delete (same behavior)
    if(req.method==='POST' && path==='/plaid/unlink'){
      const body=await readJSON(req); const userId=(body.userId||'default').toString(); const t=tokens.get(userId);
      if(!t) return json(res,200,{ok:true,message:'Nothing to unlink'});
      return safePlaid(res, async ()=>{ await plaidPost('/item/remove',{ access_token:t }); tokens.delete(userId); json(res,200,{ok:true}); });
    }
    if(req.method==='POST' && path==='/user/delete'){
      const body=await readJSON(req); const userId=(body.userId||'default').toString(); tokens.delete(userId); return json(res,200,{ok:true});
    }
    if(req.method==='POST' && path==='/plaid/webhook'){ const body=await readJSON(req); console.log('PLAID WEBHOOK:',JSON.stringify(body)); res.writeHead(200); return res.end(); }

    /* ---- Upgraded summary + explicit analyzer ---- */
    if(req.method==='GET' && path==='/summary'){
      const userId=(parsed.query.userId||'default').toString();
      try{ const s=await buildSummary(userId); return json(res,200,s); }
      catch(e){ console.error('summary error',e); return json(res,500,{error:'SUMMARY_ERROR'}); }
    }
    if(req.method==='GET' && path==='/analyzer'){
      const userId=(parsed.query.userId||'default').toString();
      try{ const s=await buildSummary(userId); return json(res,200,{ linked:s.linked, userId, ...s.analyzer }); }
      catch(e){ console.error('analyzer error',e); return json(res,500,{error:'ANALYZER_ERROR'}) }
    }

    /* ---- JAMARI Fusion (uses live KPIs) ---- */
    if(req.method==='POST' && path==='/jamari/chat'){
      const body=await readJSON(req);
      const userId=(body.userId||'default').toString();
      const message=(body.message||'').toString().slice(0,4000);
      if(!message) return json(res,400,{error:'NO_MESSAGE'});

      const summary = await buildSummary(userId);
      const k=summary.kpis||{}, a=summary.analyzer||{};
      const sys=[
        "You are JAMARI, a calm, clear money coach.",
        "Use user's live KPIs to give concise, actionable steps (bullets, numbers).",
        "Focus on reducing debt, raising savings rate, and building long-term wealth.",
      ].join(' ');
      const ctx=[
        `Live KPIs: NetWorth $${k.netWorth||0} | Cash $${k.totalCash||0} | Savings $${k.savings||0} | Checking $${k.checking||0}`,
        `Investments $${k.totalInvestments||0} | Liabilities $${k.totalLiabilities||0}`,
        `Income(30d) $${k.income30||0} | Spend(30d) $${k.spend30||0} | NetCashFlow $${k.netCashFlow||0}`,
        `Runway ${k.runwayMonths||0} mo | SavingsRate ${(k.savingsRate*100||0).toFixed(1)}%`,
        `50/30/20 (actual): N ${a.pctNeeds||0}% • W ${a.pctWants||0}% • S ${a.pctSaves||0}%`,
        ``,
        `User: ${message}`
      ].join('\n');

      try{
        const [o,an,g] = await Promise.all([askOpenAI(ctx,sys), askAnthropic(ctx,sys), askGemini(ctx,sys)]);
        const fused = fuseReplies([o,an,g]);
        return json(res,200,{ reply:fused, providers:{openai:!!o,anthropic:!!an,gemini:!!g} });
      }catch(e){ console.error('chat error',e); return json(res,500,{error:'CHAT_ERROR'}); }
    }

    return json(res,404,{error:'NOT_FOUND'});
  }catch(err){
    console.error('Server error:',err);
    return json(res,500,{error:'SERVER_ERROR',details:err});
  }
});

server.listen(PORT, ()=>console.log(`ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV}`));