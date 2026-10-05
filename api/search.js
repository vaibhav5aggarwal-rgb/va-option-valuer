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
    if (raw.length < 4) return res.status(200).json({ results: [] });
    if (raw.length > 80) return res.status(400).json({ error: "Search text is too long" });

    const term = raw.toLowerCase();

    // Common Indian indices used for NSE index options.
    const knownIndices = [
      { symbol: "^NSEI", name: "NIFTY 50" },
      { symbol: "^NSEBANK", name: "NIFTY BANK" },
      { symbol: "^CNXIT", name: "NIFTY IT" },
      { symbol: "^CNXAUTO", name: "NIFTY AUTO" },
      { symbol: "^CNXPHARMA", name: "NIFTY PHARMA" },
      { symbol: "^CNXFINANCE", name: "NIFTY FINANCIAL SERVICES" },
      { symbol: "^NSEMDCP50", name: "NIFTY MIDCAP 50" }
    ];

    const indexMatches = knownIndices.map(x => {
      const n = x.name.toLowerCase();
      const s = x.symbol.toLowerCase();
      let score = 0;
      if (n === term) score += 1000;
      if (s === term) score += 900;
      if (n.startsWith(term)) score += 700;
      if (n.includes(term)) score += 500;
      if (s.includes(term)) score += 200;
      return { symbol: x.symbol, name: x.name, score, type: "INDEX" };
    }).filter(x => x.score > 0);

    const url =
      "https://query1.finance.yahoo.com/v1/finance/search?q=" +
      encodeURIComponent(raw) + "&quotesCount=20&newsCount=0";

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
    });
    if (!response.ok) throw new Error("search_failed");

    const data = await response.json();
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];

    const marketMatches = quotes
      .filter(x => {
        const s = String(x?.symbol || "");
        return x && (x.quoteType === "EQUITY" || x.quoteType === "INDEX") &&
          (s.endsWith(".NS") || s.startsWith("^"));
      })
      .map(x => {
        const symbol = String(x.symbol || "");
        const name = String(x.longname || x.shortname || symbol.replace(".NS", ""));
        const base = symbol.replace(/\.NS$/i, "").toLowerCase();
        const nl = name.toLowerCase();
        let score = 0;
        if (base === term) score += 1000;
        if (nl === term) score += 900;
        if (base.startsWith(term)) score += 600;
        if (nl.startsWith(term)) score += 500;
        if (base.includes(term)) score += 250;
        if (nl.includes(term)) score += 150;
        return { symbol, name, score, type: x.quoteType };
      });

    const combined = [...indexMatches, ...marketMatches]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const seen = new Set();
    const results = combined
      .filter(x => {
        if (seen.has(x.symbol)) return false;
        seen.add(x.symbol);
        return true;
      })
      .slice(0, 6)
      .map(x => ({
        symbol: x.symbol,
        name: x.name,
        type: x.type === "INDEX" || x.symbol.startsWith("^") ? "INDEX" : "EQUITY"
      }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(502).json({ error: "Unable to search stocks and indices right now." });
  }
}