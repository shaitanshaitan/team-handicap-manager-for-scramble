// netlify/functions/create-mollie-payment.js
//
// Called from the client when a user taps "Upgrade to Pro". Determines
// whether they qualify for the launch promo price based on their Firebase
// Auth account-creation date, creates (or reuses) a Mollie Customer, then
// creates a "first" payment — this is what Mollie uses to establish a
// mandate for future recurring charges. The actual recurring Subscription
// (year 2 onward, at the standard price) gets created later, in the
// webhook, once this first payment confirms as paid.
//
// ── SETUP REQUIRED (Netlify → Site settings → Environment variables) ──
//   MOLLIE_API_KEY             live_... or test_...   (Mollie → Developers → API keys)
//   FIREBASE_SERVICE_ACCOUNT   <full JSON, one line>  (same as before)
//
// ── SETUP REQUIRED (package.json) ──
//   npm install @mollie/api-client firebase-admin --save
//
// ── LAUNCH DATE ──
// Not decided yet — placeholder below. Update this ONE line when the real
// launch date is set. Promo window = LAUNCH_DATE + 2 calendar months.
// Example from your own spec: launch Aug 1 2026 → promo ends Oct 1 2026.
const LAUNCH_DATE = new Date('2026-08-01T00:00:00Z'); // TODO: set real launch date

const { createMollieClient } = require('@mollie/api-client');
const admin = require('firebase-admin');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const PROMO_PRICE = '13.99';
const STANDARD_PRICE = '35.00';

function promoCutoff() {
  const cutoff = new Date(LAUNCH_DATE);
  cutoff.setMonth(cutoff.getMonth() + 2);
  return cutoff;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { idToken } = JSON.parse(event.body || '{}');
    if (!idToken) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing idToken' }) };
    }

    // Verify the user is who they say they are — never trust a uid sent
    // directly from the client for something that decides pricing.
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const userRecord = await admin.auth().getUser(uid);

    const createdAt = new Date(userRecord.metadata.creationTime);
    const qualifiesForPromo = createdAt <= promoCutoff();
    const amount = qualifiesForPromo ? PROMO_PRICE : STANDARD_PRICE;

    // Reuse an existing Mollie customer if this user already has one
    // (stored on their profile doc from a previous attempt), otherwise
    // create one. Mollie needs a Customer to attach the mandate/subscription
    // to later.
    const profileRef = db.collection('users').doc(uid).collection('profile').doc('data');
    const profileSnap = await profileRef.get();
    const profileData = profileSnap.exists ? profileSnap.data() : {};

    let mollieCustomerId = profileData.mollieCustomerId;
    if (!mollieCustomerId) {
      const customer = await mollieClient.customers.create({
        name: profileData.displayName || userRecord.displayName || 'Parmate user',
        email: userRecord.email,
        metadata: { firebaseUid: uid },
      });
      mollieCustomerId = customer.id;
      await profileRef.set({ mollieCustomerId }, { merge: true });
    }

    const siteUrl = process.env.URL || 'https://parmate.golf';

    const payment = await mollieClient.payments.create({
      amount: { currency: 'EUR', value: amount },
      description: qualifiesForPromo
        ? 'Parmate Pro — Launch price (Year 1)'
        : 'Parmate Pro — Annual subscription',
      customerId: mollieCustomerId,
      sequenceType: 'first', // establishes the mandate for future recurring charges
      // Restricted to the two methods confirmed to reliably create a
      // recurring mandate in Mollie. Other activated methods (Apple Pay,
      // Google Pay, Bancontact, KBC/CBC) are fine for one-off use elsewhere,
      // but aren't confirmed safe for the payment that has to support a
      // charge a year from now — so they're deliberately excluded here,
      // not just left to dashboard settings which govern checkout generally,
      // not this specific first-payment call.
      method: ['ideal', 'creditcard'],
      redirectUrl: `${siteUrl}/?upgrade=complete`,
      webhookUrl: `${siteUrl}/.netlify/functions/mollie-webhook`,
      metadata: { firebaseUid: uid, promo: qualifiesForPromo ? 'launch' : 'standard' },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: payment._links.checkout.href, promo: qualifiesForPromo }),
    };
  } catch (err) {
    console.error('create-mollie-payment error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
