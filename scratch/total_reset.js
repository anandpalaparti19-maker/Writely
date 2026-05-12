
const admin = require('firebase-admin');
const path = require('path');
const serviceAccountPath = path.join(process.cwd(), 'gateway', 'api-gateway', 'serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function deleteCollection(collectionPath, batchSize = 400) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(query, resolve) {
    const snapshot = await query.get();

    const batchSize = snapshot.size;
    if (batchSize === 0) {
        resolve();
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

    process.nextTick(() => {
        deleteQueryBatch(query, resolve);
    });
}

async function totalReset() {
    console.log('🧨 Starting total system reset...');

    const collections = ['assignments', 'events', 'messages', 'withdrawals', 'subscriptions'];

    for (const col of collections) {
        console.log(`⌛ Clearing collection: ${col}...`);
        await deleteCollection(col);
        console.log(`✅ Cleared: ${col}`);
    }

    console.log('✨ Total system reset complete. Environment is now fresh for launch.');
}

totalReset();
