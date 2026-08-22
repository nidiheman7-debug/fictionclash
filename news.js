// /api/news.js
// Server-side proxy for NewsData.io. Needed for the same reason as the
// Gemini endpoint: a news API key is a secret and shouldn't sit in
// client-side JS where anyone can copy it from devtools.
//
// Set NEWSDATA_API_KEY in Vercel → Project Settings → Environment Variables.
// Get a free key at https://newsdata.io/

// Maps Fiction Clash's tab names to NewsData.io's categories + a keyword to
// narrow results. NewsData.io's fixed categories are: business, crime,
// domestic, education, entertainment, environment, food, health, lifestyle,
// other, politics, science, sports, technology, top, tourism, world.
const CATEGORY_MAP = {
  'Music':         { category: 'entertainment', q: 'music' },
  'Latest Movies': { category: 'entertainment', q: 'movie OR film' },
  'Football':      { category: 'sports', q: 'football' },
  'Discovery':     { category: 'technology,science' }
};

export default async function handler(req, res) {
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing NEWSDATA_API_KEY' });
    return;
  }

  const categoryName = (req.query.category || 'Music').toString();
  const mapping = CATEGORY_MAP[categoryName] || CATEGORY_MAP['Music'];

  try {
    const params = new URLSearchParams({
      apikey: apiKey,
      language: 'en',
      category: mapping.category
    });
    if (mapping.q) params.set('q', mapping.q);

    const newsRes = await fetch(`https://newsdata.io/api/1/news?${params.toString()}`);

    if (!newsRes.ok) {
      const errText = await newsRes.text();
      console.error('NewsData.io request failed:', newsRes.status, errText);
      res.status(502).json({ error: 'News request failed' });
      return;
    }

    const data = await newsRes.json();
    const results = Array.isArray(data.results) ? data.results : [];

    const stories = results
      .slice(0, 8)
      .map(item => ({
        tag: `${categoryName.toUpperCase()} · ${
          Array.isArray(item.category) && item.category[0] ? item.category[0].toUpperCase() : 'NEWS'
        }`,
        title: item.title || '',
        url: item.link || '',
        publishedAt: item.pubDate || null // e.g. "2026-08-19 14:02:00" (UTC)
      }))
      .filter(story => story.title && story.url);

    res.status(200).json({ stories });
  } catch (err) {
    console.error('news handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
