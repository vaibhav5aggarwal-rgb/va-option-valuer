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
    if (!raw) return res.status(400).json({ error: "Missing stock name" });
    if (raw.length > 80) return res.status(400).json({ error: "Stock name is too long" });

    let symbol = "";
    let displayName = "";

    // When autocomplete has already selected an NSE symbol, use it exactly.
    if (/^[A-Za-z0-9&._-]+\.NS$/i.test(raw)) {
      symbol = raw.toUpperCase();
    } else {
      const searchUrl =
        "https://query1.finance.yahoo.com/v1/finance/search?q=" +
        encodeURIComponent(raw) + "&quotesCount=12&newsCount=0";

      const searchResp = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
      });
      if (!searchResp.ok) throw new Error("search_failed");

      const searchData = await searchResp.json();
      const quotes = Array.isArray(searchData?.quotes) ? searchData.quotes : [];

      const term = raw.toLowerCase();
      const matches = quotes
        .filter(x => x && x.quoteType === "EQUITY" && String(x.symbol || "").endsWith(".NS"))
        .map(x => {
          const s = String(x.symbol || "");
          const n = String(x.longname || x.shortname || s.replace(".NS", ""));
          const base = s.replace(/\.NS$/i, "").toLowerCase();
          const nl = n.toLowerCase();
          let score = 0;
          if (base === term) score += 1000;
          if (nl === term) score += 900;
          if (base.startsWith(term)) score += 600;
          if (nl.startsWith(term)) score += 500;
          if (base.includes(term)) score += 250;
          if (nl.includes(term)) score += 150;
          return { symbol: s, name: n, score };
        })
        .sort((a, b) => b.score - a.score);

      if (!matches.length) {
        return res.status(404).json({
          error: "NSE stock not found. Select a stock from the suggestions."
        });
      }
      symbol = matches[0].symbol;
      displayName = matches[0].name;
    }

    const chartUrl =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?range=1d&interval=1m&includePrePost=false&events=div%2Csplits";

    const chartResp = await fetch(chartUrl, {
      headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
    });
    if (!chartResp.ok) throw new Error("quote_failed");

    const chartData = await chartResp.json();
    const result = chartData?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) throw new Error("no_data");

    const cmp = Number(meta.regularMarketPrice);
    const prev = Number(meta.previousClose);

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
        error: "Stock data is incomplete right now. Please try again."
      });
    }

    displayName = displayName || String(meta.longName || meta.shortName || symbol.replace(".NS", ""));

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
      error: "Unable to fetch stock data right now."
    });
  }
}