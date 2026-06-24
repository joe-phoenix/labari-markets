const express = require("express");
const axios = require("axios");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MANSA_API_KEY = process.env.MANSA_API_KEY || "";
const MANSA_BASE = "https://api.mansaapi.com/api/v1";
const GSE_BASE = "https://dev.kwayisi.org/apis/gse";

// Exchanges to pull from Mansa (free tier — pick the most relevant)
const MANSA_EXCHANGES = ["NGX", "NSE", "JSE", "BRVM", "EGX"];

// ---------------------------------------------------------------------------
// In-memory cache
// Each key holds: { data, updatedAt, error }
// ---------------------------------------------------------------------------
const cache = {
  gse_live: { data: null, updatedAt: null, error: null },
  gse_equities: { data: null, updatedAt: null, error: null },
  mansa_exchanges: { data: null, updatedAt: null, error: null },
  mansa_movers: { data: null, updatedAt: null, error: null },
  mansa_indices: { data: null, updatedAt: null, error: null },
};

// Per-exchange stock cache: { NGX: { data, updatedAt, error }, ... }
const exchangeStocksCache = {};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchGSELive() {
  try {
    const res = await axios.get(`${GSE_BASE}/live`);
    cache.gse_live = { data: res.data, updatedAt: new Date().toISOString(), error: null };
    console.log(`[${new Date().toISOString()}] GSE live refreshed (${res.data.length} stocks)`);
  } catch (err) {
    cache.gse_live.error = err.message;
    console.error(`[GSE live] fetch failed: ${err.message}`);
  }
}

async function fetchGSEEquities() {
  try {
    const res = await axios.get(`${GSE_BASE}/equities`);
    cache.gse_equities = { data: res.data, updatedAt: new Date().toISOString(), error: null };
    console.log(`[${new Date().toISOString()}] GSE equities refreshed`);
  } catch (err) {
    cache.gse_equities.error = err.message;
    console.error(`[GSE equities] fetch failed: ${err.message}`);
  }
}

async function fetchMansaExchanges() {
  if (!MANSA_API_KEY) return;
  try {
    const res = await axios.get(`${MANSA_BASE}/markets/exchanges`, {
      headers: { Authorization: `Bearer ${MANSA_API_KEY}` },
    });
    cache.mansa_exchanges = { data: res.data, updatedAt: new Date().toISOString(), error: null };
    console.log(`[${new Date().toISOString()}] Mansa exchanges refreshed`);
  } catch (err) {
    cache.mansa_exchanges.error = err.message;
    console.error(`[Mansa exchanges] fetch failed: ${err.message}`);
  }
}

async function fetchMansaMovers() {
  if (!MANSA_API_KEY) return;
  try {
    const res = await axios.get(`${MANSA_BASE}/markets/movers/pan-african`, {
      headers: { Authorization: `Bearer ${MANSA_API_KEY}` },
    });
    cache.mansa_movers = { data: res.data, updatedAt: new Date().toISOString(), error: null };
    console.log(`[${new Date().toISOString()}] Mansa movers refreshed`);
  } catch (err) {
    cache.mansa_movers.error = err.message;
    console.error(`[Mansa movers] fetch failed: ${err.message}`);
  }
}

async function fetchMansaIndices() {
  if (!MANSA_API_KEY) return;
  try {
    const res = await axios.get(`${MANSA_BASE}/markets/indices`, {
      headers: { Authorization: `Bearer ${MANSA_API_KEY}` },
    });
    cache.mansa_indices = { data: res.data, updatedAt: new Date().toISOString(), error: null };
    console.log(`[${new Date().toISOString()}] Mansa indices refreshed`);
  } catch (err) {
    cache.mansa_indices.error = err.message;
    console.error(`[Mansa indices] fetch failed: ${err.message}`);
  }
}

async function fetchMansaExchangeStocks(exchange) {
  if (!MANSA_API_KEY) return;
  try {
    const res = await axios.get(`${MANSA_BASE}/markets/exchanges/${exchange}/stocks`, {
      headers: { Authorization: `Bearer ${MANSA_API_KEY}` },
    });
    exchangeStocksCache[exchange] = {
      data: res.data,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    console.log(`[${new Date().toISOString()}] Mansa ${exchange} stocks refreshed`);
  } catch (err) {
    if (!exchangeStocksCache[exchange]) exchangeStocksCache[exchange] = {};
    exchangeStocksCache[exchange].error = err.message;
    console.error(`[Mansa ${exchange} stocks] fetch failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Refresh functions grouped by exchange close time
// All crons run Mon–Fri only. Times are UTC.
//
//  12:05 UTC — NSE Kenya closes 15:00 EAT (UTC+3)
//  12:35 UTC — EGX Egypt closes 14:30 EET (UTC+2)
//  13:35 UTC — NGX Nigeria closes 14:30 WAT (UTC+1)
//  15:05 UTC — GSE Ghana closes 15:00 GMT (UTC+0)
//              JSE South Africa closes 17:00 SAST (UTC+2)
//  15:35 UTC — BRVM West Africa closes 15:30 GMT (UTC+0)
//  16:05 UTC — Movers + indices: after all major exchanges closed
// ---------------------------------------------------------------------------

async function refreshGSE() {
  console.log(`[${new Date().toISOString()}] EOD refresh: GSE`);
  await fetchGSELive();
  await fetchGSEEquities();
}

async function refreshNGX() {
  console.log(`[${new Date().toISOString()}] EOD refresh: NGX`);
  await fetchMansaExchangeStocks("NGX");
}

async function refreshNSE() {
  console.log(`[${new Date().toISOString()}] EOD refresh: NSE (Kenya)`);
  await fetchMansaExchangeStocks("NSE");
}

async function refreshJSE() {
  console.log(`[${new Date().toISOString()}] EOD refresh: JSE`);
  await fetchMansaExchangeStocks("JSE");
}

async function refreshBRVM() {
  console.log(`[${new Date().toISOString()}] EOD refresh: BRVM`);
  await fetchMansaExchangeStocks("BRVM");
}

async function refreshEGX() {
  console.log(`[${new Date().toISOString()}] EOD refresh: EGX`);
  await fetchMansaExchangeStocks("EGX");
}

async function refreshPanAfricanSummary() {
  console.log(`[${new Date().toISOString()}] EOD refresh: pan-African summary (movers, indices, exchanges)`);
  await fetchMansaExchanges();
  await fetchMansaMovers();
  await fetchMansaIndices();
}

// Startup: prime all caches immediately so the server is ready on first request
async function primeCache() {
  console.log(`[${new Date().toISOString()}] Priming cache on startup...`);
  await fetchGSELive();
  await fetchGSEEquities();
  await fetchMansaExchanges();
  await fetchMansaMovers();
  await fetchMansaIndices();
  for (const ex of MANSA_EXCHANGES) {
    await fetchMansaExchangeStocks(ex);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[${new Date().toISOString()}] Cache primed.`);
}

// ---------------------------------------------------------------------------
// CORS — allow GitHub Pages domain + localhost
// ---------------------------------------------------------------------------
const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://labarijournal.com",
  "https://www.labarijournal.com",
  /\.labarijournal\.com$/,
  /\.github\.io$/,
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // same-origin / curl
      const allowed = allowedOrigins.some((o) =>
        typeof o === "string" ? o === origin : o.test(origin)
      );
      allowed ? callback(null, true) : callback(new Error("Not allowed by CORS"));
    },
  })
);

app.use(express.json());

// ---------------------------------------------------------------------------
// Helper: respond from cache or 503
// ---------------------------------------------------------------------------
function sendCached(res, cacheEntry, label) {
  if (cacheEntry.data) {
    return res.json({
      success: true,
      source: label,
      updatedAt: cacheEntry.updatedAt,
      data: cacheEntry.data,
    });
  }
  return res.status(503).json({
    success: false,
    source: label,
    error: cacheEntry.error || "Data not yet available. Retry in a moment.",
  });
}

// ---------------------------------------------------------------------------
// Routes — GSE
// ---------------------------------------------------------------------------

// All GSE live prices
app.get("/api/gse/live", (req, res) => {
  sendCached(res, cache.gse_live, "gse-api/live");
});

// All GSE equities (last close)
app.get("/api/gse/equities", (req, res) => {
  sendCached(res, cache.gse_equities, "gse-api/equities");
});

// Single stock — live (proxied directly; GSE-API is free & unlimited)
app.get("/api/gse/live/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const r = await axios.get(`${GSE_BASE}/live/${symbol.toUpperCase()}`);
    res.json({ success: true, source: "gse-api/live", data: r.data });
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Single stock — full equity profile (proxied directly)
app.get("/api/gse/equities/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const r = await axios.get(`${GSE_BASE}/equities/${symbol.toUpperCase()}`);
    res.json({ success: true, source: "gse-api/equities", data: r.data });
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — Mansa (pan-African)
// ---------------------------------------------------------------------------

// All exchanges metadata
app.get("/api/markets/exchanges", (req, res) => {
  sendCached(res, cache.mansa_exchanges, "mansa/exchanges");
});

// Pan-African movers
app.get("/api/markets/movers", (req, res) => {
  sendCached(res, cache.mansa_movers, "mansa/movers");
});

// Indices
app.get("/api/markets/indices", (req, res) => {
  sendCached(res, cache.mansa_indices, "mansa/indices");
});

// Stocks for a specific exchange
app.get("/api/markets/exchanges/:exchange/stocks", (req, res) => {
  const { exchange } = req.params;
  const ex = exchange.toUpperCase();
  const entry = exchangeStocksCache[ex];
  if (!entry) {
    return res.status(404).json({
      success: false,
      error: `Exchange "${ex}" not in cache. Supported: ${MANSA_EXCHANGES.join(", ")}`,
    });
  }
  sendCached(res, entry, `mansa/${ex}/stocks`);
});

// ---------------------------------------------------------------------------
// Health / status endpoint
// ---------------------------------------------------------------------------
app.get("/api/status", (req, res) => {
  const status = {
    gse_live: { updatedAt: cache.gse_live.updatedAt, ok: !!cache.gse_live.data },
    gse_equities: { updatedAt: cache.gse_equities.updatedAt, ok: !!cache.gse_equities.data },
    mansa_exchanges: { updatedAt: cache.mansa_exchanges.updatedAt, ok: !!cache.mansa_exchanges.data },
    mansa_movers: { updatedAt: cache.mansa_movers.updatedAt, ok: !!cache.mansa_movers.data },
    mansa_indices: { updatedAt: cache.mansa_indices.updatedAt, ok: !!cache.mansa_indices.data },
    exchange_stocks: Object.fromEntries(
      MANSA_EXCHANGES.map((ex) => [
        ex,
        {
          updatedAt: exchangeStocksCache[ex]?.updatedAt || null,
          ok: !!exchangeStocksCache[ex]?.data,
        },
      ])
    ),
    mansaKeyConfigured: !!MANSA_API_KEY,
  };
  res.json({ success: true, status });
});

// ---------------------------------------------------------------------------
// EOD cron schedules — Mon–Fri only (market days)
// Each fires ~5 min after the relevant exchange closes to allow data to settle
// ---------------------------------------------------------------------------

// NSE Kenya — closes 12:00 UTC
cron.schedule("5 12 * * 1-5", refreshNSE);

// EGX Egypt — closes 12:30 UTC
cron.schedule("35 12 * * 1-5", refreshEGX);

// NGX Nigeria — closes 13:30 UTC
cron.schedule("35 13 * * 1-5", refreshNGX);

// GSE Ghana + JSE South Africa — both close around 15:00 UTC
cron.schedule("5 15 * * 1-5", async () => {
  await refreshGSE();
  await refreshJSE();
});

// BRVM West Africa — closes 15:30 UTC
cron.schedule("35 15 * * 1-5", refreshBRVM);

// Pan-African summary (movers, indices, exchange metadata) — after all major closes
cron.schedule("5 16 * * 1-5", refreshPanAfricanSummary);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`Labari Markets API running on port ${PORT}`);
  await primeCache();
});
