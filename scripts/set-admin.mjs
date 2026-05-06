/**
 * Promote (or demote) a Writely user to ADMIN.
 *
 * Reuses the gateway's Firebase Admin SDK setup, so it picks up either:
 *   - gateway/api-gateway/serviceAccountKey.json (local), or
 *   - FIREBASE_SERVICE_ACCOUNT env var (production).
 *
 * Usage (from repo root):
 *   node scripts/set-admin.mjs <email>            # promote
 *   node scripts/set-admin.mjs <email> --revoke   # demote back to original role
 *   node scripts/set-admin.mjs --uid <uid>        # promote by UID
 *
 * Examples:
 *   node scripts/set-admin.mjs you@example.com
 *   node scripts/set-admin.mjs --uid 9XaB8…
 */
import { admin, db } from '../gateway/api-gateway/firebase.js';

const args = process.argv.slice(2);
if (!args.length) {
    console.error('Usage: node scripts/set-admin.mjs <email> [--revoke]');
    console.error('       node scripts/set-admin.mjs --uid <uid> [--revoke]');
    process.exit(1);
}

const revoke = args.includes('--revoke');
let target = null;
let mode = null;

if (args[0] === '--uid') {
    if (!args[1]) { console.error('Missing UID after --uid'); process.exit(1); }
    target = args[1]; mode = 'uid';
} else {
    target = args[0]; mode = 'email';
}

(async () => {
    try {
        let uid;
        if (mode === 'email') {
            const userRecord = await admin.auth().getUserByEmail(target);
            uid = userRecord.uid;
            console.log(`Resolved ${target} → ${uid}`);
        } else {
            uid = target;
        }

        const ref = db.collection('users').doc(uid);
        const snap = await ref.get();
        if (!snap.exists) {
            console.error(`No users/${uid} document. The user must register/login at least once first.`);
            process.exit(2);
        }
        const current = snap.data();

        if (revoke) {
            const previousRole = current.previousRole || 'SEEKER';
            await ref.set({ role: previousRole, previousRole: admin.firestore.FieldValue.delete() }, { merge: true });
            console.log(`✅ Demoted ${uid} → role: ${previousRole}`);
        } else {
            if (current.role === 'ADMIN') {
                console.log(`ℹ️  ${uid} is already ADMIN. No change.`);
                process.exit(0);
            }
            await ref.set({ role: 'ADMIN', previousRole: current.role || 'SEEKER' }, { merge: true });
            console.log(`✅ Promoted ${uid} → role: ADMIN (was ${current.role || 'SEEKER'})`);
        }

        // Force a token refresh so role-based middleware picks it up immediately.
        await admin.auth().revokeRefreshTokens(uid);
        console.log('🔑 Refresh tokens revoked — user will need to re-authenticate.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Failed:', err.message);
        process.exit(3);
    }
})();
