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

    const indexPages = {
      "^NSEI": {
        name: "NIFTY 50",
        url: "https://www.moneycontrol.com/indian-indices/nifty-9.html"
      },
      "^NSEBANK": {
        name: "NIFTY BANK",
        url: "https://www.moneycontrol.com/indian-indices/nifty-bank-23.html"
      },
      "^CNXIT": {
        name: "NIFTY IT",
        url: "https://www.moneycontrol.com/indian-indices/nifty-it-19.html"
      },
      "^CNXAUTO": {
        name: "NIFTY AUTO",
        url: "https://www.moneycontrol.com/indian-indices/nifty-auto-52.html"
      },
      "^CNXPHARMA": {
        name: "NIFTY PHARMA",
        url: "https://www.moneycontrol.com/indian-indices/nifty-pharma-41.html"
      },
      "^BSESN": {
        name: "SENSEX",
        url: "https://www.moneycontrol.com/indian-indices/sensex-4.html"
      }
    };

    function stripHtml(html) {
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, " ")
        .trim();
    }

    function parseMoney(v) {
      const n = Number(String(v).replace(/,/g, ""));
      return Number.isFinite(n) ? n : NaN;
    }

    async function fetchIndex(indexSymbol) {
      const cfg = indexPages[indexSymbol];
      if (!cfg) throw new Error("unsupported_index");

      const resp = await fetch(cfg.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml"
        }
      });

      if (!resp.ok) throw new Error("index_page_failed");

      const text = stripHtml(await resp.text());

      // Moneycontrol's index detail pages expose these labels together:
      // Open <value> Previous Close <value>
      const m = text.match(
        /Open\s+([\d,]+\.\d+)\s+Previous Close\s+([\d,]+\.\d+)/i
      );

      if (!m) throw new Error("index_values_not_found");

      const open = parseMoney(m[1]);
      const previousClose = parseMoney(m[2]);

      // The current index level appears near the first occurrence of the index name.
      const namePos = text.toLowerCase().indexOf(cfg.name.toLowerCase());
      const afterName = namePos >= 0 ? text.slice(namePos, namePos + 500) : text;
      const ltpMatches = afterName.match(/([\d,]+\.\d+)\s+(?:[-+]?\d+[\d,]*\.\d+)?\s*\(?[-+]?\d+(?:\.\d+)?%\)?/g);

      let cmp = NaN;
      if (ltpMatches && ltpMatches.length) {
        const first = ltpMatches[0].match(/[\d,]+\.\d+/);
        if (first) cmp = parseMoney(first[0]);
      }

      // More reliable fallback: find "Trade Now Open ...", then use the
      // current index value shown immediately before Day Range.
      if (!Number.isFinite(cmp)) {
        const beforeOpen = text.slice(0, Math.max(0, text.indexOf("Open " + m[1])));
        const allNums = beforeOpen.match(/[\d,]+\.\d+/g) || [];
        for (let i = allNums.length - 1; i >= 0; i--) {
          const n = parseMoney(allNums[i]);
          if (Number.isFinite(n) && n > 0) {
            // Don't mistake the previous close/open for the current value.
            if (Math.abs(n - open) > 0.0001 && Math.abs(n - previousClose) > 0.0001) {
              cmp = n;
              break;
            }
          }
        }
      }

      // If the page's displayed current value cannot be isolated safely,
      // use the dedicated Yahoo real-time value only for CMP.
      if (!Number.isFinite(cmp)) {
        const chartResp = await fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/" +
          encodeURIComponent(indexSymbol) +
          "?range=1d&interval=1m&includePrePost=false",
          { headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" } }
        );
        if (chartResp.ok) {
          const chart = await chartResp.json();
          cmp = Number(chart?.chart?.result?.[0]?.meta?.regularMarketPrice);
        }
      }

      if (![cmp, open, previousClose].every(Number.isFinite) || open <= 0) {
        throw new Error("index_market_data_incomplete");
      }

      return {
        symbol: indexSymbol,
        name: cfg.name,
        cmp,
        previousClose,
        open,
        currency: "INR",
        exchange: cfg.name === "SENSEX" ? "BSE" : "NSE",
        source: "Moneycontrol",
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

    if (indexPages[symbol]) {
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