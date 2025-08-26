// Create link token (transactions only)
app.post("/plaid/link_token/create", async (req, res) => {
  try {
    const payload = {
      user: { client_user_id: "demo-user" },
      client_name: "ACTIV FINANCE JAMARI",
      products: ["transactions"],   // << ONLY THIS
      country_codes: ["US"],
      language: "en",
      // redirect_uri: process.env.PLAID_REDIRECT_URI, // leave commented unless you set it in both Plaid & Heroku
    };
    console.log("Creating link token with:", { env: PLAID_ENV, products: payload.products });
    const response = await client.linkTokenCreate(payload);
    res.json(response.data);
  } catch (err) {
    console.error("link_token/create error:", err?.response?.data || err);
    res.status(400).json(err?.response?.data || { error: "Failed to create link_token" });
  }
});