// /api/send-push.js
// Sends a real device push notification via OneSignal's REST API.
//
// Why this needs to be a server-side function and not a direct browser
// call: OneSignal's REST API Key is a secret. Calling OneSignal directly
// from client-side JS (the old approach) means that key sits in plain
// text in index.html — anyone can view-source the page, copy it, and use
// it to send push notifications to your users too. This keeps it only
// ever on Vercel's server.
//
// Set these in Vercel → Project Settings → Environment Variables:
//   ONESIGNAL_APP_ID           (safe to also hardcode client-side — it's
//                                public by design, this var is just for
//                                convenience so it's not duplicated)
//   ONESIGNAL_REST_API_KEY     (secret — starts with os_v2_app_)
// Both come from OneSignal dashboard → Settings → Keys & IDs.
//
// Auth note: os_v2_app_-prefixed keys are OneSignal's current "App API
// Key" format, which uses the `Key` auth scheme and the api.onesignal.com
// host — not the `Basic` scheme + onesignal.com/api/v1 host that older
// Legacy REST API Keys used. Mixing the two (new key + old scheme) gets
// rejected with a 401/403.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const appId = process.env.ONESIGNAL_APP_ID;
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !restApiKey) {
    // Fail soft — a misconfigured/missing push setup should never break
    // the feature that triggered it (posting a matchup/clip still works
    // fine even if the push itself can't be sent).
    res.status(200).json({ skipped: true, reason: 'OneSignal not configured' });
    return;
  }

  const { title, body } = req.body || {};
  if (!title || !body) {
    res.status(400).json({ error: 'title and body are required' });
    return;
  }

  try {
    const oneSignalRes = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Key ${restApiKey}`
      },
      body: JSON.stringify({
        app_id: appId,
        target_channel: 'push',
        included_segments: ['Subscribed Users'],
        headings: { en: String(title).slice(0, 100) },
        contents: { en: String(body).slice(0, 200) }
      })
    });

    const data = await oneSignalRes.json().catch(() => ({}));

    if (!oneSignalRes.ok) {
      console.error('OneSignal API error:', oneSignalRes.status, data);
      res.status(502).json({ error: 'OneSignal request failed', status: oneSignalRes.status, details: data });
      return;
    }

    console.log('OneSignal API success:', data);
    res.status(200).json({
      sent: true,
      id: data.id || null,
      recipients: data.recipients ?? null,
      raw: data
    });
  } catch (err) {
    console.error('send-push handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
