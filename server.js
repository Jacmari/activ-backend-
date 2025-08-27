// server.js
// ACTIV Finance Backend — single-file build (Plaid + Knowledge)
// Works on Heroku. Requires env vars: PLAID_CLIENT_ID, PLAID_SECRET, (optional) PLAID_ENV=production
// Optional: /data/books/*.txt (your notes/summaries) for JAMARI knowledge search

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

// ------------------------ Plaid setup ------------------------
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET     = process.env.PLAID_SECRET || '';
const PLAID_ENV        = (process.env.PLAID_ENV || 'production').toLowerCase(); // 'production'|'sandbox'|'development'

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV] || PlaidEnvironments.production,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(plaidConfig);

// simple in-memory token store (per dyno). For a real app, persist per-user.
let ACCESS_TOKEN = null;

// ------------------------ Knowledge (inline) ------------------------
const BOOKS_DIR = path.join(__dirname, 'data', 'books');
let KNOW_INDEX = []; // [{book, chunk, tokens, tf}]
let KNOW_STATS = { files: 0, chunks: 0, bytes: 0, indexed: 0 };

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokenize(text) {
  return normalize(text).split(' ').filter(Boolean);
}
function tf(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
function cosine(a, b) {
  let dot = 0, a2 = 0, b2 = 0;
  for (const v of a.values()) a2 += v*v;
  for (const v of b.values()) b2 += v*v;
  for (const [k, v] of a.entries()) dot += v * (b.get(k) || 0);
  return dot / ((Math.sqrt(a2) * Math.sqrt(b2)) || 1);
}
function chunkText(text, target = 800, overlap = 120) {
  const clean = String(text || '').replace(/\r/g, '');
  const paras = clean.split(/\n{2,}/);
  const out = [];
  let buf = '';
  const push = (s) => { s = s.trim(); if (s) out.push(s); };
  for (const p of paras) {
    if ((buf + '\n\n' + p).length <= target) {
      buf = buf ? buf + '\n\n' + p : p;
    } else {
      if (buf) push(buf);
      if (p.length <= target) {
        buf = p;
      } else {
        let i = 0;
        while (i < p.length) {
          push(p.slice(i, i + target));
          i += target - overlap;
        }
        buf = '';
      }
    }
  }
  if (buf) push(buf);
  return out;
}
async function knowledgeInit() {
  KNOW_INDEX = [];
  KNOW_STATS = { files: 0, chunks: 0, bytes: 0, indexed: 0 };

  if (!fs.existsSync(BOOKS_DIR)) {
    console.log('knowledge: no /data/books directory (optional)');
    return KNOW_STATS;
  }
  const files = (await fsp.readdir(BOOKS_DIR, { withFileTypes: true }))
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
    .map(e => path.join(BOOKS_DIR, e.name));

  for (const file of files) {
    const raw = await fsp.readFile(file, 'utf8');
    KNOW_STATS.files += 1;
    KNOW_STATS.bytes += Buffer.byteLength(raw, 'utf8');
    const book = path.basename(file, '.txt').replace(/_/g, ' ');
    const chunks = chunkText(raw);
    for (const chunk of chunks) {
      const tokens = tokenize(chunk);
      if (!tokens.length) continue;
      KNOW_INDEX.push({ book, chunk, tokens, tf: tf(tokens) });
      KNOW_STATS.chunks += 1;
    }
  }
  KNOW_INDEX.sort((a,b)=>a.book.localeCompare(b.book));
  KNOW_STATS.indexed = KNOW_INDEX.length;
  console.log('knowledge: loaded', KNOW_STATS);
  return KNOW_STATS;
}
function knowledgeSearch(query, topK = 5) {
  const qTokens = tokenize(query);
  if (!qTokens.length || !KNOW_INDEX.length) return [];
  const qTF = tf(qTokens);

  const hints = {
    tax: /tax|irs|deduct|credit|refund|w[-\s]?2|1099|schedule|business/i.test(query),
    invest: /invest|portfolio|etf|stock|bond|allocation|rebalance|index/i.test(query),
    debt: /debt|loan|snowball|avalanche|interest|apr/i.test(query),
    budget: /budget|50\/?30\/?20|cash flow|envelope|save/i.test(query),
  };
  const boost = (book) => {
    const b = book.toLowerCase();
    let x = 1.0;
    if (hints.tax && (b.includes('tax'))) x += 0.25;
    if (hints.invest && (b.includes('investor') || b.includes('money'))) x += 0.2;
    if (hints.debt && (b.includes('total money') || b.includes('rich dad'))) x += 0.15;
    if (hints.budget && (b.includes('dummies') || b.includes('money'))) x += 0.1;
    return x;
  };

  return KNOW_INDEX.map(e => {
    const sim = cosine(e.tf, qTF);
    const lenPenalty = Math.min(1, 400 / Math.max(100, e.tokens.length));
    return { score: sim * lenPenalty * boost(e.book), book: e.book, excerpt: e.chunk.slice(0, 600) };
  }).filter(s => s.score > 0.01)
    .sort((a,b)=>b.score - a.score)
    .slice(0, topK);
}

// fire up knowledge at boot (non-blocking for Plaid)
knowledgeInit().catch(err => console.error('knowledge init error', err));

// ------------------------ Express app ------------------------
const app = express();
app.use(cors());
app.use(express.json());

// health
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', plaid_env: PLAID_ENV, knowledge: KNOW_STATS });
});

// ---- Plaid: Link token ----
app.post('/plaid/link_token/create', async (req, res) => {
  try {
    const { user_id } = req.body || {};
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: String(user_id || 'demo-user') },
      client_name: 'ACTIV FINANCE JAMARI',
      products: ['transactions', 'balances', 'investments'],
      country_codes: ['US'],
      language: 'en',
      // redirect_uri: (optional, if you configured OAuth)
    });
    res.json(response.data);
  } catch (err) {
    console.error('link_token error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link_token' });
  }
});

// ---- Plaid: exchange public token ----
app.post('/plaid/exchange_public_token', async (req, res) => {
  try {
    const { public_token } = req.body || {};
    const resp = await plaid.itemPublicTokenExchange({ public_token });
    ACCESS_TOKEN = resp.data.access_token;
    res.json({ ok: true });
  } catch (err) {
    console.error('exchange error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange public_token' });
  }
});

// ---- Balances (real-time) ----
app.get('/plaid/balances', async (_req, res) => {
  try {
    if (!ACCESS_TOKEN) return res.status(400).json({ error: 'not_linked' });
    const resp = await plaid.accountsBalanceGet({ access_token: ACCESS_TOKEN });
    res.json(resp.data);
  } catch (err) {
    console.error('balances error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'balances_failed' });
  }
});

// ---- Transactions (last 60 days) ----
app.get('/plaid/transactions', async (req, res) => {
  try {
    if (!ACCESS_TOKEN) return res.status(400).json({ error: 'not_linked' });
    const end = new Date();
    const start = new Date(); start.setDate(start.getDate() - 60);
    const fmt = (d)=>d.toISOString().slice(0,10);

    const opts = {
      access_token: ACCESS_TOKEN,
      start_date: fmt(start),
      end_date: fmt(end),
      options: { count: 250, offset: 0 }
    };
    const resp = await plaid.transactionsGet(opts);
    res.json(resp.data);
  } catch (err) {
    console.error('transactions error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'transactions_failed' });
  }
});

// ---- Investments (holdings) ----
app.get('/plaid/investments/holdings', async (_req, res) => {
  try {
    if (!ACCESS_TOKEN) return res.status(400).json({ error: 'not_linked' });
    const resp = await plaid.investmentsHoldingsGet({ access_token: ACCESS_TOKEN });
    res.json(resp.data);
  } catch (err) {
    console.error('investments error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'investments_failed' });
  }
});

// ---- Knowledge search endpoint ----
app.get('/knowledge/search', (req, res) => {
  const q = (req.query.q || '').toString();
  const k = Math.min(10, Math.max(1, parseInt(req.query.k || '5', 10)));
  const hits = q ? knowledgeSearch(q, k) : [];
  res.json({ query: q, hits, stats: KNOW_STATS });
});

// root
app.get('/', (_req, res) => res.json({ ok: true, service: 'ACTIV backend' }));

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ACTIV backend listening on :${PORT} (env=${PLAID_ENV})`);
});