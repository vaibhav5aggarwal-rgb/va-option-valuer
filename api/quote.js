export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const raw = String(req.query?.q || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing stock name" });
    if (raw.length > 80) return res.status(400).json({ error: "Stock name is too long" });

    const q = encodeURIComponent(raw);
    const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=12&newsCount=0`;
    const searchResp = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
    });

    if (!searchResp.ok) throw new Error(`Search provider returned ${searchResp.status}`);
    const searchData = await searchResp.json();
    const quotes = Array.isArray(searchData?.quotes) ? searchData.quotes : [];

    const matches = quotes
      .filter(x => x && x.quoteType === "EQUITY")
      .map(x => ({
        symbol: String(x.symbol || ""),
        name: String(x.longname || x.shortname || x.symbol || "")
      }))
      .filter(x => x.symbol.endsWith(".NS"));

    if (!matches.length) {
      return res.status(404).json({ error: "NSE stock not found. Try the company name or NSE symbol." });
    }

    const match = matches[0];
    const symbol = match.symbol;
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=false`;
    const chartResp = await fetch(chartUrl, {
      headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
    });

    if (!chartResp.ok) throw new Error(`Quote provider returned ${chartResp.status}`);
    const chartData = await chartResp.json();
    const meta = chartData?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error("No quote data returned");

    const cmp = Number(meta.regularMarketPrice);
    const prev = Number(meta.previousClose);
    let open = Number(meta.regularMarketOpen);

    if (!Number.isFinite(open) && Array.isArray(chartData?.chart?.result?.[0]?.indicators?.quote?.[0]?.open)) {
      const opens = chartData.chart.result[0].indicators.quote[0].open;
      for (let i = opens.length - 1; i >= 0; i--) {
        if (Number.isFinite(Number(opens[i]))) { open = Number(opens[i]); break; }
      }
    }

    if (![cmp, prev, open].every(Number.isFinite)) {
      return res.status(502).json({ error: "Stock data is incomplete right now. Please try again." });
    }

    return res.status(200).json({
      symbol,
      name: match.name,
      cmp,
      previousClose: prev,
      open,
      currency: meta.currency || "INR",
      exchange: meta.exchangeName || "NSE",
      source: "Yahoo Finance",
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(502).json({ error: "Unable to fetch stock data right now." });
  }
}