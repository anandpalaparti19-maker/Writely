
async function runProductionTest() {
    console.log('🧪 Starting Automated Production Integration Test (Corrected URL)...');
    
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
        console.log('✨ Integration Test Passed: The live Render API is active and creating users in Firestore.');
        
    } catch (err) {
        console.error('❌ Integration Test Failed:', err.message);
        process.exit(1);
    }
}

runProductionTest();
