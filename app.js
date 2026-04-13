/* ══════════════════════════════════════════════════
   firebase.js  —  TES Pro
   Firebase configuration, initialisation & helpers
   ─────────────────────────────────────────────────

   ╔══════════════════════════════════════════════╗
   ║        FIREBASE SETUP GUIDE (Read First)     ║
   ╚══════════════════════════════════════════════╝

   STEP 1 ─ Create Firebase Project
   ──────────────────────────────────
   1. Visit: https://console.firebase.google.com
   2. Click "Add project" → name it "TES Pro"
   3. Disable Google Analytics (optional)
   4. Click "Create project" and wait

   STEP 2 ─ Register Web App & Get Config
   ──────────────────────────────────────
   1. In your project dashboard, click the </> (Web) icon
   2. App nickname: "TES Pro Web"
   3. Click "Register app"
   4. You will see a firebaseConfig object like:
      {
        apiKey: "AIza...",
        authDomain: "tes-pro.firebaseapp.com",
        ...
      }
   5. COPY this entire object
   6. PASTE it into the FIREBASE_CONFIG below,
      replacing all the "YOUR_..." placeholder values

   STEP 3 ─ Enable Email/Password Authentication
   ───────────────────────────────────────────────
   1. Left sidebar → Build → Authentication
   2. Click "Get started"
   3. Click "Email/Password" provider
   4. Toggle "Enable" to ON
   5. Click "Save"

   STEP 4 ─ Create Firestore Database
   ────────────────────────────────────
   1. Left sidebar → Build → Firestore Database
   2. Click "Create database"
   3. Select "Start in production mode"
   4. Choose your region (e.g. europe-west1 for Nigeria/Africa)
   5. Click "Enable"

   STEP 5 ─ Set Security Rules
   ────────────────────────────
   In Firestore → Rules tab, replace with:

   ┌─────────────────────────────────────────────┐
   │  rules_version = '2';                        │
   │  service cloud.firestore {                   │
   │    match /databases/{database}/documents {   │
   │      match /users/{userId}/{doc=**} {        │
   │        allow read, write:                    │
   │          if request.auth != null             │
   │          && request.auth.uid == userId;      │
   │      }                                       │
   │    }                                         │
   │  }                                           │
   └─────────────────────────────────────────────┘

   Click "Publish".

   STEP 6 ─ Deploy
   ─────────────────
   GitHub Pages:
   • Push all 6 files to your repo root
   • Settings → Pages → Branch: main, Folder: / (root)
   • Your app will be live at:
     https://yourusername.github.io/repo-name/

   Local Testing:
   • Use VS Code "Live Server" extension  (port 5500)
   • OR: python -m http.server 8080

   ─────────────────────────────────────────────────
   PAYMENT SETUP NOTES
   ─────────────────────────────────────────────────

   Paystack (Nigeria + Africa):
   • Sign up at https://paystack.com
   • Get your public key from Dashboard → Settings → API Keys
   • Replace PAYSTACK_PUBLIC_KEY below
   • When payment succeeds, call: grantAccess(uid)

   PayPal (Global):
   • Create app at https://developer.paypal.com
   • Get client ID from My Apps & Credentials
   • Replace PAYPAL_CLIENT_ID below
   • When payment succeeds, call: grantAccess(uid)

   ══════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────────
   ▼  PASTE YOUR FIREBASE CONFIG HERE  ▼
────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
   apiKey: "AIzaSyC9ydoRwWKGJUq8BMKAsBIHsIsflLZt5Y0",
  authDomain: "tes-trading-app.firebaseapp.com",
  projectId: "tes-trading-app",
  storageBucket: "tes-trading-app.firebasestorage.app",
  messagingSenderId: "656284025809",
  appId: "1:656284025809:web:f15425c70ce8c4fbcb96f0"
};
/* ──────────────────────────────────────────────────
   Payment keys (replace when ready to go live)
────────────────────────────────────────────────── */
const PAYSTACK_PUBLIC_KEY = "pk_test_YOUR_PAYSTACK_KEY";
const PAYPAL_CLIENT_ID    = "YOUR_PAYPAL_CLIENT_ID";
const PRODUCT_PRICE_USD   = 19;   // Monthly price in USD
const PRODUCT_PRICE_NGN   = 29000; // Monthly price in Naira

/* ──────────────────────────────────────────────────
   DO NOT EDIT BELOW — Initialisation & Helpers
────────────────────────────────────────────────── */

// Prevent double-init (GitHub Pages / hot reload safety)
if (!firebase.apps.length) {
  firebase.initializeApp(FIREBASE_CONFIG);
}

const auth = firebase.auth();
const db   = firebase.firestore();

// ── Auth persistence helper ──────────────────────
// Called before sign-in so sessions persist correctly
function setAuthPersistence(remember) {
  const p = remember
    ? firebase.auth.Auth.Persistence.LOCAL    // Cross-session (survives browser restart)
    : firebase.auth.Auth.Persistence.SESSION; // Tab-only
  return auth.setPersistence(p);
}

// ── Firestore path helpers ───────────────────────
function userRef(uid)           { return db.collection('users').doc(uid); }
function userSubRef(uid, col)   { return userRef(uid).collection(col); }

// ── Grant paid access (call after payment success) ─
async function grantAccess(uid) {
  try {
    await userRef(uid).update({
      paymentStatus: 'paid',
      paidAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    console.log('[TES] Access granted for:', uid);
    return true;
  } catch (e) {
    console.error('[TES] grantAccess error:', e);
    return false;
  }
}

// ── Revoke access ─────────────────────────────────
async function revokeAccess(uid) {
  await userRef(uid).update({ paymentStatus: 'free' });
}

// ── Config validation warning ────────────────────
(function() {
  if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
    console.warn(
      '%c[TES Pro] ⚠ Firebase not configured!\n' +
      'Open firebase.js and paste your Firebase config object.\n' +
      'See the setup guide at the top of the file.',
      'color:#e4ae2a;font-size:14px;font-weight:bold'
    );
  } else {
    console.log('%c[TES Pro] ✓ Firebase initialised', 'color:#00d4a1;font-weight:bold');
  }
  if (PAYSTACK_PUBLIC_KEY.startsWith('pk_test_YOUR')) {
    console.info('%c[TES Pro] ℹ Paystack key not set — payment will be simulated', 'color:#3d9eff');
  }
})();

