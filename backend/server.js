const express = require("express");
const axios = require("axios");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EODHD_KEY = process.env.EODHD_API_KEY || "";
const EODHD_BASE = "https://eodhd.com/api";

// Curated blue-chip stocks per exchange (EODHD free tier: individual EOD calls)
// Format: { symbol: "TICKER.EXCHANGE", name: "Company Name" }
const EXCHANGE_STOCKS = {
  GSE: {
    name: "Ghana Stock Exchange",
    currency: "GHS",
    stocks: [
      { symbol: "MTNGH.GSE",   name: "MTN Ghana" },
      { symbol: "GCB.GSE",     name: "GCB Bank" },
      { symbol: "SOGEGH.GSE",  name: "Societe Generale Ghana" },
      { symbol: "EGH.GSE",     name: "Ecobank Ghana" },
      { symbol: "TOTAL.GSE",   name: "TotalEnergies Marketing Ghana" },
      { symbol: "GOIL.GSE",    name: "Ghana Oil Company" },
      { symbol: "GGBL.GSE",    name: "Guinness Ghana Breweries" },
      { symbol: "CAL.GSE",     name: "CAL Bank" },
      { symbol: "SCB.GSE",     name: "Standard Chartered Bank Ghana" },
      { symbol: "EGL.GSE",     name: "Enterprise Group" },
      { symbol: "BOPP.GSE",    name: "Benso Oil Palm Plantation" },
      { symbol: "CLYD.GSE",    name: "Clydestone Ghana" },
      { symbol: "FML.GSE",     name: "Fan Milk" },
      { symbol: "RBGH.GSE",    name: "Republic Bank Ghana" },
      { symbol: "SIC.GSE",     name: "SIC Insurance Company" },
    ],
  },
  NGX: {
    name: "Nigerian Exchange Group",
    currency: "NGN",
    stocks: [
      { symbol: "DANGCEM.XNSA",   name: "Dangote Cement" },
      { symbol: "MTNN.XNSA",      name: "MTN Nigeria" },
      { symbol: "AIRTELAFRI.XNSA",name: "Airtel Africa" },
      { symbol: "GTCO.XNSA",      name: "Guaranty Trust Holding" },
      { symbol: "ZENITHBANK.XNSA",name: "Zenith Bank" },
      { symbol: "ACCESSCORP.XNSA",name: "Access Holdings" },
      { symbol: "FBNH.XNSA",      name: "FBN Holdings" },
      { symbol: "FIRSTHOLDCO.XNSA",name: "First HoldCo" },
      { symbol: "BUACEMENT.XNSA", name: "BUA Cement" },
      { symbol: "BUAFOODS.XNSA",  name: "BUA Foods" },
      { symbol: "NESTLE.XNSA",    name: "Nestle Nigeria" },
      { symbol: "SEPLAT.XNSA",    name: "Seplat Energy" },
      { symbol: "UBA.XNSA",       name: "United Bank for Africa" },
      { symbol: "FIDELITYBK.XNSA",name: "Fidelity Bank" },
      { symbol: "GEREGU.XNSA",    name: "Geregu Power" },
    ],
  },
  NSE: {
    name: "Nairobi Securities Exchange",
    currency: "KES",
    stocks: [
      { symbol: "SCOM.NAIROBI",  name: "Safaricom" },
      { symbol: "EQTY.NAIROBI", name: "Equity Group Holdings" },
      { symbol: "KCB.NAIROBI",  name: "KCB Group" },
      { symbol: "COOP.NAIROBI", name: "Co-operative Bank" },
      { symbol: "EABL.NAIROBI", name: "East African Breweries" },
      { symbol: "ABSA.NAIROBI", name: "Absa Bank Kenya" },
      { symbol: "NCBA.NAIROBI", name: "NCBA Group" },
      { symbol: "SCBK.NAIROBI", name: "Standard Chartered Kenya" },
      { symbol: "DTK.NAIROBI",  name: "Diamond Trust Bank" },
      { symbol: "KPLC.NAIROBI", name: "Kenya Power & Lighting" },
    ],
  },
  JSE: {
    name: "Johannesburg Stock Exchange",
    currency: "ZAR",
    stocks: [
      { symbol: "NPN.JSE",  name: "Naspers" },
      { symbol: "PRX.JSE",  name: "Prosus" },
      { symbol: "BHP.JSE",  name: "BHP Group" },
      { symbol: "AGL.JSE",  name: "Anglo American" },
      { symbol: "SOL.JSE",  name: "Sasol" },
      { symbol: "FSR.JSE",  name: "FirstRand" },
      { symbol: "SBK.JSE",  name: "Standard Bank" },
      { symbol: "ABG.JSE",  name: "Absa Group" },
      { symbol: "MTN.JSE",  name: "MTN Group" },
      { symbol: "VOD.JSE",  name: "Vodacom Group" },
      { symbol: "SHP.JSE",  name: "Shoprite Holdings" },
      { symbol: "CPI.JSE",  name: "Capitec Bank" },
      { symbol: "REM.JSE",  name: "Remgro" },
      { symbol: "DSY.JSE",  name: "Discovery" },
      { symbol: "INP.JSE",  name: "Investec" },
    ],
  },
  EGX: {
    name: "Egyptian Exchange",
    currency: "EGP",
    stocks: [
      { symbol: "COMI.EGSM",  name: "Commercial International Bank" },
      { symbol: "HRHO.EGSM",  name: "EFG Hermes Holding" },
      { symbol: "OCDI.EGSM",  name: "Orascom Development" },
      { symbol: "SWDY.EGSM",  name: "Edita Food Industries" },
      { symbol: "ESRS.EGSM",  name: "Ezz Steel" },
      { symbol: "EKHO.EGSM",  name: "Eastern Company" },
      { symbol: "TMGH.EGSM",  name: "Talaat Moustafa Group" },
      { symbol: "AMOC.EGSM",  name: "Alexandria Mineral Oils" },
      { symbol: "MNHD.EGSM",  name: "Medinet Nasr Housing" },
      { symbol: "ORWE.EGSM",  name: "Oriental Weavers" },
    ],
  },
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const cache = {
  indices: { data: null, updatedAt: null, error: null },
  movers:  { data: null, updatedAt: null, error: null },
};

const exchangeStocksCache = {};

// ---------------------------------------------------------------------------
// EODHD fetch — single stock EOD
// ---------------------------------------------------------------------------
async function fetchStockEOD(symbol) {
  const res = await axios.get(`${EODHD_BASE}/eod/${symbol}`, {
    params: { api_token: EODHD_KEY, fmt: "json", limit: 1 },
  });
  return Array.isArray(res.data) ? res.data[0] : res.data;
}

// ---------------------------------------------------------------------------
// Fetch all stocks for one exchange
// ---------------------------------------------------------------------------
async function fetchExchangeStocks(exchangeKey) {
  if (!EODHD_KEY) return;
  const ex = EXCHANGE_STOCKS[exchangeKey];
  if (!ex) return;

  const results = [];
  for (const stock of ex.stocks) {
    try {
      const eod = await fetchStockEOD(stock.symbol);
      if (eod && eod.close) {
        results.push({
          symbol: stock.symbol.split(".")[0],
          name: stock.name,
          currency: ex.currency,
          price: eod.close,
          open: eod.open,
          high: eod.high,
          low: eod.low,
          volume: eod.volume,
          change: eod.change || null,
          change_pct: eod.change_p || null,
          date: eod.date,
        });
      }
      // Small delay between calls to be respectful of rate limits
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[${exchangeKey}] ${stock.symbol} failed: ${err.message}`);
    }
  }

  if (results.length > 0) {
    exchangeStocksCache[exchangeKey] = {
      data: results,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    console.log(`[${new Date().toISOString()}] ${exchangeKey} refreshed (${results.length}/${ex.stocks.length} stocks)`);
  } else {
    if (!exchangeStocksCache[exchangeKey]) exchangeStocksCache[exchangeKey] = {};
    exchangeStocksCache[exchangeKey].error = "No data returned for any stocks";
    console.error(`[${exchangeKey}] No stocks loaded`);
  }
}

// ---------------------------------------------------------------------------
// Build movers from all cached exchange data
// ---------------------------------------------------------------------------
function buildMovers() {
  const allStocks = [];
  for (const [key, cached] of Object.entries(exchangeStocksCache)) {
    if (!cached?.data?.length) continue;
    cached.data.forEach((s) => allStocks.push({ ...s, exchange: key }));
  }

  const withChange = allStocks.filter((s) => s.change_pct != null);
  const sorted = [...withChange].sort((a, b) => b.change_pct - a.change_pct);

  cache.movers = {
    data: {
      gainers: sorted.filter((s) => s.change_pct > 0).slice(0, 10),
      losers:  sorted.filter((s) => s.change_pct < 0).reverse().slice(0, 10),
    },
    updatedAt: new Date().toISOString(),
    error: null,
  };
  console.log(`[${new Date().toISOString()}] Movers built`);
}

// ---------------------------------------------------------------------------
// Build indices summary from cached stock data
// ---------------------------------------------------------------------------
function buildIndices() {
  const indexData = Object.entries(EXCHANGE_STOCKS).map(([key, ex]) => {
    const cached = exchangeStocksCache[key];
    if (!cached?.data?.length) return null;
    const stocks = cached.data;
    const gainers   = stocks.filter((s) => (s.change_pct || 0) > 0).length;
    const losers    = stocks.filter((s) => (s.change_pct || 0) < 0).length;
    const avgChange = stocks.reduce((sum, s) => sum + (s.change_pct || 0), 0) / stocks.length;
    return {
      exchange: key,
      name: ex.name,
      currency: ex.currency,
      total_stocks: stocks.length,
      gainers,
      losers,
      unchanged: stocks.length - gainers - losers,
      avg_change_pct: parseFloat(avgChange.toFixed(2)),
      date: stocks[0]?.date || null,
    };
  }).filter(Boolean);

  cache.indices = { data: indexData, updatedAt: new Date().toISOString(), error: null };
  console.log(`[${new Date().toISOString()}] Indices summary built`);
}

// ---------------------------------------------------------------------------
// Refresh a single exchange then rebuild derived data
// ---------------------------------------------------------------------------
async function refreshExchange(key) {
  console.log(`[${new Date().toISOString()}] EOD refresh: ${key}`);
  await fetchExchangeStocks(key);
  buildMovers();
  buildIndices();
}

// ---------------------------------------------------------------------------
// Startup: prime all caches
// ---------------------------------------------------------------------------
async function primeCache() {
  console.log(`[${new Date().toISOString()}] Priming cache on startup...`);
  for (const key of Object.keys(EXCHANGE_STOCKS)) {
    await fetchExchangeStocks(key);
  }
  buildMovers();
  buildIndices();
  console.log(`[${new Date().toISOString()}] Cache primed.`);
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://labarijournal.com",
  "https://www.labarijournal.com",
  /\.labarijournal\.com$/,
  /\.github\.io$/,
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some((o) =>
      typeof o === "string" ? o === origin : o.test(origin)
    );
    allowed ? callback(null, true) : callback(new Error("Not allowed by CORS"));
  },
}));

app.use(express.json());

// ---------------------------------------------------------------------------
// Helper: respond from cache or 503
// ---------------------------------------------------------------------------
function sendCached(res, entry, label) {
  if (entry?.data) {
    return res.json({ success: true, source: label, updatedAt: entry.updatedAt, data: entry.data });
  }
  return res.status(503).json({
    success: false, source: label,
    error: entry?.error || "Data not yet available. Retry in a moment.",
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GSE is served from exchangeStocksCache["GSE"]
app.get("/api/gse/live", (req, res) => {
  sendCached(res, exchangeStocksCache["GSE"], "eodhd/GSE");
});

app.get("/api/gse/equities", (req, res) => {
  sendCached(res, exchangeStocksCache["GSE"], "eodhd/GSE");
});

// Single GSE stock — direct EODHD call
app.get("/api/gse/live/:symbol", async (req, res) => {
  try {
    const symbol = `${req.params.symbol.toUpperCase()}.GSE`;
    const eod = await fetchStockEOD(symbol);
    res.json({ success: true, source: "eodhd", data: eod });
  } catch (err) {
    res.status(err.response?.status || 500).json({ success: false, error: err.message });
  }
});

// Pan-African routes
app.get("/api/markets/indices", (req, res) => sendCached(res, cache.indices, "eodhd/indices"));
app.get("/api/markets/movers",  (req, res) => sendCached(res, cache.movers,  "eodhd/movers"));

app.get("/api/markets/exchanges/:exchange/stocks", (req, res) => {
  const ex = req.params.exchange.toUpperCase();
  const entry = exchangeStocksCache[ex];
  if (!entry) {
    return res.status(404).json({
      success: false,
      error: `Exchange "${ex}" not supported. Options: ${Object.keys(EXCHANGE_STOCKS).join(", ")}`,
    });
  }
  sendCached(res, entry, `eodhd/${ex}`);
});

// Status
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    status: {
      indices: { updatedAt: cache.indices.updatedAt, ok: !!cache.indices.data },
      movers:  { updatedAt: cache.movers.updatedAt,  ok: !!cache.movers.data },
      exchange_stocks: Object.fromEntries(
        Object.keys(EXCHANGE_STOCKS).map((ex) => [
          ex,
          { updatedAt: exchangeStocksCache[ex]?.updatedAt || null, ok: !!exchangeStocksCache[ex]?.data },
        ])
      ),
      eohdKeyConfigured: !!EODHD_KEY,
    },
  });
});

// ---------------------------------------------------------------------------
// EOD cron schedules — Mon–Fri only
// ---------------------------------------------------------------------------
cron.schedule("5 12 * * 1-5",  () => refreshExchange("NSE"));
cron.schedule("35 12 * * 1-5", () => refreshExchange("EGX"));
cron.schedule("35 13 * * 1-5", () => refreshExchange("NGX"));
cron.schedule("5 15 * * 1-5",  async () => { await refreshExchange("GSE"); await refreshExchange("JSE"); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`Labari Markets API running on port ${PORT}`);
  await primeCache();
});
