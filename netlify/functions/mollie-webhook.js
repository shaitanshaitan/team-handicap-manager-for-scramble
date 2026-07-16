// netlify/functions/mollie-webhook.js
//
// Mollie calls this with just a payment ID in the POST body — no signed
// payload like Stripe. We fetch the payment's real status directly from
// Mollie's API using our own API key, which is what makes this trustworthy
// (an attacker POSTing a fake ID here gains nothing, since we look up the
// truth ourselves rather than trusting anything in the request body).
//
// On a confirmed 'paid' first payment:
//   1. Grant Pro immediately (tier: 'pro') for the year just paid for.
//   2. Create a Mollie Subscription that starts exactly 1 year from now,
//      billing the STANDARD €35 price annually from then on — this is what
//      makes the promo → standard-price renewal automatic with no manual
//      follow-up required.
//
// ── SETUP REQUIRED (Netlify → Site settings → Environment variables) ──
//   MOLLIE_API_KEY              same as create-mollie-payment.js
//   FIREBASE_SERVICE_ACCOUNT    same as create-mollie-payment.js
//
// ── AFTER FIRST DEPLOY ──
// Nothing to configure in the Mollie dashboard for this one — the webhook
// URL is passed per-payment in create-mollie-payment.js, not registered
// globally like Stripe's dashboard webhook setup.

const { createMollieClient } = require('@mollie/api-client');
const admin = require('firebase-admin');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const STANDARD_PRICE = '35.00';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    // Mollie sends this as application/x-www-form-urlencoded: id=tr_xxxxx
    const params = new URLSearchParams(event.body);
    const paymentId = params.get('id');
    if (!paymentId) {
      return { statusCode: 400, body: 'Missing payment id' };
    }

    // Fetch the REAL status from Mollie — never trust anything else in
    // the incoming request for this decision.
    const payment = await mollieClient.payments.get(paymentId);

    if (payment.status !== 'paid') {
      // Mollie also calls this webhook for other status changes
      // (open, failed, canceled, expired) — nothing to do for those here.
      return { statusCode: 200, body: JSON.stringify({ ignored: payment.status }) };
    }

    const uid = payment.metadata && payment.metadata.firebaseUid;
    if (!uid) {
      console.error('Paid payment with no firebaseUid in metadata — cannot grant Pro.');
      return { statusCode: 200, body: 'No uid on payment, ignored.' };
    }

    const profileRef = db.collection('users').doc(uid).collection('profile').doc('data');

    // The paid year runs from now until exactly one year out. Anchor that end
    // date HERE, at purchase, so activation date + end date are fixed facts —
    // cancellation later just reads proEndsAt instead of recomputing it.
    const nowIso = new Date().toISOString();
    const endDate = new Date();
    endDate.setFullYear(endDate.getFullYear() + 1);
    const endIso = endDate.toISOString();
    const startDateStr = endIso.split('T')[0]; // YYYY-MM-DD — renewal subscription starts the day access would end

    // Grant Pro for the year already paid for.
    await profileRef.set(
      {
        tier: 'pro',
        proSince: admin.firestore.FieldValue.serverTimestamp(),
        proSinceIso: nowIso,          // plain ISO copy, easy for the client to read/display
        proEndsAt: endIso,            // fixed end of the paid year (also the renewal date)
        proAutoRenew: true,
        proCancelled: false,
        proSource: (payment.metadata && payment.metadata.promo) || 'unknown',
        molliePaymentId: payment.id,
        mollieCustomerId: payment.customerId,
      },
      { merge: true }
    );
    console.log(`Granted Pro to uid ${uid} (${payment.metadata && payment.metadata.promo}), ends ${endIso}`);

    // Set up automatic renewal at the STANDARD price, starting exactly when the
    // paid year ends — so year 2 bills at €35 with no manual action, regardless
    // of whether year 1 was the €13.99 promo or already €35.

    try {
      const subscription = await mollieClient.customerSubscriptions.create({
        customerId: payment.customerId,
        amount: { currency: 'EUR', value: STANDARD_PRICE },
        interval: '12 months',
        startDate: startDateStr,
        description: 'Parmate Pro — Annual renewal',
        webhookUrl: `${process.env.URL || 'https://parmate.golf'}/.netlify/functions/mollie-webhook`,
      });
      await profileRef.set({ mollieSubscriptionId: subscription.id }, { merge: true });
      console.log(`Created renewal subscription ${subscription.id} for uid ${uid}, starting ${startDateStr}`);
    } catch (subErr) {
      // Don't fail the whole webhook over this — the user already has Pro
      // for their paid year; a missing renewal subscription is recoverable
      // (worth alerting yourself on, but shouldn't block granting access).
      console.error(`Failed to create renewal subscription for uid ${uid}:`, subErr);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('mollie-webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
