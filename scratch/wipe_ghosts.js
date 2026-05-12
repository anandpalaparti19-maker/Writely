
const admin = require('firebase-admin');
const path = require('path');
const serviceAccountPath = path.join(process.cwd(), 'gateway', 'api-gateway', 'serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const auth = admin.auth();
const ADMIN_EMAILS = [
    'anandpalaparti009@gmail.com',
    'anandpalaparti01@gmail.com',
    'anandpalaparti001@gmail.com',
    'rishikabaggi@gmail.com'
];

async function wipeGhostUsers() {
    console.log('👻 Wiping ghost users from Auth...');
    try {
        const listResult = await auth.listUsers();
        const users = listResult.users;
        
        let deletedCount = 0;
        for (const user of users) {
            if (!ADMIN_EMAILS.includes(user.email)) {
                await auth.deleteUser(user.uid);
                console.log(`✅ Deleted ghost: ${user.email}`);
                deletedCount++;
            } else {
                console.log(`🛡️  Preserved Admin: ${user.email}`);
            }
        }
        
        console.log(`✨ Wipe complete. Removed ${deletedCount} ghost users.`);
    } catch (err) {
        console.error('Ghost wipe failed:', err);
    }
}

wipeGhostUsers();
