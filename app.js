/* ══════════════════════════════════════════════════
   app.js  —  TES Pro
   Full application logic — Auth, Firestore, UI, Charts
══════════════════════════════════════════════════ */

'use strict';

/* ── App State ───────────────────────────────────── */
const S = {
  user:          null,   // Firebase Auth user
  profile:       null,   // Firestore user doc
  trades:        [],     // live-synced from Firestore
  checkState:    {},     // checklist session state
  pendingTrade:  null,   // trade waiting for modal confirm
  outcome:       '',     // journal outcome selection
  tags:          [],     // journal selected tags
  jFilter:       'all',  // journal filter
  strengthData:  {},     // computed currency scores
  suggestions:   [],     // computed trade suggestions
  bias:          'neutral',
  charts:        {},     // chart instances
  unsubTrades:   null,   // Firestore realtime unsub
  fundNoteTimer: null    // debounce for notes save
};

/* ══════════════════════════════════════════════════
   BOOT — Firebase Auth observer
   Everything starts here. Single source of truth.
══════════════════════════════════════════════════ */
auth.onAuthStateChanged(async user => {
  if (user) {
    S.user = user;
    await bootUser(user.uid);
  } else {
    S.user    = null;
    S.profile = null;
    teardown();
    showScreen('auth');
  }
});

async function bootUser(uid) {
  try {
    const snap = await userRef(uid).get();

    if (!snap.exists) {
      // First ever login — create profile doc
      const profile = {
        uid,
        email:         S.user.email,
        displayName:   S.user.displayName || S.user.email.split('@')[0],
        paymentStatus: 'free',
        streak:        0,
        lastActive:    '',
        fundNotes:     '',
        bias:          'neutral',
        createdAt:     firebase.firestore.FieldValue.serverTimestamp()
      };
      await userRef(uid).set(profile);
      S.profile = profile;
    } else {
      S.profile = snap.data();
    }

    // Route based on payment.
    // Check localStorage first (set by simulatePayment on button click),
    // then fall back to the Firestore profile field.
    var lsKey    = 'paymentStatus_' + uid;
    var lsPaid   = localStorage.getItem(lsKey) === 'paid' ||
                   localStorage.getItem('paymentStatus') === 'paid';

    if (lsPaid && S.profile.paymentStatus !== 'paid') {
      // Sync localStorage decision into the in-memory profile
      // (Firestore update is best-effort; app still works without it)
      S.profile.paymentStatus = 'paid';
      try { await userRef(uid).update({ paymentStatus: 'paid' }); } catch(e) {}
    }

    if (S.profile.paymentStatus === 'paid') {
      launchApp();
    } else {
      setupLockedScreen();
      showScreen('locked');
    }

  } catch (err) {
    console.error('[TES] bootUser error:', err);
    toast('Connection error — check your internet.', 'error');
    showScreen('auth');
  }
}

/* ══════════════════════════════════════════════════
   SCREENS
══════════════════════════════════════════════════ */
function showScreen(name) {
  ['splash','auth','locked','app'].forEach(s => {
    document.getElementById('screen-' + s).classList.remove('active');
  });
  document.getElementById('screen-' + name).classList.add('active');
}

/* ══════════════════════════════════════════════════
   AUTH HANDLERS
══════════════════════════════════════════════════ */
function authTab(tab, btn) {
  document.querySelectorAll('.atab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('auth-' + tab).classList.add('active');
  clearErr('l-err'); clearErr('s-err');
}

function clearErr(id) { setEl(id, ''); }

function showErr(id, msg) { setEl(id, msg); }

async function doLogin() {
  const email    = val('l-email').trim();
  const password = val('l-pass');
  const remember = document.getElementById('l-remember').checked;
  clearErr('l-err');

  if (!email || !password) { showErr('l-err', 'Enter your email and password.'); return; }

  const btn = event.currentTarget;
  btnLoad(btn, 'Signing in...');

  try {
    await setAuthPersistence(remember);
    await auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged handles routing
  } catch (err) {
    showErr('l-err', fbErrMsg(err.code));
    btnLoad(btn, null, 'Sign In <span class="arr">→</span>');
  }
}

async function doSignup() {
  const name     = val('s-name').trim();
  const email    = val('s-email').trim();
  const password = val('s-pass');
  clearErr('s-err');

  if (!name || !email || !password) { showErr('s-err', 'All fields are required.'); return; }
  if (password.length < 6) { showErr('s-err', 'Password must be at least 6 characters.'); return; }

  const btn = event.currentTarget;
  btnLoad(btn, 'Creating account...');

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    // onAuthStateChanged fires and calls bootUser
  } catch (err) {
    showErr('s-err', fbErrMsg(err.code));
    btnLoad(btn, null, 'Create Account <span class="arr">→</span>');
  }
}

async function doLogout() {
  // Clear per-user localStorage payment flag on explicit logout
  // (keeps the global fallback key intact for same-user re-login)
  if (S.user) {
    localStorage.removeItem('paymentStatus_' + S.user.uid);
  }
  teardown();
  await auth.signOut();
  // onAuthStateChanged fires → showScreen('auth')
}

/* ══════════════════════════════════════════════════
   LOCKED SCREEN
══════════════════════════════════════════════════ */
function setupLockedScreen() {
  setEl('locked-user-email', 'Signed in as: ' + (S.user?.email || ''));
}

function showPayment() {
  showScreen('locked');
}

/* ── Paystack Integration ─────────────────────────
   To go live: replace PAYSTACK_PUBLIC_KEY in firebase.js
   and ensure your Paystack account is verified.
────────────────────────────────────────────────── */
function initiatePaystack() {
  // Check if Paystack script is loaded
  if (typeof PaystackPop === 'undefined') {
    // Load Paystack inline script dynamically
    const script = document.createElement('script');
    script.src = 'https://js.paystack.co/v1/inline.js';
    script.onload = () => openPaystack();
    script.onerror = () => toast('Could not load Paystack. Check your connection.', 'error');
    document.head.appendChild(script);
  } else {
    openPaystack();
  }
}

function openPaystack() {
  if (!S.user) return;

  // Paystack config — replace key when going live
  const config = {
    key:       PAYSTACK_PUBLIC_KEY,
    email:     S.user.email,
    amount:    PRODUCT_PRICE_NGN * 100, // Paystack uses kobo (lowest denomination)
    currency:  'NGN',
    ref:       'TES_' + S.user.uid + '_' + Date.now(),
    metadata:  { uid: S.user.uid, product: 'TES_PRO_MONTHLY' },
    callback: async function(response) {
      // ✅ Payment successful
      console.log('[TES] Paystack success:', response.reference);
      const ok = await grantAccess(S.user.uid);
      if (ok) {
        S.profile.paymentStatus = 'paid';
        toast('Payment confirmed! Welcome to TES Pro 🎉', 'success');
        await bootUser(S.user.uid);
      }
    },
    onClose: function() {
      toast('Payment cancelled.', '');
    }
  };

  // Check if this is a test key — simulate payment for development
  if (PAYSTACK_PUBLIC_KEY.startsWith('pk_test_YOUR')) {
    simulatePayment('Paystack');
    return;
  }

  const handler = PaystackPop.setup(config);
  handler.openIframe();
}

/* ── PayPal Integration ───────────────────────────
   To go live: replace PAYPAL_CLIENT_ID in firebase.js
   and load the PayPal JS SDK.
────────────────────────────────────────────────── */
function initiatePaypal() {
  if (PAYPAL_CLIENT_ID === 'YOUR_PAYPAL_CLIENT_ID') {
    simulateLocalPayment('PayPal');
    return;
  }
}

  // Load PayPal SDK if not loaded
  if (document.getElementById('paypal-sdk')) {
    renderPaypalButton();
    return;
  }
  const script = document.createElement('script');
  script.id  = 'paypal-sdk';
  script.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=USD`;
  script.onload = () => renderPaypalButton();
  document.head.appendChild(script);
}

function renderPaypalButton() {
  // PayPal button renders into a container element
  // Full implementation goes here when client-id is set
  toast('PayPal: add your Client ID in firebase.js to activate', 'warning');
}

// ── Dev / demo: simulate payment via localStorage ──
function simulatePayment(provider) {
  // Show a brief processing toast so the user sees feedback
  toast('Processing ' + provider + ' payment...', 'warning');

  setTimeout(function() {
    // Store payment status in localStorage keyed to the user
    // so it persists across page refreshes without needing Firestore
    var uid = S.user ? S.user.uid : 'guest';
    localStorage.setItem('paymentStatus_' + uid, 'paid');
    localStorage.setItem('paymentStatus', 'paid'); // global fallback

    toast('Payment confirmed! Loading your dashboard... 🎉', 'success');

    // Give the toast 900 ms to show before reloading
    setTimeout(function() {
      window.location.reload();
    }, 900);
  }, 1500);
}

/* ══════════════════════════════════════════════════
   APP LAUNCH
══════════════════════════════════════════════════ */
function launchApp() {
  showScreen('app');
  setupTopbar();
  setupDashboard();
  subscribeTrades();
  loadFundNotes();
  loadBias();
  loadStrengthIfAvailable();
  goPage('dashboard');
  initPWA();
}

function teardown() {
  if (S.unsubTrades) { S.unsubTrades(); S.unsubTrades = null; }
  Object.values(S.charts).forEach(c => { if (c) c.destroy(); });
  S.charts     = {};
  S.trades     = [];
  S.profile    = null;
}

function setupTopbar() {
  const name = S.profile?.displayName || S.user?.email || 'Trader';
  const first = name.split(/[\s@]/)[0];
  setEl('tb-email',  first);
  setEl('tb-avatar', first[0]?.toUpperCase() || 'T');
}

function setupDashboard() {
  const h = new Date().getHours();
  const g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const name = (S.profile?.displayName || '').split(/[\s@]/)[0];
  setEl('hero-greeting', `${g}${name ? ', ' + name : ''} ⚡`);
  setEl('hero-date', new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }));
  buildCurrencyInputs();
  restoreBiasUI();
}

/* ══════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════ */
function goPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.bn-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + id)?.classList.add('active');
  document.querySelector(`.bn-item[data-page="${id}"]`)?.classList.add('active');

  // Page-specific refresh
  if (id === 'analytics')   renderAnalytics();
  if (id === 'journal')     renderTrades();
  if (id === 'dashboard')   updateDashStats();
  if (id === 'suggestions') renderSuggestions();
}

/* ══════════════════════════════════════════════════
   FIRESTORE — TRADES (Real-time)
══════════════════════════════════════════════════ */
function subscribeTrades() {
  if (!S.user) return;
  if (S.unsubTrades) S.unsubTrades();

  S.unsubTrades = userSubRef(S.user.uid, 'trades')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      S.trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      updateDashStats();
      renderTrades();
      renderAnalytics();
    }, err => console.error('[TES] trades listener:', err));
}

async function saveTrade(trade) {
  if (!S.user) return;
  await userSubRef(S.user.uid, 'trades').add({
    ...trade,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function deleteTrade(id) {
  if (!S.user) return;
  await userSubRef(S.user.uid, 'trades').doc(id).delete();
  toast('Trade deleted.', '');
}

/* ══════════════════════════════════════════════════
   DASHBOARD STATS
══════════════════════════════════════════════════ */
function updateDashStats() {
  const t = S.trades;
  const wins = t.filter(x => x.outcome === 'win').length;
  const wr   = t.length ? Math.round(wins / t.length * 100) : 0;
  const avRR = t.length ? (t.reduce((a, x) => a + (parseFloat(x.rr) || 0), 0) / t.length).toFixed(1) : '0.0';
  const netR = t.reduce((a, x) => {
    const r = x.outcome === 'win' ? parseFloat(x.rr || 1) : x.outcome === 'loss' ? -1 : 0;
    return a + r;
  }, 0);

  setEl('st-trades', t.length || '—');
  setEl('st-wr',     t.length ? wr + '%' : '—');
  setEl('st-rr',     t.length ? avRR : '—');
  setEl('st-pnl',    t.length ? (netR > 0 ? '+' : '') + netR.toFixed(1) + 'R' : '—');
  setEl('streak-num', S.profile?.streak || 0);

  // Recent 3 trades on dashboard
  const el = document.getElementById('dash-recent');
  if (!el) return;
  const recent = t.slice(0, 3);
  el.innerHTML = recent.length
    ? recent.map(t => tradeCardHTML(t)).join('')
    : '<div class="empty-state">No trades yet. Complete the checklist and log your first trade.</div>';
}

/* ══════════════════════════════════════════════════
   RISK BIAS
══════════════════════════════════════════════════ */
const BIAS_TEXT = {
  'risk-on': 'Risk-On environment: Investors are buying riskier assets. AUD, NZD, GBP, and commodity currencies tend to strengthen. JPY, CHF, USD typically weaken as safe-haven demand falls. Favor longs on risk currencies.',
  'neutral': 'Neutral: No dominant risk theme. Mixed signals across markets. Focus on technical setups with strong confluence and avoid trading against the prevailing short-term trend.',
  'risk-off': 'Risk-Off environment: Flight to safety. USD, JPY, and CHF tend to strengthen as investors exit risk assets. AUD, NZD, and commodity currencies weaken. Favor safe-haven longs and risk-currency shorts.'
};

function setBias(type, btn) {
  document.querySelectorAll('.bias-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  S.bias = type;
  setEl('bias-explain', BIAS_TEXT[type]);
  if (S.user) {
    userRef(S.user.uid).update({ bias: type }).catch(() => {});
  }
}

function loadBias() {
  S.bias = S.profile?.bias || 'neutral';
  restoreBiasUI();
}

function restoreBiasUI() {
  document.querySelectorAll('.bias-btn').forEach(b => {
    b.classList.toggle('active', b.classList.contains(S.bias));
  });
  setEl('bias-explain', BIAS_TEXT[S.bias] || BIAS_TEXT.neutral);
}

/* ══════════════════════════════════════════════════
   CURRENCY STRENGTH ENGINE
══════════════════════════════════════════════════ */
const CURRENCIES = ['USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF'];
const CURRENCY_FACTORS = ['Rate','CPI','Employment','CB Stance'];

function buildCurrencyInputs() {
  const grid = document.getElementById('cs-inputs');
  if (!grid) return;
  grid.innerHTML = CURRENCIES.map(c => `
    <div class="cs-currency-row">
      <div class="cs-sym">${c}</div>
      ${CURRENCY_FACTORS.map(f => `
        <div class="cs-score-row">
          <label>${f}</label>
          <select id="cs-${c}-${f.replace(' ','')}" onchange="void 0">
            <option value="0">Neutral</option>
            <option value="1">+1 Bullish</option>
            <option value="2">+2 Strong</option>
            <option value="-1">-1 Bearish</option>
            <option value="-2">-2 Weak</option>
          </select>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function loadStrengthIfAvailable() {
  // Restore saved strength scores from Firestore profile
  const saved = S.profile?.strengthScores;
  if (!saved || !Object.keys(saved).length) return;
  S.strengthData = saved;
  renderStrengthTable(saved);
  computeSuggestions(saved);
}

function calcStrength() {
  const scores = {};
  CURRENCIES.forEach(c => {
    let total = 0;
    CURRENCY_FACTORS.forEach(f => {
      const el = document.getElementById(`cs-${c}-${f.replace(' ','')}`);
      if (el) total += parseInt(el.value) || 0;
    });
    scores[c] = total;
  });

  S.strengthData = scores;
  renderStrengthTable(scores);
  computeSuggestions(scores);

  // Save to Firestore
  if (S.user) {
    userRef(S.user.uid).update({ strengthScores: scores }).catch(() => {});
  }

  // Show results section
  const res = document.getElementById('cs-results');
  if (res) res.style.display = 'block';
}

function renderStrengthTable(scores) {
  const sorted  = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const maxAbs  = Math.max(...sorted.map(([,s]) => Math.abs(s)), 1);
  const res     = document.getElementById('cs-results');
  const tableEl = document.getElementById('cs-table');
  if (!res || !tableEl) return;

  res.style.display = 'block';
  tableEl.innerHTML = `
    <thead><tr>
      <th>#</th><th>Currency</th><th>Score</th><th>Strength</th><th>Bias</th>
    </tr></thead>
    <tbody>
    ${sorted.map(([c, s], i) => {
      const color  = s > 1 ? 'var(--green)' : s < -1 ? 'var(--red)' : 'var(--blue)';
      const barW   = Math.round(Math.abs(s) / maxAbs * 100);
      const badge  = s > 1 ? 'bull' : s < -1 ? 'bear' : 'neut';
      const label  = s > 1 ? 'BULL' : s < -1 ? 'BEAR' : 'NEUTRAL';
      return `<tr>
        <td style="color:var(--t3);font-size:12px">${i+1}</td>
        <td style="font-family:var(--ff-head);font-size:16px;font-weight:800">${c}</td>
        <td style="font-family:var(--ff-mono);color:${color};font-weight:700">${s>0?'+':''}${s}</td>
        <td>
          <div class="cs-bar-wrap">
            <div class="cs-bar-bg"><div class="cs-bar-fill" style="width:${barW}%;background:${color}"></div></div>
          </div>
        </td>
        <td><span class="cs-badge ${badge}">${label}</span></td>
      </tr>`;
    }).join('')}
    </tbody>`;
}

/* ══════════════════════════════════════════════════
   AUTO TRADE SUGGESTIONS (Premium)
══════════════════════════════════════════════════ */
const KNOWN_PAIRS = [
  ['EUR','USD'],['GBP','USD'],['USD','JPY'],['AUD','USD'],
  ['USD','CAD'],['NZD','USD'],['USD','CHF'],['EUR','GBP'],
  ['EUR','JPY'],['GBP','JPY'],['AUD','JPY'],['GBP','CAD']
];

function computeSuggestions(scores) {
  const sorted   = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top3     = sorted.slice(0, 3).map(([c]) => c);
  const bottom3  = sorted.slice(-3).map(([c]) => c);
  const results  = [];

  KNOWN_PAIRS.forEach(([base, quote]) => {
    const baseScore  = scores[base]  ?? 0;
    const quoteScore = scores[quote] ?? 0;
    const diff       = baseScore - quoteScore;

    if (Math.abs(diff) < 2) return; // Not strong enough signal

    const isBuy       = diff > 0;
    const confidence  = Math.min(99, Math.round(55 + Math.abs(diff) * 6));
    const rr          = (1.5 + Math.abs(diff) * 0.2).toFixed(1);
    const strong      = isBuy ? base  : quote;
    const weak        = isBuy ? quote : base;

    results.push({
      pair:       base + quote,
      direction:  isBuy ? 'BUY' : 'SELL',
      reason:     `${strong} strong (${scores[strong]>0?'+':''}${scores[strong]}) vs ${weak} weak (${scores[weak]>0?'+':''}${scores[weak]})`,
      confidence,
      rr,
      strongScore: scores[strong],
      weakScore:   scores[weak],
      entryType:   Math.abs(diff) >= 6 ? 'Limit Order at Zone' : 'Wait for M15 Confirmation',
      logic:       buildLogicText(base, quote, baseScore, quoteScore, isBuy, S.bias)
    });
  });

  // Special: XAUUSD driven by USD weakness
  const usdScore = scores['USD'] ?? 0;
  if (usdScore <= -2) {
    results.unshift({
      pair:       'XAUUSD',
      direction:  'BUY',
      reason:     `USD weak (${usdScore}) — Gold typically rallies when USD weakens`,
      confidence: Math.min(95, 60 + Math.abs(usdScore) * 8),
      rr:         '2.5',
      entryType:  'Buy on Demand Zone',
      logic:      'Gold has an inverse relationship with the USD. Current USD weakness provides fundamental tailwind for Gold longs. Look for demand zone entries on H1/M15 with confirmation.'
    });
  } else if (usdScore >= 3) {
    results.unshift({
      pair:       'XAUUSD',
      direction:  'SELL',
      reason:     `USD strong (+${usdScore}) — Headwind for Gold`,
      confidence: Math.min(90, 55 + usdScore * 5),
      rr:         '2.0',
      entryType:  'Sell at Supply Zone',
      logic:      'Strong USD creates fundamental headwind for Gold. Look for supply zone entries on H4/H1 with confirmation candles before entering shorts.'
    });
  }

  // Sort by confidence
  S.suggestions = results.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

function buildLogicText(base, quote, bScore, qScore, isBuy, bias) {
  const strong = isBuy ? base  : quote;
  const weak   = isBuy ? quote : base;
  const dir    = isBuy ? 'bullish' : 'bearish';
  const biasAlign = (bias === 'risk-on' && ['AUD','NZD','GBP'].includes(strong)) ||
                    (bias === 'risk-off' && ['USD','JPY','CHF'].includes(strong));
  return `Fundamental scoring shows ${strong} significantly stronger (${bScore>0?'+':''}${bScore}) vs ${weak} (${qScore>0?'+':''}${qScore}). ` +
         `This creates a ${dir} bias for ${base+quote}. ` +
         (biasAlign ? `Current ${bias.replace('-',' ')} sentiment reinforces this setup. ` : '') +
         `Wait for price to reach a key S/D zone on H4, then drill down to H1/M15 for a confirmation entry (BOS, OB, or rejection wick).`;
}

function renderSuggestions() {
  const emptyEl = document.getElementById('sugg-empty');
  const listEl  = document.getElementById('sugg-list');
  const gateEl  = document.getElementById('sugg-gate');
  if (!emptyEl || !listEl || !gateEl) return;

  const isPaid = S.profile?.paymentStatus === 'paid';

  if (!S.suggestions.length) {
    emptyEl.style.display = 'block';
    listEl.style.display  = 'none';
    gateEl.style.display  = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.style.display  = 'block';
  gateEl.style.display  = isPaid ? 'none' : 'block';

  listEl.innerHTML = S.suggestions.map((s, i) => `
    <div class="sugg-card" id="sc-${i}">
      <div class="sugg-header" onclick="toggleSugg(${i})">
        <div class="sugg-dir ${s.direction.toLowerCase()}">${s.direction}</div>
        <div class="sugg-main">
          <div class="sugg-pair">${s.pair}</div>
          <div class="sugg-reason">${s.reason}</div>
        </div>
        <div class="sugg-right">
          <div class="sugg-conf">${s.confidence}%</div>
          <div class="sugg-rr">R:R 1:${s.rr}</div>
        </div>
      </div>
      <div class="sugg-expand" id="se-${i}">
        <div class="sugg-detail-grid">
          <div class="sugg-detail">
            <div class="sugg-detail-key">Confidence</div>
            <div class="sugg-detail-val" style="color:${s.confidence>=75?'var(--green)':s.confidence>=55?'var(--gold)':'var(--red)'}">${s.confidence}%</div>
          </div>
          <div class="sugg-detail">
            <div class="sugg-detail-key">Risk:Reward</div>
            <div class="sugg-detail-val" style="color:var(--gold)">1 : ${s.rr}</div>
          </div>
          <div class="sugg-detail">
            <div class="sugg-detail-key">Entry Type</div>
            <div class="sugg-detail-val">${s.entryType}</div>
          </div>
          <div class="sugg-detail">
            <div class="sugg-detail-key">Direction</div>
            <div class="sugg-detail-val" style="color:${s.direction==='BUY'?'var(--green)':'var(--red)'}">${s.direction}</div>
          </div>
        </div>
        <div class="sugg-explanation">${s.logic}</div>
      </div>
    </div>
  `).join('');
}

function toggleSugg(i) {
  const el = document.getElementById('se-' + i);
  if (el) el.classList.toggle('open');
}

/* ══════════════════════════════════════════════════
   FUNDAMENTALS NOTES
══════════════════════════════════════════════════ */
function loadFundNotes() {
  const el = document.getElementById('fund-notes');
  if (el && S.profile?.fundNotes) el.value = S.profile.fundNotes;
}

function saveFundNotes() {
  clearTimeout(S.fundNoteTimer);
  S.fundNoteTimer = setTimeout(async () => {
    const notes = val('fund-notes');
    if (!S.user) return;
    try {
      await userRef(S.user.uid).update({ fundNotes: notes });
      S.profile.fundNotes = notes;
      const saved = document.getElementById('fund-saved');
      if (saved) {
        saved.textContent = 'Saved ✓';
        setTimeout(() => { saved.textContent = ''; }, 2000);
      }
    } catch (e) { /* non-critical */ }
  }, 1000);
}

/* ══════════════════════════════════════════════════
   CHECKLIST
══════════════════════════════════════════════════ */
function clToggle(el) {
  el.classList.toggle('checked');
  S.checkState[el.dataset.id] = el.classList.contains('checked');
  clUpdateProgress();
}

function clUpdateProgress() {
  const items   = document.querySelectorAll('.cl-item');
  const checked = document.querySelectorAll('.cl-item.checked').length;
  const pct     = items.length ? Math.round(checked / items.length * 100) : 0;
  const bar     = document.getElementById('cl-bar');
  if (bar) bar.style.width = pct + '%';
  setEl('cl-count', `${checked}/${items.length}`);
  setEl('cl-pct',   `${pct}%`);
}

function clReset() {
  document.querySelectorAll('.cl-item').forEach(i => i.classList.remove('checked'));
  S.checkState = {};
  clUpdateProgress();
}

async function clSubmit() {
  const checked = document.querySelectorAll('.cl-item.checked').length;
  const total   = document.querySelectorAll('.cl-item').length;
  if (checked < 8) {
    toast(`Complete at least 8 checks first (${checked}/${total} done)`, 'warning');
    return;
  }

  const score = Math.round(checked / total * 100);

  // Save checklist result to Firestore
  if (S.user) {
    try {
      await userSubRef(S.user.uid, 'checklists').add({
        score,
        checks:    { ...S.checkState },
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await updateStreak();
    } catch (e) { /* non-critical */ }
  }

  toast(`Checklist passed! ${score}% — proceed to trade.`, 'success');
  goPage('journal');
  setTimeout(() => jShowForm(), 400);
}

async function updateStreak() {
  if (!S.user) return;
  const today     = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const last      = S.profile?.lastActive;
  let   streak    = S.profile?.streak || 0;
  if (last === today) return;
  streak = last === yesterday ? streak + 1 : 1;
  await userRef(S.user.uid).update({ streak, lastActive: today }).catch(() => {});
  S.profile.streak    = streak;
  S.profile.lastActive = today;
  setEl('streak-num', streak);
}

/* ══════════════════════════════════════════════════
   TRADE JOURNAL
══════════════════════════════════════════════════ */
function jShowForm() {
  const el = document.getElementById('j-form-wrap');
  if (el) { el.style.display = 'block'; el.scrollIntoView({ behavior: 'smooth' }); }
}
function jHideForm() {
  const el = document.getElementById('j-form-wrap');
  if (el) el.style.display = 'none';
  jResetForm();
}

function jSetOC(type, btn) {
  document.querySelectorAll('.oc-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  S.outcome = type;
}

function jTag(el, tag) {
  el.classList.toggle('active');
  if (el.classList.contains('active')) { if (!S.tags.includes(tag)) S.tags.push(tag); }
  else S.tags = S.tags.filter(t => t !== tag);
}

function jCalcRR() {
  const e  = parseFloat(val('j-entry'));
  const sl = parseFloat(val('j-sl'));
  const tp = parseFloat(val('j-tp'));
  const el = document.getElementById('j-rr');
  if (!el) return 0;
  if (isNaN(e) || isNaN(sl) || isNaN(tp)) { el.textContent = 'R:R  — : —'; el.style.color=''; return 0; }
  const risk = Math.abs(e - sl);
  const rew  = Math.abs(tp - e);
  if (!risk) { el.textContent = 'R:R  — : —'; return 0; }
  const rr = parseFloat((rew / risk).toFixed(2));
  el.textContent = `R:R  1 : ${rr}`;
  el.style.color = rr >= 2 ? 'var(--green)' : rr >= 1 ? 'var(--gold)' : 'var(--red)';
  return rr;
}

function jSubmit() {
  if (!val('j-entry') || !val('j-sl') || !val('j-tp')) {
    toast('Fill in Entry, Stop Loss, and Take Profit.', 'warning'); return;
  }
  if (!S.outcome) { toast('Select an outcome (Win/Loss/BE).', 'warning'); return; }

  S.pendingTrade = {
    pair:      val('j-pair'),
    direction: val('j-dir'),
    entry:     parseFloat(val('j-entry')),
    sl:        parseFloat(val('j-sl')),
    tp:        parseFloat(val('j-tp')),
    rr:        jCalcRR(),
    outcome:   S.outcome,
    tags:      [...S.tags],
    notes:     val('j-notes')
  };

  document.getElementById('modal-confirm').style.display = 'flex';
}

function jCancelConfirm() {
  document.getElementById('modal-confirm').style.display = 'none';
  S.pendingTrade = null;
}

async function jConfirmSave() {
  document.getElementById('modal-confirm').style.display = 'none';
  if (!S.pendingTrade) return;
  try {
    await saveTrade(S.pendingTrade);
    toast('Trade saved! 📓', 'success');
    S.pendingTrade = null;
    jHideForm();
  } catch (e) {
    toast('Failed to save trade. Check connection.', 'error');
  }
}

function jResetForm() {
  ['j-entry','j-sl','j-tp','j-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const rr = document.getElementById('j-rr');
  if (rr) { rr.textContent = 'R:R  — : —'; rr.style.color = ''; }
  document.querySelectorAll('.oc-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.jtag').forEach(b => b.classList.remove('active'));
  S.outcome = '';
  S.tags    = [];
}

function jFilter(f, btn) {
  S.jFilter = f;
  document.querySelectorAll('.jf-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderTrades();
}

function renderTrades() {
  const el = document.getElementById('j-list');
  if (!el) return;

  let list = S.trades;
  if (S.jFilter !== 'all') list = list.filter(t => t.outcome === S.jFilter);

  setEl('j-subtitle', `${S.trades.length} trade${S.trades.length !== 1 ? 's' : ''}`);

  el.innerHTML = list.length
    ? list.map(t => tradeCardHTML(t)).join('')
    : '<div class="empty-state">No trades yet. Complete the pre-trade checklist and log your first trade!</div>';
}

function tradeCardHTML(t) {
  const d       = t.createdAt?.toDate ? t.createdAt.toDate() : new Date();
  const ds      = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const ts      = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const isUp    = t.direction === 'BUY';
  const dirCls  = isUp ? 'tc-dir-up' : 'tc-dir-dn';
  const dirSym  = isUp ? '↑ BUY' : '↓ SELL';
  const tags    = (t.tags || []).map(tag => `<span class="tc-tag">${escH(tag)}</span>`).join('');
  const notes   = t.notes ? `<div class="tc-notes">${escH(t.notes)}</div>` : '';
  const outcome = t.outcome === 'win' ? 'WIN' : t.outcome === 'loss' ? 'LOSS' : 'BE';
  return `<div class="tc">
    <div class="tc-top">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-family:var(--ff-head);font-size:19px;font-weight:800">${t.pair}</span>
        <span class="${dirCls}">${dirSym}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="tc-badge ${t.outcome}">${outcome}</span>
        <button class="tc-del" onclick="deleteTrade('${t.id}')" title="Delete">🗑</button>
      </div>
    </div>
    <div class="tc-meta">
      <span>📅 ${ds} ${ts}</span>
      <span class="tc-rr">1:${t.rr || '—'}</span>
      <span>Entry: ${t.entry}</span>
    </div>
    ${tags ? `<div class="tc-tags">${tags}</div>` : ''}
    ${notes}
  </div>`;
}

/* ══════════════════════════════════════════════════
   ANALYTICS
══════════════════════════════════════════════════ */
function renderAnalytics() {
  const t     = S.trades;
  const wins  = t.filter(x => x.outcome === 'win').length;
  const losses= t.filter(x => x.outcome === 'loss').length;
  const bes   = t.filter(x => x.outcome === 'be').length;
  const wr    = t.length ? Math.round(wins / t.length * 100) : 0;
  const avRR  = t.length ? (t.reduce((a,x) => a+(parseFloat(x.rr)||0),0)/t.length).toFixed(2) : '0.00';

  setEl('an-wins',   wins);
  setEl('an-losses', losses);
  setEl('an-rr',     avRR);
  setEl('an-wr',     wr + '%');

  buildEquityChart(t);
  buildDistChart(wins, losses, bes);
  buildWRChart(t);
  buildPairStats(t);
}

function buildEquityChart(trades) {
  const cvs = document.getElementById('eq-chart');
  if (!cvs) return;
  if (S.charts.eq) S.charts.eq.destroy();

  let eq = 0;
  const data   = [0];
  const labels = ['Start'];
  [...trades].reverse().forEach((t, i) => {
    eq += t.outcome === 'win' ? parseFloat(t.rr||1) : t.outcome === 'loss' ? -1 : 0;
    data.push(parseFloat(eq.toFixed(2)));
    labels.push('T' + (i+1));
  });

  const ctx  = cvs.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 200);
  grad.addColorStop(0, 'rgba(228,174,42,0.28)');
  grad.addColorStop(1, 'rgba(228,174,42,0)');

  S.charts.eq = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{
      data, label: 'Equity (R)',
      borderColor: '#e4ae2a', backgroundColor: grad,
      fill: true, tension: 0.4, pointRadius: 3,
      pointBackgroundColor: '#e4ae2a', pointBorderWidth: 0
    }]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#7a8eb0', font: { size: 10 } }, grid: { color: '#1c2840' } },
        y: { ticks: { color: '#7a8eb0', font: { size: 10 } }, grid: { color: '#1c2840' } }
      }
    }
  });
}

function buildDistChart(wins, losses, bes) {
  const cvs = document.getElementById('dist-chart');
  if (!cvs) return;
  if (S.charts.dist) S.charts.dist.destroy();
  S.charts.dist = new Chart(cvs.getContext('2d'), {
    type: 'doughnut',
    data: { labels: ['Wins','Losses','Breakeven'],
      datasets: [{ data: [wins||0, losses||0, bes||0],
        backgroundColor: ['#00d4a1','#ff4560','#3d9eff'],
        borderWidth: 0, hoverOffset: 4 }]
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a8eb0', font: { size: 11 } } } }
    }
  });
}

function buildWRChart(trades) {
  const cvs = document.getElementById('wr-chart');
  if (!cvs) return;
  if (S.charts.wr) S.charts.wr.destroy();
  const last10 = trades.slice(0, 10).reverse();
  let runW = 0;
  const data = [], labels = [];
  last10.forEach((t, i) => {
    if (t.outcome === 'win') runW++;
    data.push(Math.round(runW / (i+1) * 100));
    labels.push('T' + (trades.length - last10.length + i + 1));
  });
  S.charts.wr = new Chart(cvs.getContext('2d'), {
    type: 'bar',
    data: { labels: labels.length ? labels : ['—'],
      datasets: [{ label: 'Win %', data: data.length ? data : [0],
        backgroundColor: 'rgba(228,174,42,0.6)', borderRadius: 4 }]
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#7a8eb0', font: { size: 10 } }, grid: { color: '#1c2840' } },
        y: { ticks: { color: '#7a8eb0', font: { size: 10 }, callback: v => v+'%' },
          grid: { color: '#1c2840' }, min: 0, max: 100 }
      }
    }
  });
}

function buildPairStats(trades) {
  const el = document.getElementById('pair-stats');
  if (!el) return;
  const map = {};
  trades.forEach(t => {
    if (!map[t.pair]) map[t.pair] = { wins: 0, total: 0 };
    map[t.pair].total++;
    if (t.outcome === 'win') map[t.pair].wins++;
  });
  const rows = Object.entries(map).sort((a, b) => b[1].total - a[1].total);
  if (!rows.length) { el.innerHTML = '<div style="font-size:13px;color:var(--t2);padding:8px 0">No trades logged yet.</div>'; return; }
  el.innerHTML = rows.map(([pair, s]) => {
    const wr  = Math.round(s.wins / s.total * 100);
    const col = wr >= 50 ? 'var(--green)' : 'var(--red)';
    return `<div class="pair-stat-row">
      <div><div class="psr-name">${pair}</div><div class="psr-count">${s.total} trades</div></div>
      <div class="psr-wr" style="color:${col}">${wr}% WR</div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════
   PWA
══════════════════════════════════════════════════ */
let _pwaPrompt = null;

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' })
      .then(r => console.log('[TES] SW registered:', r.scope))
      .catch(e => console.warn('[TES] SW error:', e));
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _pwaPrompt = e;
    if (!localStorage.getItem('pwa_dismiss')) {
      document.getElementById('pwa-banner').style.display = 'flex';
    }
  });
  window.addEventListener('appinstalled', () => {
    document.getElementById('pwa-banner').style.display = 'none';
    toast('TES Pro installed on your home screen! ✅', 'success');
  });
  if (window.matchMedia('(display-mode: standalone)').matches) {
    document.getElementById('pwa-banner').style.display = 'none';
  }
}

function pwaInstall() {
  if (!_pwaPrompt) { toast('Use "Add to Home Screen" from your browser menu 📲', 'warning'); return; }
  _pwaPrompt.prompt();
  _pwaPrompt.userChoice.then(r => {
    if (r.outcome === 'accepted') document.getElementById('pwa-banner').style.display = 'none';
    _pwaPrompt = null;
  });
}

function pwaDismiss() {
  document.getElementById('pwa-banner').style.display = 'none';
  localStorage.setItem('pwa_dismiss', '1');
}

/* ══════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════ */
function val(id)          { return document.getElementById(id)?.value || ''; }
function setEl(id, text)  { const el = document.getElementById(id); if (el) el.textContent = text; }
function escH(s)          { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast ' + type;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3200);
}

function btnLoad(btn, loadText, restoreHTML) {
  if (!btn) return;
  if (loadText) {
    btn._orig   = btn.innerHTML;
    btn.innerHTML = loadText;
    btn.disabled  = true;
  } else {
    btn.innerHTML = restoreHTML || btn._orig || btn.innerHTML;
    btn.disabled  = false;
  }
}

function fbErrMsg(code) {
  const m = {
    'auth/user-not-found':       'No account found with this email address.',
    'auth/wrong-password':       'Incorrect password. Please try again.',
    'auth/email-already-in-use': 'This email is already registered. Sign in instead.',
    'auth/invalid-email':        'Please enter a valid email address.',
    'auth/weak-password':        'Password must be at least 6 characters.',
    'auth/too-many-requests':    'Too many attempts. Please wait a few minutes.',
    'auth/network-request-failed':'Network error. Check your internet connection.',
    'auth/invalid-credential':   'Incorrect email or password.',
    'auth/user-disabled':        'This account has been disabled. Contact support.'
  };
  return m[code] || 'Something went wrong. Please try again.';
}

/* ── Enter key support ─────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('l-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('s-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSignup(); });
  document.getElementById('j-entry')?.addEventListener('input', jCalcRR);
  document.getElementById('j-sl')?.addEventListener('input', jCalcRR);
  document.getElementById('j-tp')?.addEventListener('input', jCalcRR);
});
