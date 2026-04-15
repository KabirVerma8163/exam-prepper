module.exports = async function handler(req, res) {
  const expectedPassword = process.env.ADMIN_PAGE_PASSWORD || "";
  const providedPassword = (req.headers["x-admin-password"] || "").toString();

  if (!expectedPassword) {
    return res.status(500).json({ error: "ADMIN_PAGE_PASSWORD is not configured." });
  }
  if (providedPassword !== expectedPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
  }

  const limit = Number(process.env.GEMINI_FREE_MONTHLY_LIMIT_USD || 0);
  const used = Number(process.env.GEMINI_MONTH_TO_DATE_SPEND_USD || 0);
  const monthly = Number.isFinite(limit) && Number.isFinite(used)
    ? { limit_usd: limit, used_usd: used, remaining_usd: Math.max(0, +(limit - used).toFixed(4)) }
    : null;

  try {
    // Tiny probe request to gather any rate-limit headers Gemini returns.
    const probe = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1, temperature: 0 }
        })
      }
    );

    const headerNames = [
      "x-ratelimit-limit-requests",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-reset-requests",
      "x-ratelimit-reset-tokens"
    ];
    const rateHeaders = {};
    for (const name of headerNames) {
      const v = probe.headers.get(name);
      if (v != null) rateHeaders[name] = v;
    }

    if (!probe.ok) {
      const body = await probe.text();
      return res.status(200).json({
        ok: false,
        model,
        note: "Gemini usage endpoint is reachable but probe failed. Monthly free remaining is not directly exposed by API key.",
        monthly,
        probe_status: probe.status,
        probe_body: body,
        rate_headers: rateHeaders
      });
    }

    return res.status(200).json({
      ok: true,
      model,
      month_utc: new Date().toISOString().slice(0, 7),
      note: "Monthly free remaining is not directly exposed by Gemini API keys. 'monthly' values are from your env vars; rate_headers are live from a probe call when available.",
      monthly,
      rate_headers: rateHeaders
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      model,
      note: "Could not reach Gemini API for live headers.",
      monthly,
      error: err.message
    });
  }
};
