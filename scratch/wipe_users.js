
const admin = require('firebase-admin');
const path = require('path');
// Use absolute path to avoid confusion
const serviceAccountPath = path.join(process.cwd(), 'gateway', 'api-gateway', 'serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

async function wipeUsers() {
    console.log('🧹 Starting total user wipe...');

    try {
        // 1. Get all users from Firestore to find ADMINs
        const userSnap = await db.collection('users').get();
        const admins = [];
        const toDelete = [];

        userSnap.forEach(doc => {
            if (doc.data().role === 'ADMIN') {
                admins.push(doc.id);
                console.log(`🛡️  Preserving Admin: ${doc.data().email} (${doc.id})`);
            } else {
                toDelete.push(doc.id);
            }
        });

        console.log(`📉 Found ${toDelete.length} non-admin users to delete.`);

        if (toDelete.length === 0) {
            console.log('✨ No non-admin users to delete.');
            return;
        }

        // 2. Delete from Auth
        for (const uid of toDelete) {
            try {
                await auth.deleteUser(uid);
                console.log(`✅ Auth deleted: ${uid}`);
            } catch (e) {
                console.error(`❌ Auth delete failed for ${uid}:`, e.message);
            }
        }

        // 3. Delete from Firestore
        const batchSize = 400;
        for (let i = 0; i < toDelete.length; i += batchSize) {
            const batch = db.batch();
            const chunk = toDelete.slice(i, i + batchSize);
            chunk.forEach(uid => {
                batch.delete(db.collection('users').doc(uid));
            });
            await batch.commit();
            console.log(`📦 Firestore batch deleted (${i + chunk.length}/${toDelete.length})`);
        }

        console.log('✨ Wipe complete. Admins preserved.');
    } catch (err) {
        console.error('Wipe failed:', err);
    }
}

wipeUsers();
