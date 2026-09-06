// /api/create-payment.js
// Starts a Paystack checkout for a premium (real-money) item: a premium
// avatar decoration, or a verified-badge weekly renewal. The client only
// ever sends WHAT it wants to buy (itemType + itemId) — never an amount.
// The amount is looked up from lib/pricing.js and converted to naira here,
// server-side, using the live rate from lib/fx.js. Requires the same
// FIREBASE_SERVICE_ACCOUNT_KEY env var as vote.js/comment.js/like.js, plus
// PAYSTACK_SECRET_KEY (Paystack's live secret key).

import admin from 'firebase-admin';
import { PREMIUM_DECORATIONS, BADGE_RENEWAL_USD } from './lib/pricing.js';
import { getUsdToNgnRate } from './lib/fx.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { itemType, itemId, returnUrl } = req.body || {};
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (itemType !== 'decoration' && itemType !== 'badge') {
    return res.status(400).json({ error: 'itemType must be "decoration" or "badge"' });
  }
  if (itemType === 'decoration' && (!itemId || !PREMIUM_DECORATIONS[itemId])) {
    return res.status(400).json({ error: 'Unknown or non-premium itemId' });
  }
  if (!idToken) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  try {
    const usd = itemType === 'decoration' ? PREMIUM_DECORATIONS[itemId] : BADGE_RENEWAL_USD;

    if (itemType === 'decoration') {
      const userSnap = await db.collection('users').doc(uid).get();
      const owned = userSnap.exists && Array.isArray(userSnap.data().unlockedDecorations)
        ? userSnap.data().unlockedDecorations
        : [];
      if (owned.includes(itemId)) {
        return res.status(409).json({ error: 'You already own this decoration' });
      }
    }

    // Firebase Auth is the source of truth for email, not whatever the
    // client claims — same reasoning as pulling name/avatar server-side
    // in comment.js rather than trusting the request body.
    let email;
    try {
      const authUser = await admin.auth().getUser(uid);
      email = authUser.email;
    } catch (err) {
      // fall through — email stays undefined, handled below
    }
    if (!email) {
      const userSnap = await db.collection('users').doc(uid).get();
      email = userSnap.exists ? userSnap.data().email : null;
    }
    if (!email) {
      return res.status(400).json({ error: 'Add an email to your account before buying premium items' });
    }

    const rate = await getUsdToNgnRate(db);
    const ngn = Math.round(usd * rate);
    const amountKobo = ngn * 100;

    const reference = `fc_${itemType}_${itemId || 'renew'}_${uid.slice(0, 8)}_${Date.now()}`;

    const paystackResp = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: amountKobo,
        currency: 'NGN',
        reference,
        callback_url: returnUrl || undefined,
        metadata: { uid, itemType, itemId: itemId || null },
      }),
    });
    const paystackData = await paystackResp.json();
    if (!paystackResp.ok || !paystackData.status) {
      console.error('Paystack initialize failed:', paystackData);
      return res.status(502).json({ error: 'Could not start checkout' });
    }

    // Recorded BEFORE redirecting the user to Paystack so verify-payment.js
    // and the webhook always have a pending record to check the payment
    // against, however the user's flow ends (success, abandonment, or the
    // app closing mid-payment).
    await db.collection('payments').doc(reference).set({
      uid,
      itemType,
      itemId: itemId || null,
      usd,
      ngn,
      amountKobo,
      rate,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      authorization_url: paystackData.data.authorization_url,
      reference,
    });
  } catch (err) {
    console.error('Create payment failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
