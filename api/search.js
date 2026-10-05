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
    const results = [];

    // Explicit NSE indices used by the option valuer.
    const knownIndices = [
      { symbol: "^NSEI", name: "NIFTY 50" },
      { symbol: "^NSEBANK", name: "NIFTY BANK" },
      { symbol: "^CNXIT", name: "NIFTY IT" },
      { symbol: "^CNXAUTO", name: "NIFTY AUTO" },
      { symbol: "^CNXPHARMA", name: "NIFTY PHARMA" },
      { symbol: "^CNXFINANCE", name: "NIFTY FINANCIAL SERVICES" },
      { symbol: "^NSEMDCP50", name: "NIFTY MIDCAP 50" }
    ];

    knownIndices.forEach(x => {
      const n = x.name.toLowerCase();
      const compact = n.replace(/\s+/g, "");
      const queryCompact = term.replace(/\s+/g, "");
      let score = 0;
      if (n === term || compact === queryCompact) score += 2000;
      else if (n.startsWith(term) || compact.startsWith(queryCompact)) score += 1600;
      else if (n.includes(term) || compact.includes(queryCompact)) score += 1200;
      if (score) results.push({ symbol: x.symbol, name: x.name, type: "INDEX", score });
    });

    // Moneycontrol's own autocomplete is the primary company-name search.
    const mcUrl =
      "https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php" +
      "?classic=true&query=" + encodeURIComponent(raw) +
      "&type=1&format=json&callback=suggest1";

    const mcResp = await fetch(mcUrl, {
      headers: {
        "Accept": "text/javascript, application/javascript, application/json, */*",
        "Referer": "https://www.moneycontrol.com/",
        "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0",
        "X-Requested-With": "XMLHttpRequest"
      }
    });

    if (mcResp.ok) {
      const text = await mcResp.text();
      const jsonText = text
        .replace(/^\s*suggest1\(/, "")
        .replace(/\)\s*;?\s*$/, "")
        .trim();

      let data = [];
      try { data = JSON.parse(jsonText); } catch (_) { data = []; }

      if (Array.isArray(data)) {
        data.forEach(item => {
          if (!item?.stock_name || !item?.sc_id) return;

          const name = String(item.stock_name).trim();
          const nameLower = name.toLowerCase();
          const compactName = nameLower.replace(/[^a-z0-9]/g, "");
          const compactQuery = term.replace(/[^a-z0-9]/g, "");

          let score = 100;
          if (nameLower === term || compactName === compactQuery) score += 1800;
          else if (nameLower.startsWith(term) || compactName.startsWith(compactQuery)) score += 1600;
          else if (nameLower.includes(term) || compactName.includes(compactQuery)) score += 1200;

          results.push({
            symbol: "MC:" + String(item.sc_id),
            name,
            type: "EQUITY",
            score
          });
        });
      }
    }

    // Yahoo fallback for cases where Moneycontrol's autocomplete is temporarily unavailable.
    if (!results.some(x => x.type === "EQUITY")) {
      const url =
        "https://query1.finance.yahoo.com/v1/finance/search?q=" +
        encodeURIComponent(raw) + "&quotesCount=20&newsCount=0";

      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 VA-Option-Valuer/1.0" }
      });

      if (response.ok) {
        const data = await response.json();
        const quotes = Array.isArray(data?.quotes) ? data.quotes : [];

        quotes
          .filter(x => x && x.quoteType === "EQUITY" && String(x.symbol || "").endsWith(".NS"))
          .forEach(x => {
            const symbol = String(x.symbol);
            const name = String(x.longname || x.shortname || symbol.replace(".NS", ""));
            const n = name.toLowerCase();
            let score = 100;
            if (n === term) score += 1500;
            else if (n.startsWith(term)) score += 1300;
            else if (n.includes(term)) score += 1100;
            results.push({ symbol, name, type: "EQUITY", score });
          });
      }
    }

    const seen = new Set();
    const output = results
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .filter(x => {
        if (seen.has(x.symbol)) return false;
        seen.add(x.symbol);
        return true;
      })
      .slice(0, 8)
      .map(x => ({ symbol: x.symbol, name: x.name, type: x.type }));

    return res.status(200).json({ results: output });
  } catch (err) {
    return res.status(502).json({ error: "Unable to search stocks and indices right now." });
  }
}