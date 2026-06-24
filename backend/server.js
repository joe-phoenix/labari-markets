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
const GSE_BASE = "https://dev.kwayisi.org/apis/gse";

// EODHD exchange codes for each African market
const EXCHANGES = {
  NGX:  { code: "XNSA", name: "Nigerian Exchange Group",          currency: "NGN" },
  NSE:  { code: "NAIROBI", name: "Nairobi Securities Exchange",   currency: "KES" },
  JSE:  { code: "JSE",  name: "Johannesburg Stock Exchange",      currency: "ZAR" },
  EGX:  { code: "EGSM", name: "Egyptian Exchange",                currency: "EGP" },
  BRVM: { code: "BRVM", name: "Bourse Régionale des Valeurs Mobilières", currency: "XOF" },
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const cache = {
  gse_live:     { data: null, updatedAt: null, error: null },
  gse_equities: { data: null, updatedAt: null, error: null },
  indices:      { data: null, updatedAt: null, error: null },
  movers:       { data: null, updatedAt: null, error: null },
};

// Per-exchange stock cache: { NGX: { data, updatedAt, error }, ... }
const exchangeStocksCache = {};

// ---------------------------------------------------------------------------
// EODHD helpers
// ---------------------------------------------------------------------------
function eodhd(path, params = {}) {
  return axios.get(`${EODHD_BASE}${path}`, {
    params: { api_token: EODHD_KEY, fmt: "json", ...params },
  });
}

// ---------------------------------------------------------------------------
// GSE fetch (GSE-API — free, no key)
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

// ---------------------------------------------------------------------------
// EODHD — fetch all stocks for an exchange
// Uses /api/exchange-symbol-list to get tickers, then /api/eod for latest prices
// ---------------------------------------------------------------------------
async function fetchExchangeStocks(exchangeKey) {
  if (!EODHD_KEY) return;
  const ex = EXCHANGES[exchangeKey];
  if (!ex) return;

  try {
    // Get full symbol list for the exchange
    const symbolRes = await eodhd(`/exchange-symbol-list/${ex.code}`, { fmt: "json" });
    const symbols = symbolRes.data;

    if (!symbols || !symbols.length) throw new Error("No symbols returned");

    // Get EOD prices for all symbols in one call using the bulk endpoint
    const bulkRes = await eodhd(`/eod-bulk-last-day/${ex.code}`, { fmt: "json" });
    const prices = bulkRes.data;

    // Merge symbol info with price data
    const priceMap = {};
    if (Array.isArray(prices)) {
      prices.forEach((p) => { priceMap[p.code] = p; });
    }

    const stocks = symbols
      .filter((s) => s.Type === "Common Stock" || s.Type === "ETF" || !s.Type)
      .map((s) => {
        const p = priceMap[s.Code] || {};
        return {
          symbol: s.Code,
          name: s.Name,
          currency: ex.currency,
          price: p.close || p.adjusted_close || null,
          open: p.open || null,
          high: p.high || null,
          low: p.low || null,
          volume: p.volume || null,
          change: p.change || null,
          change_pct: p.change_p || null,
          date: p.date || null,
        };
      })
      .filter((s) => s.price !== null);

    exchangeStocksCache[exchangeKey] = {
      data: stocks,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    console.log(`[${new Date().toISOString()}] ${exchangeKey} stocks refreshed (${stocks.length} stocks)`);
  } catch (err) {
    if (!exchangeStocksCache[exchangeKey]) exchangeStocksCache[exchangeKey] = {};
    exchangeStocksCache[exchangeKey].error = err.message;
    console.error(`[${exchangeKey} stocks] fetch failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// EODHD — build indices summary from bulk EOD data
// ---------------------------------------------------------------------------
async function fetchIndices() {
  if (!EODHD_KEY) return;
  try {
    // Pull one representative stock per exchange as a proxy for market activity
    // EODHD has index data under /api/eod/INDX.INDX but it varies by exchange
    // Instead we build a summary from the exchange bulk data we already have
    const indexData = Object.entries(EXCHANGES).map(([key, ex]) => {
      const cached = exchangeStocksCache[key];
      if (!cached?.data?.length) return null;
      const stocks = cached.data;
      const gainers = stocks.filter((s) => (s.change_pct || 0) > 0).length;
      const losers = stocks.filter((s) => (s.change_pct || 0) < 0).length;
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
  } catch (err) {
    cache.indices.error = err.message;
    console.error(`[Indices] build failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Build movers from cached exchange data
// ---------------------------------------------------------------------------
function buildMovers() {
  const allStocks = [];
  for (const [key, cached] of Object.entries(exchangeStocksCache)) {
    if (!cached?.data?.length) continue;
    cached.data.forEach((s) => allStocks.push({ ...s, exchange: key }));
  }

  const sorted = allStocks
    .filter((s) => s.change_pct != null && s.volume > 0)
    .sort((a, b) => b.change_pct - a.change_pct);

  const gainers = sorted.filter((s) => s.change_pct > 0).slice(0, 10);
  const losers = [...sorted].reverse().filter((s) => s.change_pct < 0).slice(0, 10);

  cache.movers = {
    data: { gainers, losers },
    updatedAt: new Date().toISOString(),
    error: null,
  };
  console.log(`[${new Date().toISOString()}] Movers built (${gainers.length} gainers, ${losers.length} losers)`);
}

// ---------------------------------------------------------------------------
// Refresh functions per exchange
// ---------------------------------------------------------------------------
async function refreshGSE() {
  console.log(`[${new Date().toISOString()}] EOD refresh: GSE`);
  await fetchGSELive();
  await fetchGSEEquities();
}

async function refreshExchange(key) {
  console.log(`[${new Date().toISOString()}] EOD refresh: ${key}`);
  await fetchExchangeStocks(key);
  buildMovers();
  await fetchIndices();
}

// ---------------------------------------------------------------------------
// Startup cache prime
// ---------------------------------------------------------------------------
async function primeCache() {
  console.log(`[${new Date().toISOString()}] Priming cache on startup...`);
  await fetchGSELive();
  await fetchGSEEquities();
  for (const key of Object.keys(EXCHANGES)) {
    await fetchExchangeStocks(key);
    await new Promise((r) => setTimeout(r, 500));
  }
  buildMovers();
  await fetchIndices();
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
app.get("/api/gse/live", (req, res) => sendCached(res, cache.gse_live, "gse-api/live"));
app.get("/api/gse/equities", (req, res) => sendCached(res, cache.gse_equities, "gse-api/equities"));

app.get("/api/gse/live/:symbol", async (req, res) => {
  try {
    const r = await axios.get(`${GSE_BASE}/live/${req.params.symbol.toUpperCase()}`);
    res.json({ success: true, source: "gse-api/live", data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ success: false, error: err.message });
  }
});

app.get("/api/gse/equities/:symbol", async (req, res) => {
  try {
    const r = await axios.get(`${GSE_BASE}/equities/${req.params.symbol.toUpperCase()}`);
    res.json({ success: true, source: "gse-api/equities", data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Routes — Pan-African (EODHD)
// ---------------------------------------------------------------------------
app.get("/api/markets/indices", (req, res) => sendCached(res, cache.indices, "eodhd/indices"));
app.get("/api/markets/movers", (req, res) => sendCached(res, cache.movers, "eodhd/movers"));

app.get("/api/markets/exchanges/:exchange/stocks", (req, res) => {
  const ex = req.params.exchange.toUpperCase();
  const entry = exchangeStocksCache[ex];
  if (!entry) {
    return res.status(404).json({
      success: false,
      error: `Exchange "${ex}" not in cache. Supported: ${Object.keys(EXCHANGES).join(", ")}`,
    });
  }
  sendCached(res, entry, `eodhd/${ex}/stocks`);
});

// ---------------------------------------------------------------------------
// Status endpoint
// ---------------------------------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    status: {
      gse_live:     { updatedAt: cache.gse_live.updatedAt,     ok: !!cache.gse_live.data },
      gse_equities: { updatedAt: cache.gse_equities.updatedAt, ok: !!cache.gse_equities.data },
      indices:      { updatedAt: cache.indices.updatedAt,      ok: !!cache.indices.data },
      movers:       { updatedAt: cache.movers.updatedAt,       ok: !!cache.movers.data },
      exchange_stocks: Object.fromEntries(
        Object.keys(EXCHANGES).map((ex) => [
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
cron.schedule("5 15 * * 1-5",  async () => { await refreshGSE(); await refreshExchange("JSE"); });
cron.schedule("35 15 * * 1-5", () => refreshExchange("BRVM"));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`Labari Markets API running on port ${PORT}`);
  await primeCache();
});
