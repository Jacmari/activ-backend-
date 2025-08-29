// server.js
// ACTIV Banking backend — Heroku + Plaid + Postgres
// Works with your current frontend and adds update-mode (investments)

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = require('@plaid/plaid');

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS: allow your app (Netlify) and local
app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    credentials: false,
  })
);

// ----- Env -----
const PORT = process.env.PORT || 3000;
const PLAID_ENV = String(process.env.PLAID_ENV || 'sandbox').toLowerCase();
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',')
  .map((s) => s.trim());
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || undefined;
// default products: don't force "investments" at link; we'll add it via update-mode
const PLAID_PRODUCTS = (process.env.PLAID_PRODUCTS ||
  'transactions,liabilities')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ----- Plaid client -----
const plaidCfg = new Configuration({
  basePath:
    PLAID_ENV === 'production'
      ? PlaidEnvironments.production
      : PLAID_ENV === 'development'
      ? PlaidEnvironments.development
      : PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidCfg);

// ----- Postgres -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : undefined,
});
async function dbExec(sql, params = []) {
  const c = await pool.connect();
  try {
    return await c.query(sql, params);
  } finally {
    c.release();
  }
}
async function dbOne(sql, params = []) {
  const r = await dbExec(sql, params);
  return r.rows[0] || null;
}
async function dbInit() {
  // Create tokens table (idempotent) and make sure needed columns exist
  await dbExec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      item_id TEXT,
      institution_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await dbExec(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS item_id TEXT;`);
  await dbExec(
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS institution_name TEXT;`
  );
  await dbExec(
    `CREATE INDEX IF NOT EXISTS idx_tokens_user_created ON tokens(user_id, created_at DESC);`
  );
}

// helper: latest token for a user
async function getLatestToken(userId = 'default') {
  return await dbOne(
    `SELECT access_token, item_id FROM tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
}

// ----- Health -----
app.get('/', async (req, res) => {
  try {
    await dbInit();
    res.json({ ok: true, env: PLAID_ENV, db: true, dbReady: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/ping', (req, res) => res.json({ ok: true }));

// ----- Plaid: Link token (create) -----
app.post('/plaid/link_token/create', async (req, res) => {
  try {
    const { userId = 'default' } = req.body || {};
    const request = {
      user: { client_user_id: userId },
      client_name: 'ACTIV Finance',
      products: PLAID_PRODUCTS,
      country_codes: PLAID_COUNTRY_CODES,
      language: 'en',
    };
    if (PLAID_REDIRECT_URI) request.redirect_uri = PLAID_REDIRECT_URI;

    const resp = await plaidClient.linkTokenCreate(request);
    res.json({ link_token: resp.data.link_token, expiration: resp.data.expiration });
  } catch (e) {
    console.error('link_token/create error', e?.response?.data || e);
    res
      .status(500)
      .json({ error: 'LINK_TOKEN_CREATE_FAIL', details: e?.response?.data || String(e) });
  }
});

// ----- Plaid: exchange public_token (store access_token) -----
app.post('/plaid/exchange_public_token', async (req, res) => {
  try {
    const { public_token, userId = 'default', institution_name } = req.body || {};
    if (!public_token) return res.status(400).json({ error: 'NO_PUBLIC_TOKEN' });

    const exch = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exch.data.access_token;
    const item_id = exch.data.item_id;

    await dbExec(
      `INSERT INTO tokens (user_id, access_token, item_id, institution_name)
       VALUES ($1,$2,$3,$4)`,
      [userId, access_token, item_id || null, institution_name || null]
    );

    res.json({ ok: true, item_id });
  } catch (e) {
    console.error('exchange_public_token error', e?.response?.data || e);
    res
      .status(500)
      .json({ error: 'EXCHANGE_FAIL', details: e?.response?.data || String(e) });
  }
});

// ----- Plaid: item remove -----
app.post('/plaid/item/remove', async (req, res) => {
  try {
    const { userId = 'default' } = req.body || {};
    const row = await getLatestToken(userId);
    if (!row?.access_token) return res.status(400).json({ error: 'NO_LINKED_ITEM_FOR_USER' });

    await plaidClient.itemRemove({ access_token: row.access_token });
    await dbExec(`DELETE FROM tokens WHERE user_id = $1`, [userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('item/remove error', e?.response?.data || e);
    res
      .status(500)
      .json({ error: 'ITEM_REMOVE_FAIL', details: e?.response?.data || String(e) });
  }
});

// ===== 2A) Plaid: link_token UPDATE (add investments to the current Item) =====
app.post('/plaid/link_token/update', async (req, res) => {
  try {
    const { userId = 'default' } = req.body || {};
    const row = await getLatestToken(userId);
    if (!row?.access_token) return res.status(400).json({ error: 'NO_ACCESS_TOKEN' });

    const cfg = {
      access_token: row.access_token,
      user: { client_user_id: userId },
      // request an additional product to be added to the Item
      products: ['investments'],
      client_name: 'ACTIV Finance',
      country_codes: PLAID_COUNTRY_CODES,
      language: 'en',
    };
    if (PLAID_REDIRECT_URI) cfg.redirect_uri = PLAID_REDIRECT_URI;

    const resp = await plaidClient.linkTokenCreate(cfg);
    res.json({ link_token: resp.data.link_token, expiration: resp.data.expiration });
  } catch (e) {
    console.error('update link_token error', e?.response?.data || e);
    res
      .status(500)
      .json({ error: 'LINK_TOKEN_UPDATE_FAIL', details: e?.response?.data || String(e) });
  }
});

// ----- Data: accounts -----
app.get('/plaid/accounts', async (req, res) => {
  try {
    const userId = (req.query.userId || 'default').toString();
    const row = await getLatestToken(userId);
    if (!row?.access_token) return res.status(400).json({ error: 'NO_LINKED_ITEM_FOR_USER' });

    const r = await plaidClient.accountsBalanceGet({ access_token: row.access_token });
    res.json({ accounts: r.data.accounts || [] });
  } catch (e) {
    console.error('accounts error', e?.response?.data || e);
    const status = e?.response?.status || 500;
    res.status(status).json({ error: 'PLAID_ERROR', details: e?.response?.data || String(e) });
  }
});

// ----- Data: transactions -----
app.get('/plaid/transactions', async (req, res) => {
  try {
    const userId = (req.query.userId || 'default').toString();
    const start = (req.query.start || '').toString();
    const end = (req.query.end || '').toString();
    const row = await getLatestToken(userId);
    if (!row?.access_token) return res.status(400).json({ error: 'NO_LINKED_ITEM_FOR_USER' });

    const r = await plaidClient.transactionsGet({
      access_token: row.access_token,
      start_date: start,
      end_date: end,
      options: { count: 500, offset: 0 },
    });

    res.json({ transactions: r.data.transactions || [] });
  } catch (e) {
    console.error('transactions error', e?.response?.data || e);
    const status = e?.response?.status || 500;
    res.status(status).json({ error: 'PLAID_ERROR', details: e?.response?.data || String(e) });
  }
});

// ----- Data: liabilities -----
app.get('/plaid/liabilities', async (req, res) => {
  try {
    const userId = (req.query.userId || 'default').toString();
    const row = await getLatestToken(userId);
    if (!row?.access_token) return res.status(400).json({ error: 'NO_LINKED_ITEM_FOR_USER' });

    const r = await plaidClient.liabilitiesGet({ access_token: row.access_token });
    res.json({ liabilities: r.data.liabilities || {} });
  } catch (e) {
    console.error('liabilities error', e?.response?.data || e);
    const status = e?.response?.status || 500;
    res.status(status).json({ error: 'PLAID_ERROR', details: e?.response?.data || String(e) });
  }
});

// ----- Data: investments/holdings -----
app.get('/plaid/investments/holdings', async (req, res) => {
  try {
    const userId = (req.query.userId || 'default').toString();
    const row = await getLatestToken(userId);
    if (!row?.access_token) return res.status(400).json({ error: 'NO_LINKED_ITEM_FOR_USER' });

    const r = await plaidClient.investmentsHoldingsGet({
      access_token: row.access_token,
    });
    res.json({
      holdings: r.data.holdings || [],
      securities: r.data.securities || [],
      accounts: r.data.accounts || [],
    });
  } catch (e) {
    console.error('investments/holdings error', e?.response?.data || e);
    const status = e?.response?.status || 500;
    res.status(status).json({ error: 'PLAID_ERROR', details: e?.response?.data || String(e) });
  }
});

// ----- Start -----
(async () => {
  await dbInit();
  app.listen(PORT, () =>
    console.log(
      `ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV} | DB=${!!process.env.DATABASE_URL}`
    )
  );
})();