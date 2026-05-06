/**
 * 🚨 DESTRUCTIVE — Wipes ALL Writely data for a clean slate.
 *
 * Deletes:
 *   - Every Firebase Auth user
 *   - Every document in: users, assignments, bids, wallets, transactions, messages, events
 *
 * Usage:
 *   node scripts/nuke-database.js --i-really-want-to-delete-everything
 *
 * The flag is required. Without it, the script just prints what it WOULD do.
 *
 * Run from inside: gateway/api-gateway/
 */
import admin from 'firebase-admin';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const CONFIRM_FLAG = '--i-really-want-to-delete-everything';
const isConfirmed = process.argv.includes(CONFIRM_FLAG);

const COLLECTIONS_TO_WIPE = [
    'users',
    'assignments',
    'bids',
    'wallets',
    'transactions',
    'messages',
    'events'
];

// --- Init Admin SDK ---
let serviceAccount;
try {
    serviceAccount = require('../serviceAccountKey.json');
} catch (e) {
    console.error('❌ serviceAccountKey.json not found in gateway/api-gateway/');
    process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// --- Helpers ---
async function deleteCollection(collectionPath, batchSize = 100) {
    const collectionRef = db.collection(collectionPath);
    let totalDeleted = 0;

    while (true) {
        const snapshot = await collectionRef.limit(batchSize).get();
        if (snapshot.empty) break;

        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        totalDeleted += snapshot.size;
        console.log(`   deleted ${snapshot.size} docs (running total: ${totalDeleted})`);
    }
    return totalDeleted;
}

async function deleteAllAuthUsers() {
    let total = 0;
    let nextPageToken;
    do {
        const result = await admin.auth().listUsers(1000, nextPageToken);
        if (result.users.length === 0) break;

        const uids = result.users.map(u => u.uid);
        const batchResult = await admin.auth().deleteUsers(uids);
        total += batchResult.successCount;
        if (batchResult.failureCount > 0) {
            console.warn(`   ⚠️ ${batchResult.failureCount} users failed to delete`);
        }
        console.log(`   deleted ${batchResult.successCount} auth users (running total: ${total})`);
        nextPageToken = result.pageToken;
    } while (nextPageToken);
    return total;
}

// --- Main ---
async function main() {
    console.log('=================================================');
    console.log('🚨 WRITELY DATABASE NUKE');
    console.log('=================================================\n');

    // Dry-run preview
    console.log('Counting what would be deleted...\n');
    let totalDocs = 0;
    for (const coll of COLLECTIONS_TO_WIPE) {
        const snap = await db.collection(coll).count().get();
        const count = snap.data().count;
        totalDocs += count;
        console.log(`   ${coll.padEnd(15)} : ${count} docs`);
    }
    const authList = await admin.auth().listUsers(1000);
    console.log(`   ${'auth users'.padEnd(15)} : ${authList.users.length}${authList.pageToken ? '+' : ''} users`);
    console.log(`\n   TOTAL FIRESTORE DOCS TO DELETE: ${totalDocs}\n`);

    if (!isConfirmed) {
        console.log('⚠️  DRY RUN — nothing was deleted.');
        console.log(`To actually delete, re-run with:  node scripts/nuke-database.js ${CONFIRM_FLAG}\n`);
        process.exit(0);
    }

    console.log('🔥 CONFIRMED — proceeding to delete in 3 seconds...');
    await new Promise(r => setTimeout(r, 3000));

    // Wipe collections
    for (const coll of COLLECTIONS_TO_WIPE) {
        console.log(`\n🗑  Deleting collection: ${coll}`);
        const count = await deleteCollection(coll);
        console.log(`   ✅ ${count} docs deleted from ${coll}`);
    }

    // Wipe Auth users
    console.log('\n🗑  Deleting Firebase Auth users');
    const authCount = await deleteAllAuthUsers();
    console.log(`   ✅ ${authCount} auth users deleted`);

    console.log('\n=================================================');
    console.log('✅ DONE — database wiped clean');
    console.log('=================================================');
    process.exit(0);
}

main().catch(err => {
    console.error('\n❌ Nuke failed:', err);
    process.exit(1);
});
