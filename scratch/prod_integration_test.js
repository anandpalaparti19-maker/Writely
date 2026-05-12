const admin = require('firebase-admin');
const path = require('path');
const serviceAccountPath = path.join(process.cwd(), 'gateway', 'api-gateway', 'serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

async function runProductionTest() {
    console.log('🧪 Starting Automated Production Integration Test...');
    
    // Live API URL discovered from logic.js
    const API_BASE = 'https://writely-55q5.onrender.com/api';
    const testEmail = `prod_test_${Date.now()}@example.com`;
    const testPassword = 'TestPassword@123!';

    try {
        console.log(`📡 Testing Registration for: ${testEmail}`);
        const regRes = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'QA Automation Bot',
                email: testEmail,
                password: testPassword,
                role: 'SEEKER',
                city: 'Delhi',
                pincode: '110001'
            })
        });

        const regData = await regRes.json();
        if (regRes.status !== 201) {
            throw new Error(`Registration Failed (${regRes.status}): ${regData.error || JSON.stringify(regData)}`);
        }
        
        console.log('✅ Registration Successful (201 Created)');

        // --- CLEANUP: Always delete test users so they don't block real registrations ---
        console.log('🧹 Cleaning up test user from Firebase Auth...');
        const testUser = await admin.auth().getUserByEmail(testEmail);
        await admin.auth().deleteUser(testUser.uid);
        await admin.firestore().collection('users').doc(testUser.uid).delete();
        console.log('✅ Test user cleaned up successfully.');

        console.log('✨ Integration Test Passed & Cleaned Up.');
        
    } catch (err) {
        console.error('❌ Integration Test Failed:', err.message);
        process.exit(1);
    }
}

runProductionTest();
