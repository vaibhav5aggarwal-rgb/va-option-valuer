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

    const url =
      "https://query1.finance.yahoo.com/v1/finance/search?q=" +
      encodeURIComponent(raw) + "&quotesCount=20&newsCount=0";

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
    });
    if (!response.ok) throw new Error("search_failed");

    const data = await response.json();
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    const term = raw.toLowerCase();

    const results = quotes
      .filter(x => x && x.quoteType === "EQUITY" && String(x.symbol || "").endsWith(".NS"))
      .map(x => {
        const symbol = String(x.symbol || "");
        const name = String(x.longname || x.shortname || symbol.replace(".NS", ""));
        const baseSymbol = symbol.replace(/\.NS$/i, "");
        const n = name.toLowerCase();
        const s = baseSymbol.toLowerCase();

        let score = 0;
        if (s === term) score += 1000;
        if (n === term) score += 900;
        if (s.startsWith(term)) score += 600;
        if (n.startsWith(term)) score += 500;
        if (s.includes(term)) score += 250;
        if (n.includes(term)) score += 150;

        return { symbol, name, score };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 6)
      .map(({ symbol, name }) => ({ symbol, name }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(502).json({ error: "Unable to search NSE stocks right now." });
  }
}