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
//
// ---------- caching ----------
// Character power ratings barely change over time, and the same pairs get
// looked up over and over (Thanos vs Batman alone has 6k+ votes) — so every
// tap was re-paying for a fresh Gemini call even when someone else asked
// the exact same thing five minutes earlier. This now checks a Firestore
// cache first, keyed on the sorted character names (+ the custom question,
// if any, since that changes the answer) and only calls Gemini on a miss.
//
// Uses firebase-admin (NOT the client SDK) so writes bypass Firestore
// security rules entirely — this cache is server-only, nothing a browser
// client ever writes to directly.
//
// Setup needed in Vercel → Project Settings → Environment Variables:
//   FIREBASE_SERVICE_ACCOUNT_KEY = the full JSON key from
//   Firebase Console → Project Settings → Service Accounts → Generate new
//   private key. Paste the whole JSON file's contents as the value.
//
// Add "firebase-admin" to package.json dependencies if it isn't already
// there (npm install firebase-admin, or add "firebase-admin": "^12.7.0"
// to the dependencies block and let Vercel install it on deploy).
import crypto from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — generous, since ratings rarely change

// Lazy singleton — serverless functions can reuse a "warm" instance between
// invocations, so this avoids re-initializing the admin SDK on every request.
let cachedDb = null;
function getAdminDb() {
  if (cachedDb) return cachedDb;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) return null; // caching just won't run — see callers below
  try {
    if (!getApps().length) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      // Private keys pasted into env vars sometimes end up with literal
      // "\n" instead of real newlines — this normalizes either form.
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      initializeApp({ credential: cert(serviceAccount) });
    }
    cachedDb = getFirestore();
    return cachedDb;
  } catch (err) {
    console.error('Firebase admin init failed — caching disabled for this request:', err);
    return null;
  }
}

// One stable key per (character set + question) combination, independent
// of name order or capitalization, so "Batman vs Thanos" and "Thanos vs
// Batman" share a cache entry instead of doubling storage for no reason.
function buildCacheKey(cleanNames, cleanQuestion) {
  const normalizedNames = [...cleanNames].map(n => n.toLowerCase().trim()).sort();
  const normalizedQuestion = cleanQuestion.toLowerCase().trim();
  const raw = JSON.stringify({ n: normalizedNames, q: normalizedQuestion });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

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

  // ---------- cache lookup ----------
  // Fails soft: any problem here (missing credentials, Firestore hiccup)
  // just falls through to calling Gemini fresh, same as before caching
  // existed — a cache outage should never take the feature down with it.
  const cacheKey = buildCacheKey(cleanNames, cleanQuestion);
  const db = getAdminDb();
  let cacheRef = null;
  if (db) {
    try {
      cacheRef = db.collection('aiCache').doc(cacheKey);
      const cacheSnap = await cacheRef.get();
      if (cacheSnap.exists) {
        const cached = cacheSnap.data();
        const age = Date.now() - (cached.cachedAt || 0);
        if (age < CACHE_TTL_MS && cached.result) {
          res.status(200).json(cached.result);
          return;
        }
      }
    } catch (err) {
      console.error('Cache read failed — continuing without it:', err);
    }
  }

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
    // Give Gemini a hard deadline — without this, a slow/stuck upstream
    // response just hangs the serverless function (and the user's spinner)
    // until Vercel's own function timeout kills it. Aborting early and
    // returning a clean error lets the client fall back to local stats
    // fast instead of sitting there.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const geminiRes = await fetch(
      // gemini-3.5-flash-lite is Google's low-latency model built for
      // exactly this kind of job — structured extraction/classification —
      // as opposed to gemini-3.7-flash, which is the heavier "agentic
      // coding / multi-step reasoning" flagship. That extra reasoning
      // depth is what was making stat lookups feel slow: it "thinks"
      // before answering by default, which this task doesn't need.
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            // Gemini 3.x models think by default unless told otherwise.
            // "low" keeps just enough reasoning for consistent JSON
            // without the latency of the model's default thinking depth.
            thinkingConfig: { thinkingLevel: 'low' }
          }
        })
      }
    );
    clearTimeout(timeout);

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

    // ---------- cache write ----------
    // Happens after the response is already sent so it never adds latency
    // to what the user is waiting on. Also fails soft — a write error here
    // just means the next request pays for a fresh Gemini call, no worse
    // off than if caching didn't exist at all.
    if (cacheRef) {
      cacheRef.set({
        result: parsed,
        cachedAt: Date.now(),
        names: cleanNames,
        question: cleanQuestion || null
      }).catch(err => console.error('Cache write failed:', err));
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('character-analysis handler timed out waiting on Gemini');
      res.status(504).json({ error: 'AI analysis timed out' });
      return;
    }
    console.error('character-analysis handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
