// /api/character-analysis.js
// Shared AI endpoint for Fiction Clash's three analysis surfaces:
//   - Hero "AI Power Scout" stats
//   - Compare Characters
//   - Team Builder "AI feat check"
//
// One endpoint, one prompt shape, so all three consumers get numbers
// (strength/speed/durability/battleIQ) AND a short natural-language
// analysis per character, plus an optional overall verdict.
//
// Why this has to be a server-side function and not a direct browser call:
// a Gemini API key is a secret — putting it in client-side JS means anyone
// can open devtools and copy it. This keeps GEMINI_API_KEY only ever on
// Vercel's server.
//
// Set GEMINI_API_KEY in Vercel → Project Settings → Environment Variables.
// Get a key at https://aistudio.google.com/apikey

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY' });
    return;
  }

  const { characters, question } = req.body || {};
  if (!Array.isArray(characters) || characters.length === 0) {
    res.status(400).json({ error: 'Provide at least one character name' });
    return;
  }

  const cleanNames = characters
    .map(name => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean)
    .slice(0, 12); // hard cap — keeps prompts/costs bounded even if a caller misbehaves

  if (cleanNames.length === 0) {
    res.status(400).json({ error: 'No valid character names provided' });
    return;
  }

  const cleanQuestion = typeof question === 'string' ? question.trim().slice(0, 300) : '';

  const prompt = `You are a fictional-character analyst for a versus-battle app called Fiction Clash.
For EACH character listed below, provide:
- Power ratings from 0-100: strength, speed, durability, battleIQ
- A short "analysis": 1-2 sentences on their most relevant feats/abilities for a versus debate

Base ratings on the character's most well-known/iconic canonical depiction, UNLESS a specific version is given in parentheses after the name (e.g. "Goku (Ultra Instinct)"), in which case rate that exact version/power level.
If a name is obscure, unfamiliar, or ambiguous, make your best-effort identification and briefly note the uncertainty in the analysis rather than refusing to rate them.

Characters to rate:
${cleanNames.map(n => `- ${n}`).join('\n')}

${cleanQuestion
    ? `Additionally, answer this specific question comparing them: "${cleanQuestion}". Put your answer in the top-level "verdict" field (2-4 sentences).`
    : `Also include a top-level "verdict" field: a brief 1-2 sentence take on who has the edge overall and why, or that it's genuinely close if it is.`}

Respond with ONLY valid JSON, no markdown code fences, no commentary outside the JSON, in exactly this shape:
{"characters":{"<exact name as given above>":{"strength":0,"speed":0,"durability":0,"battleIQ":0,"analysis":"..."}},"verdict":"..."}`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      res.status(502).json({ error: 'Gemini request failed' });
      return;
    }

    const data = await geminiRes.json();
    const text = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

    if (!text) {
      console.error('No text in Gemini response:', JSON.stringify(data));
      res.status(502).json({ error: 'No content returned from Gemini' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      console.error('Could not parse Gemini JSON:', text);
      res.status(502).json({ error: 'Gemini returned invalid JSON' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error('character-analysis handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
