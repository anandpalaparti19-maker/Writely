/**
 * Writely System Logic & Firebase Integration
 */

// Your web app's Firebase configuration
// NOTE (Security #1): Firebase client config keys are intentionally public — the SDK
// requires them to identify the project. The REAL lock is Firestore Security Rules +
// Firebase App Check (initialized below). Do NOT put server-side secrets here.
const firebaseConfig = {
  apiKey: "AIzaSyCbZu69j_2STCm7QCaJbkKfaO2S9kqjcRI",
  authDomain: "writely-304a8.firebaseapp.com",
  databaseURL: "https://writely-304a8-default-rtdb.firebaseio.com",
  projectId: "writely-304a8",
  storageBucket: "writely-304a8.firebasestorage.app",
  messagingSenderId: "552037081907",
  appId: "1:552037081907:web:5c3902b9a8bedd6e7b1446",
  measurementId: "G-TZ8EP71QXL"
};

// --- FIREBASE INITIALIZATION ---
let app;
try {
    if (typeof firebase !== 'undefined') {
        console.log("🔥 Initializing Writely Firebase...");
        app = firebase.initializeApp(firebaseConfig);
        console.log("✅ Writely Firebase Online");
    } else {
        console.warn("⚠️ Firebase SDK not detected.");
    }
} catch (e) {
    console.error("❌ Firebase Init Error:", e);
}

// --- FIX #1: FIREBASE APP CHECK ---
// App Check ensures only genuine, un-tampered instances of THIS app can call Firebase
// services — even if someone sees the config keys in source. It uses reCAPTCHA v3 for
// web clients (invisible to legitimate users). To activate:
//   1. Go to Firebase Console → App Check → Register your web app
//   2. Choose reCAPTCHA v3 and add your reCAPTCHA site key below
//   3. In Firebase Console, enforce App Check on Firestore, Storage, and Auth
// Until enforced, App Check runs in "debug" / "unenforced" mode (harmless).
(function initAppCheck() {
    try {
        if (typeof firebase === 'undefined' || !firebase.appCheck) return;
        const RECAPTCHA_SITE_KEY = '6Lc54OAsAAAAAAFvdfWOMjeM6u4mC5kdTCv1Waet'; // reCAPTCHA v3 site key
        
        // Enable debug token for local development to bypass App Check Enforcement
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
            console.log("⚠️ App Check Debug Mode Enabled. Check console for token and add it to Firebase Console.");
        }

        if (!RECAPTCHA_SITE_KEY) {
            console.warn('⚠️ App Check: reCAPTCHA site key not set. Add it to logic.js to activate App Check protection.');
            return;
        }
        firebase.appCheck().activate(
            new firebase.appCheck.ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
            true // auto-refresh token
        );
        console.log('🛡️ App Check activated');
    } catch (e) {
        console.warn('App Check init skipped:', e.message);
    }
})();



const Writely = {
    events: [],
    API_URL: (function() {
        const h = window.location.hostname;
        if (h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') || h.startsWith('10.') || h.startsWith('172.') || h === '') {
            return `http://${h || 'localhost'}:5001/api`;
        }
        return 'https://writely-55q5.onrender.com/api';
    })(),



    init: async function() {
        console.log("🌐 Writely API Context:", this.API_URL);
        
        // Connectivity check
        try {
            const res = await fetch(`${this.API_URL}/health`).catch(() => null);
            if (res && res.ok) console.log("✅ API Connectivity: OK");
            else console.warn("⚠️ API Connectivity: FAILED (Check if backend is running)");
        } catch (e) {}

        this.checkPaymentReturn();
    },

    // --- Rule 45: Account Deletion Helper ---
    deleteAccount: async function() {
        if (!confirm("🚨 ARE YOU SURE? This will permanently deactivate your account and revoke all sessions. This action cannot be undone.")) {
            return;
        }
        
        try {
            const response = await this.apiFetch('/user/delete-account', { method: 'POST' });
            const result = await response.json();
            
            if (response.ok) {
                alert("Account deleted successfully. You have been logged out.");
                await firebase.auth().signOut();
                window.location.href = '/';
            } else {
                throw new Error(result.error || "Deletion failed");
            }
        } catch (err) {
            alert("Error: " + err.message);
        }
    },


    checkPaymentReturn: async function() {
        const urlParams = new URLSearchParams(window.location.search);
        const orderId = urlParams.get('order_id');
        if (orderId && !window.paymentProcessed) {
            window.paymentProcessed = true;
            console.log("💳 Detected return from payment. Verifying order:", orderId);
            try {
                const res = await this.apiFetch('/payments/cashfree/verify', {
                    method: 'POST',
                    body: JSON.stringify({ order_id: orderId })
                });
                
                if (res.status === 'PAID' || res.status === 'SUCCESS' || res.status === 'SUCCESS_D') {
                    console.log("✅ Payment Verified Successfully!");
                    alert(`✅ Payment Successful! ₹${res.amount || ''} added to your wallet.`);
                    // Redirect to wallet to clear params and refresh balance
                    window.location.href = window.location.pathname;
                }
            } catch (err) {
                console.error("❌ Verification error:", err);
            }
        }
    },

    /**
     * Authenticated fetch helper — attaches the current user's Firebase ID token
     * to every request. Auto-redirects to login on 401.
     *
     * Usage: Writely.apiFetch('/assignments', { method: 'POST', body: JSON.stringify(x) })
     */
    apiFetch: async function(path, options = {}) {
        const url = `${this.API_URL}${path.startsWith('/') ? path : '/' + path}`;
        const headers = { ...(options.headers || {}) };

        // Attach ID token when a user is signed in
        try {
            const user = firebase.auth().currentUser;
            if (user) {
                const token = await user.getIdToken();
                headers['Authorization'] = `Bearer ${token}`;
            }
        } catch (e) { /* no user / sdk not loaded */ }

        // Set Content-Type automatically for JSON payloads (unless it's FormData)
        if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, { ...options, headers });

        if (response.status === 401) {
            console.warn('Auth expired — redirecting to login');
            if (!window.location.pathname.endsWith('index.html') && !window.location.pathname.endsWith('/')) {
                // FIX: detect which portal we're in and redirect to the correct login
                const isWriterPortal = window.location.pathname.includes('writer-mobile');
                window.location.href = isWriterPortal
                    ? '/apps/writer-mobile/index.html'
                    : '/apps/seeker-web/index.html';
            }
        }
        return response;
    },

    fetchEvents: async function() {
        try {
            const response = await this.apiFetch('/events');
            if (!response.ok) return; // silently fail for non-admins
            this.events = await response.json();
            this.updateAdminUI();
        } catch (err) { console.error('API Sync Failed:', err); }
    },

    updateAdminUI: function() {
        const tableBody = document.querySelector('tbody');
        if(!tableBody) return;
        tableBody.innerHTML = this.events.map(e => `
            <tr>
                <td>#${e.id || 'SYNC'}</td>
                <td><span class="badge badge-purple">${e.service}</span></td>
                <td>${e.description}</td>
                <td><span class="status-dot bg-success"></span> ${e.status}</td>
                <td>${e.time || 'Live'}</td>
            </tr>
        `).join('');
    },

    /**
     * Client-side password strength validation (Rule 22).
     * Enforces: 8+ chars, 1 uppercase, 2 lowercase, 1 special character.
     */
    validatePassword: function(password) {
        const errors = [];
        if (!password) {
            return { ok: false, errors: ['Password is required'] };
        }
        if (password.length < 8) {
            errors.push('At least 8 characters');
        }
        if (!/[A-Z]/.test(password)) {
            errors.push('At least 1 uppercase letter');
        }
        if ((password.match(/[a-z]/g) || []).length < 2) {
            errors.push('At least 2 lowercase letters');
        }
        if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
            errors.push('At least 1 special character');
        }
        
        return {
            ok: errors.length === 0,
            errors: errors
        };
    }
};

// =====================================================================
// 📍 LOCATION DETECTION — browser geolocation + free reverse-geocoding
// Uses OpenStreetMap Nominatim (free, no API key required, ~1 req/sec is fine).
// Swap for Google Geocoding API later if you need higher accuracy / volume.
// =====================================================================

/**
 * Get the user's current location (lat/lng + city + pincode).
 * Resolves with: { lat, lng, accuracy, city, pincode, formattedAddress }
 * Rejects if permission denied, timeout, or geolocation unsupported.
 */
Writely.detectLocation = async function() {
    if (!navigator.geolocation) {
        throw new Error('Your browser does not support location detection.');
    }

    // 1. Ask the browser for coordinates (uses GPS / Wi-Fi / cell towers)
    const coords = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
            pos => resolve({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy
            }),
            err => reject(err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    });

    // 2. Reverse-geocode via OpenStreetMap Nominatim (free, no key)
    let geo = null;
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${coords.lat}&lon=${coords.lng}&zoom=18&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en-IN' } });
        if (res.ok) geo = await res.json();
    } catch (e) {
        console.warn('Reverse geocoding failed (non-fatal):', e.message);
    }

    const addr = geo?.address || {};
    // Nominatim returns the locality at different keys depending on size
    const city = addr.city || addr.town || addr.village
              || addr.suburb || addr.state_district || addr.county || '';
    const pincode = (addr.postcode || '').replace(/\D/g, '').slice(0, 6);

    return {
        lat: coords.lat,
        lng: coords.lng,
        accuracy: coords.accuracy,
        city,
        pincode,
        formattedAddress: geo?.display_name || ''
    };
};

/**
 * Wire a "📍 Detect" button to auto-fill city / pincode / address inputs.
 * Falls back gracefully if the user denies permission.
 *
 *   Writely.attachLocationDetectButton(buttonEl, {
 *       city:    document.getElementById('city'),
 *       pincode: document.getElementById('pincode'),
 *       address: document.getElementById('deliveryAddress')  // optional
 *   });
 */
Writely.attachLocationDetectButton = function(buttonEl, fields = {}) {
    if (!buttonEl) return;
    const original = buttonEl.innerHTML;

    buttonEl.addEventListener('click', async (e) => {
        e.preventDefault();
        buttonEl.disabled = true;
        buttonEl.innerHTML = '⏳ Detecting…';

        try {
            const loc = await Writely.detectLocation();
            if (fields.city    && loc.city)             fields.city.value = loc.city;
            if (fields.pincode && loc.pincode)          fields.pincode.value = loc.pincode;
            if (fields.address && loc.formattedAddress) fields.address.value = loc.formattedAddress;

            // Trigger change events so any listeners (validation, budget calc, etc.) react
            [fields.city, fields.pincode, fields.address].forEach(el => {
                if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
            });

            buttonEl.innerHTML = '✓ Detected';
            setTimeout(() => { buttonEl.innerHTML = original; buttonEl.disabled = false; }, 1800);
        } catch (err) {
            buttonEl.innerHTML = original;
            buttonEl.disabled = false;
            const msg = err.code === 1 ? '📍 Location permission denied. Please type your city and pincode below.'
                      : err.code === 2 ? '📍 Could not determine your location. Please type manually.'
                      : err.code === 3 ? '📍 Location request timed out. Please type manually.'
                      : `Could not detect location: ${err.message || err}. Please type manually.`;
            alert(msg);
        }
    });
};

// --- AUTHENTICATION & REGISTRATION ---
window.registerUser = async function(event) {
    if (event) event.preventDefault();
    const submitBtn = document.getElementById('submitBtn');
    const fullName = document.getElementById('fullName').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const collegeEl = document.getElementById('collegeName');
    const phoneEl = document.getElementById('phoneNumber');
    const cityEl = document.getElementById('city');
    const pincodeEl = document.getElementById('pincode');
    const collegeName = collegeEl ? collegeEl.value : '';
    const phoneNumber = phoneEl ? phoneEl.value : '';
    const city = cityEl ? cityEl.value.trim() : '';
    const pincode = pincodeEl ? String(pincodeEl.value).replace(/\D/g, '').slice(0, 6) : '';
    const role = (typeof selectedRole !== 'undefined' ? selectedRole : 'seeker').toUpperCase();

    // Pincode validation — must be exactly 6 digits if provided
    if (pincodeEl && pincode.length !== 6) {
        alert('Please enter a valid 6-digit Indian pincode');
        return;
    }

    // Phone validation
    if (phoneNumber && !/^(\+91[\-\s]?)?[0]?(91)?[6789]\d{9}$/.test(phoneNumber)) {
        alert('Please enter a valid Indian phone number.');
        return;
    }

    // Password strength — 8+ chars, ≥1 uppercase, ≥2 lowercase, ≥1 special
    const pwdCheck = Writely.validatePassword(password);
    if (!pwdCheck.ok) {
        alert('Weak password:\n• ' + pwdCheck.errors.join('\n• '));
        return;
    }

    try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = "Creating account..."; }
        
        // --- FIX #22: Server-side Registration ---
        // Instead of direct Firestore write from the client, we call the API.
        const response = await Writely.apiFetch('/auth/register', {
            method: 'POST',
            body: JSON.stringify({
                email,
                password,
                fullName,
                collegeName,
                phoneNumber,
                city,
                pincode,
                role
            })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Registration failed');
        }

        // --- Direct Login (Bypassing Verification Rule) ---
        await firebase.auth().signInWithEmailAndPassword(email, password);
        
        // Redirect based on role
        if (role === 'ADMIN') {
            window.location.href = '../admin-web/admin.html';
        } else if (role === 'WRITER') {
            window.location.href = window.location.pathname.includes('seeker-web') ? '../writer-mobile/writer.html' : 'writer.html';
        } else {
            window.location.href = 'dashboard.html';
        }
    } catch (error) {
        alert("Registration Failed: " + error.message);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = "Create Account"; }
    }
};

window.loginUser = async function(event) {
    if (event) event.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const submitBtn = document.querySelector('button[type="submit"]');

    try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = "Signing in..."; }
        const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
        const user = userCredential.user;

        // --- Email Verification Check Disabled for Onboarding Smoothness ---
        // if (!user.emailVerified) { ... }

        const userDoc = await firebase.firestore().collection('users').doc(user.uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        
        if (userData.role === 'ADMIN') {
            window.location.href = '../admin-web/admin.html';
        } else if (userData.role === 'WRITER') {
            window.location.href = window.location.pathname.includes('seeker-web') ? '../writer-mobile/writer.html' : 'writer.html';
        } else {
            window.location.href = 'dashboard.html';
        }
    } catch (error) {
        alert("Login Failed: " + error.message);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = "Sign In"; }
    }
};

// --- PROFILE & SETTINGS ---
Writely.getUserProfile = async function() {
    return new Promise((resolve) => {
        firebase.auth().onAuthStateChanged(async (user) => {
            if (user) {
                const doc = await firebase.firestore().collection("users").doc(user.uid).get();
                resolve(doc.exists ? doc.data() : null);
            } else {
                resolve(null);
            }
        });
    });
};

Writely.updateUserProfile = async function(data) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("No user logged in");
    await firebase.firestore().collection("users").doc(user.uid).update({
        ...data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
};

Writely.uploadProfilePhoto = async function(file) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("No user logged in");

    const storageRef = firebase.storage().ref();
    const photoRef = storageRef.child("avatars/" + user.uid + "." + file.name.split(".").pop());
    
    const snapshot = await photoRef.put(file);
    const photoUrl = await snapshot.ref.getDownloadURL();

    await firebase.firestore().collection("users").doc(user.uid).update({
        avatarUrl: photoUrl,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    return photoUrl;
};

// Get a single page of jobs (default 20). Returns just the array for backward compat.
// For pagination, use getJobFeedPage({ after: '<id>' }) → { jobs, nextCursor }.
Writely.getJobFeed = async function(opts = {}) {
    const page = await this.getJobFeedPage(opts);
    return page.jobs;
};

Writely.getJobFeedPage = async function({ limit = 20, after = null, scope = 'all', pincode = '', city = '' } = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (after)   params.set('after',   after);
    if (scope)   params.set('scope',   scope);
    if (pincode) params.set('pincode', pincode);
    if (city)    params.set('city',    city);
    try {
        const response = await this.apiFetch(`/assignments?${params.toString()}`);
        if (!response.ok) throw new Error("Failed to fetch jobs");
        const data = await response.json();
        // Backward compat: old endpoint returned a bare array
        if (Array.isArray(data)) return { jobs: data, nextCursor: null };
        return data; // { jobs, nextCursor }
    } catch (err) {
        console.error("Job Feed Error:", err);
        return { jobs: [], nextCursor: null };
    }
};


/**
 * Download an attachment the seeker uploaded with the assignment.
 * Only works if the current user is the seeker or the hired writer.
 *
 * Opens a new tab with a short-lived (15 min) signed URL and forces a download
 * with the original filename.
 */
Writely.downloadAttachment = async function(assignmentId, index) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Please sign in to download');

    // We can't set Authorization on a plain <a> — so fetch with auth → follow redirect → open
    const res = await this.apiFetch(`/assignments/${encodeURIComponent(assignmentId)}/attachments/${index}/download`);
    if (!res.ok) {
        const msg = await res.text().catch(() => 'Download failed');
        throw new Error(msg || `Download failed (${res.status})`);
    }
    // Server returns a 302 redirect to the signed Storage URL; fetch follows it automatically,
    // so res.url is now the final signed URL. Open it to trigger the download.
    window.open(res.url, '_blank');
};

Writely.submitBid = async function(assignmentId, bidData) {
    try {
        const response = await this.apiFetch(`/assignments/${assignmentId}/bid`, {
            method: 'POST',
            body: JSON.stringify(bidData)
        });
        return await response.json();
    } catch (err) {
        console.error("Bid Error:", err);
        throw err;
    }
};

// --- FIX #3: writerId is NOT sent from the client.
// The backend derives the writer's identity from the verified Firebase ID token (req.user.uid).
// Sending writerId from the client would allow any user to impersonate another writer.
Writely.assignWriter = async function(assignmentId) {
    try {
        const response = await this.apiFetch(`/assignments/${assignmentId}/assign`, {
            method: 'POST',
            body: JSON.stringify({}) // writerId resolved server-side from auth token
        });
        return await response.json();
    } catch (err) {
        console.error("Assign Error:", err);
        throw err;
    }
};

Writely.createAssignment = async function(formData) {
    try {
        const response = await this.apiFetch('/assignments', {
            method: 'POST',
            body: formData
        });
        return await response.json();
    } catch (err) {
        console.error("Post Error:", err);
        throw err;
    }
};

// --- CASHFREE PAYMENT HELPERS ---
// Internal: opens the Cashfree.js drop-in checkout for a given plan, then verifies on the server.
// `planType` is the source of truth — backend looks up the price (or validates the range for top-ups).
// For WALLET_TOPUP, pass `amount` (₹100–₹50,000); for fixed plans, `amount` is ignored.
Writely._cashfreePay = async function({ planType, amount }) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("Please login first");

    if (typeof Cashfree !== 'function') {
        throw new Error("Cashfree SDK not loaded. Make sure <script src='https://sdk.cashfree.com/js/v3/cashfree.js'> is included on this page.");
    }

    // 1. Get config (mode = sandbox/production)
    const configRes = await this.apiFetch('/payments/cashfree/config');
    if (!configRes.ok) throw new Error("Could not load payment config");
    const { mode } = await configRes.json();

    // 2. Create order on backend (server resolves the actual amount from planType)
    const orderRes = await this.apiFetch('/payments/cashfree/create-order', {
        method: 'POST',
        body: JSON.stringify({ 
            planType, 
            amount,
            returnUrl: window.location.href // Pass returnUrl to backend too
        })
    });
    const order = await orderRes.json();
    if (!orderRes.ok || !order.payment_session_id) {
        throw new Error(order.error || "Failed to initialize payment");
    }

    // 3. Open Cashfree drop-in checkout
    // SDK v3 documentation: https://docs.cashfree.com/docs/js-checkout
    const cashfree = Cashfree({ mode: mode || 'sandbox' });
    
    console.log("💳 Opening Cashfree Checkout for:", order.order_id);
    
    const result = await cashfree.checkout({
        paymentSessionId: order.payment_session_id,
        returnUrl: window.location.href // Redirect back to this page after payment
    });

    // NOTE: For redirect-based payments (Banks, some UPI apps), the code below 
    // will NOT run as the page redirects. Verification must happen on page load
    // or via the Cashfree webhook.
    if (result?.error) {
        console.error("❌ Cashfree Error:", result.error);
        throw new Error(result.error.message || "Payment cancelled or failed");
    }

    // 4. Server-side verify by querying Cashfree directly.
    console.log("🔍 Verifying payment for:", order.order_id);
    const verifyRes = await this.apiFetch('/payments/cashfree/verify', {
        method: 'POST',
        body: JSON.stringify({ order_id: order.order_id })
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok) throw new Error(verifyData.error || "Payment verification failed");

    console.log("✅ Payment Verified:", verifyData);
    return verifyData;
};

// Generic plan purchase helper — works for any subscription plan.
//   planType: 'SEEKER_PASS' | 'WRITELY_PLUS' | 'WRITELY_PRO' | 'WRITER_ZERO_FEE' | 'WRITER_PRO' | 'WRITER_ELITE'
Writely.buyPlan = async function(planType) {
    const data = await this._cashfreePay({ planType });
    return data.expiresAt ? new Date(data.expiresAt) : null;
};

// Convenience wrappers (kept for backward compatibility with existing UI)
Writely.buySubscription       = function() { return this.buyPlan('SEEKER_PASS'); };
Writely.buyWriterSubscription = function() { return this.buyPlan('WRITER_ZERO_FEE'); };
Writely.buyWritelyPlus        = function() { return this.buyPlan('WRITELY_PLUS'); };
Writely.buyWritelyPro         = function() { return this.buyPlan('WRITELY_PRO'); };
Writely.buyWriterPro          = function() { return this.buyPlan('WRITER_PRO'); };
Writely.buyWriterElite        = function() { return this.buyPlan('WRITER_ELITE'); };

// Get an authoritative fee preview from the backend (matches what user will actually pay).
Writely.getFeePreview = async function(budget) {
    const res = await this.apiFetch(`/fees/preview?budget=${encodeURIComponent(budget)}`);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not load fee preview');
    }
    return res.json(); // { budget, platformFee, total, subscriptionActive, subscriptionType }
};

// Top up the seeker's wallet with INR via Cashfree. Range: ₹100 – ₹50,000.
Writely.topUpWallet = async function(amount) {
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 100 || numAmount > 50000) {
        throw new Error("Amount must be between ₹100 and ₹50,000");
    }
    const data = await this._cashfreePay({ planType: 'WALLET_TOPUP', amount: numAmount });
    return data.amountAdded || numAmount;
};

// =====================================================================
// MESSAGING — chat helpers (real-time via Firestore onSnapshot)
// Server enforces participation and pushes notification to the other side.
// =====================================================================
Writely.sendMessage = async function(assignmentId, text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error("Message cannot be empty");
    const res = await this.apiFetch(`/assignments/${assignmentId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: trimmed })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send message');
    return data;
};

/**
 * Subscribe to real-time messages for an assignment.
 *
 *   const unsub = Writely.subscribeToMessages(assignmentId, (messages) => { ... });
 *   // later: unsub() to stop listening
 */
Writely.subscribeToMessages = function(assignmentId, callback) {
    if (!assignmentId || typeof callback !== 'function') {
        throw new Error("subscribeToMessages requires (assignmentId, callback)");
    }
    return firebase.firestore().collection('messages')
        .where('assignmentId', '==', assignmentId)
        .orderBy('timestamp', 'asc')
        .limit(200)
        .onSnapshot(snap => {
            const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            callback(messages);
        }, err => {
            console.warn('Messages listener error:', err.message);
            callback([], err);
        });
};

// =====================================================================
// REVIEWS — submit a 5-star + comment review after completion
// =====================================================================

/**
 * Open a review modal for an assignment.
 *   Writely.reviews.prompt(assignmentId).then(result => ...)
 * Resolves with the submitted review or null if cancelled.
 */
Writely.reviews = (function() {
    let modalEl = null;

    function injectStyles() {
        if (document.getElementById('writely-review-styles')) return;
        const s = document.createElement('style');
        s.id = 'writely-review-styles';
        s.textContent = `
            .wr-review-overlay {
                position: fixed; inset: 0; z-index: 10000;
                background: rgba(15, 23, 42, .6);
                display: flex; align-items: center; justify-content: center;
                padding: 20px; backdrop-filter: blur(4px);
            }
            .wr-review-card {
                background: white; width: min(440px, 100%);
                border-radius: 20px; padding: 32px;
                box-shadow: 0 24px 64px rgba(0,0,0,.2);
                animation: wrReviewIn .2s ease;
            }
            @keyframes wrReviewIn { from { opacity:0; transform: scale(.95); } to { opacity:1; transform: scale(1); } }
            .wr-review-card h3 { margin: 0 0 8px; font-size: 22px; font-weight: 800; }
            .wr-review-card .wr-review-sub { color: #64748b; font-size: 14px; margin-bottom: 24px; }
            .wr-stars { display: flex; gap: 8px; justify-content: center; margin: 8px 0 24px; }
            .wr-star {
                width: 40px; height: 40px; cursor: pointer;
                color: #e5e7eb; transition: transform .15s ease, color .15s ease;
                display: inline-flex; align-items: center; justify-content: center;
                font-size: 32px; line-height: 1;
            }
            .wr-star:hover { transform: scale(1.15); }
            .wr-star.filled { color: #fbbf24; }
            .wr-review-textarea {
                width: 100%; min-height: 90px; padding: 12px;
                border: 1px solid #e5e7eb; border-radius: 12px;
                font: inherit; font-size: 14px; resize: vertical;
                outline: none; transition: border-color .15s ease;
            }
            .wr-review-textarea:focus { border-color: #6366f1; }
            .wr-review-actions { display: flex; gap: 12px; margin-top: 20px; justify-content: flex-end; }
            .wr-review-btn {
                padding: 10px 20px; border-radius: 10px; font-weight: 600;
                font-size: 14px; cursor: pointer; border: none;
            }
            .wr-review-btn.primary { background: #6366f1; color: white; }
            .wr-review-btn.primary:hover { background: #4f46e5; }
            .wr-review-btn.primary:disabled { opacity: .5; cursor: not-allowed; }
            .wr-review-btn.ghost { background: transparent; color: #64748b; }
            .wr-review-btn.ghost:hover { background: #f1f5f9; }
        `;
        document.head.appendChild(s);
    }

    function close() {
        if (modalEl) { modalEl.remove(); modalEl = null; }
    }

    function prompt(assignmentId, { title = 'Leave a review' } = {}) {
        injectStyles();
        close(); // Ensure only one modal at a time

        return new Promise((resolve) => {
            let rating = 0;

            modalEl = document.createElement('div');
            modalEl.className = 'wr-review-overlay';
            modalEl.innerHTML = `
                <div class="wr-review-card" role="dialog" aria-modal="true">
                    <h3>${title}</h3>
                    <p class="wr-review-sub">Help others by sharing your experience. Your review is public.</p>
                    <div class="wr-stars" id="wrStars">
                        ${[1,2,3,4,5].map(i => `<span class="wr-star" data-val="${i}">★</span>`).join('')}
                    </div>
                    <textarea class="wr-review-textarea" id="wrComment" placeholder="Optional: what stood out? (max 500 chars)" maxlength="500"></textarea>
                    <div class="wr-review-actions">
                        <button class="wr-review-btn ghost" id="wrCancel" type="button">Cancel</button>
                        <button class="wr-review-btn primary" id="wrSubmit" type="button" disabled>Submit Review</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modalEl);

            const stars = modalEl.querySelectorAll('.wr-star');
            const submitBtn = modalEl.querySelector('#wrSubmit');

            function updateStars() {
                stars.forEach(s => {
                    s.classList.toggle('filled', Number(s.dataset.val) <= rating);
                });
                submitBtn.disabled = rating === 0;
            }

            stars.forEach(star => {
                star.addEventListener('click', () => {
                    rating = Number(star.dataset.val);
                    updateStars();
                });
            });

            modalEl.querySelector('#wrCancel').addEventListener('click', () => {
                close();
                resolve(null);
            });

            // Close on overlay click (but not card click)
            modalEl.addEventListener('click', (e) => {
                if (e.target === modalEl) {
                    close();
                    resolve(null);
                }
            });

            submitBtn.addEventListener('click', async () => {
                if (rating === 0) return;
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting…';
                try {
                    const comment = modalEl.querySelector('#wrComment').value;
                    const result = await Writely.submitReview(assignmentId, rating, comment);
                    close();
                    resolve(result);
                } catch (err) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit Review';
                    alert('Could not submit review: ' + (err.message || err));
                }
            });
        });
    }

    return { prompt, close };
})();

Writely.submitReview = async function(assignmentId, rating, comment = '') {
    const numRating = Number(rating);
    if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
        throw new Error("Rating must be 1–5");
    }
    const res = await this.apiFetch(`/assignments/${assignmentId}/review`, {
        method: 'POST',
        body: JSON.stringify({ rating: numRating, comment })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit review');
    return data;
};

// Subscribe to reviews for a specific user (e.g., to show on a writer's profile).
Writely.subscribeToUserReviews = function(userId, callback) {
    return firebase.firestore().collection('reviews')
        .where('revieweeId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .onSnapshot(snap => {
            const reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            callback(reviews);
        }, err => {
            console.warn('Reviews listener error:', err.message);
            callback([], err);
        });
};

Writely.logout = async function() {
    if(confirm("Are you sure you want to logout?")) {
        try {
            await firebase.auth().signOut();
            window.location.href = 'index.html';
        } catch (err) {
            console.error("Logout failed:", err);
        }
    }
};

// =====================================================================
// NOTIFICATIONS — auto-injected bell + real-time listener
// Works on any page that loads logic.js. No HTML changes needed.
// =====================================================================
Writely.notifications = (function() {
    let unsubscribe = null;
    let cached = [];
    let bellEl = null;
    let badgeEl = null;
    let panelEl = null;
    let injected = false;

    // Don't show notifications on auth/index pages — only after login
    function shouldShowOnThisPage() {
        const p = window.location.pathname.toLowerCase();
        if (p.endsWith('/') || p.endsWith('/index.html') || p === '') return false;
        return true;
    }

    function injectStyles() {
        if (document.getElementById('writely-notif-styles')) return;
        const style = document.createElement('style');
        style.id = 'writely-notif-styles';
        style.textContent = `
            .wr-notif-bell {
                position: fixed; top: 18px; right: 18px; z-index: 9998;
                width: 44px; height: 44px; border-radius: 50%;
                background: white; border: 1px solid var(--border, #e5e7eb);
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.06);
                transition: transform .15s ease, box-shadow .15s ease;
            }
            .wr-notif-bell:hover { transform: scale(1.05); box-shadow: 0 6px 16px rgba(0,0,0,.1); }
            .wr-notif-bell svg { width: 20px; height: 20px; color: #1f2937; }
            .wr-notif-badge {
                position: absolute; top: -4px; right: -4px;
                background: #ef4444; color: white;
                min-width: 18px; height: 18px; padding: 0 5px;
                border-radius: 9px; font-size: 10px; font-weight: 700;
                display: none; align-items: center; justify-content: center;
                box-shadow: 0 0 0 2px white;
            }
            .wr-notif-badge.show { display: flex; }
            .wr-notif-panel {
                position: fixed; top: 70px; right: 18px; z-index: 9999;
                width: min(360px, calc(100vw - 36px));
                max-height: 70vh; overflow-y: auto;
                background: white; border-radius: 16px;
                border: 1px solid var(--border, #e5e7eb);
                box-shadow: 0 12px 40px rgba(0,0,0,.15);
                display: none;
            }
            .wr-notif-panel.open { display: block; }
            .wr-notif-header {
                padding: 16px 20px; border-bottom: 1px solid var(--border, #f3f4f6);
                display: flex; justify-content: space-between; align-items: center;
                position: sticky; top: 0; background: white; border-radius: 16px 16px 0 0;
            }
            .wr-notif-header h4 { margin: 0; font-size: 15px; font-weight: 700; }
            .wr-notif-mark-read {
                background: none; border: none; color: #6366f1;
                font-size: 12px; cursor: pointer; font-weight: 600;
            }
            .wr-notif-list { list-style: none; margin: 0; padding: 0; }
            .wr-notif-item {
                padding: 14px 20px; border-bottom: 1px solid #f3f4f6;
                cursor: pointer; transition: background .15s ease;
                display: block; color: inherit; text-decoration: none;
            }
            .wr-notif-item:hover { background: #f9fafb; }
            .wr-notif-item.unread { background: #eef2ff; }
            .wr-notif-item.unread:hover { background: #e0e7ff; }
            .wr-notif-title { font-weight: 600; font-size: 13px; color: #111827; margin-bottom: 4px; }
            .wr-notif-body { font-size: 12px; color: #6b7280; line-height: 1.4; }
            .wr-notif-time { font-size: 11px; color: #9ca3af; margin-top: 6px; }
            .wr-notif-empty {
                padding: 40px 20px; text-align: center; color: #9ca3af; font-size: 13px;
            }
        `;
        document.head.appendChild(style);
    }

    function injectUI() {
        if (injected) return;
        injectStyles();

        // Bell
        bellEl = document.createElement('button');
        bellEl.className = 'wr-notif-bell';
        bellEl.setAttribute('aria-label', 'Notifications');
        bellEl.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
            </svg>
            <span class="wr-notif-badge" id="wr-notif-badge">0</span>
        `;
        document.body.appendChild(bellEl);
        badgeEl = bellEl.querySelector('.wr-notif-badge');

        // Panel
        panelEl = document.createElement('div');
        panelEl.className = 'wr-notif-panel';
        panelEl.innerHTML = `
            <div class="wr-notif-header">
                <h4>Notifications</h4>
                <button class="wr-notif-mark-read" type="button">Mark all read</button>
            </div>
            <ul class="wr-notif-list"><li class="wr-notif-empty">No notifications yet.</li></ul>
        `;
        document.body.appendChild(panelEl);

        // Toggle on bell click
        bellEl.addEventListener('click', (e) => {
            e.stopPropagation();
            panelEl.classList.toggle('open');
        });
        // Close on outside click
        document.addEventListener('click', (e) => {
            if (panelEl.classList.contains('open') && !panelEl.contains(e.target) && !bellEl.contains(e.target)) {
                panelEl.classList.remove('open');
            }
        });
        // Mark all read
        panelEl.querySelector('.wr-notif-mark-read').addEventListener('click', markAllRead);

        injected = true;
    }

    function timeAgo(date) {
        if (!date) return '';
        const s = Math.floor((Date.now() - date.getTime()) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }

    function escapeHtml(str) {
        return String(str || '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function render() {
        if (!panelEl) return;
        const list = panelEl.querySelector('.wr-notif-list');
        const unreadCount = cached.filter(n => !n.read).length;

        // Update badge
        if (badgeEl) {
            badgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
            badgeEl.classList.toggle('show', unreadCount > 0);
        }

        if (cached.length === 0) {
            list.innerHTML = '<li class="wr-notif-empty">No notifications yet.</li>';
            return;
        }

        list.innerHTML = cached.map(n => {
            const created = n.createdAt?.toDate ? n.createdAt.toDate() : null;
            return `
                <a class="wr-notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" href="${n.link || '#'}">
                    <div class="wr-notif-title">${escapeHtml(n.title)}</div>
                    <div class="wr-notif-body">${escapeHtml(n.body)}</div>
                    <div class="wr-notif-time">${timeAgo(created)}</div>
                </a>
            `;
        }).join('');

        // Mark single as read on click
        list.querySelectorAll('.wr-notif-item').forEach(el => {
            el.addEventListener('click', async () => {
                const id = el.dataset.id;
                const user = firebase.auth().currentUser;
                if (!id || !user) return;
                try {
                    await firebase.firestore()
                        .collection('users').doc(user.uid)
                        .collection('notifications').doc(id)
                        .update({ read: true, readAt: firebase.firestore.FieldValue.serverTimestamp() });
                } catch (e) { /* ignore */ }
            });
        });
    }

    async function markAllRead() {
        const user = firebase.auth().currentUser;
        if (!user) return;
        const unread = cached.filter(n => !n.read);
        if (unread.length === 0) return;

        const batch = firebase.firestore().batch();
        unread.forEach(n => {
            const ref = firebase.firestore()
                .collection('users').doc(user.uid)
                .collection('notifications').doc(n.id);
            batch.update(ref, { read: true, readAt: firebase.firestore.FieldValue.serverTimestamp() });
        });
        try { await batch.commit(); } catch (e) { console.warn('markAllRead failed:', e.message); }
    }

    function start(uid) {
        if (unsubscribe) unsubscribe();
        injectUI();
        unsubscribe = firebase.firestore()
            .collection('users').doc(uid)
            .collection('notifications')
            .orderBy('createdAt', 'desc')
            .limit(20)
            .onSnapshot(snap => {
                cached = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                render();
            }, err => {
                console.warn('Notifications listener error:', err.message);
            });
    }

    function stop() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        cached = [];
        if (bellEl) bellEl.remove();
        if (panelEl) panelEl.remove();
        bellEl = panelEl = badgeEl = null;
        injected = false;
    }

    // Auto-bootstrap once Firebase auth resolves
    function autoBootstrap() {
        if (typeof firebase === 'undefined' || !firebase.auth) return;
        if (!shouldShowOnThisPage()) return;
        firebase.auth().onAuthStateChanged(user => {
            if (user) start(user.uid);
            else stop();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            autoBootstrap();
            Writely.init();
        });
    } else {
        autoBootstrap();
        Writely.init();
    }

    return { start, stop, markAllRead };
})();

// --- AI SUPPORT BOT LOGIC ---
const chatHistory = [];

window.toggleSupport = function() {
    const chatWin = document.getElementById('supportWindow');
    const trigger = document.getElementById('aiSupport');
    if (!chatWin) return;
    
    const isVisible = chatWin.style.display === 'flex';
    chatWin.style.display = isVisible ? 'none' : 'flex';
    if (trigger) trigger.classList.toggle('active', !isVisible);

    if (!isVisible && document.getElementById('aiMessages').children.length === 0) {
        addBotMessage("Hi! I'm the Writely Concierge. How can I help you today?");
    }
};

function addBotMessage(text) {
    const container = document.getElementById('aiMessages');
    const msg = document.createElement('div');
    msg.className = 'msg msg-bot';
    msg.innerText = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    chatHistory.push({ role: 'model', text });
}

function addUserMessage(text) {
    const container = document.getElementById('aiMessages');
    const msg = document.createElement('div');
    msg.className = 'msg msg-user';
    msg.innerText = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    chatHistory.push({ role: 'user', text });
}

window.askAI = async function() {
    const input = document.getElementById('supportInput');
    const text = input.value.trim();
    if (!text) return;

    addUserMessage(text);
    input.value = '';
    
    const typingMsg = document.createElement('div');
    typingMsg.className = 'msg msg-bot';
    typingMsg.innerText = '...';
    document.getElementById('aiMessages').appendChild(typingMsg);

    try {
        const response = await Writely.apiFetch('/support/chat', {
            method: 'POST',
            body: JSON.stringify({ message: text, history: chatHistory.slice(-6) })
        });
        const data = await response.json();
        typingMsg.remove();
        addBotMessage(data.text || data.error || "I encountered an error.");
    } catch (err) {
        if (typingMsg) typingMsg.remove();
        addBotMessage("Sorry, I'm having trouble connecting. Is the API running?");
    }
};

// Handle Enter Key
document.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'supportInput') {
        askAI();
    }
});

// --- REAL-TIME NOTIFICATIONS ---
Writely.initNotifications = function(userId) {
    if (!userId) return;
    
    // Request permission for browser notifications
    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }

    // Listen for project status changes (Seeker/Writer)
    firebase.firestore().collection('assignments')
        .where('seekerId', '==', userId)
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                if (change.type === 'modified') {
                    const job = change.doc.data();
                    Writely.showToast(`Project Update: "${job.title}" is now ${job.status}`);
                    Writely.pushNotify(`Project Update`, `"${job.title}" is now ${job.status}`);
                }
            });
        });

    // Listen for new messages
    firebase.firestore().collection('messages')
        .where('receiverId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                if (change.type === 'added') {
                    const msg = change.doc.data();
                    // Only notify if message is recent (within 10s) to avoid old alerts
                    if (msg.createdAt && (Date.now() - msg.createdAt.toMillis() < 10000)) {
                        Writely.showToast(`New Message: ${msg.text.substring(0, 30)}...`);
                        Writely.pushNotify(`New Message from Writely`, msg.text);
                    }
                }
            });
        });
};

Writely.showToast = function(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
        background: var(--ink-purple); color: white; padding: 12px 24px;
        border-radius: 50px; z-index: 9999; font-weight: 600; font-size: 14px;
        box-shadow: 0 10px 25px rgba(109, 40, 217, 0.3); animation: slideUp 0.3s ease-out;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

Writely.pushNotify = function(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/favicon.ico' });
    }
};

// --- PASSWORD POLICY ---
// Rules: min 8 chars, ≥1 uppercase, ≥2 lowercase, ≥1 number, ≥1 special character.
Writely.validatePassword = function(pwd) {
    const errors = [];
    const s = String(pwd || '');
    if (s.length < 8) errors.push('Must be at least 8 characters long');
    if (!/[A-Z]/.test(s)) errors.push('Must contain at least 1 uppercase letter');
    const lower = (s.match(/[a-z]/g) || []).length;
    if (lower < 2) errors.push('Must contain at least 2 lowercase letters');
    if (!/[0-9]/.test(s)) errors.push('Must contain at least 1 number');
    if (!/[^A-Za-z0-9]/.test(s)) errors.push('Must contain at least 1 special character (e.g. !@#$%^&*)');
    return { ok: errors.length === 0, errors };
};

// Attach a live strength meter under any password <input>.
// Usage (optional): Writely.attachPasswordMeter(document.getElementById('password'));
Writely.attachPasswordMeter = function(input) {
    if (!input || input.dataset.meterAttached) return;
    input.dataset.meterAttached = '1';

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:6px; font-size:12px; line-height:1.5; color:#64748b;';
    hint.innerHTML = `
        <div data-rule="len">• At least 8 characters</div>
        <div data-rule="upper">• 1 uppercase letter</div>
        <div data-rule="lower">• 2 lowercase letters</div>
        <div data-rule="number">• 1 number</div>
        <div data-rule="special">• 1 special character</div>`;
    input.insertAdjacentElement('afterend', hint);

    const update = () => {
        const s = input.value;
        const checks = {
            len: s.length >= 8,
            upper: /[A-Z]/.test(s),
            lower: (s.match(/[a-z]/g) || []).length >= 2,
            number: /[0-9]/.test(s),
            special: /[^A-Za-z0-9]/.test(s)
        };
        Object.entries(checks).forEach(([k, pass]) => {
            const row = hint.querySelector(`[data-rule="${k}"]`);
            if (row) {
                row.style.color = pass ? '#10b981' : '#64748b';
                row.textContent = (pass ? '✓ ' : '• ') + row.textContent.replace(/^[•✓]\s*/, '');
            }
        });
    };
    input.addEventListener('input', update);
    update();
};

// Auto-attach the meter ONLY on registration / change-password screens
// (not on login — confusing to show rules on a sign-in form).
document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('password');
    if (!el || el.type !== 'password') return;

    // Heuristic: enable the meter only when one of these is true:
    //   1. The input has data-strength="true"
    //   2. The page URL points at register / signup / change-password
    //   3. There's a #registerForm or [data-form="register"] on the page
    const isRegisterPage = /register|signup|change-password/i.test(location.pathname);
    const hasRegisterForm = !!document.getElementById('registerForm') || !!document.querySelector('[data-form="register"]');
    const optedIn = el.dataset.strength === 'true';

    if (isRegisterPage || hasRegisterForm || optedIn) {
        Writely.attachPasswordMeter(el);
    }
});

// Global Exposure
window.logout = Writely.logout;
Writely.registerUser = window.registerUser;
Writely.loginUser = window.loginUser;
window.Writely = Writely;

// ============================================
// 📱 Mobile Navigation — Auto-inject across all pages
// ============================================
(function injectMobileNav() {
    function setupTopNav() {
        document.querySelectorAll('nav').forEach(nav => {
            const links = nav.querySelector('.nav-links');
            if (!links) return;
            if (nav.querySelector('.hamburger-btn')) return;

            const btn = document.createElement('button');
            btn.className = 'hamburger-btn';
            btn.setAttribute('aria-label', 'Toggle menu');
            btn.setAttribute('aria-expanded', 'false');
            btn.innerHTML = '<span></span><span></span><span></span>';

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = links.classList.toggle('open');
                btn.classList.toggle('active', isOpen);
                btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            });

            links.addEventListener('click', (e) => {
                if (e.target.tagName === 'A') {
                    links.classList.remove('open');
                    btn.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');
                }
            });
            document.addEventListener('click', (e) => {
                if (!nav.contains(e.target) && links.classList.contains('open')) {
                    links.classList.remove('open');
                    btn.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');
                }
            });

            const container = nav.querySelector('.container') || nav;
            container.appendChild(btn);
        });
    }

    function setupDashboardSidebar() {
        // Matches sidebars across ALL dashboard pages: seeker, writer, admin, tenant
        const sidebar = document.querySelector(
            'aside.sidebar, .dashboard-sidebar, .admin-sidebar, .tenant-sidebar, .onboarding-sidebar'
        );
        if (!sidebar) return;
        // Main content area — try common class names in order of specificity
        const main = document.querySelector(
            '.main-content, main.main-content, .admin-content, .onboarding-main'
        );
        if (!main) return;
        if (document.querySelector('.dashboard-mobile-topbar')) return;

        // Top bar with menu button (mobile only — CSS hides on desktop)
        const topbar = document.createElement('div');
        topbar.className = 'dashboard-mobile-topbar';
        topbar.innerHTML = `
            <button class="sidebar-toggle-btn" aria-label="Open menu" aria-expanded="false">
                <span></span><span></span><span></span>
            </button>
            <div class="dashboard-mobile-title">Writely</div>
        `;
        main.insertBefore(topbar, main.firstChild);

        // Backdrop overlay
        const backdrop = document.createElement('div');
        backdrop.className = 'sidebar-backdrop';
        document.body.appendChild(backdrop);

        const toggleBtn = topbar.querySelector('.sidebar-toggle-btn');
        const closeSidebar = () => {
            sidebar.classList.remove('open');
            backdrop.classList.remove('open');
            toggleBtn.classList.remove('active');
            toggleBtn.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        };
        const openSidebar = () => {
            sidebar.classList.add('open');
            backdrop.classList.add('open');
            toggleBtn.classList.add('active');
            toggleBtn.setAttribute('aria-expanded', 'true');
            document.body.style.overflow = 'hidden';
        };

        toggleBtn.addEventListener('click', () => {
            if (sidebar.classList.contains('open')) closeSidebar();
            else openSidebar();
        });
        backdrop.addEventListener('click', closeSidebar);
        sidebar.addEventListener('click', (e) => {
            // Close sidebar when user taps any link OR nav-item (tenant_admin uses divs)
            const clickable = e.target.closest('a, .nav-item, .menu-item, .admin-menu-item');
            if (clickable && sidebar.contains(clickable)) closeSidebar();
        });
        // Close on resize back to desktop
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) closeSidebar();
        });
    }

    function getLogoSrc() {
        // Compute path to logo.png relative to current page depth.
        const scriptEl = document.querySelector('script[src*="shared/utils/logic.js"]');
        if (scriptEl) {
            return scriptEl.getAttribute('src').replace(/utils\/logic\.js.*$/, 'assets/logo.png');
        }
        return '/shared/assets/logo.png';
    }

    function replaceLogoMarks() {
        const logoSrc = getLogoSrc();
        document.querySelectorAll('.logo-mark').forEach(mark => {
            mark.innerHTML = `<img src="${logoSrc}" alt="Seekers & Writers" style="width:100%;height:100%;object-fit:cover;object-position:center 38%;transform:scale(2);" />`;
        });
    }

    function setFavicon() {
        const logoSrc = getLogoSrc();
        // Remove any existing favicons to avoid duplicates
        document.querySelectorAll('link[rel*="icon"]').forEach(el => el.remove());
        // Add the new one
        const link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/png';
        link.href = logoSrc;
        document.head.appendChild(link);
        // Also Apple touch icon for iOS bookmarks/PWA
        const apple = document.createElement('link');
        apple.rel = 'apple-touch-icon';
        apple.href = logoSrc;
        document.head.appendChild(apple);
    }

    function setup() {
        setFavicon();
        replaceLogoMarks();
        setupTopNav();
        setupDashboardSidebar();
        injectPwaTags();
        registerServiceWorker();
    }

    // --- PWA: inject manifest + theme tags if missing ---
    function injectPwaTags() {
        try {
            const head = document.head;
            if (!head) return;
            if (!head.querySelector('link[rel="manifest"]')) {
                const m = document.createElement('link');
                m.rel = 'manifest';
                m.href = '/manifest.webmanifest';
                head.appendChild(m);
            }
            if (!head.querySelector('meta[name="theme-color"]')) {
                const t = document.createElement('meta');
                t.name = 'theme-color';
                t.content = '#6366f1';
                head.appendChild(t);
            }
            if (!head.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
                const a = document.createElement('meta');
                a.name = 'apple-mobile-web-app-capable';
                a.content = 'yes';
                head.appendChild(a);
            }
        } catch (_) { /* noop */ }
    }

    // --- PWA: register the service worker (skip on localhost over HTTP, file://, and inside iframes) ---
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (window.top !== window.self) return;                  // don't register from iframes
        if (location.protocol === 'file:') return;
        // Allow http on localhost (browsers permit SWs there)
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;

        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js', { scope: '/' })
                .then(reg => {
                    // Re-check for updates every 60 minutes
                    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
                })
                .catch(() => { /* purely cosmetic warning, suppressed */ });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
