// api/gemini-batch.js
// Password-gated batch endpoint for Gemini visual slide analysis.
// POST { slides: [{ imageBase64, mimeType, triggerReason, borderline }] }
//   → { ok, batchName }
// GET  ?batchName=batches/xyz
//   → { ok, state } | { ok, state: 'JOB_STATE_SUCCEEDED', results: string[] }

module.exports = async function handler(req, res) {
  const expectedPassword = process.env.ADMIN_PAGE_PASSWORD || '';
  const providedPassword = (req.headers['x-admin-password'] || '').toString();

  if (!expectedPassword) return res.status(500).json({ error: 'ADMIN_PAGE_PASSWORD is not configured.' });
  if (providedPassword !== expectedPassword) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.GEMINI_API_KEY;
  const model  = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured.' });

  if (req.method === 'POST') {
    const { slides } = req.body || {};
    if (!Array.isArray(slides) || !slides.length) {
      return res.status(400).json({ error: 'slides array is required' });
    }

    const requests = slides.map(({ imageBase64, mimeType = 'image/jpeg', triggerReason, borderline = false }) => ({
      contents: [{
        parts: [
          { text: buildPrompt(triggerReason, borderline) },
          { inline_data: { mime_type: mimeType, data: imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0.1 }
    }));

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/batches?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `models/${model}`, requests })
        }
      );
      if (!geminiRes.ok) {
        const body = await geminiRes.text();
        return res.status(200).json({ ok: false, error: `Gemini ${geminiRes.status}: ${body}` });
      }
      const data = await geminiRes.json();
      return res.status(200).json({ ok: true, batchName: data.name });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message });
    }

  } else if (req.method === 'GET') {
    const { batchName } = req.query || {};
    if (!batchName) return res.status(400).json({ error: 'batchName is required' });

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${batchName}?key=${apiKey}`
      );
      if (!geminiRes.ok) {
        const body = await geminiRes.text();
        return res.status(200).json({ ok: false, error: `Gemini ${geminiRes.status}: ${body}` });
      }
      const data = await geminiRes.json();

      if (data.state === 'JOB_STATE_SUCCEEDED') {
        const results = (data.responses || []).map(r =>
          r.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? 'no response'
        );
        return res.status(200).json({ ok: true, state: data.state, results });
      }
      return res.status(200).json({ ok: true, state: data.state || 'JOB_STATE_PENDING' });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message });
    }

  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
};

function buildPrompt(triggerReason, borderline) {
  if (triggerReason === 'vector_diagram') {
    if (borderline) {
      return (
        'This slide triggered a visual-content check but the signal is weak — it may contain a small diagram, ' +
        'a decorative element, or just a coloured template border. Look carefully:\n' +
        '- If there is a genuine diagram, flowchart, chart, or table: describe it thoroughly. ' +
        'For flowcharts list every node and connection as \'A → B\'.\n' +
        '- If the only non-text content is decorative (borders, lines, background shapes, logos, ' +
        'page numbers, or slide template elements): respond with exactly: text only\n' +
        'Be conservative — only describe content that would actually be useful for generating exam questions.'
      );
    }
    return (
      'This slide appears to contain a flowchart, vector diagram, table, or chart drawn as graphics. Do the following:\n' +
      '1. If there is a flowchart or graph: list every node/box and every directed connection ' +
      'as \'A → B\'. Include branch points, parallel tracks, and any colour-coded groupings.\n' +
      '2. If there is a chart or plot: describe axis labels, units, data series, and the key ' +
      'trend or comparison being made.\n' +
      '3. If there is a table: reproduce its structure and values as text.\n' +
      '4. If there is a multi-column layout: describe each column\'s content and its relationship.\n' +
      'Be exhaustive — this output will be used to generate quiz questions. ' +
      'If there is no notable visual content beyond plain text, respond with exactly: text only'
    );
  }
  return (
    'Describe any diagrams, charts, figures, equations, screenshots, or visual content on this slide. ' +
    'Be specific — include axis labels, data trends, key values, tool names, or structural relationships if present. ' +
    'If there is no notable visual content beyond plain text, respond with exactly: text only'
  );
}
