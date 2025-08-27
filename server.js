// ACTIV Banking Backend — Plaid v23
// Products: transactions + balance

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const PORT = process.env.PORT || 3000;

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET    = process.env.PLAID_SECRET;
const PLAID_ENV       = (process.env.PLAID_ENV || 'sandbox').toLowerCase(); // sandbox|development|production

// Plaid client
const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});
const client = new PlaidApi(config);

// Single-user, in-memory store (demo)
const store = { accessToken: null, itemId: null };

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Health
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', env: PLAID_ENV, time: new Date().toISOString() });
});

// Create Link token (ONLY products you have access to)
app.post('/plaid/link_token/create', async (req, res) => {
  try {
    const user_id = (req.body && req.body.user_id) || 'local-user';
    const response = await client.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: 'ACTIV FINANCE JAMARI',
      products: ['transactions', 'balance'],
      country_codes: ['US'],
      language: 'en',
      // redirect_uri: process.env.PLAID_REDIRECT_URI, // only needed for OAuth banks
    });
    res.json(response.data);
  } catch (err) {
    console.error('link_token error:', err?.response?.data || err);
    res.status(err?.response?.status || 500).json({
      error: 'Failed to create link_token',
      details: err?.response?.data || String(err),
    });
  }
});

// Exchange public token
app.post('/plaid/exchange_public_token', async (req, res) => {
  try {
    const public_token = req.body?.public_token;
    if (!public_token) return res.status(400).json({ error: 'Missing public_token' });
    const r = await client.itemPublicTokenExchange({ public_token });
    store.accessToken = r.data.access_token;
    store.itemId = r.data.item_id;
    res.json({ ok: true });
  } catch (err) {
    console.error('exchange error:', err?.response?.data || err);
    res.status(err?.response?.status || 500).json({
      error: 'Failed to exchange token',
      details: err?.response?.data || String(err),
    });
  }
});

// Balances for all accounts
app.get('/balances', async (_req, res) => {
  try {
    if (!store.accessToken) return res.status(401).json({ error: 'Not linked' });
    const r = await client.accountsBalanceGet({ access_token: store.accessToken });
    const accounts = r.data.accounts || [];
    const totals = accounts.reduce(
      (acc, a) => {
        const cur = a.balances?.current ?? 0;
        return { count: acc.count + 1, total: acc.total + (Number(cur) || 0) };
      },
      { count: 0, total: 0 }
    );
    res.json({ accounts, totals });
  } catch (err) {
    console.error('balances error:', err?.response?.data || err);
    res.status(err?.response?.status || 500).json({
      error: 'Failed to fetch balances',
      details: err?.response?.data || String(err),
    });
  }
});

// Transactions (last 30 days default)
app.get('/transactions', async (req, res) => {
  try {
    if (!store.accessToken) return res.status(401).json({ error: 'Not linked' });
    const end   = req.query.end   || new Date().toISOString().slice(0,10);
    const start = req.query.start || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
    const r = await client.transactionsGet({
      access_token: store.accessToken,
      start_date: start,
      end_date: end,
      options: { count: 100, offset: 0 },
    });
    res.json(r.data);
  } catch (err) {
    console.error('transactions error:', err?.response?.data || err);
    res.status(err?.response?.status || 500).json({
      error: 'Failed to fetch transactions',
      details: err?.response?.data || String(err),
    });
  }
});

// Simple combined summary
app.get('/summary', async (_req, res) => {
  try {
    if (!store.accessToken) return res.status(401).json({ error: 'Not linked' });
    const [bal, tx] = await Promise.all([
      client.accountsBalanceGet({ access_token: store.accessToken }),
      client.transactionsGet({
        access_token: store.accessToken,
        start_date: new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10),
        end_date: new Date().toISOString().slice(0,10),
        options: { count: 100, offset: 0 },
      }),
    ]);
    const accounts = bal.data.accounts || [];
    const total = accounts.reduce((sum,a)=>sum + (Number(a.balances?.current)||0), 0);
    res.json({ totalBalance: total, accountCount: accounts.length, last30d: tx.data.transactions?.length || 0 });
  } catch (err) {
    console.error('summary error:', err?.response?.data || err);
    res.status(err?.response?.status || 500).json({
      error: 'Failed to build summary',
      details: err?.response?.data || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on :${PORT} (env=${PLAID_ENV})`);
});