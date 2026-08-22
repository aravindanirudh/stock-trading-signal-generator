// ============================================================
//  Morning Catalyst Routine 3 — Upstox API Edition
//  Replaces: Playwright + Yahoo Finance (headless browser)
//  Replaces with: Direct Upstox REST API via native fetch
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ────────────────────────────────────────────────────────────
//  AUTHENTICATION
//  Token is read from env first; falls back to the hardcoded
//  value below. Rotate this daily — Upstox tokens expire at
//  03:30 AM IST the following morning.
//  ⚠️  WARNING: Do NOT commit this file to a public repository
//  while the token is hardcoded here.
//    NSE_COOKIE — (optional) NSE session cookie via env
// ────────────────────────────────────────────────────────────
const HARDCODED_TOKEN = '';
const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || HARDCODED_TOKEN;
if (!UPSTOX_TOKEN) {
  console.error('CRITICAL: No Upstox access token found. Set UPSTOX_ACCESS_TOKEN or hardcode HARDCODED_TOKEN.');
  process.exit(1);
}

const UPSTOX_BASE = 'https://api.upstox.com/v2';

// ────────────────────────────────────────────────────────────
//  1.  DATE HELPERS
// ────────────────────────────────────────────────────────────
const today        = new Date();
const ninetyDaysAgo = new Date();
ninetyDaysAgo.setDate(today.getDate() - 90);

const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(today.getDate() - 7);

// YYYY-MM-DD  (required by Upstox Historical Candle endpoint)
const formatISO = (d) => {
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year  = d.getFullYear();
  return `${year}-${month}-${day}`;
};

// DD-MM-YYYY  (NSE API legacy format)
const formatNseDate = (d) => {
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year  = d.getFullYear();
  return `${day}-${month}-${year}`;
};

// YYYYMMDD  (BSE API format)
const formatBseDate = (d) => {
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year  = d.getFullYear();
  return `${year}${month}${day}`;
};

const todayISO       = formatISO(today);
const ninetyDaysAgoISO = formatISO(ninetyDaysAgo);
const todayNSE       = formatNseDate(today);
const sevenDaysAgoNSE = formatNseDate(sevenDaysAgo);
const todayBSE       = formatBseDate(today);
const sevenDaysAgoBSE = formatBseDate(sevenDaysAgo);

const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const formatDealDate = (d) => {
  const day   = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const year  = d.getFullYear();
  return `${day}-${month}-${year}`;
};

// Generate last 5 calendar days to safely cover ~3 trading days
const recentDealDates = [];
for (let i = 1; i <= 5; i++) {
  const d = new Date();
  d.setDate(today.getDate() - i);
  recentDealDates.push(formatDealDate(d));
}

// ────────────────────────────────────────────────────────────
//  2.  INSTRUMENT KEY MAPPING UTILITY
//
//  The Historical Candle API requires ISIN-based keys:
//    NSE_EQ|INE848E01016   (NOT NSE_EQ|NHPC)
//  Full Market Quotes accepts both forms, but we normalise
//  everything through this map for consistency.
//
//  instrumentMap: trading_symbol (e.g. "NHPC") → instrument_key
//                 (e.g. "NSE_EQ|INE848E01016")
// ────────────────────────────────────────────────────────────
const instrumentMap = new Map(); // populated by loadInstrumentMap()

/**
 * Downloads the Upstox NSE instruments master (gzipped JSON) once at
 * startup and builds a trading_symbol → instrument_key lookup.
 * Caches to data/nse_instruments.json so re-runs in the same day are instant.
 */
async function loadInstrumentMap() {
  const dataDir  = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  const cacheFile = path.join(dataDir, 'nse_instruments.json');

  let instruments;
  // Use cache if it was created today (avoids re-downloading on every run)
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageMins = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMins < 720) { // valid for 12 hours
      console.log('[Instruments] Loading from local cache...');
      instruments = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  }

  if (!instruments) {
    console.log('[Instruments] Downloading NSE instruments master from Upstox...');
    const res = await fetch('https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz');
    if (!res.ok) throw new Error(`Failed to download instruments: HTTP ${res.status}`);
    const buf  = Buffer.from(await res.arrayBuffer());
    instruments = JSON.parse(zlib.gunzipSync(buf).toString());
    fs.writeFileSync(cacheFile, JSON.stringify(instruments));
    console.log(`[Instruments] Downloaded ${instruments.length} instruments and cached.`);
  }

  // Build map: only NSE_EQ segment equities, keyed by trading_symbol
  let count = 0;
  for (const inst of instruments) {
    if (inst.segment === 'NSE_EQ' && inst.trading_symbol && inst.instrument_key) {
      instrumentMap.set(inst.trading_symbol.toUpperCase(), inst.instrument_key);
      count++;
    }
  }
  console.log(`[Instruments] Mapped ${count} NSE_EQ equities.`);
}

/**
 * Returns the correct Upstox instrument_key for a given NSE ticker.
 * Uses ISIN-based key from instrumentMap for Historical Candle API.
 * Falls back to ticker-based key (NSE_EQ|SYMBOL) if not found — this
 * form still works for Full Market Quotes.
 */
function toUpstoxKey(symbol) {
  const cleaned = symbol.replace(/\.NS$/i, '').toUpperCase();
  return instrumentMap.get(cleaned) || `NSE_EQ|${cleaned}`;
}

function encodeUpstoxKey(instrumentKey) {
  // Upstox uses pipe in path segments, which must be percent-encoded
  return instrumentKey.replace(/\|/g, '%7C');
}

// ────────────────────────────────────────────────────────────
//  3.  TECHNICAL INDICATOR FUNCTIONS  (unchanged from v2.3)
// ────────────────────────────────────────────────────────────
function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  let ema = sum / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const h_l  = highs[i] - lows[i];
    const h_pc = Math.abs(highs[i] - closes[i - 1]);
    const l_pc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(h_l, h_pc, l_pc));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calculateBollingerBandWidths(closes, period = 20) {
  if (closes.length < period) return [];
  const widths = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice   = closes.slice(i - period + 1, i + 1);
    const sma     = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const stdDev  = Math.sqrt(variance);
    const upper   = sma + 2 * stdDev;
    const lower   = sma - 2 * stdDev;
    const width   = sma === 0 ? 0 : (upper - lower) / sma;
    widths.push(width);
  }
  return widths;
}

function isInstitutional(clientName) {
  if (!clientName) return false;
  const name     = clientName.toUpperCase();
  const keywords = [
    'FUND','MUTUAL','INSURANCE','PROMOTER','FIDELITY','SOCIETE','GOLDMAN',
    'MORGAN','CITIGROUP','BANK','CAPITAL','TRUST','PENSION','LIC','HDFC',
    'ICICI','SBI','AXIS','NIPPON','DSP','MIRAE','UTI','TATA','BANDHAN',
    'HSBC','INVESCO','PPFAS','QUANT','FRANKLIN'
  ];
  return keywords.some(kw => name.includes(kw));
}

// ────────────────────────────────────────────────────────────
//  4.  UPSTOX API HELPERS
// ────────────────────────────────────────────────────────────

/**
 * Shared Upstox authenticated fetch wrapper.
 * Always sends Accept + Authorization headers.
 */
async function upstoxFetch(url) {
  const res = await fetch(url, {
    headers: {
      'Accept':        'application/json',
      'Authorization': `Bearer ${UPSTOX_TOKEN}`,
      'Content-Type':  'application/json',
    }
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Upstox API error ${res.status} for ${url}: ${errText}`);
  }
  return res.json();
}

/**
 * REPLACEMENT FOR fetchYahooHistory()
 * Fetches 90-day daily OHLC from Upstox Historical Candle API.
 *
 * Endpoint: GET /v2/historical-candle/{instrument_key}/day/{to_date}/{from_date}
 * Candle array layout: [timestamp, open, high, low, close, volume, oi]
 *
 * @param {string} symbol  — Plain NSE ticker, e.g. "NHPC"
 * @returns {Array|null}   — Array of {date, open, high, low, close} or null on error
 */
async function fetchUpstoxHistory(symbol) {
  const key     = toUpstoxKey(symbol);
  const encoded = encodeUpstoxKey(key);
  const url     = `${UPSTOX_BASE}/historical-candle/${encoded}/day/${todayISO}/${ninetyDaysAgoISO}`;

  try {
    console.log(`[Upstox Historical] Fetching 90-day OHLC for: ${symbol}`);
    const json = await upstoxFetch(url);

    if (json.status !== 'success' || !json.data || !json.data.candles) {
      console.warn(`No candle data returned for ${symbol}`);
      return null;
    }

    // Upstox returns candles newest-first; reverse to get chronological order
    const candles = [...json.data.candles].reverse();
    const history = candles.map(c => ({
      date:  c[0].split('T')[0],
      open:  c[1],
      high:  c[2],
      low:   c[3],
      close: c[4],
    })).filter(c => c.open && c.high && c.low && c.close);

    return history;
  } catch (e) {
    console.error(`Error fetching Upstox history for ${symbol}:`, e.message);
    return null;
  }
}

/**
 * REPLACEMENT FOR Yahoo pre-open parsing loop.
 * Batch call to Full Market Quotes endpoint — up to 500 instruments per call.
 *
 * Endpoint: GET /v2/market-quote/quotes?instrument_key={comma-separated}
 * Response: { status, data: { "NSE_EQ:NHPC": { ohlc, depth, last_price,
 *              lower_circuit_limit, upper_circuit_limit,
 *              total_buy_quantity, total_sell_quantity, ... } } }
 *
 * @param {string[]} symbols  — Array of plain NSE tickers
 * @returns {Map<string, object>}  — Map keyed by plain ticker → quote object
 */
async function fetchBatchMarketQuotes(symbols) {
  if (!symbols || symbols.length === 0) return new Map();

  // Build comma-separated instrument key list (pipe must NOT be encoded in query string)
  const keysParam  = symbols.map(toUpstoxKey).join(',');
  const url        = `${UPSTOX_BASE}/market-quote/quotes?instrument_key=${encodeURIComponent(keysParam)}`;

  const resultMap  = new Map();
  try {
    console.log(`[Upstox Quotes] Fetching batch quotes for ${symbols.length} instruments`);
    const json = await upstoxFetch(url);

    if (json.status !== 'success' || !json.data) {
      console.warn('[Upstox Quotes] Non-success response or missing data');
      return resultMap;
    }

    // The response data object is keyed by "NSE_EQ:NHPC" (colon-separated, not pipe)
    for (const [responseKey, quoteData] of Object.entries(json.data)) {
      // Parse "NSE_EQ:NHPC" → "NHPC"
      const parts  = responseKey.split(':');
      const ticker = parts.length >= 2 ? parts[1] : responseKey;
      resultMap.set(ticker, quoteData);
    }
  } catch (e) {
    console.error('[Upstox Quotes] Batch fetch error:', e.message);
  }
  return resultMap;
}

/**
 * Dedicated call to fetch India VIX for the macro regime check.
 * Uses instrument key: NSE_INDEX|India VIX
 * @returns {number|null} VIX value or null on failure
 */
async function fetchIndiaVIX() {
  const vixKey    = 'NSE_INDEX|India VIX';
  const url       = `${UPSTOX_BASE}/market-quote/quotes?instrument_key=${encodeURIComponent(vixKey)}`;
  try {
    console.log('[Regime Check] Fetching India VIX...');
    const json = await upstoxFetch(url);
    if (json.status !== 'success' || !json.data) return null;

    // The response key may appear as "NSE_INDEX:India VIX"
    const entry = Object.values(json.data)[0];
    if (!entry) return null;

    // VIX is returned in last_price
    const vix = entry.last_price ?? entry.ohlc?.close ?? null;
    console.log(`[Regime Check] India VIX = ${vix}`);
    return vix;
  } catch (e) {
    console.error('[Regime Check] Failed to fetch India VIX:', e.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
//  5.  NSE / BSE HELPER (no longer needs Playwright — plain fetch)
//  NSE requires cookies from a warm session; we send them from env
//  or fall back to a minimal header set.
// ────────────────────────────────────────────────────────────
async function fetchNseApi(endpoint) {
  const fullUrl = `https://www.nseindia.com${endpoint}`;
  console.log(`[NSE API] GET ${endpoint}`);
  const headers = {
    'Accept':          'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    'Referer':         'https://www.nseindia.com',
    'sec-fetch-dest':  'empty',
    'sec-fetch-mode':  'cors',
    'sec-fetch-site':  'same-origin',
  };
  // Inject NSE session cookie if provided via env
  if (process.env.NSE_COOKIE) {
    headers['Cookie'] = process.env.NSE_COOKIE;
  }
  const res = await fetch(fullUrl, { headers });
  if (!res.ok) throw new Error(`NSE API ${res.status} for ${endpoint}`);
  return res.json();
}

// ────────────────────────────────────────────────────────────
//  6.  RISK MANAGEMENT FILTERS  (new in 3)
// ────────────────────────────────────────────────────────────

/**
 * CIRCUIT LIMIT DEFENSE
 * Returns true (remove from candidates) if the IEP / last price is
 * within 1% of the lower circuit limit.
 */
function isNearLowerCircuit(quoteData, iep) {
  const lcl = quoteData?.lower_circuit_limit;
  if (!lcl || !iep || lcl === 0) return false;
  const distancePct = ((iep - lcl) / iep) * 100;
  if (distancePct <= 1.0) {
    console.warn(`[Circuit Defense] IEP ₹${iep} is within 1% of lower circuit ₹${lcl}. Dropping candidate.`);
    return true;
  }
  return false;
}

/**
 * PRE-OPEN ORDER BOOK DEPTH FILTER
 * Returns true (remove from candidates) if order book signals an institutional dump/squeeze.
 * For LONG:  drop if total_sell_qty > 3x total_buy_qty
 * For SHORT: drop if total_buy_qty  > 3x total_sell_qty (inverse rule)
 */
function isOrderBookAdverse(quoteData, direction) {
  const buyQty  = quoteData?.total_buy_quantity  ?? 0;
  const sellQty = quoteData?.total_sell_quantity ?? 0;
  if (buyQty === 0 && sellQty === 0) return false; // no data, pass through

  if (direction === 'LONG') {
    if (sellQty > 3 * buyQty && buyQty > 0) {
      console.warn(`[Depth Filter] LONG vetoed — sell qty (${sellQty}) > 3x buy qty (${buyQty}). Institutional dump signal.`);
      return true;
    }
  } else if (direction === 'SHORT') {
    if (buyQty > 3 * sellQty && sellQty > 0) {
      console.warn(`[Depth Filter] SHORT vetoed — buy qty (${buyQty}) > 3x sell qty (${sellQty}). Squeeze signal.`);
      return true;
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────
//  7.  MAIN RUN ROUTINE
// ────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(` Morning Catalyst Routine v3 — Upstox API Edition`);
  console.log(` Executing for date: ${todayNSE}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  // ── Step 0: LOAD INSTRUMENT MAP (ISIN lookup for Historical Candle API) ──
  await loadInstrumentMap();

  // ── Step A: MACRO REGIME CHECK ──────────────────────────────
  const indiaVIX         = await fetchIndiaVIX();
  const isHighVolatility = indiaVIX !== null && indiaVIX > 18.0;
  if (isHighVolatility) {
    console.log(`⚠️  HIGH VOLATILITY REGIME: India VIX = ${indiaVIX.toFixed(2)} > 18.0`);
    console.log('   Strategy 1 LONG (Gap-and-Go) will be DISABLED.');
    console.log('   ATR Stop-Loss multiplier will be tightened by 0.75x for HIGH-VIX sessions.');
  } else {
    console.log(`✅  Normal Volatility: India VIX = ${indiaVIX !== null ? indiaVIX.toFixed(2) : 'N/A'}`);
  }

  // ── Step B: FETCH NSE DATA ───────────────────────────────────
  const data = {};
  try {
    console.log('\nStep B: Fetching NSE APIs...');
    [
      data.preOpen,
      data.fiiDii,
      data.bulkDeals,
      data.nseBoardMeetings,
      data.nseAnnouncements,
      data.nseInsiderTrading,
    ] = await Promise.all([
      fetchNseApi('/api/market-data-pre-open?key=ALL'),
      fetchNseApi('/api/fiidiiTradeNse'),
      fetchNseApi('/api/snapshot-capital-market-largedeal'),
      fetchNseApi(`/api/corporate-board-meetings?index=equities&from=${sevenDaysAgoNSE}&to=${todayNSE}`),
      fetchNseApi('/api/corporate-announcements?index=equities'),
      fetchNseApi('/api/corporates-pit-gg?index=equities'),
    ]);
  } catch (e) {
    console.error('CRITICAL: Failed fetching one of the NSE APIs:', e.message);
    console.log('ERROR: Live data fetch failed. Cannot provide trade setups.');
    process.exit(1);
  }

  // ── Step C: FETCH BSE ANNOUNCEMENTS ─────────────────────────
  console.log('\nStep C: Fetching BSE Announcements...');
  try {
    const bseUrl = `https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w?pageno=1&strCat=-1&strPrevDate=${sevenDaysAgoBSE}&strScrip=&strSearch=P&strToDate=${todayBSE}&strType=C`;
    const bseRes = await fetch(bseUrl, {
      headers: {
        'Accept':   'application/json',
        'Referer':  'https://www.bseindia.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
      }
    });
    data.bseAnnouncements = bseRes.ok ? await bseRes.json() : [];
  } catch (err) {
    console.error('Failed to fetch BSE Announcements:', err.message);
    data.bseAnnouncements = [];
  }

  // Macro events from investing.com omitted in API-only mode
  // (no headless browser available); placeholder retained for compatibility.
  data.globalMacros = [];

  // ── Step D: BUILD PRE-OPEN MAP (PRICE FLOOR + UPSTOX QUOTES) ─
  console.log('\nStep D: Building pre-open candidate map...');

  const preOpenData   = data.preOpen?.data || [];
  // First pass — collect raw NSE pre-open metadata
  const nsePreOpenMap = new Map();
  preOpenData.forEach(item => {
    if (item.metadata && item.metadata.symbol) {
      // 🚨 HARD MINIMUM PRICE FLOOR: Block all Penny Stocks / Micro-caps
      if (item.metadata.iep && item.metadata.iep < 100) {
        return; // Instantly skip and delete from analysis pipeline
      }
      nsePreOpenMap.set(item.metadata.symbol, item.metadata);
    }
  });

  // Batch fetch Upstox Full Market Quotes for ALL pre-open candidates
  // so we can apply circuit limit + depth filters
  const allSymbols   = Array.from(nsePreOpenMap.keys());
  // Upstox allows up to 500 instruments per call
  const BATCH_SIZE   = 500;
  const upstoxQuoteMap = new Map();
  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch  = allSymbols.slice(i, i + BATCH_SIZE);
    const result = await fetchBatchMarketQuotes(batch);
    result.forEach((v, k) => upstoxQuoteMap.set(k, v));
  }

  // Build the final preOpenMap applying circuit limit defense
  const preOpenMap = new Map();
  nsePreOpenMap.forEach((metadata, symbol) => {
    const iep        = metadata.iep;
    const quoteData  = upstoxQuoteMap.get(symbol);

    // CIRCUIT LIMIT DEFENSE
    if (quoteData && isNearLowerCircuit(quoteData, iep)) {
      return; // Drop from candidates
    }
    preOpenMap.set(symbol, metadata);
  });

  console.log(`Pre-open map: ${nsePreOpenMap.size} raw → ${preOpenMap.size} after circuit filter`);

  // ── Step E: ADVANCE-DECLINE REGIME CHECK ─────────────────────
  // If >75% of index constituents are gapping down, disable all LONG momentum
  let longMomentumDisabled = false;
  {
    let gapDownCount = 0;
    let totalCount   = 0;
    preOpenMap.forEach(meta => {
      totalCount++;
      if (meta.pChange < 0) gapDownCount++;
    });
    if (totalCount > 0) {
      const gapDownRatio = gapDownCount / totalCount;
      if (gapDownRatio > 0.75) {
        longMomentumDisabled = true;
        console.warn(`⚠️  A/D REGIME FILTER: ${(gapDownRatio * 100).toFixed(1)}% of pre-open universe is gapping DOWN.`);
        console.warn('   ALL LONG MOMENTUM SETUPS (Strategy 1 LONG) are FORCE-DISABLED for this session.');
      } else {
        console.log(`✅  A/D Ratio OK: ${(gapDownRatio * 100).toFixed(1)}% of pre-open universe gapping down.`);
      }
    }
  }

  // Combined LONG disable flag: VIX > 18 OR A/D filter triggered
  const disableStrategy1Long = isHighVolatility || longMomentumDisabled;

  // ── Step F: BUILD CATALYST MAP ────────────────────────────────
  const rawDataPoints  = [];
  const strategySetups = [];
  const catalysts      = new Map();

  // Board Meeting catalysts (NSE)
  if (data.nseBoardMeetings) {
    data.nseBoardMeetings.forEach(bm => {
      if (bm.bm_purpose && bm.bm_purpose.toLowerCase().includes('result')) {
        catalysts.set(bm.bm_symbol, { type: 'EARNINGS', desc: `Board Meeting on ${bm.bm_date}` });
      }
    });
  }

  // Announcement catalysts (NSE)
  if (data.nseAnnouncements) {
    data.nseAnnouncements.forEach(ann => {
      const desc = (ann.desc || '').toLowerCase();
      const txt  = (ann.attchmntText || '').toLowerCase();
      if (desc.includes('result') || desc.includes('financial') || txt.includes('result') || txt.includes('financial')) {
        catalysts.set(ann.symbol, { type: 'EARNINGS', desc: `Earnings Announcement (${ann.desc})` });
      }
    });
  }

  // Institutional Bulk/Block Deals from recent days
  const yesterdaysDeals = [];
  if (data.bulkDeals) {
    if (data.bulkDeals.BULK_DEALS_DATA)  yesterdaysDeals.push(...data.bulkDeals.BULK_DEALS_DATA.map(d => ({ ...d, type: 'BULK' })));
    if (data.bulkDeals.BLOCK_DEALS_DATA) yesterdaysDeals.push(...data.bulkDeals.BLOCK_DEALS_DATA.map(d => ({ ...d, type: 'BLOCK' })));
  }

  yesterdaysDeals.forEach(deal => {
    if (recentDealDates.includes(deal.date) && deal.buySell === 'BUY') {
      if (isInstitutional(deal.clientName)) {
        catalysts.set(deal.symbol, {
          type:       'BULK',
          desc:       `Institutional Buy: ${deal.clientName} (${deal.qty} @ ${deal.watp})`,
          clientName: deal.clientName,
          watp:       parseFloat(deal.watp),
          qty:        parseFloat(deal.qty),
        });
      }
    }
  });

  // ── Step G: SCREEN CANDIDATES FOR HISTORY ────────────────────
  const candidatesForHistory = new Set();

  // Strategy 1: gap-up or gap-down on catalyst
  for (const [symbol, catalyst] of catalysts.entries()) {
    const meta = preOpenMap.get(symbol);
    if (meta) {
      const gapPct = meta.pChange;
      if ((gapPct >= 1.0 && gapPct <= 3.0) || (gapPct <= -1.0 && gapPct >= -3.0)) {
        candidatesForHistory.add(symbol);
      }
    }
  }

  // Strategy 2 LONG: inst. buy floor pullback (-3% to +1%)
  const instBuys = [];
  yesterdaysDeals.forEach(deal => {
    if (recentDealDates.includes(deal.date) && deal.buySell === 'BUY' && isInstitutional(deal.clientName)) {
      instBuys.push(deal);
    }
  });
  instBuys.forEach(deal => {
    const symbol       = deal.symbol;
    const instBuyPrice = parseFloat(deal.watp);
    const meta         = preOpenMap.get(symbol);
    if (meta) {
      const currentPrice  = meta.iep;
      const priceDiffPct  = ((currentPrice - instBuyPrice) / instBuyPrice) * 100;
      if (priceDiffPct >= -3.0 && priceDiffPct <= 1.0) {
        candidatesForHistory.add(symbol);
      }
    }
  });

  // Strategy 2 SHORT: inst. sell ceiling rejection (-1% to +3%)
  const instSells = [];
  yesterdaysDeals.forEach(deal => {
    if (recentDealDates.includes(deal.date) && deal.buySell === 'SELL' && isInstitutional(deal.clientName)) {
      instSells.push(deal);
    }
  });
  instSells.forEach(deal => {
    const symbol        = deal.symbol;
    const instSellPrice = parseFloat(deal.watp);
    const meta          = preOpenMap.get(symbol);
    if (meta) {
      const currentPrice = meta.iep;
      const priceDiffPct = ((currentPrice - instSellPrice) / instSellPrice) * 100;
      if (priceDiffPct >= -1.0 && priceDiffPct <= 3.0) {
        candidatesForHistory.add(symbol);
      }
    }
  });

  // Strategy 3: Board meetings today or tomorrow
  const isTodayOrTomorrow = (dateStr) => {
    if (!dateStr) return false;
    const dStr = dateStr.toString().toLowerCase();
    const tomorrowDate = new Date();
    tomorrowDate.setDate(today.getDate() + 1);
    const todayNSEStr    = formatNseDate(today);
    const tomorrowNSEStr = formatNseDate(tomorrowDate);
    const todayISOStr    = formatISO(today);
    const tomorrowISOStr = formatISO(tomorrowDate);
    return (
      dStr.includes(todayNSEStr.toLowerCase()) ||
      dStr.includes(tomorrowNSEStr.toLowerCase()) ||
      dStr.includes(todayISOStr) ||
      dStr.includes(tomorrowISOStr)
    );
  };
  if (data.nseBoardMeetings) {
    data.nseBoardMeetings.forEach(bm => {
      if (isTodayOrTomorrow(bm.bm_date)) {
        candidatesForHistory.add(bm.bm_symbol);
      }
    });
  }

  // ── Step H: FETCH 90-DAY HISTORY FROM UPSTOX (replaces Yahoo) ─
  const historyCache   = new Map();
  const candidatesArray = Array.from(candidatesForHistory).slice(0, 20); // guard cap
  console.log(`\nStep H: Fetching Upstox 90-day OHLC for ${candidatesArray.length} candidates:`, candidatesArray);

  // Sequential fetch (rate-limit friendly; Upstox free tier: 10 req/sec)
  for (const symbol of candidatesArray) {
    const history = await fetchUpstoxHistory(symbol);
    if (history && history.length > 0) {
      historyCache.set(symbol, history);
    }
    // Small polite delay to respect rate limits
    await new Promise(r => setTimeout(r, 150));
  }

  // ── Step I: SAVE RAW DATA ─────────────────────────────────────
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'raw_fetched_data.json'), JSON.stringify(data, null, 2));

  // ────────────────────────────────────────────────────────────
  //  STRATEGY SCREENING
  // ────────────────────────────────────────────────────────────

  // ═══════════════ STRATEGY 1: Catalyst Gap-and-Go / Gap-and-Fade ═══════════
  for (const [symbol, catalyst] of catalysts.entries()) {
    const meta = preOpenMap.get(symbol);
    if (!meta) continue;

    const gapPct   = meta.pChange;
    const iep      = meta.iep;
    const quoteData = upstoxQuoteMap.get(symbol);

    rawDataPoints.push({
      symbol,
      preOpenPrice:  iep,
      instBuyPrice:  catalyst.watp || null,
      catalystType:  catalyst.type,
      catalystDesc:  catalyst.desc,
      gapPct,
    });

    // ─── STRATEGY 1 LONG: Gap-and-Go ───────────────────────────
    if (gapPct >= 1.0 && gapPct <= 3.0) {
      // Macro regime gates
      if (disableStrategy1Long) {
        console.log(`[S1 LONG] ${symbol}: disabled by VIX/A-D regime filter.`);
        continue;
      }
      // Order book depth filter for LONG
      if (quoteData && isOrderBookAdverse(quoteData, 'LONG')) continue;

      const history = historyCache.get(symbol);
      let stopLossStr = (iep * 0.985).toFixed(2); // Baseline 1.5% fallback
      let targetStr   = (iep * 1.03).toFixed(2);
      let remarks     = 'Strict Intraday play. Cut immediately if SL hit.';

      if (history && history.length >= 15) {
        const highs  = history.map(h => h.high);
        const lows   = history.map(h => h.low);
        const closes = history.map(h => h.close);
        const atr    = calculateATR(highs, lows, closes, 14);

        if (atr) {
          // --- INTRADAY ATR RISK MANAGEMENT ---
          // HIGH-VIX SESSION: tighten stop-loss buffer by 0.75x (VIX guard)
          const atrMultiplier = isHighVolatility ? 0.5 * 0.75 : 0.5;
          const stopLoss      = iep - (atrMultiplier * atr);
          const riskPerShare  = iep - stopLoss;
          const target        = iep + (riskPerShare * 2); // 1:2 RR
          const targetPct     = ((target - iep) / iep) * 100;

          stopLossStr = stopLoss.toFixed(2);
          targetStr   = `${target.toFixed(2)} (+${targetPct.toFixed(1)}% | 1:2 RR)`;
          remarks     = isHighVolatility
            ? `HIGH-VIX Session. ATR SL tightened to ${(atrMultiplier * atr).toFixed(2)} (0.75x of 0.5 ATR). Reduce position size.`
            : `Volatility-Adjusted Intraday Trade. Stop Loss set at 0.5 ATR (₹${(0.5 * atr).toFixed(2)}) below opening print.`;
        }
      }

      strategySetups.push({
        symbol,
        setupName:    'Catalyst Gap-and-Go',
        tradeType:    'Intraday',
        direction:    'LONG',
        entry:        iep.toFixed(2),
        maxLimitEntry: (iep * 1.005).toFixed(2),
        stopLoss:     stopLossStr,
        target:       targetStr,
        reasoning:    `${catalyst.type} catalyst (${catalyst.desc}) + confirmed Pre-Open gap of ${gapPct.toFixed(2)}%`,
        remarks,
      });
    }

    // ─── STRATEGY 1 SHORT: Gap-and-Fade ────────────────────────
    else if (gapPct <= -1.0 && gapPct >= -3.0) {
      // Order book depth filter for SHORT
      if (quoteData && isOrderBookAdverse(quoteData, 'SHORT')) continue;

      const history = historyCache.get(symbol);
      let stopLossStr = (iep * 1.015).toFixed(2); // Baseline 1.5% fallback SL above entry
      let targetStr   = (iep * 0.97).toFixed(2);
      let remarks     = 'Strict Intraday SHORT. Cover immediately if SL hit.';

      if (history && history.length >= 15) {
        const highs  = history.map(h => h.high);
        const lows   = history.map(h => h.low);
        const closes = history.map(h => h.close);
        const atr    = calculateATR(highs, lows, closes, 14);

        if (atr) {
          // HIGH-VIX: tighten SL multiplier by 0.75x
          const atrMultiplier = isHighVolatility ? 0.5 * 0.75 : 0.5;
          const stopLoss      = iep + (atrMultiplier * atr);
          const riskPerShare  = stopLoss - iep;
          const target        = iep - (riskPerShare * 2); // 1:2 RR
          const targetPct     = ((iep - target) / iep) * 100;

          stopLossStr = stopLoss.toFixed(2);
          targetStr   = `${target.toFixed(2)} (-${targetPct.toFixed(1)}% | 1:2 RR)`;
          remarks     = isHighVolatility
            ? `HIGH-VIX Session. ATR SL tightened (${(atrMultiplier * atr).toFixed(2)} above entry). Reduce position size.`
            : `Volatility-Adjusted Intraday SHORT. Stop Loss set at 0.5 ATR (₹${(0.5 * atr).toFixed(2)}) above opening print.`;
        }
      }

      strategySetups.push({
        symbol,
        setupName:    'Catalyst Gap-and-Fade',
        tradeType:    'Intraday',
        direction:    'SHORT',
        entry:        iep.toFixed(2),
        minLimitEntry: (iep * 0.995).toFixed(2),
        stopLoss:     stopLossStr,
        target:       targetStr,
        reasoning:    `${catalyst.type} catalyst (${catalyst.desc}) triggered a confirmed Pre-Open gap DOWN of ${gapPct.toFixed(2)}%. Fade the dead-cat bounce; momentum expected to continue lower.`,
        remarks,
      });
    }
  }

  // ═══════════════ STRATEGY 2 LONG: Invisible Floor Pullback ════
  for (const deal of instBuys) {
    const symbol       = deal.symbol;
    const instBuyPrice = parseFloat(deal.watp);
    const meta         = preOpenMap.get(symbol);
    if (!meta) continue;

    const currentPrice = meta.iep;
    const priceDiffPct = ((currentPrice - instBuyPrice) / instBuyPrice) * 100;

    if (priceDiffPct >= -3.0 && priceDiffPct <= 1.0) {
      const quoteData = upstoxQuoteMap.get(symbol);
      // Order book depth filter
      if (quoteData && isOrderBookAdverse(quoteData, 'LONG')) continue;

      const history = historyCache.get(symbol);
      if (history && history.length >= 50) {
        const closes = history.map(h => h.close);
        const highs  = history.map(h => h.high);
        const lows   = history.map(h => h.low);

        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const atr   = calculateATR(highs, lows, closes, 14);

        if (ema20 && ema50 && atr) {
          const isUptrend    = ema20 > ema50;
          const distanceToEma = Math.abs(currentPrice - ema20);
          const isNearEma    = distanceToEma <= 1.0 * atr;

          rawDataPoints.push({
            symbol,
            preOpenPrice: currentPrice,
            instBuyPrice,
            ema20,
            ema50,
            atr,
            priceDiffPct,
            isUptrend,
            isNearEma,
          });

          if (isUptrend && isNearEma) {
            // --- DYNAMIC ATR RISK MANAGEMENT ---
            const stopLoss    = instBuyPrice - atr; // 1 ATR below inst. floor
            const riskPerShare = currentPrice - stopLoss;
            const target      = currentPrice + (riskPerShare * 3); // 1:3 RR
            const targetPct   = ((target - currentPrice) / currentPrice) * 100;

            strategySetups.push({
              symbol,
              setupName:    'Invisible Floor Pullback',
              tradeType:    'Delivery',
              direction:    'LONG',
              entry:        currentPrice.toFixed(2),
              maxLimitEntry: (currentPrice * 1.005).toFixed(2),
              stopLoss:     stopLoss.toFixed(2),
              target:       `${target.toFixed(2)} (+${targetPct.toFixed(1)}% Target | 1:3 RR)`,
              reasoning:    `Large inst. buy (last 3 days) by ${deal.clientName} @ ₹${instBuyPrice.toFixed(2)}. Price pulled back near EMA20 (₹${ema20.toFixed(2)}) within 1.0 ATR (₹${(1.0 * atr).toFixed(2)}) in a macro uptrend.`,
              remarks:      `Delivery position. Stop Loss is dynamically set to 1 ATR (₹${atr.toFixed(2)}) below the institution's buy price to avoid intraday noise.`,
            });
          }
        }
      }
    }
  }

  // ═══════════════ STRATEGY 2 SHORT: Invisible Ceiling Rejection ═
  for (const deal of instSells) {
    const symbol        = deal.symbol;
    const instSellPrice = parseFloat(deal.watp);
    const meta          = preOpenMap.get(symbol);
    if (!meta) continue;

    const currentPrice = meta.iep;
    const priceDiffPct = ((currentPrice - instSellPrice) / instSellPrice) * 100;

    if (priceDiffPct >= -1.0 && priceDiffPct <= 3.0) {
      const quoteData = upstoxQuoteMap.get(symbol);
      // Order book depth filter
      if (quoteData && isOrderBookAdverse(quoteData, 'SHORT')) continue;

      const history = historyCache.get(symbol);
      if (history && history.length >= 50) {
        const closes = history.map(h => h.close);
        const highs  = history.map(h => h.high);
        const lows   = history.map(h => h.low);

        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const atr   = calculateATR(highs, lows, closes, 14);

        if (ema20 && ema50 && atr) {
          const isDowntrend   = ema20 < ema50;
          const distanceToEma = Math.abs(currentPrice - ema20);
          const isNearEma     = distanceToEma <= 1.0 * atr;

          rawDataPoints.push({
            symbol,
            preOpenPrice: currentPrice,
            instSellPrice,
            ema20,
            ema50,
            atr,
            priceDiffPct,
            isDowntrend,
            isNearEma,
            direction: 'SHORT',
          });

          if (isDowntrend && isNearEma) {
            const stopLoss    = instSellPrice + atr; // 1 ATR above inst. ceiling
            const riskPerShare = stopLoss - currentPrice;
            const target      = currentPrice - (riskPerShare * 3); // 1:3 RR
            const targetPct   = ((currentPrice - target) / currentPrice) * 100;

            strategySetups.push({
              symbol,
              setupName:    'Invisible Ceiling Rejection',
              tradeType:    'Intraday', // SHORT sales must be intraday in cash equity
              direction:    'SHORT',
              entry:        currentPrice.toFixed(2),
              minLimitEntry: (currentPrice * 0.995).toFixed(2),
              stopLoss:     stopLoss.toFixed(2),
              target:       `${target.toFixed(2)} (-${targetPct.toFixed(1)}% Target | 1:3 RR)`,
              reasoning:    `Large inst. sell (last 3 days) by ${deal.clientName} @ ₹${instSellPrice.toFixed(2)}. Price bounced back near EMA20 (₹${ema20.toFixed(2)}) within 1.0 ATR (₹${(1.0 * atr).toFixed(2)}) in a macro downtrend. Resistance ceiling confirmed.`,
              remarks:      `Intraday SHORT position. Auto square-off applies. Sell via MIS/CO context before 03:15 PM.`,
            });
          }
        }
      }
    }
  }

  // ═══════════════ STRATEGY 3: Bollinger Squeeze + Corp Action ══
  if (data.nseBoardMeetings) {
    data.nseBoardMeetings.forEach(bm => {
      if (isTodayOrTomorrow(bm.bm_date)) {
        const symbol  = bm.bm_symbol;
        const history = historyCache.get(symbol);
        if (history && history.length >= 70) {
          const closes = history.map(h => h.close);
          const widths = calculateBollingerBandWidths(closes, 20);
          if (widths.length >= 2) {
            const latestWidth  = widths[widths.length - 1];
            const last50Widths = widths.slice(-50);
            const minWidth     = Math.min(...last50Widths);
            const maxWidth     = Math.max(...last50Widths);
            const range        = maxWidth - minWidth;
            const percentile   = range === 0 ? 0 : (latestWidth - minWidth) / range;
            const isSqueeze    = percentile <= 0.4; // BB Width in bottom 40% of 50-day range

            const metaPreOpen   = preOpenMap.get(symbol);
            const currentPrice  = metaPreOpen ? metaPreOpen.iep : closes[closes.length - 1];
            const quoteData     = upstoxQuoteMap.get(symbol);

            rawDataPoints.push({
              symbol,
              preOpenPrice:    currentPrice,
              bbWidthPercentile: percentile,
              isSqueeze,
            });

            if (isSqueeze) {
              const preOpenGapPct = metaPreOpen ? metaPreOpen.pChange : 0;

              if (preOpenGapPct >= 0) {
                // ── LONG breakout ──
                if (!disableStrategy1Long) {
                  if (!(quoteData && isOrderBookAdverse(quoteData, 'LONG'))) {
                    const stopLoss = currentPrice * 0.97;
                    const target   = currentPrice * 1.10;
                    strategySetups.push({
                      symbol,
                      setupName:    'Bollinger Squeeze Breakout (LONG)',
                      tradeType:    'Delivery',
                      direction:    'LONG',
                      entry:        currentPrice.toFixed(2),
                      maxLimitEntry: (currentPrice * 1.005).toFixed(2),
                      stopLoss:     stopLoss.toFixed(2),
                      target:       `${target.toFixed(2)} (10% Target)`,
                      reasoning:    `BB Width in bottom 40% of 50-day range (Percentile: ${(percentile * 100).toFixed(0)}%). Board Meeting on ${bm.bm_date} (${bm.bm_purpose}). Pre-open flat/positive (+${preOpenGapPct.toFixed(2)}%) favours upside breakout.`,
                      remarks:      'Delivery LONG. Stop Loss set at 3% below entry.',
                    });
                  }
                } else {
                  console.log(`[S3 LONG] ${symbol}: disabled by VIX/A-D regime filter.`);
                }
              } else {
                // ── SHORT breakdown ──
                if (!(quoteData && isOrderBookAdverse(quoteData, 'SHORT'))) {
                  const stopLoss  = currentPrice * 1.03;
                  const target    = currentPrice * 0.90;
                  const targetPct = ((currentPrice - target) / currentPrice) * 100;
                  strategySetups.push({
                    symbol,
                    setupName:    'Bollinger Squeeze Breakdown (SHORT)',
                    tradeType:    'Intraday', // SHORT sales must be intraday in cash equity
                    direction:    'SHORT',
                    entry:        currentPrice.toFixed(2),
                    minLimitEntry: (currentPrice * 0.995).toFixed(2),
                    stopLoss:     stopLoss.toFixed(2),
                    target:       `${target.toFixed(2)} (-${targetPct.toFixed(1)}% Target)`,
                    reasoning:    `BB Width in bottom 40% of 50-day range (Percentile: ${(percentile * 100).toFixed(0)}%). Board Meeting on ${bm.bm_date} (${bm.bm_purpose}). Pre-open negative (${preOpenGapPct.toFixed(2)}%) favours downside breakdown.`,
                    remarks:      'Intraday SHORT breakout. Auto square-off applies. Sell via MIS/CO context before 03:15 PM.',
                  });
                }
              }
            }
          }
        }
      }
    });
  }

  // ── Step J: SAVE ANALYSIS RESULTS ────────────────────────────
  const analysisResults = { rawDataPoints, strategySetups };
  fs.writeFileSync(
    path.join(dataDir, 'analysis_results.json'),
    JSON.stringify(analysisResults, null, 2)
  );

  console.log('\n═══════════════════════════════════════════════════');
  console.log(` Analysis routine completed successfully!`);
  console.log(` Strategy setups found: ${strategySetups.length}`);
  console.log(`═══════════════════════════════════════════════════\n`);
}

run().catch(err => {
  console.error('Error executing main run routine:', err);
  process.exit(1);
});