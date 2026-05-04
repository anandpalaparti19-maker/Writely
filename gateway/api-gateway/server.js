import express from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import Razorpay from 'razorpay';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { admin, db, bucket } from './firebase.js';
import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/googleai';

dotenv.config();

// Initialize Genkit
console.log('🔑 Using Google GenAI Key:', process.env.GOOGLE_GENAI_API_KEY ? `${process.env.GOOGLE_GENAI_API_KEY.substring(0, 8)}...` : 'MISSING');
const ai = genkit({
    plugins: [googleAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY })],
    model: googleAI.model('gemini-3-flash-preview'),
});


const FieldValue = admin.firestore.FieldValue;

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret_mock'
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
    /^https:\/\/([a-z0-9-]+\.)?netlify\.app$/i,   // any netlify subdomain (deploy previews too)
    /^https:\/\/([a-z0-9-]+\.)?onrender\.com$/i,
    /^http:\/\/localhost(:\d+)?$/i,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/i
];
app.use(cors({
    origin: (origin, cb) => {
        // Allow same-origin / curl / Postman (no Origin header)
        if (!origin) return cb(null, true);
        if (allowedOriginPatterns.some(rx => rx.test(origin))) return cb(null, true);
        console.warn('CORS blocked origin:', origin);
        cb(new Error('Origin not allowed'));
    },
    credentials: true
}));

app.use(express.json({ limit: '1mb' }));

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

console.log('✅ Writely API Gateway (Firebase Admin) Starting...');

// --- RAZORPAY ---
app.get('/api/payments/razorpay/config', (req, res) => {
    res.json({ keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock' });
});

app.post('/api/payments/razorpay/create-order', paymentLimiter, requireAuth, async (req, res) => {
    try {
        const { amount, currency = "INR" } = req.body;
        const numAmount = Number(amount);
        if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 100000) {
            return res.status(400).json({ error: 'Invalid amount (must be 1–100000)' });
        }
        const order = await razorpay.orders.create({
            amount: Math.round(numAmount * 100),
            currency,
            receipt: `rcpt_${req.user.uid.substring(0, 8)}_${Date.now()}`
        });
        res.json(order);
    } catch (err) {
        console.error('Create order error:', err.message);
        res.status(500).json({ error: 'Could not create order' });
    }
});

app.post('/api/payments/razorpay/verify', paymentLimiter, requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planType } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment parameters' });
        }

        const secret = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret_mock';
        const body = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: 'Invalid signature' });
        }

        // userId comes from the verified Firebase token — NOT from the request body (prevents spoofing)
        const userId = req.user.uid;
        const endDate = new Date();
        let subscriptionField = 'subscription';
        let subType = 'SEEKER_PASS';

        if (planType === 'WRITER_ZERO_FEE') {
            endDate.setHours(endDate.getHours() + 24); // 24 hours
            subscriptionField = 'writerSubscription';
            subType = 'WRITER_ZERO_FEE';
        } else {
            endDate.setDate(endDate.getDate() + 11);  // 11 days for seeker pass
        }

        await db.collection('users').doc(userId).update({
            [subscriptionField]: {
                type: subType,
                expiresAt: admin.firestore.Timestamp.fromDate(endDate),
                paymentId: razorpay_payment_id
            }
        });

        res.json({ status: 'success', message: 'Payment verified', expiresAt: endDate });
    } catch (err) {
        console.error('Verify payment error:', err.message);
        res.status(500).json({ error: 'Verification failed' });
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
app.post('/api/assignments/:id/release', requireAuth, async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const assignmentSnap = await assignmentRef.get();
        if (!assignmentSnap.exists) return res.status(404).json({ error: 'Assignment not found' });
        const assignment = assignmentSnap.data();

        // Ownership check
        if (assignment.seekerId !== req.user.uid) {
            return res.status(403).json({ error: 'Only the seeker can release funds' });
        }
        if (assignment.status === 'COMPLETED') {
            return res.status(400).json({ error: 'Already released' });
        }
        if (!assignment.activeWriterId) {
            return res.status(400).json({ error: 'No writer assigned' });
        }

        let writerDeduction = 15; // Standard

        // Check for Writer Zero-Fee Pass (now 2% Residual)
        const writerRef = db.collection('users').doc(assignment.activeWriterId);
        const writerSnap = await writerRef.get();
        const writerData = writerSnap.data();

        if (writerData?.writerSubscription?.expiresAt?.toDate() > new Date()) {
            writerDeduction = Math.round(assignment.budget * 0.02); // 2% Residual
        }

        const writerPayout = assignment.budget - writerDeduction;

        const walletRef = db.collection('wallets').doc(assignment.activeWriterId);
        const walletSnap = await walletRef.get();

        if (walletSnap.exists) {
            await walletRef.update({ balance: FieldValue.increment(writerPayout) });
        } else {
            await walletRef.set({ userId: assignment.activeWriterId, balance: writerPayout });
        }

        await db.collection('transactions').add({
            assignmentId: req.params.id,
            receiverId: assignment.activeWriterId,
            amount: writerPayout,
            type: 'PAYOUT',
            status: 'COMPLETED',
            timestamp: FieldValue.serverTimestamp()
        });

        await assignmentRef.update({ 
            status: 'COMPLETED',
            writerPayout,
            platformEarnings: (assignment.platformFeePaid || 0) + writerDeduction
        });

        res.json({ message: 'Funds released successfully', writerPayout, writerDeduction });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- CREATE ASSIGNMENT ---
app.post('/api/assignments', requireAuth, upload.array('attachments', 5), async (req, res) => {
    try {
        const { title, description, budget, pages, deliveryMethod, deliveryAddress } = req.body;

        // Validate
        if (!title || title.trim().length < 3) return res.status(400).json({ error: 'Title required (min 3 chars)' });
        if (!description || description.trim().length < 10) return res.status(400).json({ error: 'Description required (min 10 chars)' });
        const numBudget = Number(budget);
        if (!Number.isFinite(numBudget) || numBudget < 50 || numBudget > 500000) {
            return res.status(400).json({ error: 'Budget must be ₹50 – ₹500,000' });
        }

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

        const docRef = await db.collection('assignments').add({
            title: title.trim(),
            description: description.trim(),
            pages: Number(pages) || 0,
            budget: numBudget,
            seekerId,
            status: 'POSTED',
            deliveryMethod: deliveryMethod || 'Digital',
            deliveryAddress: (deliveryAddress || '').trim(),
            attachments,
            createdAt: FieldValue.serverTimestamp()
        });

        res.status(201).json({ id: docRef.id, title, status: 'POSTED' });
    } catch (err) {
        console.error("Create Assignment Error:", err);
        res.status(400).json({ error: err.message });
    }
});

// --- GET JOB FEED (public list of POSTED jobs; only writers care, but open is fine) ---
app.get('/api/assignments', requireAuth, async (req, res) => {
    try {
        const snapshot = await db.collection('assignments')
            .where('status', '==', 'POSTED')
            .get();

        const jobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // Sort in memory to avoid Firestore Composite Index requirements
        jobs.sort((a, b) => {
            const timeA = a.createdAt ? a.createdAt.toMillis() : 0;
            const timeB = b.createdAt ? b.createdAt.toMillis() : 0;
            return timeB - timeA; // Descending
        });

        res.json(jobs);
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
        res.json({ message: 'Bid submitted successfully' });
    } catch (err) {
        console.error('Bid error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// --- ASSIGN WRITER & START PROJECT (only the SEEKER can do this) ---
app.post('/api/assignments/:id/assign', requireAuth, async (req, res) => {
    try {
        const { writerId } = req.body;
        if (!writerId) return res.status(400).json({ error: 'writerId required' });

        const assignmentRef = db.collection('assignments').doc(req.params.id);
        
        await db.runTransaction(async (t) => {
            const snap = await t.get(assignmentRef);
            if (!snap.exists) throw new Error("Assignment not found");
            const assignment = snap.data();

            // Ownership: only the seeker who owns the assignment can hire
            if (assignment.seekerId !== req.user.uid) {
                throw new Error("Only the seeker can hire a writer");
            }
            if (assignment.status !== 'POSTED' && assignment.status !== 'BIDDING') {
                throw new Error("Project is no longer available for hiring");
            }

            // Lock Escrow
            let platformFee = 15;
            const seekerRef = db.collection('users').doc(assignment.seekerId);
            const seekerSnap = await t.get(seekerRef);
            const seekerData = seekerSnap.data();

            if (seekerData?.subscription?.expiresAt?.toDate() > new Date()) {
                platformFee = Math.round(assignment.budget * 0.02);
            }

            const totalAmount = assignment.budget + platformFee;

            t.set(db.collection('transactions').doc(), {
                assignmentId: req.params.id,
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
        res.json({ message: 'Solution submitted. Your seeker has been notified.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
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

        res.json({ message: 'Project frozen. Arbitration initiated.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
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

        const response = await ai.generate({
            system: systemPrompt,
            prompt: message,
            messages: messages
        });

        res.json({ text: response.text });
    } catch (err) {
        console.error("AI Chat Error:", err);
        res.status(500).json({ error: "I'm having trouble connecting right now. Please try again later." });
    }
});

// --- ADMIN EVENTS (reads from real events collection; admin-only) ---
app.get('/api/events', requireAuth, async (req, res) => {
    try {
        // Verify admin role
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists || userDoc.data().role !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const snap = await db.collection('events').orderBy('timestamp', 'desc').limit(50).get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        console.error('Events error:', err.message);
        res.status(500).json({ error: 'Could not fetch events' });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Writely API Gateway (Firebase Admin) running on port ${PORT}`);
});
