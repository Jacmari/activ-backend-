// server.js — ACTIV backend (Plaid + JAMARI AI Fusion) — Node 18+
// Heroku-ready. Uses Postgres to persist Plaid access_tokens.
// CORS + error handling are production-safe.

const http = require('http');
const url = require('url');
const { Client: PGClient } = require('pg');

const PORT = process.env.PORT || 3000;

// ---------- Plaid ----------
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET = process.env.PLAID_SECRET || '';
const PLAID_ENV = (process.env.PLAID_ENV || 'production').toLowerCase();
const COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());
const BASES = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// ---------- AI (optional) ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-3-haiku-20240307';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-1.5-flash';

// ---------- CORS / helpers ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJSON(req) {
  return new Promise((resolve) => {
    let data=''; req.on('data', c => (data+=c));
    req.on('end', () => { try { resolve(JSON.parse(data||'{}')); } catch { resolve({}); } });
  });
}
async function plaidPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw:text }; }
  if (!r.ok) { const err = data||{}; err.http_status=r.status; throw err; }
  return data;
}
function daysAgo(n) {
  const d = new Date(Date.now()-n*24*3600*1000);
  return d.toISOString().slice(0,10);
}
function cleanProducts(list) {
  const VALID = new Set([
    'auth','transactions','identity','assets','investments','liabilities',
    'income','payment_initiation','transfer','signal','credit_details'
  ]);
  const PREFERRED = ['transactions','auth','identity','liabilities','investments'];
  return (list || PREFERRED).map(s=>String(s).trim().toLowerCase()).filter(p=>VALID.has(p));
}
function parseInvalidProducts(err) {
  const m = (err?.error_message||'').match(/\[([^\]]+)\]/);
  return m ? m[1].split(',').map(s=>s.trim().toLowerCase()) : [];
}
async function linkTokenCreateSmart(baseReq, prods) {
  let products = cleanProducts(prods);
  if (!products.length) products = ['transactions'];
  while (products.length) {
    try { return { ...(await plaidPost('/link/token/create', { ...baseReq, products })), products_used: products }; }
    catch (e) {
      const code = e?.error_code || e?.error || '';
      if (code === 'INVALID_PRODUCT') {
        const bad = new Set(parseInvalidProducts(e));
        products = products.filter(p => !bad.has(p));
        if (!products.length) break;
        continue;
      }
      if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'PRODUCTS_NOT_ENABLED') {
        products = products.filter(p => p==='transactions' || p==='auth');
        if (!products.length) products = ['transactions'];
        continue;
      }
      throw e;
    }
  }
  const out = await plaidPost('/link/token/create', { ...baseReq, products:['transactions'] });
  return { ...out, products_used:['transactions'] };
}

// ---------- Postgres token store ----------
const pg = new PGClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized:false } : false
});

let dbReady = false;

async function initDB() {
  if (!process.env.DATABASE_URL) return; // will fall back to memory map if missing
  await pg.connect();
  await pg.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  dbReady = true;
}
const memTokens = new Map();

async function getToken(userId) {
  if (dbReady) {
    const r = await pg.query('SELECT access_token FROM tokens WHERE user_id=$1', [userId]);
    return r.rows[0]?.access_token || null;
  }
  return memTokens.get(userId) || null;
}
async function setToken(userId, token) {
  if (dbReady) {
    await pg.query(`
      INSERT INTO tokens (user_id, access_token)
      VALUES ($1,$2)
      ON CONFLICT (user_id) DO UPDATE SET access_token=EXCLUDED.access_token, updated_at=NOW()
    `, [userId, token]);
    return;
  }
  memTokens.set(userId, token);
}
async function deleteToken(userId) {
  if (dbReady) {
    await pg.query('DELETE FROM tokens WHERE user_id=$1', [userId]);
    return;
  }
  memTokens.delete(userId);
}

// ---------- summary (same as before, trimmed) ----------
function sum(arr){return (arr||[]).reduce((a,b)=>a+(+b||0),0)}
function money(n){return Math.round((+n||0)*100)/100}
async function buildSummary(userId) {
  const access = await getToken(userId);
  if (!access) return { linked:false };
  const [acc, liab, inv, tx] = await Promise.allSettled([
    plaidPost('/accounts/balance/get', { access_token: access }),
    plaidPost('/liabilities/get',     { access_token: access }),
    plaidPost('/investments/holdings/get', { access_token: access }),
    plaidPost('/transactions/get', {
      access_token: access, start_date: daysAgo(30), end_date: daysAgo(0),
      options:{count:250,offset:0}
    }),
  ]);
  const accounts = acc.value?.accounts || [];
  const cash = accounts.filter(a=>a.type==='depository').map(a=>a.balances?.available ?? a.balances?.current ?? 0);
  const totalCash = money(sum(cash));
  let totalLiabilities=0; if (liab.value?.liabilities){
    const L=liab.value.liabilities;
    totalLiabilities = money(
      sum((L.credit||[]).map(x=>x.balance?.current||0)) +
      sum((L.student||[]).map(x=>x.outstanding_balance||0)) +
      sum((L.mortgage||[]).map(x=>x.principal_balance||0)) +
      sum((L.auto||[]).map(x=>x.outstanding_balance||0))
    );
  }
  let totalInvestments=0;
  if (inv.value?.holdings && inv.value?.securities) {
    const secMap=new Map(); inv.value.securities.forEach(s=>secMap.set(s.security_id,s));
    totalInvestments = money(sum(inv.value.holdings.map(h=>{
      if (typeof h.institution_value==='number') return h.institution_value;
      const sec=secMap.get(h.security_id); const px=sec?.close_price ?? sec?.price ?? 0;
      return (+h.quantity||0)*(+px||0);
    })));
  }
  let income30=0, spend30=0, netCashFlow=0;
  if (tx.value?.transactions) {
    const t=tx.value.transactions;
    income30 = money(sum(t.filter(x=>x.amount<0).map(x=>-x.amount)));
    spend30  = money(sum(t.filter(x=>x.amount>0).map(x=> x.amount)));
    if (income30<spend30 && sum(t.map(x=>x.amount))<0){
      income30 = money(sum(t.filter(x=>x.amount>0).map(x=> x.amount)));
      spend30  = money(sum(t.filter(x=>x.amount<0).map(x=>-x.amount)));
    }
    netCashFlow = money(income30-spend30);
  }
  const monthlySpend = spend30 || 2000;
  const runwayMonths = monthlySpend ? money(totalCash/monthlySpend) : 0;
  const checking = money(sum(accounts.filter(a=>a.subtype==='checking').map(a=>a.balances?.available ?? a.balances?.current ?? 0)));
  const savings  = money(sum(accounts.filter(a=>a.subtype==='savings').map(a=>a.balances?.available ?? a.balances?.current ?? 0)));
  const netWorth = money(totalCash + totalInvestments - totalLiabilities);

  return {
    linked:true, userId,
    accounts: accounts.map(a=>({
      account_id:a.account_id, name:a.name||a.official_name||'Account', mask:a.mask||'',
      type:a.type, subtype:a.subtype,
      available:a.balances?.available ?? null, current:a.balances?.current ?? null,
      currency:a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || 'USD'
    })),
    kpis:{ netWorth, totalCash, checking, savings, totalInvestments, totalLiabilities,
      income30, spend30, netCashFlow, monthlySpend, runwayMonths }
  };
}

// ---------- AI helpers (unchanged behavior, trimmed for brevity) ----------
function withTimeout(p,ms=14000){return Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error('TIMEOUT')),ms))])}
async function askOpenAI(prompt,system){ if(!OPENAI_API_KEY) return null;
  try{const r=await withTimeout(fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,temperature:0.3,messages:[{role:'system',content:system},{role:'user',content:prompt}]})})); const j=await r.json(); return j?.choices?.[0]?.message?.content?.trim()||null;}catch{return null}}
async function askAnthropic(prompt,system){ if(!ANTHROPIC_API_KEY) return null;
  try{const r=await withTimeout(fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:ANTHROPIC_MODEL,max_tokens:1024,system,messages:[{role:'user',content:[{type:'text',text:prompt}]}]})})); const j=await r.json(); return j?.content?.[0]?.text?.trim()||null;}catch{return null}}
async function askGemini(prompt,system){ if(!GEMINI_API_KEY) return null;
  try{const r=await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:`${system}\n\n${prompt}`}] }],generationConfig:{temperature:0.3,maxOutputTokens:1024}})})); const j=await r.json(); return j?.candidates?.[0]?.content?.parts?.map(p=>p.text).join(' ').trim()||null;}catch{return null}}
function fuseReplies(arr){const t=arr.filter(Boolean).map(s=>String(s).trim()).filter(Boolean); if(!t.length) return "I'm ready, but no AI providers responded. Check your AI keys."; const first=t[0]; const seen=new Set(first.split(/(?<=\.)\s+/).map(s=>s.trim().toLowerCase())); const extra=[]; for(let i=1;i<t.length;i++){ for(const part of t[i].split(/(?<=\.)\s+/)){ const k=part.trim().toLowerCase(); if(k && !seen.has(k)){extra.push(part.trim()); if(extra.length>=3) break;} } if(extra.length>=3) break;} return [first,...extra].join(' ')}

// ---------- HTTP server ----------
const server = http.createServer(async (req,res)=>{
  cors(res); if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const parsed=url.parse(req.url,true); const path=parsed.pathname;

  try {
    if (req.method==='GET' && path==='/') return json(res,200,{ok:true,env:PLAID_ENV,db:!!process.env.DATABASE_URL,dbReady});
    if (req.method==='GET' && path==='/ping') return json(res,200,{ok:true,env:PLAID_ENV});

    // Create Link Token
    if (req.method==='POST' && path==='/plaid/link_token/create') {
      const body=await readJSON(req);
      const userId=body.userId || body.user_id || 'default';
      const baseReq={ user:{client_user_id:userId}, client_name:'ACTIV', language:'en', country_codes:COUNTRY_CODES };
      if (process.env.PLAID_REDIRECT_URI) baseReq.redirect_uri=process.env.PLAID_REDIRECT_URI;
      if (process.env.WEBHOOK_URL) baseReq.webhook=process.env.WEBHOOK_URL;
      try{
        const data=await linkTokenCreateSmart(baseReq, body.products);
        return json(res,200,{link_token:data.link_token,expiration:data.expiration,userId,products_used:data.products_used});
      }catch(e){ console.error('link_token error',e); return json(res, e.http_status||500, {error:e.error_code||'PLAID_ERROR', details:e}); }
    }

    // Exchange public_token -> access_token (PERSISTS)
    if (req.method==='POST' && path==='/plaid/exchange_public_token') {
      const body = await readJSON(req);
      const public_token = body.public_token;
      const userId = (body.userId || 'default').toString();
      if (!public_token) return json(res,400,{error:'MISSING_PUBLIC_TOKEN'});
      try{
        const data = await plaidPost('/item/public_token/exchange',{ public_token });
        await setToken(userId, data.access_token);
        return json(res,200,{ item_id:data.item_id, stored_for_user:userId });
      }catch(e){ console.error('exchange error',e); return json(res, e.http_status||500, {error:e.error_code||'EXCHANGE_ERROR', details:e}); }
    }

    // Helper to require token
    async function needToken() {
      const userId=(parsed.query.userId || 'default').toString();
      const tok = await getToken(userId);
      if (!tok) { json(res,401,{error:'NO_LINKED_ITEM_FOR_USER'}); return null; }
      return { userId, tok };
    }

    // Accounts / balances
    if (req.method==='GET' && path==='/plaid/accounts') {
      const nt = await needToken(); if(!nt) return;
      return json(res,200, await plaidPost('/accounts/balance/get',{access_token: nt.tok}));
    }
    if (req.method==='GET' && path==='/plaid/balances') {
      const nt = await needToken(); if(!nt) return;
      return json(res,200, await plaidPost('/accounts/balance/get',{access_token: nt.tok}));
    }

    // Transactions
    if (req.method==='GET' && path==='/plaid/transactions') {
      const nt = await needToken(); if(!nt) return;
      const end=(parsed.query.end || daysAgo(0)); const start=(parsed.query.start || daysAgo(30));
      return json(res,200, await plaidPost('/transactions/get',{access_token: nt.tok, start_date:start, end_date:end, options:{count:250,offset:0}}));
    }

    // Liabilities
    if (req.method==='GET' && path==='/plaid/liabilities') {
      const nt = await needToken(); if(!nt) return;
      return json(res,200, await plaidPost('/liabilities/get',{access_token: nt.tok}));
    }

    // Investments
    if (req.method==='GET' && path==='/plaid/investments/holdings') {
      const nt = await needToken(); if(!nt) return;
      return json(res,200, await plaidPost('/investments/holdings/get',{access_token: nt.tok}));
    }
    if (req.method==='GET' && path==='/plaid/investments/transactions') {
      const nt = await needToken(); if(!nt) return;
      const end=(parsed.query.end || daysAgo(0)); const start=(parsed.query.start || daysAgo(90));
      return json(res,200, await plaidPost('/investments/transactions/get',{access_token: nt.tok, start_date:start, end_date:end}));
    }

    // Auth / Identity / Item
    if (req.method==='GET' && path==='/plaid/auth')      { const nt=await needToken(); if(!nt) return; return json(res,200, await plaidPost('/auth/get',{access_token:nt.tok})); }
    if (req.method==='GET' && path==='/plaid/identity')  { const nt=await needToken(); if(!nt) return; return json(res,200, await plaidPost('/identity/get',{access_token:nt.tok})); }
    if (req.method==='GET' && path==='/plaid/item')      { const nt=await needToken(); if(!nt) return; return json(res,200, await plaidPost('/item/get',{access_token:nt.tok})); }

    // Unlink / delete
    if (req.method==='POST' && path==='/plaid/unlink') {
      const body=await readJSON(req); const userId=(body.userId||'default').toString();
      const tok=await getToken(userId); if(!tok) return json(res,200,{ok:true,message:'Nothing to unlink'});
      try{ await plaidPost('/item/remove',{access_token:tok}); }catch(_){}
      await deleteToken(userId);
      return json(res,200,{ok:true});
    }
    if (req.method==='POST' && path==='/user/delete') {
      const body=await readJSON(req); const userId=(body.userId||'default').toString();
      await deleteToken(userId); return json(res,200,{ok:true});
    }

    // Webhook (optional)
    if (req.method==='POST' && path==='/plaid/webhook') { res.writeHead(200); return res.end(); }

    // Summary
    if (req.method==='GET' && path==='/summary') {
      const userId=(parsed.query.userId||'default').toString();
      const s = await buildSummary(userId);
      return json(res,200,s);
    }

    // JAMARI chat (kept same)
    if (req.method==='POST' && path==='/jamari/chat') {
      const body=await readJSON(req); const userId=(body.userId||'default').toString();
      const message=(body.message||'').toString().slice(0,4000); if(!message) return json(res,400,{error:'NO_MESSAGE'});
      const summary=await buildSummary(userId); const k=summary.kpis||{};
      const sys = "You are JAMARI, a calm, clear personal finance coach. Use live KPIs. Be concise.";
      const context = [
        `Live KPIs: NetWorth:$${k.netWorth||0} Cash:$${k.totalCash||0} Savings:$${k.savings||0} Checking:$${k.checking||0}`,
        `Investments:$${k.totalInvestments||0} Liabilities:$${k.totalLiabilities||0}`,
        `Income30:$${k.income30||0} Spend30:$${k.spend30||0} NetCashFlow:$${k.netCashFlow||0}`,
        `Runway:${k.runwayMonths||0} mo SavingsRate:${((k.savingsRate||0)*100).toFixed?.(1)||'0.0'}%`,
        `User: ${message}`
      ].join('\n');
      const [o,a,g]=await Promise.all([askOpenAI(context,sys), askAnthropic(context,sys), askGemini(context,sys)]);
      return json(res,200,{reply:fuseReplies([o,a,g]), providers:{openai:!!o,anthropic:!!a,gemini:!!g}});
    }

    return json(res,404,{error:'NOT_FOUND'});
  } catch (e) {
    console.error('Server error:', e);
    return json(res,500,{error:'SERVER_ERROR'});
  }
});

initDB().then(()=>{
  server.listen(PORT, ()=>console.log(`ACTIV backend on :${PORT} | env=${PLAID_ENV} | dbReady=${dbReady}`));
}).catch(err=>{
  console.error('DB init failed (falling back to memory):', err);
  server.listen(PORT, ()=>console.log(`ACTIV backend on :${PORT} | env=${PLAID_ENV} | dbReady=false`));
});