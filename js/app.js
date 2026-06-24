/* ============================================================
   LABARI MARKETS — Frontend App
   Replace API_BASE with your Render backend URL before deploying.
   ============================================================ */

const API_BASE = "https://labari-markets-api.onrender.com/api/status"; // ← update this

// Mansa exchanges we support for the stock browser
const SUPPORTED_EXCHANGES = ["NGX", "NSE", "JSE", "BRVM", "EGX"];

// ── State ──────────────────────────────────────────────────
let gseData = [];
let currentExchange = null;
let exchangeStockData = {};

// ── Helpers ────────────────────────────────────────────────
function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-GH", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtChange(n) {
  if (n == null || isNaN(n)) return { text: "—", cls: "change-zero" };
  const abs = Math.abs(n).toFixed(2);
  if (n > 0) return { text: `+${abs}`, cls: "change-pos" };
  if (n < 0) return { text: `-${abs}`, cls: "change-neg" };
  return { text: "0.00", cls: "change-zero" };
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return { text: "—", cls: "change-zero" };
  const val = Number(n);
  const text = `${val > 0 ? "+" : ""}${val.toFixed(2)}%`;
  const cls = val > 0 ? "change-pos" : val < 0 ? "change-neg" : "change-zero";
  return { text, cls };
}

function timeAgo(isoString) {
  if (!isoString) return "never";
  const diff = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Tab navigation ─────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ── Refresh button ─────────────────────────────────────────
const refreshBtn = document.getElementById("refresh-btn");
refreshBtn.addEventListener("click", () => {
  refreshBtn.classList.add("spinning");
  Promise.all([loadGSE(), loadIndices(), loadMovers()]).finally(() => {
    setTimeout(() => refreshBtn.classList.remove("spinning"), 600);
  });
});

// ── Last updated display ───────────────────────────────────
function setUpdated(isoString) {
  document.getElementById("last-updated").textContent = `Updated ${timeAgo(isoString)}`;
}

// ── GSE ─────────────────────────────────────────────────────
async function loadGSE() {
  try {
    const json = await apiFetch("/api/gse/live");
    if (!json.success) throw new Error(json.error);
    gseData = json.data;
    setUpdated(json.updatedAt);
    renderGSESummary(gseData);
    renderGSETable(gseData);
  } catch (err) {
    document.getElementById("gse-tbody").innerHTML = `
      <tr><td colspan="4" class="loading-row" style="color:#e8454a">
        Failed to load GSE data: ${err.message}
      </td></tr>`;
  }
}

function renderGSESummary(data) {
  const gainers = data.filter((s) => s.change > 0).length;
  const losers = data.filter((s) => s.change < 0).length;
  const flat = data.filter((s) => s.change === 0 || s.change == null).length;
  document.getElementById("gse-count").textContent = data.length;
  document.getElementById("gse-gainers").textContent = gainers;
  document.getElementById("gse-losers").textContent = losers;
  document.getElementById("gse-flat").textContent = flat;
}

function renderGSETable(data) {
  const tbody = document.getElementById("gse-tbody");
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">No data available.</td></tr>`;
    return;
  }
  tbody.innerHTML = data
    .map((s) => {
      const chg = fmtChange(s.change);
      return `
        <tr data-symbol="${s.name}" data-source="gse">
          <td><span class="ticker-badge">${s.name}</span></td>
          <td class="right">${fmt(s.price)}</td>
          <td class="right ${chg.cls}">${chg.text}</td>
          <td class="right">${s.volume != null ? s.volume.toLocaleString() : "—"}</td>
        </tr>`;
    })
    .join("");

  // Row click → open detail modal
  tbody.querySelectorAll("tr[data-symbol]").forEach((row) => {
    row.addEventListener("click", () => openGSEModal(row.dataset.symbol));
  });
}

// GSE search + sort
document.getElementById("gse-search").addEventListener("input", filterGSETable);
document.getElementById("gse-sort").addEventListener("change", filterGSETable);

function filterGSETable() {
  const q = document.getElementById("gse-search").value.toLowerCase();
  const sort = document.getElementById("gse-sort").value;

  let filtered = gseData.filter((s) => s.name.toLowerCase().includes(q));

  filtered = [...filtered].sort((a, b) => {
    switch (sort) {
      case "price-desc": return (b.price || 0) - (a.price || 0);
      case "price-asc": return (a.price || 0) - (b.price || 0);
      case "change-desc": return (b.change || 0) - (a.change || 0);
      case "change-asc": return (a.change || 0) - (b.change || 0);
      case "volume-desc": return (b.volume || 0) - (a.volume || 0);
      default: return a.name.localeCompare(b.name);
    }
  });

  renderGSETable(filtered);
}

// ── GSE Modal ───────────────────────────────────────────────
async function openGSEModal(symbol) {
  const overlay = document.getElementById("modal-overlay");
  const body = document.getElementById("modal-body");
  overlay.classList.add("open");
  body.innerHTML = `<div class="loading-block">Loading ${symbol}…</div>`;

  try {
    const [liveJson, equityJson] = await Promise.all([
      apiFetch(`/api/gse/live/${symbol}`),
      apiFetch(`/api/gse/equities/${symbol}`),
    ]);

    const live = liveJson.data || {};
    const eq = equityJson.data || {};
    const co = eq.company || {};
    const chg = fmtChange(live.change);

    const directors = co.directors?.length
      ? `<p class="modal-section-title">Board of Directors</p>
         <ul class="director-list">
           ${co.directors.map((d) => `<li><span>${d.name}</span><span class="director-pos">${d.position || "Director"}</span></li>`).join("")}
         </ul>`
      : "";

    body.innerHTML = `
      <div class="modal-ticker">${symbol}</div>
      <div class="modal-company">${co.name || ""} ${co.sector ? `· ${co.sector}` : ""}</div>
      <div class="modal-stats">
        <div class="modal-stat">
          <span class="modal-stat-label">Price (GHS)</span>
          <span class="modal-stat-value">${fmt(live.price || eq.price)}</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-label">Change</span>
          <span class="modal-stat-value ${chg.cls}">${chg.text}</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-label">Volume</span>
          <span class="modal-stat-value">${live.volume != null ? live.volume.toLocaleString() : "—"}</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-label">Market Cap</span>
          <span class="modal-stat-value">${eq.capital ? "GHS " + fmt(eq.capital, 0) : "—"}</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-label">EPS</span>
          <span class="modal-stat-value">${eq.eps != null ? fmt(eq.eps) : "—"}</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-label">DPS</span>
          <span class="modal-stat-value">${eq.dps != null ? fmt(eq.dps) : "—"}</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-label">Shares Outstanding</span>
          <span class="modal-stat-value">${eq.shares ? Number(eq.shares).toLocaleString() : "—"}</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-label">Industry</span>
          <span class="modal-stat-value" style="font-size:0.8rem">${co.industry || "—"}</span>
        </div>
      </div>
      ${directors}
    `;
  } catch (err) {
    body.innerHTML = `<div class="loading-block" style="color:#e8454a">Could not load ${symbol}: ${err.message}</div>`;
  }
}

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("modal-overlay").classList.remove("open");
});
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove("open");
});

// ── Pan-African Indices ─────────────────────────────────────
async function loadIndices() {
  const grid = document.getElementById("indices-grid");
  try {
    const json = await apiFetch("/api/markets/indices");
    if (!json.success || !json.data) throw new Error(json.error || "No data");

    const indices = Array.isArray(json.data) ? json.data : Object.values(json.data);

    if (!indices.length) {
      grid.innerHTML = `<div class="loading-block">No index data available.</div>`;
      return;
    }

    grid.innerHTML = indices
      .map((idx) => {
        const chg = fmtPct(idx.change_pct ?? idx.changePercent ?? idx.change);
        return `
          <div class="exchange-card">
            <div class="exchange-code">${idx.exchange || idx.code || ""}</div>
            <div class="exchange-name">${idx.name || idx.index || "Index"}</div>
            <div class="index-value">${fmt(idx.value || idx.close || idx.price, 2)}</div>
            <div class="index-change ${chg.cls}">${chg.text}</div>
          </div>`;
      })
      .join("");
  } catch (err) {
    grid.innerHTML = `<div class="loading-block" style="color:#e8454a">Could not load indices: ${err.message}</div>`;
  }
}

// ── Exchange stock browser ──────────────────────────────────
function buildExchangeSelector() {
  const sel = document.getElementById("exchange-selector");
  sel.innerHTML = SUPPORTED_EXCHANGES.map((ex) =>
    `<button class="ex-btn" data-exchange="${ex}">${ex}</button>`
  ).join("");

  sel.querySelectorAll(".ex-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      sel.querySelectorAll(".ex-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      loadExchangeStocks(btn.dataset.exchange);
    });
  });
}

async function loadExchangeStocks(exchange) {
  const wrapper = document.getElementById("exchange-stock-wrapper");
  const controls = document.getElementById("exchange-stock-controls");
  const tbody = document.getElementById("exchange-tbody");

  wrapper.style.display = "block";
  controls.style.display = "flex";
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading ${exchange} stocks…</td></tr>`;
  currentExchange = exchange;

  try {
    const json = await apiFetch(`/api/markets/exchanges/${exchange}/stocks`);
    if (!json.success) throw new Error(json.error);

    const stocks = Array.isArray(json.data) ? json.data : (json.data?.stocks || []);
    exchangeStockData[exchange] = stocks;
    renderExchangeTable(stocks);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row" style="color:#e8454a">
      ${err.message}
    </td></tr>`;
  }
}

function renderExchangeTable(stocks) {
  const tbody = document.getElementById("exchange-tbody");
  if (!stocks.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">No stocks found.</td></tr>`;
    return;
  }
  tbody.innerHTML = stocks
    .map((s) => {
      const chg = fmtPct(s.change_pct ?? s.changePercent ?? s.change);
      const price = s.price ?? s.close ?? s.last;
      return `
        <tr>
          <td><span class="ticker-badge">${s.symbol || s.ticker || "—"}</span></td>
          <td style="color:var(--muted);font-size:0.78rem">${s.name || "—"}</td>
          <td class="right">${price != null ? fmt(price) : "—"}</td>
          <td class="right ${chg.cls}">${chg.text}</td>
        </tr>`;
    })
    .join("");
}

// Exchange search
document.getElementById("exchange-search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  const stocks = (exchangeStockData[currentExchange] || []).filter(
    (s) =>
      (s.symbol || "").toLowerCase().includes(q) ||
      (s.name || "").toLowerCase().includes(q)
  );
  renderExchangeTable(stocks);
});

// ── Pan-African Movers ──────────────────────────────────────
async function loadMovers() {
  const grid = document.getElementById("movers-grid");
  try {
    const json = await apiFetch("/api/markets/movers");
    if (!json.success) throw new Error(json.error);

    const data = json.data;
    const gainers = Array.isArray(data?.gainers) ? data.gainers : (Array.isArray(data) ? data.filter((s) => (s.change_pct ?? 0) > 0) : []);
    const losers = Array.isArray(data?.losers) ? data.losers : (Array.isArray(data) ? data.filter((s) => (s.change_pct ?? 0) < 0) : []);

    function moverRow(s) {
      const chg = fmtPct(s.change_pct ?? s.changePercent ?? s.change);
      return `
        <div class="mover-row">
          <div class="mover-info">
            <span class="mover-ticker">${s.symbol || s.ticker || "—"}</span>
            <span class="mover-exchange">${s.exchange || ""} ${s.name ? "· " + s.name : ""}</span>
          </div>
          <span class="mover-change ${chg.cls}">${chg.text}</span>
        </div>`;
    }

    grid.innerHTML = `
      <div class="movers-col gainers">
        <h3>Top Gainers</h3>
        ${gainers.slice(0, 10).map(moverRow).join("") || "<div class='loading-block'>No gainers data</div>"}
      </div>
      <div class="movers-col losers">
        <h3>Top Losers</h3>
        ${losers.slice(0, 10).map(moverRow).join("") || "<div class='loading-block'>No losers data</div>"}
      </div>`;
  } catch (err) {
    grid.innerHTML = `<div class="loading-block" style="color:#e8454a">Could not load movers: ${err.message}</div>`;
  }
}

// ── Boot ────────────────────────────────────────────────────
buildExchangeSelector();
Promise.all([loadGSE(), loadIndices(), loadMovers()]);
