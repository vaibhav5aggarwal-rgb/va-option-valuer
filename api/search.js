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
    if (raw.length < 3) return res.status(200).json({ results: [] });
    if (raw.length > 80) return res.status(400).json({ error: "Search text is too long" });

    const term = raw.toLowerCase();
    const compact = term.replace(/\s+/g, "");

    // Common NSE indices. Names are deliberately first-class search targets.
    const knownIndices = [
      { symbol: "^NSEI", name: "NIFTY 50" },
      { symbol: "^NSEBANK", name: "NIFTY BANK" },
      { symbol: "^CNXIT", name: "NIFTY IT" },
      { symbol: "^CNXAUTO", name: "NIFTY AUTO" },
      { symbol: "^CNXPHARMA", name: "NIFTY PHARMA" },
      { symbol: "^CNXFINANCE", name: "NIFTY FINANCIAL SERVICES" },
      { symbol: "^NSEMDCP50", name: "NIFTY MIDCAP 50" }
    ];

    const indexResults = knownIndices.map(x => {
      const name = x.name.toLowerCase();
      const symbol = x.symbol.toLowerCase();
      const nameCompact = name.replace(/\s+/g, "");
      let score = 0;

      if (name === term || nameCompact === compact) score += 1200;
      if (name.startsWith(term) || nameCompact.startsWith(compact)) score += 1100;
      if (name.includes(term) || nameCompact.includes(compact)) score += 900;
      if (symbol === term) score += 500;
      if (symbol.includes(term)) score += 200;

      return { symbol: x.symbol, name: x.name, type: "INDEX", score };
    }).filter(x => x.score > 0);

    const url =
      "https://query1.finance.yahoo.com/v1/finance/search?q=" +
      encodeURIComponent(raw) + "&quotesCount=30&newsCount=0";

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
    });

    if (!response.ok) throw new Error("search_failed");

    const data = await response.json();
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];

    const equityResults = quotes
      .filter(x => {
        const s = String(x?.symbol || "");
        return x && x.quoteType === "EQUITY" && s.endsWith(".NS");
      })
      .map(x => {
        const symbol = String(x.symbol || "");
        const name = String(x.longname || x.shortname || symbol.replace(".NS", ""));
        const baseSymbol = symbol.replace(/\.NS$/i, "");
        const nameLower = name.toLowerCase();
        const symbolLower = baseSymbol.toLowerCase();
        const nameCompact = nameLower.replace(/[^a-z0-9]/g, "");
        const queryCompact = compact.replace(/[^a-z0-9]/g, "");

        // COMPANY NAME IS THE PRIMARY SEARCH CRITERION.
        // This makes "qual" rank "Quality Power..." above unrelated symbols.
        let score = 0;
        if (nameLower === term || nameCompact === queryCompact) score += 1500;
        if (nameLower.startsWith(term) || nameCompact.startsWith(queryCompact)) score += 1300;
        if (nameLower.includes(term) || nameCompact.includes(queryCompact)) score += 1100;

        // Symbol matching is supported, but intentionally lower priority.
        if (symbolLower === term) score += 700;
        if (symbolLower.startsWith(term)) score += 500;
        if (symbolLower.includes(term)) score += 250;

        return {
          symbol,
          name,
          type: "EQUITY",
          score
        };
      })
      .filter(x => x.score > 0);

    const combined = [...indexResults, ...equityResults]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const seen = new Set();
    const results = combined
      .filter(x => {
        if (seen.has(x.symbol)) return false;
        seen.add(x.symbol);
        return true;
      })
      .slice(0, 8)
      .map(x => ({
        symbol: x.symbol,
        name: x.name,
        type: x.type
      }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(502).json({ error: "Unable to search stocks and indices right now." });
  }
}