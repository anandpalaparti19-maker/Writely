import express from 'express';
import cors from 'cors';
import multer from 'multer';
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

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

console.log('✅ Writely API Gateway (Firebase Admin) Starting...');

// --- RAZORPAY ---
app.get('/api/payments/razorpay/config', (req, res) => {
    res.json({ keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock' });
});

app.post('/api/payments/razorpay/create-order', async (req, res) => {
    try {
        const { amount, currency = "INR", receipt = "receipt_order_1" } = req.body;
        const order = await razorpay.orders.create({ amount: Math.round(amount * 100), currency, receipt });
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payments/razorpay/verify', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId } = req.body;
        const secret = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret_mock';

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature === razorpay_signature) {
            // Update subscription in Firestore from backend
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + 11); // Example: 11 days

            await db.collection('users').doc(userId).update({
                subscription: {
                    type: 'ONE_DAY_PASS',
                    expiresAt: admin.firestore.Timestamp.fromDate(endDate)
                }
            });

            res.json({ status: 'success', message: 'Payment verified and subscription activated', expiresAt: endDate });
        } else {
            res.status(400).json({ error: 'Invalid signature' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ESCROW ---
app.post('/api/assignments/:id/escrow', async (req, res) => {
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

// --- RELEASE FUNDS ---
app.post('/api/assignments/:id/release', async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const assignmentSnap = await assignmentRef.get();
        const assignment = assignmentSnap.data();

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
app.post('/api/assignments', upload.array('attachments', 5), async (req, res) => {
    try {
        const { title, description, budget, seekerId, pages, deliveryMethod, deliveryAddress } = req.body;
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
                const [url] = await blob.getSignedUrl({ action: 'read', expires: '01-01-2100' });
                attachments.push({ filename: file.originalname, url, mimetype: file.mimetype, size: file.size });
            }
        }

        const docRef = await db.collection('assignments').add({
            title: title || '',
            description: description || '',
            pages: Number(pages) || 0,
            budget: Number(budget) || 0,
            seekerId: seekerId || '',
            status: 'POSTED',
            deliveryMethod: deliveryMethod || 'Digital',
            deliveryAddress: deliveryAddress || '',
            attachments,
            createdAt: FieldValue.serverTimestamp()
        });

        res.status(201).json({ id: docRef.id, title, status: 'POSTED' });
    } catch (err) {
        console.error("Create Assignment Error:", err);
        res.status(400).json({ error: err.message });
    }
});

// --- GET JOB FEED ---
app.get('/api/assignments', async (req, res) => {
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
app.post('/api/assignments/:id/bid', async (req, res) => {
    try {
        const { writerId, amount, proposal } = req.body;
        await db.collection('assignments').doc(req.params.id).update({
            bids: FieldValue.arrayUnion({ writerId, amount, proposal, timestamp: new Date() }),
            status: 'BIDDING'
        });
        res.json({ message: 'Bid submitted successfully' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- ASSIGN WRITER & START PROJECT (WITH ESCROW) ---
app.post('/api/assignments/:id/assign', async (req, res) => {
    try {
        const { writerId } = req.body;
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        
        await db.runTransaction(async (t) => {
            const snap = await t.get(assignmentRef);
            if (!snap.exists) throw new Error("Assignment not found");
            const assignment = snap.data();

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

// --- WITHDRAW FUNDS ---
app.post('/api/wallets/:userId/withdraw', async (req, res) => {
    try {
        const { userId } = req.params;
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

// --- SUBMIT SOLUTION ---
app.post('/api/assignments/:id/submit', upload.single('solution'), async (req, res) => {
    try {
        let solutionData = {
            deliveredAt: new Date(),
            notes: req.body.notes || ''
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

        await db.collection('assignments').doc(req.params.id).update({
            solution: solutionData,
            status: 'REVIEW'
        });
        res.json({ message: 'Solution submitted. Your seeker has been notified.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- SECURE DOWNLOAD ENDPOINT ---
app.get('/api/assignments/:id/download', async (req, res) => {
    try {
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const doc = await assignmentRef.get();
        if (!doc.exists) return res.status(404).send('Not found');
        
        const job = doc.data();
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

// --- DISPUTE SYSTEM ---
app.post('/api/assignments/:id/dispute', async (req, res) => {
    try {
        const { reason } = req.body;
        const assignmentRef = db.collection('assignments').doc(req.params.id);
        const snap = await assignmentRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Assignment not found' });
        
        const assignment = snap.data();

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

// --- AI SUPPORT CHAT ---
app.post('/api/support/chat', async (req, res) => {
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

// --- ADMIN EVENTS ---

app.get('/api/events', (req, res) => {
    res.json([
        { id: 1, service: 'PAYMENT', description: 'Escrow Locked: Order #442', status: 'SUCCESS' },
        { id: 2, service: 'AUTH', description: 'User Verified: Sarah Jenkins', status: 'SUCCESS' }
    ]);
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Writely API Gateway (Firebase Admin) running on port ${PORT}`);
});
