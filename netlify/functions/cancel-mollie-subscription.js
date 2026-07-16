// netlify/functions/cancel-mollie-subscription.js
//
// Cancels a Pro user's recurring Mollie subscription so it does NOT renew.
// The user KEEPS Pro until the end of the period they already paid for —
// this function does not revoke Pro immediately. It:
//   1. Verifies the caller (Firebase ID token).
//   2. Cancels the Mollie subscription (if one exists) so no future charge happens.
//   3. Writes cancellation state + the date Pro access ends to Firestore.
//
// Actual downgrade to Free happens at/after proEndsAt — enforced by the app
// reading proEndsAt, and ultimately by a scheduled cleanup (or the next
// webhook cycle). This function's job is to stop the renewal and record when
// access ends.
//
// ── ENV (Netlify → Environment variables) ──
//   MOLLIE_API_KEY, FIREBASE_SERVICE_ACCOUNT   (same as the other functions)

const { createMollieClient } = require('@mollie/api-client');
const admin = require('firebase-admin');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

// One paid year from a given start date (ISO string) → ISO date the access ends.
function oneYearAfter(startIso) {
  const d = startIso ? new Date(startIso) : new Date();
  const end = new Date(d);
  end.setFullYear(end.getFullYear() + 1);
  return end;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { idToken } = JSON.parse(event.body || '{}');
    if (!idToken) return { statusCode: 400, body: JSON.stringify({ error: 'Missing idToken' }) };

    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const profileRef = db.collection('users').doc(uid).collection('profile').doc('data');
    const snap = await profileRef.get();
    const data = snap.exists ? snap.data() : {};

    if (data.tier !== 'pro') {
      return { statusCode: 400, body: JSON.stringify({ error: 'not_pro', message: 'No active Pro plan to cancel.' }) };
    }
    if (data.proCancelled) {
      // Idempotent: already cancelled — just report the existing end date.
      return { statusCode: 200, body: JSON.stringify({ alreadyCancelled: true, proEndsAt: data.proEndsAt || null }) };
    }

    // 1) Cancel the Mollie subscription so it will not renew.
    let mollieCancelled = false;
    if (data.mollieCustomerId && data.mollieSubscriptionId) {
      try {
        await mollieClient.customerSubscriptions.cancel(data.mollieSubscriptionId, { customerId: data.mollieCustomerId });
        mollieCancelled = true;
      } catch (subErr) {
        // If it's already cancelled/completed on Mollie's side, treat as success.
        console.error('Mollie cancel error (continuing):', subErr && subErr.message);
        if (subErr && /410|not found|no longer|cancel/i.test(String(subErr.message || ''))) mollieCancelled = true;
      }
    } else {
      // No renewal subscription on record (e.g. free-Pro grant). Nothing to cancel
      // on Mollie's side, but we still record the cancellation intent below.
      mollieCancelled = true;
    }

    // 2) Determine when Pro access ends. Prefer an explicit paid-period end if we
    //    ever store one; otherwise one year from proSince (the paid year start).
    let proEndsAt = data.proEndsAt ? new Date(data.proEndsAt) : null;
    if (!proEndsAt) {
      const since = data.proSince && data.proSince.toDate ? data.proSince.toDate().toISOString()
                  : (typeof data.proSinceIso === 'string' ? data.proSinceIso
                  : (typeof data.proSince === 'string' ? data.proSince : null));
      proEndsAt = oneYearAfter(since);
    }

    // 3) Record cancellation. Pro stays active (tier still 'pro') until proEndsAt.
    await profileRef.set({
      proCancelled: true,
      proAutoRenew: false,
      proCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      proEndsAt: proEndsAt.toISOString(),
    }, { merge: true });

    return {
      statusCode: 200,
      body: JSON.stringify({ cancelled: true, mollieCancelled, proEndsAt: proEndsAt.toISOString() }),
    };
  } catch (err) {
    console.error('cancel-mollie-subscription error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
