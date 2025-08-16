const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔑 Read keys from Heroku Config Vars
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || "sandbox";

// Plaid client setup
const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
      "PLAID-SECRET": PLAID_SECRET,
    },
  },
});
const client = new PlaidApi(config);

// 🔹 Health check
app.get("/ping", (req, res) => {
  res.json({ status: "ok", message: "Backend is running 🚀" });
});

// 🔹 Create link token
app.post("/plaid/link_token/create", async (req, res) => {
  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: "demo-user" },
      client_name: "ACTIV FINANCE JAMARI",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
    });
    res.json(response.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create link_token" });
  }
});

// 🔹 Exchange public token
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await client.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    // In a real app you'd save access_token in a database
    res.json({ access_token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to exchange public_token" });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});