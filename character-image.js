// /api/character-image.js
// Server-side proxy for Comic Vine's character search.
//
// Why this has to be a serverless function and not a direct browser fetch:
// Comic Vine's API does not send CORS headers, so calling it straight from
// client-side JS will just fail silently in the browser. It also expects a
// descriptive User-Agent, which browsers won't let you set on fetch()
// anyway. Routing through here also keeps COMICVINE_API_KEY out of the
// client bundle entirely.
//
// Set COMICVINE_API_KEY in Vercel → Project Settings → Environment Variables.
// Get a free key at https://comicvine.gamespot.com/api/

export default async function handler(req, res) {
  const apiKey = process.env.COMICVINE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing COMICVINE_API_KEY' });
    return;
  }

  const name = (req.query.name || '').toString().trim();
  const hint = (req.query.hint || '').toString().trim();
  if (!name) {
    res.status(400).json({ error: 'Missing "name" query param' });
    return;
  }

  const searchTerm = hint ? `${name} ${hint}` : name;

  try {
    const url = `https://comicvine.gamespot.com/api/search/?api_key=${apiKey}` +
      `&format=json&resources=character&limit=6` +
      `&field_list=name,aliases,image,deck,api_detail_url` +
      `&query=${encodeURIComponent(searchTerm)}`;

    const cvRes = await fetch(url, {
      headers: {
        // Comic Vine blocks requests with no/blank User-Agent — swap the
        // contact info below for your own if you have one.
        'User-Agent': 'FictionClash/1.0 (https://your-fiction-clash-domain.vercel.app)'
      }
    });

    if (!cvRes.ok) {
      console.error('Comic Vine request failed:', cvRes.status, await cvRes.text());
      res.status(502).json({ error: 'Comic Vine request failed', url: null });
      return;
    }

    const data = await cvRes.json();
    const results = Array.isArray(data.results) ? data.results : [];
    const normalized = name.toLowerCase();

    // Prefer an exact name match, then an exact alias match, then just the
    // first result that actually has a usable image — mirrors the
    // exact-match-first approach used for Jikan, so we don't hand back a
    // loosely-related character's photo.
    let match = results.find(r => (r.name || '').toLowerCase() === normalized);
    if (!match && results.length) {
      // Comic Vine returns aliases as a single newline-delimited string, not an array.
      match = results.find(r => {
        if (!r.aliases) return false;
        const aliasList = String(r.aliases).split('\n').map(a => a.trim().toLowerCase());
        return aliasList.includes(normalized);
      });
    }
    if (!match) {
      match = results.find(r => r.image && (r.image.medium_url || r.image.small_url));
    }

    const imageUrl = (match && match.image)
      ? (match.image.medium_url || match.image.small_url || match.image.icon_url || null)
      : null;

    res.status(200).json({ url: imageUrl });
  } catch (err) {
    console.error('character-image handler error:', err);
    res.status(500).json({ error: 'Internal server error', url: null });
  }
}
