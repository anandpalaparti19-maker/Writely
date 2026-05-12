
async function testRegisterLive() {
    const email = `live_test_${Date.now()}@example.com`;
    const payload = {
        email: email,
        password: 'Password123!',
        fullName: 'Live Test User',
        role: 'seeker',
        phoneNumber: '+919876543210',
        city: 'Delhi',
        pincode: '110001',
        collegeName: 'Test College'
    };

    console.log('Testing LIVE registration with:', email);
    try {
        const res = await fetch('https://writely-55q5.onrender.com/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        console.log('Status:', res.status);
        console.log('Response:', data);
    } catch (err) {
        console.error('Fetch error:', err.message);
    }
}

testRegisterLive();
