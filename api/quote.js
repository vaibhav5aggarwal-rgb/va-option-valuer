export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const raw = String(req.query?.q || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing stock or index" });

    const knownIndexMap = {
      "NIFTY 50": "^NSEI",
      "NIFTY": "^NSEI",
      "NIFTY50": "^NSEI",
      "NIFTY BANK": "^NSEBANK",
      "BANK NIFTY": "^NSEBANK",
      "BANKNIFTY": "^NSEBANK",
      "NIFTY IT": "^CNXIT",
      "NIFTY AUTO": "^CNXAUTO",
      "NIFTY PHARMA": "^CNXPHARMA",
      "NIFTY FINANCIAL SERVICES": "^CNXFINANCE",
      "NIFTY MIDCAP 50": "^NSEMDCP50",
      "SENSEX": "^BSESN",
      "BSE SENSEX": "^BSESN",
      "S&P BSE SENSEX": "^BSESN"
    };

    const indexNames = {
      "^NSEI": "NIFTY 50",
      "^NSEBANK": "NIFTY BANK",
      "^CNXIT": "NIFTY IT",
      "^CNXAUTO": "NIFTY AUTO",
      "^CNXPHARMA": "NIFTY PHARMA",
      "^CNXFINANCE": "NIFTY FINANCIAL SERVICES",
      "^NSEMDCP50": "NIFTY MIDCAP 50",
      "^BSESN": "SENSEX"
    };

    async function fetchIndex(indexSymbol) {
      const chartUrl =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(indexSymbol) +
        "?range=5d&interval=1d&includePrePost=false";

      const response = await fetch(chartUrl, {
        headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
      });
      if (!response.ok) throw new Error("index_quote_provider_http_" + response.status);

      const payload = await response.json();
      const result = payload?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) throw new Error("index_quote_provider_no_data");

      const candles = result?.indicators?.quote?.[0] || {};
      const opens = Array.isArray(candles.open) ? candles.open : [];
      const closes = Array.isArray(candles.close) ? candles.close : [];

      const valid = [];
      for (let i = 0; i < closes.length; i++) {
        const close = Number(closes[i]);
        const open = Number(opens[i]);
        if (Number.isFinite(close) && close > 0) {
          valid.push({ close, open: Number.isFinite(open) && open > 0 ? open : NaN });
        }
      }

      const latest = valid.length ? valid[valid.length - 1] : null;
      const previous = valid.length > 1 ? valid[valid.length - 2] : null;

      const livePrice = Number(meta.regularMarketPrice);
      const previousMeta = Number(meta.chartPreviousClose ?? meta.previousClose);
      const openMeta = Number(meta.regularMarketOpen);

      const cmp = Number.isFinite(livePrice) && livePrice > 0
        ? livePrice : (latest ? latest.close : NaN);
      const previousClose = Number.isFinite(previousMeta) && previousMeta > 0
        ? previousMeta : (previous ? previous.close : NaN);
      const open = Number.isFinite(openMeta) && openMeta > 0
        ? openMeta : (latest ? latest.open : NaN);

      if (![cmp, previousClose, open].every(Number.isFinite)) {
        throw new Error("index_quote_provider_incomplete_data");
      }

      return {
        symbol: indexSymbol,
        name: indexNames[indexSymbol],
        cmp,
        previousClose,
        open,
        currency: meta.currency || "INR",
        exchange: indexSymbol === "^BSESN" ? "BSE" : "NSE",
        source: "Yahoo Finance",
        fetchedAt: new Date().toISOString()
      };
    }

    let symbol = "";
    let displayName = "";

    const upper = raw.toUpperCase();

    if (knownIndexMap[upper]) {
      symbol = knownIndexMap[upper];
    } else if (/^\^[A-Za-z0-9]+$/.test(raw)) {
      symbol = raw.toUpperCase();
    } else if (raw.startsWith("MC:")) {
      const scId = raw.slice(3).trim();
      if (!scId) return res.status(400).json({ error: "Invalid stock selection" });

      const url =
        "https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/" +
        encodeURIComponent(scId);

      const resp = await fetch(url, {
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Referer": "https://www.moneycontrol.com/",
          "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0"
        }
      });

      if (!resp.ok) throw new Error("moneycontrol_quote_failed");

      const payload = await resp.json();
      const data = payload?.data;
      if (!data) throw new Error("moneycontrol_no_data");

      const cmp = Number(data.pricecurrent ?? data.HP ?? data.lastPrice);
      const prev = Number(data.priceprevclose ?? data.previousClose);
      const open = Number(data.OPN ?? data.open ?? data.openPrice);

      if (![cmp, prev, open].every(Number.isFinite)) {
        throw new Error("moneycontrol_incomplete_data");
      }

      displayName = String(
        data.SC_FULLNM || data.company || data.companyName || "NSE Stock"
      );

      return res.status(200).json({
        symbol: data.NSEID || scId,
        name: displayName,
        cmp,
        previousClose: prev,
        open,
        currency: "INR",
        exchange: "NSE",
        source: "Moneycontrol",
        fetchedAt: new Date().toISOString()
      });
    } else if (/^[A-Za-z0-9&._-]+\.NS$/i.test(raw)) {
      symbol = raw.toUpperCase();
    } else {
      const searchUrl =
        "https://query1.finance.yahoo.com/v1/finance/search?q=" +
        encodeURIComponent(raw) + "&quotesCount=20&newsCount=0";

      const searchResp = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
      });
      if (!searchResp.ok) throw new Error("search_failed");

      const searchData = await searchResp.json();
      const quotes = Array.isArray(searchData?.quotes) ? searchData.quotes : [];

      const candidates = quotes.filter(x => {
        const s = String(x?.symbol || "");
        return x && (x.quoteType === "EQUITY" || x.quoteType === "INDEX") &&
          (s.endsWith(".NS") || s.startsWith("^"));
      });

      if (!candidates.length) {
        return res.status(404).json({
          error: "Stock or index not found. Select an item from the suggestions."
        });
      }

      symbol = String(candidates[0].symbol);
      displayName = String(
        candidates[0].longname || candidates[0].shortname || symbol
      );
    }

    if (indexNames[symbol]) {
      const data = await fetchIndex(symbol);
      return res.status(200).json(data);
    }

    // Equity quote path — leave the currently working stock flow intact.
    const chartUrl =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?range=1d&interval=1m&includePrePost=false";

    const chartResp = await fetch(chartUrl, {
      headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
    });
    if (!chartResp.ok) throw new Error("quote_failed");

    const chartData = await chartResp.json();
    const result = chartData?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) throw new Error("no_data");

    const cmp = Number(meta.regularMarketPrice);
    const prev = Number(meta.previousClose ?? meta.chartPreviousClose);
    const quote = result?.indicators?.quote?.[0];
    const opens = Array.isArray(quote?.open) ? quote.open : [];

    let open = Number(meta.regularMarketOpen);
    if (!Number.isFinite(open) || open <= 0) {
      for (let i = 0; i < opens.length; i++) {
        const candidate = Number(opens[i]);
        if (Number.isFinite(candidate) && candidate > 0) {
          open = candidate;
          break;
        }
      }
    }

    if (![cmp, prev, open].every(Number.isFinite) || open <= 0) {
      return res.status(502).json({
        error: "Market data is incomplete right now. Please try again."
      });
    }

    displayName =
      displayName ||
      String(meta.longName || meta.shortName || symbol.replace(".NS", "").replace("^", ""));

    return res.status(200).json({
      symbol,
      name: displayName,
      cmp,
      previousClose: prev,
      open,
      currency: meta.currency || "INR",
      exchange: meta.exchangeName || "NSE",
      source: "Yahoo Finance",
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(502).json({
      error: "Unable to fetch market data right now."
    });
  }
}