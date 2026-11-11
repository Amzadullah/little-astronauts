// Vercel serverless function: POST /api/ask -> Google Gemini.
// Set GEMINI_API_KEY in Vercel → Project → Settings → Environment Variables.
// Optional: GEMINI_MODEL (default below).

const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.7-flash', 'gemini-2.5-flash'].filter(Boolean);
const hits = new Map(); // simple per-IP rate limit (best effort)

const SYSTEM = (lang) => `You are "Astro", a friendly robot Mission Advisor in "Little Astronauts", a space-learning app for children aged about 7 to 14, made for the NASA Space Apps Challenge.

How to answer:
- Answer ONLY in ${lang === 'bn' ? 'Bangla (Bengali script). Use simple everyday Bangla words a child understands; scientific names can be kept in English in brackets' : 'simple English'}.
- Explain just as much as a child needs: 2 to 5 short sentences. Use one fun comparison from daily life (a football, a rickshaw, a glass of water…).
- Be correct. Use real NASA facts. If you are not sure, say so simply.
- If the child is playing the Mars mission, use the game state you are given and give ONE clear, practical tip about what to do this sol and why.
- You may use 1 or 2 emoji. No markdown headings, no lists longer than 3 items.
- Keep it safe and kind. If a question is not about space, science or the game, gently bring the talk back to space. Never ask for personal information such as full name, address, school or phone number.`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || 'x';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  if (list.length >= 15) return res.status(429).json({ error: 'Too many questions. Wait a minute!' });
  list.push(now); hits.set(ip, list);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const question = String(body?.question || '').slice(0, 600).trim();
  const lang = body?.lang === 'en' ? 'en' : 'bn';
  const context = String(body?.context || '').slice(0, 2000);
  const history = Array.isArray(body?.history) ? body.history.slice(-6) : [];
  if (!question) return res.status(400).json({ error: 'Empty question' });

  const contents = [
    ...history.filter(h => h && h.text).map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 800) }] })),
    { role: 'user', parts: [{ text: (context ? `[App context: ${context}]\n\n` : '') + question }] },
  ];

  let lastErr = 'unknown';
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM(lang) }] },
          contents,
          generationConfig: { temperature: 0.6, maxOutputTokens: 600 },
          safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
            .map(category => ({ category, threshold: 'BLOCK_LOW_AND_ABOVE' })),
        }),
      });
      const data = await r.json();
      if (r.status === 404) { lastErr = `model ${model} not found`; continue; }
      if (!r.ok) { lastErr = data?.error?.message || `HTTP ${r.status}`; if (r.status >= 500) continue; break; }
      const answer = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!answer) { lastErr = 'empty answer'; continue; }
      return res.status(200).json({ answer, model });
    } catch (e) { lastErr = e.message; }
  }
  return res.status(502).json({ error: lastErr });
}
