import express from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { admin, db, bucket } from './firebase.js';
import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/googleai';

dotenv.config();

// --- Sentry (optional) — enabled only if SENTRY_DSN env var is set ---
// Doesn't bloat the app at all in dev; in prod it captures all unhandled errors.
let Sentry = null;
if (process.env.SENTRY_DSN) {
    try {
        const sentryModule = await import('@sentry/node');
        Sentry = sentryModule;
        Sentry.init({
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV || 'production',
            tracesSampleRate: 0.1,
            // Don't capture user's request bodies (PII / payment data)
            sendDefaultPii: false
        });
        console.log('🛡️  Sentry initialized');
    } catch (e) {
        console.warn('Sentry SDK not installed — run `npm i @sentry/node` to enable monitoring.');
    }
}

// Initialize Genkit
console.log('🔑 Using Google GenAI Key:', process.env.GOOGLE_GENAI_API_KEY ? `${process.env.GOOGLE_GENAI_API_KEY.substring(0, 8)}...` : 'MISSING');
const ai = genkit({
    plugins: [googleAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY })],
    model: googleAI.model('gemini-1.5-flash'),
});


const FieldValue = admin.firestore.FieldValue;

// --- CASHFREE PAYMENT GATEWAY ---
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || 'TEST_APP_ID';
const CASHFREE_SECRET = process.env.CASHFREE_SECRET_KEY || 'TEST_SECRET';
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'TEST').toUpperCase(); // TEST | PROD
const CASHFREE_BASE_URL = CASHFREE_ENV === 'PROD'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
const CASHFREE_API_VERSION = '2023-08-01';

const cashfreeClient = axios.create({
    baseURL: CASHFREE_BASE_URL,
    headers: {
        'x-api-version': CASHFREE_API_VERSION,
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET,
        'Content-Type': 'application/json'
    },
    timeout: 15000
});

// File uploads: max 10MB, 5 files, only common document/image mimetypes
const ALLOWED_MIMES = new Set([
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg', 'image/png', 'image/webp',
    'text/plain', 'application/zip'
]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10MB/file, 5 files max
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIMES.has(file.mimetype)) return cb(null, true);
        cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
});

const app = express();

// --- CORS: restrict to trusted origins ---
const allowedOriginPatterns = [
    /^https:\/\/writely-304a8\.web\.app$/i,            // Explicit primary domain
    /^https:\/\/([a-z0-9-]+\.)?web\.app$/i,            // Any Firebase Hosting subdomain
    /^https:\/\/([a-z0-9-]+\.)?firebaseapp\.com$/i,    // Firebase Hosting alt domain
    /^https:\/\/([a-z0-9-]+\.)?netlify\.app$/i,        // Netlify subdomains
    /^https:\/\/([a-z0-9-]+\.)?onrender\.com$/i,       // Backend itself (if needed)
    /^http:\/\/localhost(:\d+)?$/i,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/i
];

app.use(cors({
    origin: (origin, cb) => {
        // 1. Allow same-origin / curl / Postman (no Origin header)
        if (!origin) return cb(null, true);

        // 2. Normalize and check against patterns
        const normalized = String(origin).trim().toLowerCase();
        const isAllowed = allowedOriginPatterns.some(rx => rx.test(normalized));

        if (isAllowed) {
            cb(null, true);
        } else {
            console.warn('⚠️ CORS blocked origin:', origin);
            // Return false instead of an Error to avoid triggering the global 500 handler
            // Browsers will still block the request but the server won't crash/error.
            cb(null, false);
        }
    },
    credentials: true,
    optionsSuccessStatus: 200 // Some legacy browsers choke on 204
}));

// Capture rawBody on every JSON request — required for verifying Cashfree webhook signatures
app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

// --- Rate limiters ---
const generalLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 120,              // 120 req/min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' }
});
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,               // AI chat is expensive: 10/min per IP
    message: { error: 'AI chat rate limit exceeded. Wait a minute.' }
});
const paymentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many payment attempts.' }
});
app.use(generalLimiter);

// --- AUTH MIDDLEWARE: verifies Firebase ID tokens ---
async function requireAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing authorization token' });
        }
        const idToken = authHeader.substring(7);
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.user = decoded; // { uid, email, ... }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Health check (public, no auth) — used by Render and uptime monitors
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Preview platform fee for a given budget (and the seeker's current subscription).
// Used by the "post assignment" UI to show "₹X platform fee" before checkout.
app.get('/api/fees/preview', requireAuth, async (req, res) => {
    try {
        const budget = Number(req.query.budget);
        if (!Number.isFinite(budget) || budget <= 0 || budget > 500000) {
            return res.status(400).json({ error: 'Invalid budget' });
        }
        const userSnap = await db.collection('users').doc(req.user.uid).get();
        const subscription = userSnap.exists ? userSnap.data().subscription : null;
        const fee = computeSeekerFee(budget, subscription);
        res.json({
            budget,
            platformFee: fee,
            total: budget + fee,
            subscriptionActive: isSubActive(subscription),
            subscriptionType: isSubActive(subscription) ? subscription.type : null
        });
    } catch (err) {
        console.error('Fee preview error:', err.message);
        res.status(500).json({ error: 'Could not compute fee' });
    }
});

/**
 * Push a notification to a user's notifications subcollection.
 * Always non-blocking (errors logged, never thrown to caller) — notifications
 * must never break the underlying business operation that triggered them.
 *
 *   type:    short machine-readable code (e.g., 'BID_RECEIVED')
 *   title:   short human-readable title shown in dropdown
 *   body:    longer detail line
 *   link:    optional URL the bell-dropdown row should link to
 *   meta:    extra structured data (assignmentId, etc.)
 */
async function createNotification(uid, { type, title, body, link = null, meta = {} } = {}) {
    if (!uid || !type) return;
    try {
        await db.collection('users').doc(uid)
            .collection('notifications').add({
                type,
                title: title || '',
                body: body || '',
                link,
                meta,
                read: false,
                createdAt: FieldValue.serverTimestamp()
            });
    } catch (e) {
        console.warn(`Notification dispatch failed for ${uid}:`, e.message);
    }
}

console.log('✅ Writely API Gateway (Firebase Admin) Starting...');

// --- CASHFREE PAYMENTS ---

// Plan catalog — server-controlled to prevent clients from inventing plan types or fees.
//   fixedAmount:       charge is fixed regardless of client input.
//   minAmount/maxAmount: client specifies amount within range (used for wallet top-ups).
//   durationDays/durationHours: subscription validity window from purchase time.
//   field:             which Firestore user field to write the active subscription into.
const PLAN_CATALOG = {
    // ───── Seeker subscriptions ─────
    SEEKER_PASS:     { fixedAmount: 120, kind: 'subscription', durationDays: 11, field: 'subscription',       label: 'Seeker Pass (11 days)' },
    WRITELY_PLUS:    { fixedAmount: 99,  kind: 'subscription', durationDays: 30, field: 'subscription',       label: 'Writely Plus (Monthly)' },
    WRITELY_PRO:     { fixedAmount: 299, kind: 'subscription', durationDays: 30, field: 'subscription',       label: 'Writely Pro (Monthly)' },
    // ───── Writer subscriptions ─────
    WRITER_ZERO_FEE: { fixedAmount: 30,  kind: 'subscription', durationHours: 24, field: 'writerSubscription', label: 'Writer Zero-Fee Pass (24h)' },
    WRITER_PRO:      { fixedAmount: 149, kind: 'subscription', durationDays: 30,  field: 'writerSubscription', label: 'Writer Pro (Monthly)' },
    WRITER_ELITE:    { fixedAmount: 499, kind: 'subscription', durationDays: 30,  field: 'writerSubscription', label: 'Writer Elite (Monthly)' },
    // ───── Wallet ─────
    WALLET_TOPUP:    { minAmount: 100, maxAmount: 50000, kind: 'wallet', label: 'Wallet Top-Up' }
};

// Centralised fee math — change once, applies everywhere (assign/release, dashboards, invoicing).
// Adjust these numbers to tune unit economics without touching business logic.
const FEE_RULES = {
    // What the SEEKER pays the platform on top of the assignment budget
    SEEKER: {
        // Active subscription → flat percentage of budget
        BY_SUBSCRIPTION: {
            WRITELY_PRO:  0.02,  // 2% — premium tier
            WRITELY_PLUS: 0.05,  // 5% — basic tier
            SEEKER_PASS:  0.02   // legacy compat
        },
        // No active subscription → progressive tiers
        TIERS: [
            { upTo: 300,    flat: 19 },               // ₹19 flat for tiny jobs
            { upTo: 1500,   percent: 0.08 },          // 8% for assignments
            { upTo: 5000,   percent: 0.06 },          // 6% for projects
            { upTo: Infinity, percent: 0.04 }         // 4% for theses/dissertations
        ]
    },
    // What is DEDUCTED from the writer's payout
    WRITER: {
        BY_SUBSCRIPTION: {
            WRITER_ELITE:    0.05,  // 5% — top tier
            WRITER_PRO:      0.10,  // 10% — pro
            WRITER_ZERO_FEE: 0.02   // legacy compat (was effectively 2%)
        },
        DEFAULT_PERCENT: 0.15       // No sub: 15% commission (a common gig-marketplace rate)
    }
};

function isSubActive(sub) {
    return sub?.expiresAt?.toDate?.() > new Date();
}

function computeSeekerFee(budget, subscription) {
    if (isSubActive(subscription)) {
        const rate = FEE_RULES.SEEKER.BY_SUBSCRIPTION[subscription.type];
        if (rate != null) return Math.max(1, Math.round(budget * rate));
    }
    for (const tier of FEE_RULES.SEEKER.TIERS) {
        if (budget < tier.upTo) {
            return tier.flat != null ? tier.flat : Math.round(budget * tier.percent);
        }
    }
    return Math.round(budget * 0.04); // Safety fallback
}

function computeWriterDeduction(budget, writerSubscription) {
    if (isSubActive(writerSubscription)) {
        const rate = FEE_RULES.WRITER.BY_SUBSCRIPTION[writerSubscription.type];
        if (rate != null) return Math.max(1, Math.round(budget * rate));
    }
    return Math.max(1, Math.round(budget * FEE_RULES.WRITER.DEFAULT_PERCENT));
}

// Public config endpoint — frontend needs the App ID + environment to init Cashfree.js
app.get('/api/payments/cashfree/config', (req, res) => {
    res.json({
        appId: CASHFREE_APP_ID,
        mode: CASHFREE_ENV === 'PROD' ? 'production' : 'sandbox'
    });
});

// Create a Cashfree order — returns payment_session_id used by Cashfree.js drop-in.
// Stores intent in `paymentOrders` collection so /verify and /webhook can apply it idempotently.
app.post('/api/payments/cashfree/create-order', paymentLimiter, requireAuth, async (req, res) => {
    try {
        const { planType, amount: clientAmount, currency = 'INR' } = req.body;
        const plan = PLAN_CATALOG[planType];
        if (!plan) return res.status(400).json({ error: 'Invalid planType' });

        // Resolve final amount server-side (never trust the client for fixed plans)
        let finalAmount;
        if (plan.fixedAmount) {
            finalAmount = plan.fixedAmount;
        } else {
            finalAmount = Number(clientAmount);
            if (!Number.isFinite(finalAmount) || finalAmount < plan.minAmount || finalAmount > plan.maxAmount) {
                return res.status(400).json({ error: `Amount must be ₹${plan.minAmount}–${plan.maxAmount}` });
            }
        }

        // Cashfree requires customer phone. Pull from user's Firestore profile, fall back to a test number.
        let customerPhone = '9999999999';
        let customerEmail = req.user.email || 'noreply@writely.app';
        try {
            const userSnap = await db.collection('users').doc(req.user.uid).get();
            if (userSnap.exists) {
                const u = userSnap.data();
                const digits = String(u.phoneNumber || '').replace(/\D/g, '').slice(-10);
                if (/^\d{10}$/.test(digits)) customerPhone = digits;
                if (u.email) customerEmail = u.email;
            }
        } catch (_) { /* non-fatal */ }

        const orderId = `wr_${req.user.uid.substring(0, 8)}_${Date.now()}`;
        const payload = {
            order_id: orderId,
            order_amount: Math.round(finalAmount * 100) / 100,
            order_currency: currency,
            customer_details: {
                customer_id: req.user.uid,
                customer_email: customerEmail,
                customer_phone: customerPhone
            },
            order_meta: { 
                notify_url: '',
                return_url: req.body.returnUrl || '' // Allow frontend to specify return URL
            }
        };

        const { data } = await cashfreeClient.post('/orders', payload);

        // Persist intent for idempotent application by /verify or /webhook later
        await db.collection('paymentOrders').doc(orderId).set({
            uid: req.user.uid,
            amount: finalAmount,
            planType,
            kind: plan.kind,
            status: 'PENDING',
            createdAt: FieldValue.serverTimestamp()
        });

        res.json({
            order_id: data.order_id,
            payment_session_id: data.payment_session_id,
            order_amount: data.order_amount,
            order_currency: data.order_currency
        });
    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('Cashfree create order error:', detail);
        res.status(500).json({ error: 'Could not create order' });
    }
});

/**
 * Idempotently apply a paid Cashfree order to the user's account.
 * - Looks up our `paymentOrders` record (created at /create-order)
 * - Verifies status with Cashfree (server→server)
 * - Atomically claims the order (status=PROCESSED) and applies side effects
 *   (subscription extension OR wallet credit) inside a single Firestore transaction.
 *
 * Safe to call multiple times for the same order_id (e.g., /verify + webhook race).
 * Used by both /verify (user-initiated) and /webhook (Cashfree-initiated).
 */
async function applyPaidOrder(orderId, expectedUid = null) {
    const orderRef = db.collection('paymentOrders').doc(orderId);
    const existing = await orderRef.get();

    if (!existing.exists) throw new Error('Unknown order');
    const intent = existing.data();
    if (expectedUid && intent.uid !== expectedUid) {
        const e = new Error('Order does not belong to caller');
        e.code = 'FORBIDDEN';
        throw e;
    }
    // Fast path — already processed
    if (intent.status === 'PROCESSED') {
        return { alreadyProcessed: true, kind: intent.kind, expiresAt: intent.expiresAt?.toDate?.() || null, amount: intent.amount };
    }

    // Verify with Cashfree (cannot do HTTP inside a Firestore transaction)
    const { data: cfOrder } = await cashfreeClient.get(`/orders/${encodeURIComponent(orderId)}`);
    if (!cfOrder || cfOrder.order_status !== 'PAID') {
        const e = new Error(`Payment not completed (status: ${cfOrder?.order_status || 'unknown'})`);
        e.code = 'NOT_PAID';
        throw e;
    }

    // Atomic claim + apply side effects
    return await db.runTransaction(async (t) => {
        const fresh = await t.get(orderRef);
        const data = fresh.data();
        if (data.status === 'PROCESSED') {
            return { alreadyProcessed: true, kind: data.kind, expiresAt: data.expiresAt?.toDate?.() || null, amount: data.amount };
        }

        const { uid, amount, planType, kind } = data;

        if (kind === 'wallet') {
            // Credit wallet
            const walletRef = db.collection('wallets').doc(uid);
            t.set(walletRef, { userId: uid, balance: FieldValue.increment(amount) }, { merge: true });

            t.set(db.collection('transactions').doc(), {
                receiverId: uid,
                amount,
                type: 'WALLET_TOPUP',
                status: 'COMPLETED',
                paymentId: orderId,
                timestamp: FieldValue.serverTimestamp()
            });

            t.update(orderRef, {
                status: 'PROCESSED',
                processedAt: FieldValue.serverTimestamp(),
                cfReference: cfOrder.cf_order_id || null
            });

            return { kind: 'wallet', amountAdded: amount };
        }

        // Subscription plans — metadata-driven (works for all 6 plans)
        const plan = PLAN_CATALOG[planType];
        if (!plan || plan.kind !== 'subscription') {
            throw new Error(`Unknown subscription plan: ${planType}`);
        }
        const endDate = new Date();
        if (plan.durationHours) {
            endDate.setHours(endDate.getHours() + plan.durationHours);
        } else if (plan.durationDays) {
            endDate.setDate(endDate.getDate() + plan.durationDays);
        }

        t.update(db.collection('users').doc(uid), {
            [plan.field]: {
                type: planType,
                expiresAt: admin.firestore.Timestamp.fromDate(endDate),
                paymentId: orderId
            }
        });

        t.update(orderRef, {
            status: 'PROCESSED',
            processedAt: FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(endDate),
            cfReference: cfOrder.cf_order_id || null
        });

        return { kind: 'subscription', expiresAt: endDate };
    });
}

// User-initiated verify — called by frontend after the Cashfree modal closes successfully.
app.post('/api/payments/cashfree/verify', paymentLimiter, requireAuth, async (req, res) => {
    try {
        const { order_id } = req.body;
        if (!order_id || typeof order_id !== 'string') {
            return res.status(400).json({ error: 'Missing order_id' });
        }
        // Order ID format check — defence in depth (also enforced by paymentOrders ownership check)
        if (!order_id.startsWith(`wr_${req.user.uid.substring(0, 8)}_`)) {
            return res.status(403).json({ error: 'Order does not belong to caller' });
        }

        const result = await applyPaidOrder(order_id, req.user.uid);
        res.json({ status: 'success', message: 'Payment verified', ...result });
    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('Cashfree verify error:', detail);
        const code = err.code === 'FORBIDDEN' ? 403 : err.code === 'NOT_PAID' ? 400 : 500;
        res.status(code).json({ error: err.message || 'Verification failed' });
    }
});

/**
 * Cashfree webhook — server-to-server confirmation.
 * Critical safety net: even if the user closes the browser before /verify fires,
 * Cashfree will POST here and we'll still apply the order.
 *
 * Signature verification: HMAC-SHA256(timestamp + rawBody) base64-encoded, must match `x-webhook-signature`.
 * The shared secret is the Cashfree Secret Key (same one used for API auth).
 */
app.post('/api/payments/cashfree/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];
        if (!signature || !timestamp || !req.rawBody) {
            return res.status(400).send('Missing signature/timestamp/body');
        }

        const expected = crypto.createHmac('sha256', CASHFREE_SECRET)
            .update(timestamp + req.rawBody)
            .digest('base64');

        // Timing-safe comparison
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            console.warn('Cashfree webhook: signature mismatch');
            return res.status(401).send('Invalid signature');
        }

        const event = req.body;
        const eventType = event?.type || '';
        const orderId = event?.data?.order?.order_id;

        // Always 200 to Cashfree quickly so they don't retry forever; just log non-success types.
        if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' && orderId) {
            try {
                await applyPaidOrder(orderId);
                console.log(`✅ Webhook applied order ${orderId}`);
            } catch (e) {
                console.error(`❌ Webhook apply failed for ${orderId}:`, e.message);
            }
        } else {
            console.log(`ℹ️  Webhook event ignored: ${eventType} (order=${orderId || 'n/a'})`);
        }

        res.status(200).send('ok');
    } catch (err) {
        console.error('Webhook handler error:', err.message);
        // Even on internal error we 200 so Cashfree stops retrying for parsing issues
        res.status(200).send('ok');
    }
});

// --- ESCROW (deprecated, kept for compatibility; use /assign instead) ---
app.post('/api/assignments/:id/escrow', requireAuth, async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const assignmentSnap = await assignmentRef.get();

        if (!assignmentSnap.exists) {
            return res.status(404).json({ error: 'Assignment not found' });
        }

        const assignment = assignmentSnap.data();
        let platformFee = 15; // Standard fee

        // Check Seeker Subscription
        const seekerRef = db.collection('users').doc(assignment.seekerId);
        const seekerSnap = await seekerRef.get();
        const seekerData = seekerSnap.data();

        if (seekerData?.subscription?.expiresAt?.toDate() > new Date()) {
            platformFee = Math.round(assignment.budget * 0.02); // 2% for subscribers
        }

        const totalAmount = assignment.budget + platformFee;

        await db.collection('transactions').add({
            assignmentId: req.params.id,
            senderId: assignment.seekerId,
            amount: totalAmount,
            type: 'ESCROW_LOCK',
            status: 'COMPLETED',
            timestamp: FieldValue.serverTimestamp()
        });

        await assignmentRef.update({ 
            status: 'ACTIVE',
            platformFeePaid: platformFee,
            totalSeekerPaid: totalAmount
        });

        res.json({ message: 'Funds locked in escrow', totalAmount, platformFee });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- RELEASE FUNDS (only the SEEKER who owns the assignment can release) ---
// Wrapped in a Firestore transaction to prevent double-payouts on concurrent calls.
app.post('/api/assignments/:id/release', requireAuth, async (req, res) => {
    try {
        const result = await db.runTransaction(async (t) => {
            const assignmentRef = db.collection('assignments').doc(req.params.id);
            const assignmentSnap = await t.get(assignmentRef);
            if (!assignmentSnap.exists) {
                const e = new Error('Assignment not found'); e.code = 'NOT_FOUND'; throw e;
            }
            const assignment = assignmentSnap.data();

            // Ownership + state guards (re-checked INSIDE transaction → race-safe)
            if (assignment.seekerId !== req.user.uid) {
                const e = new Error('Only the seeker can release funds'); e.code = 'FORBIDDEN'; throw e;
            }
            if (assignment.status === 'COMPLETED') {
                const e = new Error('Already released'); e.code = 'CONFLICT'; throw e;
            }
            if (!assignment.activeWriterId) {
                const e = new Error('No writer assigned'); e.code = 'BAD_REQUEST'; throw e;
            }

            // Compute writer deduction (subscription rate if active, else default %)
            const writerRef = db.collection('users').doc(assignment.activeWriterId);
            const writerSnap = await t.get(writerRef);
            const writerData = writerSnap.data() || {};
            const writerDeduction = computeWriterDeduction(assignment.budget, writerData.writerSubscription);
            const writerPayout = assignment.budget - writerDeduction;

            // Credit wallet (creates if not exists via merge:true)
            const walletRef = db.collection('wallets').doc(assignment.activeWriterId);
            t.set(walletRef, {
                userId: assignment.activeWriterId,
                balance: FieldValue.increment(writerPayout)
            }, { merge: true });

            // Audit transaction
            t.set(db.collection('transactions').doc(), {
                assignmentId: req.params.id,
                senderId: assignment.seekerId,
                receiverId: assignment.activeWriterId,
                amount: writerPayout,
                type: 'PAYOUT',
                status: 'COMPLETED',
                timestamp: FieldValue.serverTimestamp()
            });

            // Mark assignment completed
            t.update(assignmentRef, {
                status: 'COMPLETED',
                writerPayout,
                platformEarnings: (assignment.platformFeePaid || 0) + writerDeduction,
                completedAt: FieldValue.serverTimestamp()
            });

            return { writerPayout, writerDeduction, writerId: assignment.activeWriterId, title: assignment.title };
        });

        // Notify the writer that funds were released to their wallet
        createNotification(result.writerId, {
            type: 'PAYOUT_RECEIVED',
            title: '💰 Payment released!',
            body: `₹${result.writerPayout.toLocaleString()} has been credited to your wallet for "${result.title || 'your work'}"`,
            link: `/apps/writer-mobile/writer.html#wallet`,
            meta: { assignmentId: req.params.id, amount: result.writerPayout }
        });

        res.json({ message: 'Funds released successfully', writerPayout: result.writerPayout, writerDeduction: result.writerDeduction });
    } catch (err) {
        const code = err.code === 'NOT_FOUND' ? 404
                    : err.code === 'FORBIDDEN' ? 403
                    : err.code === 'CONFLICT' ? 409
                    : 400;
        console.error('Release error:', err.message);
        res.status(code).json({ error: err.message });
    }
});

// --- CREATE ASSIGNMENT ---
app.post('/api/assignments', requireAuth, upload.array('attachments', 5), async (req, res) => {
    try {
        const { title, description, budget, pages, deliveryMethod, deliveryAddress, pincode, city, deadline, collegeName } = req.body;

        // Validate
        if (!title || title.trim().length < 3) return res.status(400).json({ error: 'Title required (min 3 chars)' });
        if (!description || description.trim().length < 10) return res.status(400).json({ error: 'Description required (min 10 chars)' });
        const numBudget = Number(budget);
        if (!Number.isFinite(numBudget) || numBudget < 50 || numBudget > 500000) {
            return res.status(400).json({ error: 'Budget must be ₹50 – ₹500,000' });
        }

        // Deadline — must be a valid future timestamp (at least 30 min ahead)
        let deadlineTs = null;
        if (deadline) {
            const dt = new Date(deadline);
            if (isNaN(dt.getTime())) return res.status(400).json({ error: 'Invalid deadline format' });
            if (dt.getTime() < Date.now() + 30 * 60 * 1000) {
                return res.status(400).json({ error: 'Deadline must be at least 30 minutes in the future' });
            }
            deadlineTs = admin.firestore.Timestamp.fromDate(dt);
        } else {
            return res.status(400).json({ error: 'Deadline is required' });
        }

        // College / University — required, capped at 120 chars
        const cleanCollege = String(collegeName || '').trim().slice(0, 120);
        if (!cleanCollege) return res.status(400).json({ error: 'College / University name is required' });

        // seekerId comes from verified token, NOT request body
        const seekerId = req.user.uid;
        const attachments = [];

        if (req.files) {
            for (const file of req.files) {
                const blob = bucket.file(`assignments/${Date.now()}_${file.originalname}`);
                const blobStream = blob.createWriteStream({ mimetype: file.mimetype });
                await new Promise((resolve, reject) => {
                    blobStream.on('error', reject);
                    blobStream.on('finish', resolve);
                    blobStream.end(file.buffer);
                });
                // Store only path; generate short-lived signed URLs on-demand via /download
                attachments.push({ filename: file.originalname, storagePath: blob.name, mimetype: file.mimetype, size: file.size });
            }
        }

        // Normalise location fields — pincode is a 6-digit string in India
        const cleanPincode = String(pincode || '').replace(/\D/g, '').slice(0, 6);
        const cleanCity = String(city || '').trim().slice(0, 80);

        const docRef = await db.collection('assignments').add({
            title: title.trim(),
            description: description.trim(),
            pages: Number(pages) || 0,
            budget: numBudget,
            seekerId,
            status: 'POSTED',
            deliveryMethod: deliveryMethod || 'Digital',
            deliveryAddress: (deliveryAddress || '').trim(),
            pincode: cleanPincode || null,                      // e.g. "110001"
            city: cleanCity ? cleanCity.toLowerCase() : null,    // normalised lowercase for matching
            cityDisplay: cleanCity || null,                      // original casing for UI
            deadline: deadlineTs,                                // Firestore Timestamp — when seeker needs it by
            collegeName: cleanCollege,                           // visible to writers in feed
            attachments,
            createdAt: FieldValue.serverTimestamp()
        });

        res.status(201).json({ id: docRef.id, title, status: 'POSTED' });
    } catch (err) {
        console.error("Create Assignment Error:", err);
        res.status(400).json({ error: err.message });
    }
});

// --- GET JOB FEED (paginated, location-aware) ---
// Query params:
//   ?limit=20                      number of jobs per page (1–50)
//   ?after=<assignmentId>          cursor for pagination
//   ?scope=nearby|city|all         filter by writer's location (default: all)
//   ?pincode=110001&city=delhi     writer's location (read by scope filter)
// Returns: { jobs: [...], nextCursor: <id|null>, scope }
app.get('/api/assignments', requireAuth, async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
        const afterId = req.query.after;
        const scope = ['nearby', 'city', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
        const pincode = String(req.query.pincode || '').replace(/\D/g, '').slice(0, 6) || null;
        const cityRaw = String(req.query.city || '').trim().toLowerCase().slice(0, 80) || null;

        // Helper: build a query for a single status value with optional location filter
        function buildQuery(status) {
            let q = db.collection('assignments').where('status', '==', status);
            if (scope === 'nearby' && pincode) {
                q = q.where('pincode', '==', pincode);
            } else if (scope === 'city' && cityRaw) {
                q = q.where('city', '==', cityRaw);
            }
            return q.orderBy('createdAt', 'desc');
        }

        let docs = [];
        try {
            // Try the compound 'in' query first (requires composite index)
            let query = db.collection('assignments').where('status', 'in', ['POSTED', 'BIDDING']);
            if (scope === 'nearby' && pincode) {
                query = query.where('pincode', '==', pincode);
            } else if (scope === 'city' && cityRaw) {
                query = query.where('city', '==', cityRaw);
            }
            query = query.orderBy('createdAt', 'desc');
            if (afterId) {
                const afterDoc = await db.collection('assignments').doc(String(afterId)).get();
                if (afterDoc.exists) query = query.startAfter(afterDoc);
            }
            const snap = await query.limit(limit + 1).get();
            docs = snap.docs;
        } catch (indexErr) {
            // Fallback: fetch POSTED and BIDDING separately and merge (no composite index needed)
            console.warn('Composite index missing, using fallback query:', indexErr.message.split('\n')[0]);
            const [postedSnap, biddingSnap] = await Promise.all([
                buildQuery('POSTED').limit(limit).get(),
                buildQuery('BIDDING').limit(limit).get()
            ]);
            const merged = [...postedSnap.docs, ...biddingSnap.docs];
            // Sort by createdAt descending
            merged.sort((a, b) => {
                const tA = a.data().createdAt?.toMillis?.() || 0;
                const tB = b.data().createdAt?.toMillis?.() || 0;
                return tB - tA;
            });
            docs = merged;
        }

        const hasMore = docs.length > limit;
        const pageDocs = hasMore ? docs.slice(0, limit) : docs;

        // Annotate each job with a proximity tag so the writer's UI can show a badge.
        const jobs = pageDocs.map(d => {
            const data = d.data();
            let proximity = 'other';
            if (pincode && data.pincode === pincode) proximity = 'same_pincode';
            else if (cityRaw && data.city === cityRaw) proximity = 'same_city';
            return { id: d.id, ...data, proximity };
        });

        res.json({
            jobs,
            nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null,
            scope
        });
    } catch (err) {
        console.error('❌ Query failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// --- SUBMIT BID ---
app.post('/api/assignments/:id/bid', requireAuth, async (req, res) => {
    try {
        const { amount, proposal } = req.body;
        const writerId = req.user.uid; // from token, not client
        const numAmount = Number(amount);

        if (!Number.isFinite(numAmount) || numAmount < 50 || numAmount > 500000) {
            return res.status(400).json({ error: 'Bid amount must be ₹50 – ₹500,000' });
        }
        if (!proposal || proposal.trim().length < 10) {
            return res.status(400).json({ error: 'Proposal required (min 10 chars)' });
        }

        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const snap = await assignmentRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Assignment not found' });
        const asn = snap.data();
        if (asn.status !== 'POSTED' && asn.status !== 'BIDDING') {
            return res.status(400).json({ error: 'Bidding closed for this assignment' });
        }
        if (asn.seekerId === writerId) {
            return res.status(400).json({ error: "You can't bid on your own assignment" });
        }

        await assignmentRef.update({
            bids: FieldValue.arrayUnion({ writerId, amount: numAmount, proposal: proposal.trim(), timestamp: new Date() }),
            status: 'BIDDING'
        });

        // Notify the seeker (fire-and-forget)
        createNotification(asn.seekerId, {
            type: 'BID_RECEIVED',
            title: 'New bid on your assignment',
            body: `A writer placed a ₹${numAmount.toLocaleString()} bid on "${asn.title || 'your assignment'}"`,
            link: `/apps/seeker-web/dashboard.html#assignment/${req.params.id}`,
            meta: { assignmentId: req.params.id, amount: numAmount }
        });

        res.json({ message: 'Bid submitted successfully' });
    } catch (err) {
        console.error('Bid error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// --- ASSIGN WRITER & START PROJECT ---
// FIX #3: writerId is derived from the authenticated token (req.user.uid), NOT from the request body.
// This prevents any user from sending an arbitrary writerId to hijack assignments.
// The writer must call this endpoint themselves — they are the one accepting the job.
app.post('/api/assignments/:id/assign', requireAuth, async (req, res) => {
    try {
        // Always use the authenticated caller's UID as the writerId
        const writerId = req.user.uid;

        const assignmentRef = db.collection('assignments').doc(req.params.id);
        
        await db.runTransaction(async (t) => {
            const snap = await t.get(assignmentRef);
            if (!snap.exists) throw new Error("Assignment not found");
            const assignment = snap.data();

            // Prevent seekers from accepting their own assignments as a writer
            if (assignment.seekerId === writerId) {
                throw new Error("You cannot accept your own assignment");
            }
            if (assignment.status !== 'POSTED' && assignment.status !== 'BIDDING') {
                throw new Error("Project is no longer available for hiring");
            }

            // Compute platform fee (tiered, with subscription discount if active)
            const seekerRef = db.collection('users').doc(assignment.seekerId);
            const seekerSnap = await t.get(seekerRef);
            const seekerData = seekerSnap.data() || {};
            const platformFee = computeSeekerFee(assignment.budget, seekerData.subscription);

            const totalAmount = assignment.budget + platformFee;

            t.set(db.collection('transactions').doc(), {
                assignmentId: req.params.id,
                senderId: assignment.seekerId,
                amount: totalAmount,
                type: 'ESCROW_LOCK',
                status: 'COMPLETED',
                timestamp: FieldValue.serverTimestamp()
            });

            t.update(assignmentRef, {
                activeWriterId: writerId,
                status: 'ACTIVE',
                platformFeePaid: platformFee,
                totalSeekerPaid: totalAmount,
                assignedAt: FieldValue.serverTimestamp()
            });

            t.set(db.collection('messages').doc(), {
                assignmentId: req.params.id,
                senderId: writerId,
                text: "I have started working on your project!",
                timestamp: FieldValue.serverTimestamp()
            });
        });

        // Notify the hired writer (fire-and-forget)
        createNotification(writerId, {
            type: 'BID_ACCEPTED',
            title: '🎉 You won a bid!',
            body: 'A seeker accepted your bid. Funds are locked in escrow — start working!',
            link: `/apps/writer-mobile/writer.html#assignment/${req.params.id}`,
            meta: { assignmentId: req.params.id }
        });

        res.json({ message: 'Writer hired and funds locked in escrow!' });
    } catch (err) {
        console.error("Assign Error:", err);
        res.status(400).json({ error: err.message });
    }
});

// --- WITHDRAW FUNDS (userId in URL MUST match authenticated user) ---
app.post('/api/wallets/:userId/withdraw', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        // CRITICAL: prevent draining other users' wallets
        if (userId !== req.user.uid) {
            return res.status(403).json({ error: 'You can only withdraw from your own wallet' });
        }
        const walletRef = db.collection('wallets').doc(userId);
        
        await db.runTransaction(async (t) => {
            const walletSnap = await t.get(walletRef);
            if (!walletSnap.exists) throw new Error("Wallet not found");
            
            const balance = walletSnap.data().balance || 0;
            if (balance <= 0) throw new Error("Insufficient funds for withdrawal");

            t.update(walletRef, { balance: 0 });
            
            t.set(db.collection('transactions').doc(), {
                receiverId: userId,
                amount: -balance,
                type: 'WITHDRAWAL',
                status: 'COMPLETED',
                timestamp: FieldValue.serverTimestamp()
            });
        });

        res.json({ message: 'Withdrawal successful' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- SUBMIT SOLUTION (only the assigned writer can submit) ---
app.post('/api/assignments/:id/submit', requireAuth, upload.single('solution'), async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const snap = await assignmentRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Assignment not found' });
        const asn = snap.data();
        if (asn.activeWriterId !== req.user.uid) {
            return res.status(403).json({ error: 'Only the assigned writer can submit' });
        }
        if (asn.status !== 'ACTIVE') {
            return res.status(400).json({ error: 'Can only submit active assignments' });
        }

        let solutionData = {
            deliveredAt: new Date(),
            notes: (req.body.notes || '').trim()
        };

        if (req.body.tracking) {
            solutionData.tracking = req.body.tracking;
        }

        if (req.file) {
            // Secure storage path
            const blob = bucket.file(`solutions/${req.params.id}/${Date.now()}_${req.file.originalname}`);
            const blobStream = blob.createWriteStream({ 
                mimetype: req.file.mimetype,
                metadata: { cacheControl: 'no-cache' }
            });
            await new Promise((resolve, reject) => {
                blobStream.on('error', reject);
                blobStream.on('finish', resolve);
                blobStream.end(req.file.buffer);
            });
            
            // Store ONLY the path, not a public URL
            solutionData.filename = req.file.originalname;
            solutionData.storagePath = blob.name;
            solutionData.mimetype = req.file.mimetype;
        }

        await assignmentRef.update({
            solution: solutionData,
            status: 'REVIEW'
        });

        // Notify seeker that work was delivered
        createNotification(asn.seekerId, {
            type: 'SOLUTION_SUBMITTED',
            title: '📦 Your assignment is ready!',
            body: `"${asn.title || 'Your assignment'}" has been delivered. Review and release payment.`,
            link: `/apps/seeker-web/dashboard.html#assignment/${req.params.id}`,
            meta: { assignmentId: req.params.id }
        });

        res.json({ message: 'Solution submitted. Your seeker has been notified.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- DOWNLOAD ORIGINAL BRIEF / ATTACHMENTS (seeker's uploaded files) ---
// Only the seeker OR the currently hired writer (activeWriterId) can download.
// Writers who only placed a bid (but weren't hired) cannot — prevents scraping.
app.get('/api/assignments/:id/attachments/:index/download', requireAuth, async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const doc = await assignmentRef.get();
        if (!doc.exists) return res.status(404).send('Assignment not found');

        const job = doc.data();
        const isSeeker = job.seekerId === req.user.uid;
        const isAssignedWriter = job.activeWriterId && job.activeWriterId === req.user.uid;

        if (!isSeeker && !isAssignedWriter) {
            return res.status(403).send('Forbidden — only the seeker or the assigned writer can download attachments');
        }

        const attachments = Array.isArray(job.attachments) ? job.attachments : [];
        const idx = Number(req.params.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= attachments.length) {
            return res.status(404).send('Attachment not found');
        }

        const att = attachments[idx];
        if (!att.storagePath) return res.status(400).send('Attachment has no file');

        // Short-lived signed URL (15 min) so the link can't be shared permanently
        const [url] = await bucket.file(att.storagePath).getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000,
            responseDisposition: `attachment; filename="${att.filename || 'download'}"`
        });

        res.redirect(url);
    } catch (err) {
        console.error('Attachment download error:', err.message);
        res.status(500).send('Download failed');
    }
});

// --- SECURE DOWNLOAD ENDPOINT (only seeker or assigned writer can download) ---
app.get('/api/assignments/:id/download', requireAuth, async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const doc = await assignmentRef.get();
        if (!doc.exists) return res.status(404).send('Not found');
        
        const job = doc.data();
        if (job.seekerId !== req.user.uid && job.activeWriterId !== req.user.uid) {
            return res.status(403).send('Forbidden');
        }
        if (!job.solution || !job.solution.storagePath) {
            return res.status(400).send('No file delivered yet');
        }

        // Generate a 15-minute signed URL
        const [url] = await bucket.file(job.solution.storagePath).getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000, // 15 mins
        });

        res.redirect(url);
    } catch (err) {
        res.status(500).send('Download failed');
    }
});

// --- DISPUTE SYSTEM (only seeker or assigned writer can dispute) ---
app.post('/api/assignments/:id/dispute', requireAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({ error: 'Dispute reason required (min 10 chars)' });
        }
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const snap = await assignmentRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Assignment not found' });
        
        const assignment = snap.data();
        if (assignment.seekerId !== req.user.uid && assignment.activeWriterId !== req.user.uid) {
            return res.status(403).json({ error: 'Only the seeker or writer can dispute' });
        }
        if (assignment.status !== 'REVIEW' && assignment.status !== 'ACTIVE') {
            return res.status(400).json({ error: 'Only active or reviewed projects can be disputed' });
        }

        await assignmentRef.update({ 
            status: 'DISPUTED',
            disputeReason: reason,
            disputedAt: FieldValue.serverTimestamp()
        });

        // Log for Admin Dashboard
        await db.collection('events').add({
            service: 'DISPUTE',
            description: `⚠️ Dispute on #${req.params.id}: ${reason}`,
            status: 'WARNING',
            time: 'Just now'
        });

        // Notify the OTHER party about the dispute
        const otherUid = assignment.seekerId === req.user.uid ? assignment.activeWriterId : assignment.seekerId;
        if (otherUid) {
            createNotification(otherUid, {
                type: 'DISPUTE_OPENED',
                title: '⚠️ A dispute was opened on your project',
                body: `Reason: ${reason.substring(0, 120)}${reason.length > 120 ? '…' : ''}`,
                link: `/apps/seeker-web/dashboard.html#assignment/${req.params.id}`,
                meta: { assignmentId: req.params.id }
            });
        }

        res.json({ message: 'Project frozen. Arbitration initiated.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- NEGOTIATE DISPUTE (Propose a settlement split) ---
app.post('/api/assignments/:id/negotiate', requireAuth, async (req, res) => {
    try {
        const { writerShare, note } = req.body;
        const share = Number(writerShare);
        if (isNaN(share) || share < 0 || share > 1) {
            return res.status(400).json({ error: 'writerShare must be between 0 and 1' });
        }

        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const snap = await assignmentRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Assignment not found' });
        const asn = snap.data();

        if (asn.status !== 'DISPUTED') {
            return res.status(400).json({ error: 'Negotiation is only possible during an active dispute' });
        }

        if (asn.seekerId !== req.user.uid && asn.activeWriterId !== req.user.uid) {
            return res.status(403).json({ error: 'Only involved parties can negotiate' });
        }

        const proposal = {
            proposerId: req.user.uid,
            writerShare: share,
            note: note || '',
            timestamp: FieldValue.serverTimestamp()
        };

        await assignmentRef.update({
            disputeProposal: proposal
        });

        const isSeeker = req.user.uid === asn.seekerId;
        const targetId = isSeeker ? asn.activeWriterId : asn.seekerId;
        createNotification(targetId, {
            type: 'DISPUTE_PROPOSAL',
            title: '🤝 Settlement proposed',
            body: `${isSeeker ? 'Seeker' : 'Writer'} has proposed a ${Math.round(share * 100)}% split.`,
            link: isSeeker ? `/apps/writer-mobile/submissions.html` : `/apps/seeker-web/dashboard.html`,
            meta: { assignmentId: req.params.id, writerShare: share }
        });

        res.json({ message: 'Settlement proposed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ACCEPT NEGOTIATION (Finalize the settlement) ---
app.post('/api/assignments/:id/accept-negotiation', requireAuth, async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const result = await db.runTransaction(async (t) => {
            const snap = await t.get(assignmentRef);
            if (!snap.exists) throw new Error('Not found');
            const asn = snap.data();

            if (!asn.disputeProposal || asn.disputeProposal.proposerId === req.user.uid) {
                throw new Error('No proposal to accept from the other party');
            }

            const share = asn.disputeProposal.writerShare;
            const budget = Number(asn.budget || 0);
            const writerPayout = Math.round(budget * share);
            const seekerRefund = budget - writerPayout;

            // Apply payouts
            if (writerPayout > 0 && asn.activeWriterId) {
                const writerWallet = db.collection('wallets').doc(asn.activeWriterId);
                t.set(writerWallet, { userId: asn.activeWriterId, balance: FieldValue.increment(writerPayout) }, { merge: true });
            }
            if (seekerRefund > 0) {
                const seekerWallet = db.collection('wallets').doc(asn.seekerId);
                t.set(seekerWallet, { userId: asn.seekerId, balance: FieldValue.increment(seekerRefund) }, { merge: true });
            }

            t.update(assignmentRef, {
                status: writerPayout > 0 ? 'COMPLETED' : 'CANCELLED',
                disputeResolution: 'SELF_NEGOTIATED',
                disputeWriterShare: share,
                disputeResolvedAt: FieldValue.serverTimestamp(),
                disputeProposal: null
            });

            return { writerId: asn.activeWriterId, seekerId: asn.seekerId, writerPayout, seekerRefund };
        });

        createNotification(result.writerId, { type: 'DISPUTE_RESOLVED', title: '✅ Dispute settled!', body: 'A settlement was agreed upon and funds released.' });
        createNotification(result.seekerId, { type: 'DISPUTE_RESOLVED', title: '✅ Dispute settled!', body: 'A settlement was agreed upon and refund issued.' });

        res.json({ message: 'Dispute resolved via mutual agreement' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// =====================================================================
// MESSAGING — chat between seeker and assigned writer per assignment
// =====================================================================

// POST a message into an assignment's chat thread.
// Authorisation: only the seeker or the assigned/bidding writer can send.
// Side-effect: pushes a notification to the OTHER party.
app.post('/api/assignments/:id/messages', requireAuth, async (req, res) => {
    try {
        const { text } = req.body;
        const trimmed = String(text || '').trim();
        if (trimmed.length < 1 || trimmed.length > 2000) {
            return res.status(400).json({ error: 'Message must be 1–2000 chars' });
        }

        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const snap = await assignmentRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Assignment not found' });
        const asn = snap.data();

        const isSeeker = asn.seekerId === req.user.uid;
        const isActiveWriter = asn.activeWriterId === req.user.uid;
        // Allow bidders to message before assignment too (so seeker can chat with bidders)
        const isBidder = (asn.bids || []).some(b => b.writerId === req.user.uid);

        if (!isSeeker && !isActiveWriter && !isBidder) {
            return res.status(403).json({ error: 'You are not part of this assignment' });
        }

        const msgRef = await db.collection('messages').add({
            assignmentId: req.params.id,
            senderId: req.user.uid,
            text: trimmed,
            timestamp: FieldValue.serverTimestamp()
        });

        // Notify the other party (only if a writer is actively assigned)
        const otherUid = isSeeker ? asn.activeWriterId : asn.seekerId;
        if (otherUid && otherUid !== req.user.uid) {
            createNotification(otherUid, {
                type: 'MESSAGE_RECEIVED',
                title: '💬 New message',
                body: trimmed.length > 80 ? trimmed.substring(0, 77) + '…' : trimmed,
                link: `/apps/seeker-web/messages.html#${req.params.id}`,
                meta: { assignmentId: req.params.id, messageId: msgRef.id }
            });
        }

        res.status(201).json({ id: msgRef.id, text: trimmed });
    } catch (err) {
        console.error('Send message error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// =====================================================================
// REVIEWS — post-completion ratings (5-star + comment)
// Both seeker and writer can leave one review per completed assignment.
// Updates the reviewee's aggregate rating (running average + count).
// =====================================================================
app.post('/api/assignments/:id/review', requireAuth, async (req, res) => {
    try {
        const { rating, comment } = req.body;
        const numRating = Number(rating);
        if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
            return res.status(400).json({ error: 'Rating must be an integer 1–5' });
        }
        const cleanComment = String(comment || '').trim().substring(0, 500);

        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const reviewerId = req.user.uid;

        const result = await db.runTransaction(async (t) => {
            const snap = await t.get(assignmentRef);
            if (!snap.exists) { const e = new Error('Assignment not found'); e.code = 'NOT_FOUND'; throw e; }
            const asn = snap.data();

            if (asn.status !== 'COMPLETED') {
                const e = new Error('Reviews allowed only after completion'); e.code = 'BAD_STATE'; throw e;
            }

            const isSeeker = asn.seekerId === reviewerId;
            const isWriter = asn.activeWriterId === reviewerId;
            if (!isSeeker && !isWriter) {
                const e = new Error('Only participants can review'); e.code = 'FORBIDDEN'; throw e;
            }

            // Determine reviewee
            const revieweeId = isSeeker ? asn.activeWriterId : asn.seekerId;
            if (!revieweeId) { const e = new Error('No counterpart to review'); e.code = 'BAD_REQUEST'; throw e; }

            // One review per (assignment, reviewer) pair → deterministic doc ID
            const reviewId = `${req.params.id}_${reviewerId}`;
            const reviewRef = db.collection('reviews').doc(reviewId);
            const existing = await t.get(reviewRef);
            if (existing.exists) {
                const e = new Error('You have already reviewed this assignment'); e.code = 'CONFLICT'; throw e;
            }

            // Update reviewee's aggregate metrics (running mean for stable accuracy)
            const userRef = db.collection('users').doc(revieweeId);
            const userSnap = await t.get(userRef);
            const cur = userSnap.data() || {};
            const prevCount = cur.metrics?.reviewCount || 0;
            const prevAvg = cur.metrics?.avgRating || 0;
            const newCount = prevCount + 1;
            const newAvg = ((prevAvg * prevCount) + numRating) / newCount;

            t.set(reviewRef, {
                assignmentId: req.params.id,
                reviewerId,
                revieweeId,
                reviewerRole: isSeeker ? 'SEEKER' : 'WRITER',
                rating: numRating,
                comment: cleanComment,
                createdAt: FieldValue.serverTimestamp()
            });

            t.set(userRef, {
                metrics: {
                    ...(cur.metrics || {}),
                    avgRating: Math.round(newAvg * 100) / 100,
                    reviewCount: newCount
                }
            }, { merge: true });

            return { revieweeId, newAvg, newCount };
        });

        // Notify the reviewee
        createNotification(result.revieweeId, {
            type: 'REVIEW_RECEIVED',
            title: `⭐ You got a ${numRating}-star review`,
            body: cleanComment ? `"${cleanComment.substring(0, 100)}${cleanComment.length > 100 ? '…' : ''}"` : 'Tap to view.',
            link: `/apps/seeker-web/dashboard.html#assignment/${req.params.id}`,
            meta: { assignmentId: req.params.id, rating: numRating }
        });

        res.status(201).json({ status: 'success', avgRating: result.newAvg, reviewCount: result.newCount });
    } catch (err) {
        const code = err.code === 'NOT_FOUND' ? 404
                    : err.code === 'FORBIDDEN' ? 403
                    : err.code === 'CONFLICT' ? 409
                    : 400;
        console.error('Review error:', err.message);
        res.status(code).json({ error: err.message });
    }
});

// --- AI SUPPORT CHAT (rate-limited & authenticated to prevent quota abuse) ---
app.post('/api/support/chat', aiLimiter, requireAuth, async (req, res) => {
    try {
        const { message, history = [] } = req.body;
        
        const systemPrompt = `
            You are the "Writely Concierge", a premium AI support assistant for Writely, an academic marketplace.
            Writely connects "Seekers" (students/clients) with "Writers" (academic experts).
            
            Key platform details:
            1. Escrow: Payments are locked in escrow when a writer is hired and only released when the seeker approves the work.
            2. Seeker Pass (₹120): Valid for 11 days, reduces platform fee to 2% and gives 24h delivery priority.
            3. Writer Zero-Fee Pass (₹30): Valid for 24h, gives the writer 100% of the budget (no deductions).
            4. Delivery: Writers can deliver digitally (PDF) or physically (Courier).
            5. Writer Levels: Level 1 (New), Level 2 (Pro), Level 3 (Expert), Elite Expert (Top Tier).
            
            Guidelines:
            - Be professional, helpful, and concise.
            - Use "Writely" branding in your responses.
            - If you don't know the answer, ask them to contact support@writely.com.
            - Keep responses short (max 2-3 sentences unless asked for detail).
        `;

        // Filter history to ensure it starts with 'user' role (required by Gemini)
        let messages = history.map(h => ({ role: h.role, content: [{ text: h.text }] }));
        const firstUserIndex = messages.findIndex(m => m.role === 'user');
        if (firstUserIndex !== -1) {
            messages = messages.slice(firstUserIndex);
        } else {
            messages = [];
        }

        // Contextual awareness: check if user needs human help
        const frustrationKeywords = ['human', 'person', 'scam', 'cheat', 'fake', 'stole', 'money', 'complain', 'frustrated', 'bad service'];
        const needsHuman = frustrationKeywords.some(k => message.toLowerCase().includes(k));

        if (needsHuman) {
            // Trigger a silent event for admins
            await db.collection('events').add({
                service: 'CONCIERGE',
                description: `👤 User ${req.user.uid} requested human help or expressed frustration: "${message.substring(0, 50)}..."`,
                status: 'WARNING',
                timestamp: FieldValue.serverTimestamp()
            });
            
            // Also notify the admin directly if an admin user exists
            const adminSnap = await db.collection('users').where('role', '==', 'ADMIN').limit(1).get();
            if (!adminSnap.empty) {
                createNotification(adminSnap.docs[0].id, {
                    type: 'HUMAN_SUPPORT_REQUESTED',
                    title: '🚨 Human support requested',
                    body: `User ${req.user.uid.substring(0, 5)} needs help. Check Concierge logs.`,
                    meta: { userId: req.user.uid, message }
                });
            }
        }

        const response = await ai.generate({
            system: systemPrompt + (needsHuman ? "\nThe user seems frustrated or wants a person. Reassure them and mention that an admin has been alerted." : ""),
            prompt: message,
            messages: messages
        });

        res.json({ text: response.text });
    } catch (err) {
        console.error("AI Chat Error:", err);
        res.status(500).json({ error: "I'm having trouble connecting right now. Please try again later." });
    }
});

// =====================================================================
// ADMIN ENDPOINTS
// All require role == 'ADMIN' on the user's profile (set manually in Firestore).
// =====================================================================

// Admin gate — chains after requireAuth.
async function requireAdmin(req, res, next) {
    try {
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists || userDoc.data().role !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        req.adminProfile = userDoc.data();
        next();
    } catch (err) {
        console.error('requireAdmin error:', err.message);
        res.status(500).json({ error: 'Auth check failed' });
    }
}

// --- ADMIN EVENTS (audit log) ---
app.get('/api/events', requireAuth, requireAdmin, async (req, res) => {
    try {
        const snap = await db.collection('events').orderBy('timestamp', 'desc').limit(100).get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        console.error('Events error:', err.message);
        res.status(500).json({ error: 'Could not fetch events' });
    }
});

// --- PLATFORM STATS (totals for the dashboard cards) ---
app.get('/api/admin/stats', requireAuth, requireAdmin, async (_req, res) => {
    try {
        const [usersSnap, asnSnap, txSnap, disputesSnap] = await Promise.all([
            db.collection('users').count().get(),
            db.collection('assignments').count().get(),
            db.collection('transactions').where('type', '==', 'PAYOUT').get(),
            db.collection('assignments').where('status', '==', 'DISPUTED').count().get()
        ]);

        let grossPayouts = 0;
        let platformEarnings = 0;
        txSnap.forEach(d => { grossPayouts += Number(d.data().amount || 0); });

        const earnSnap = await db.collection('assignments').where('status', '==', 'COMPLETED').get();
        earnSnap.forEach(d => { platformEarnings += Number(d.data().platformEarnings || 0); });

        res.json({
            totalUsers: usersSnap.data().count,
            totalAssignments: asnSnap.data().count,
            openDisputes: disputesSnap.data().count,
            grossPayouts: Math.round(grossPayouts),
            platformEarnings: Math.round(platformEarnings)
        });
    } catch (err) {
        console.error('Admin stats error:', err.message);
        res.status(500).json({ error: 'Stats unavailable' });
    }
});

// --- LIST DISPUTES (open disputes with full context) ---
app.get('/api/admin/disputes', requireAuth, requireAdmin, async (_req, res) => {
    try {
        const snap = await db.collection('assignments')
            .where('status', '==', 'DISPUTED')
            .limit(100)
            .get();
        const disputes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Sort by disputedAt desc client-side (avoids needing another index)
        disputes.sort((a, b) => (b.disputedAt?._seconds || 0) - (a.disputedAt?._seconds || 0));
        res.json(disputes);
    } catch (err) {
        console.error('List disputes error:', err.message);
        res.status(500).json({ error: 'Could not fetch disputes' });
    }
});

// --- RESOLVE DISPUTE (admin pays writer, refunds seeker, or splits) ---
// body: { resolution: 'RELEASE_WRITER' | 'REFUND_SEEKER' | 'SPLIT', writerShare?: 0..1, note?: string }
// --- RESOLVE DISPUTE (admin pays writer, refunds seeker, or splits) ---
// body: { resolution: 'RELEASE_WRITER' | 'REFUND_SEEKER' | 'SPLIT', writerShare?: 0..1, note?: string }
app.post('/api/admin/disputes/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { resolution, writerShare, note } = req.body;
        if (!['RELEASE_WRITER', 'REFUND_SEEKER', 'SPLIT', 'SMART_RESOLVE'].includes(resolution)) {
            return res.status(400).json({ error: 'Invalid resolution' });
        }
        
        let share = resolution === 'SPLIT' ? Number(writerShare) : (resolution === 'RELEASE_WRITER' ? 1 : 0);
        
        // Handle AI-driven smart resolve
        let aiNote = '';
        if (resolution === 'SMART_RESOLVE') {
            const assignmentSnap = await db.collection('assignments').doc(req.params.id).get();
            const messagesSnap = await db.collection('messages').where('assignmentId', '==', req.params.id).orderBy('timestamp', 'asc').limit(20).get();
            const asn = assignmentSnap.data();
            const chatText = messagesSnap.docs.map(d => `${d.data().senderId === asn.seekerId ? 'Seeker' : 'Writer'}: ${d.data().text}`).join('\n');
            
            const analysis = await ai.generate({
                system: "You are the Writely Dispute Arbiter. Analyze the project details and chat logs to recommend a fair split. Return ONLY a JSON object: { writerShare: 0..1, reason: 'string' }",
                prompt: `Project: ${asn.title}\nDescription: ${asn.description}\nDispute Reason: ${asn.disputeReason}\nChat History:\n${chatText}`
            });
            
            try {
                const parsed = JSON.parse(analysis.text.match(/\{.*\}/s)?.[0] || '{}');
                share = Number(parsed.writerShare);
                aiNote = `[AI Recommendation] ${parsed.reason}`;
            } catch (e) {
                return res.status(500).json({ error: 'Smart resolution failed to parse AI analysis' });
            }
        }

        if (Number.isNaN(share) || share < 0 || share > 1) {
            return res.status(400).json({ error: 'writerShare must be 0..1' });
        }

        const assignmentRef = db.collection('assignments').doc(req.params.id);

        const result = await db.runTransaction(async (t) => {
            const snap = await t.get(assignmentRef);
            if (!snap.exists) { const e = new Error('Assignment not found'); e.code = 'NOT_FOUND'; throw e; }
            const asn = snap.data();
            if (asn.status !== 'DISPUTED') {
                const e = new Error('Assignment is not under dispute'); e.code = 'BAD_STATE'; throw e;
            }

            const budget = Number(asn.budget || 0);
            const writerPayout = Math.round(budget * share);
            const seekerRefund = budget - writerPayout;

            // Pay writer (if any)
            if (writerPayout > 0 && asn.activeWriterId) {
                const writerWallet = db.collection('wallets').doc(asn.activeWriterId);
                t.set(writerWallet, { userId: asn.activeWriterId, balance: FieldValue.increment(writerPayout) }, { merge: true });
                t.set(db.collection('transactions').doc(), {
                    assignmentId: req.params.id,
                    receiverId: asn.activeWriterId,
                    amount: writerPayout,
                    type: 'DISPUTE_PAYOUT',
                    status: 'COMPLETED',
                    timestamp: FieldValue.serverTimestamp()
                });
            }

            // Refund seeker (if any)
            if (seekerRefund > 0) {
                const seekerWallet = db.collection('wallets').doc(asn.seekerId);
                t.set(seekerWallet, { userId: asn.seekerId, balance: FieldValue.increment(seekerRefund) }, { merge: true });
                t.set(db.collection('transactions').doc(), {
                    assignmentId: req.params.id,
                    receiverId: asn.seekerId,
                    amount: seekerRefund,
                    type: 'DISPUTE_REFUND',
                    status: 'COMPLETED',
                    timestamp: FieldValue.serverTimestamp()
                });
            }

            t.update(assignmentRef, {
                status: writerPayout > 0 ? 'COMPLETED' : 'CANCELLED',
                disputeResolution: resolution,
                disputeWriterShare: share,
                disputeResolvedAt: FieldValue.serverTimestamp(),
                disputeResolvedBy: req.user.uid,
                disputeNote: String(note || aiNote).substring(0, 1000)
            });

            return { writerId: asn.activeWriterId, seekerId: asn.seekerId, writerPayout, seekerRefund, title: asn.title, share };
        });

        // Audit + notifications
        await db.collection('events').add({
            service: 'DISPUTE',
            description: `⚖️ Dispute resolved on #${req.params.id} (${resolution}). Split: ${result.share * 100}% Writer / ${(1 - result.share) * 100}% Seeker`,
            status: 'SUCCESS',
            timestamp: FieldValue.serverTimestamp()
        });

        if (result.writerId) {
            createNotification(result.writerId, {
                type: 'DISPUTE_RESOLVED',
                title: result.writerPayout > 0 ? '✅ Dispute resolved — funds released' : 'Dispute resolved',
                body: result.writerPayout > 0 ? `₹${result.writerPayout.toLocaleString()} credited to your wallet` : 'No payout was issued.',
                link: `/apps/writer-mobile/writer.html#wallet`,
                meta: { assignmentId: req.params.id }
            });
        }
        createNotification(result.seekerId, {
            type: 'DISPUTE_RESOLVED',
            title: result.seekerRefund > 0 ? '✅ Dispute resolved — refund issued' : 'Dispute resolved',
            body: result.seekerRefund > 0 ? `₹${result.seekerRefund.toLocaleString()} refunded to your wallet` : 'Funds released to writer.',
            link: `/apps/seeker-web/wallet.html`,
            meta: { assignmentId: req.params.id }
        });

        res.json({ message: 'Dispute resolved successfully', ...result });
    } catch (err) {
        const code = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_STATE' ? 409 : 400;
        console.error('Resolve dispute error:', err.message);
        res.status(code).json({ error: err.message });
    }
});

// --- LIST USERS (search by email/name, paginated) ---
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 100);
        const search = String(req.query.search || '').trim().toLowerCase();
        const snap = await db.collection('users').limit(500).get();
        let users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (search) {
            users = users.filter(u =>
                (u.email || '').toLowerCase().includes(search) ||
                (u.name || '').toLowerCase().includes(search) ||
                (u.cityNormalized || '').includes(search)
            );
        }
        users = users.slice(0, limit).map(u => ({
            id: u.id, email: u.email, name: u.name, role: u.role,
            city: u.city, pincode: u.pincode, banned: !!u.banned,
            metrics: u.metrics || null,
            subscription: u.subscription || null,
            writerSubscription: u.writerSubscription || null,
            createdAt: u.createdAt || null
        }));
        res.json(users);
    } catch (err) {
        console.error('List users error:', err.message);
        res.status(500).json({ error: 'Could not fetch users' });
    }
});

// --- BAN / UNBAN USER ---
app.post('/api/admin/users/:uid/ban', requireAuth, requireAdmin, async (req, res) => {
    try {
        const banned = !!req.body.banned;
        const reason = String(req.body.reason || '').substring(0, 300);
        if (req.params.uid === req.user.uid) {
            return res.status(400).json({ error: 'You cannot ban yourself' });
        }
        await db.collection('users').doc(req.params.uid).set({
            banned, bannedReason: banned ? reason : null,
            bannedAt: banned ? FieldValue.serverTimestamp() : null,
            bannedBy: banned ? req.user.uid : null
        }, { merge: true });

        // Revoke active sessions when banning
        if (banned) {
            try { await admin.auth().revokeRefreshTokens(req.params.uid); } catch (_) {}
        }

        await db.collection('events').add({
            service: 'ADMIN',
            description: `${banned ? 'BANNED' : 'UNBANNED'} user ${req.params.uid} by ${req.user.uid}${reason ? ' — ' + reason : ''}`,
            status: banned ? 'WARNING' : 'INFO',
            timestamp: FieldValue.serverTimestamp()
        });

        res.json({ uid: req.params.uid, banned });
    } catch (err) {
        console.error('Ban user error:', err.message);
        res.status(500).json({ error: 'Could not update user' });
    }
});

// --- RECENT TRANSACTIONS (payouts/refunds/topups for monitoring) ---
app.get('/api/admin/transactions', requireAuth, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const type = String(req.query.type || '').toUpperCase();
        let q = db.collection('transactions').orderBy('timestamp', 'desc').limit(limit);
        if (type) q = db.collection('transactions').where('type', '==', type).orderBy('timestamp', 'desc').limit(limit);
        const snap = await q.get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        console.error('Admin tx error:', err.message);
        res.status(500).json({ error: 'Could not fetch transactions' });
    }
});

// --- GLOBAL ERROR HANDLER (last middleware — catches anything not handled above) ---
// Sends to Sentry if configured, then returns a generic 500 to the client
// (never leak stack traces / internals).
app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    if (Sentry) {
        try { Sentry.captureException(err); } catch (_) { /* noop */ }
    }
    res.status(err.status || 500).json({
        error: err.expose ? err.message : 'Internal server error'
    });
});

// Last-resort safety net: log uncaught promises so Render logs surface them
process.on('unhandledRejection', (reason) => {
    console.error('UnhandledRejection:', reason);
    if (Sentry) {
        try { Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason))); } catch (_) {}
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Writely API Gateway (Firebase Admin) running on port ${PORT}`);
});
