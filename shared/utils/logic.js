/**
 * Writely System Logic & Firebase Integration
 */

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCbZu69j_2STCm7QCaJbkKfaO2S9kqjcRI",
  authDomain: "writely-304a8.firebaseapp.com",
  databaseURL: "https://writely-304a8-default-rtdb.firebaseio.com",
  projectId: "writely-304a8",
  storageBucket: "writely-304a8.firebasestorage.app",
  messagingSenderId: "552037081907",
  appId: "1:552037081907:web:5c3902b9a8bedd6e7b1446",
  measurementId: "G-TZ8EP71QXL"
};

// --- FIREBASE INITIALIZATION ---
let app;
try {
    if (typeof firebase !== 'undefined') {
        console.log("🔥 Initializing Writely Firebase...");
        app = firebase.initializeApp(firebaseConfig);
        console.log("✅ Writely Firebase Online");
    } else {
        console.warn("⚠️ Firebase SDK not detected.");
    }
} catch (e) {
    console.error("❌ Firebase Init Error:", e);
}

const Writely = {
    events: [],
    API_URL: (
        window.location.hostname === 'localhost' || 
        window.location.hostname === '127.0.0.1' || 
        window.location.hostname.startsWith('192.168.') || 
        window.location.hostname.startsWith('10.') || 
        window.location.hostname.startsWith('172.') ||
        window.location.hostname === ''
    ) 
        ? `http://${window.location.hostname || 'localhost'}:5001/api` 
        : 'https://writely-55q5.onrender.com/api',

    /**
     * Authenticated fetch helper — attaches the current user's Firebase ID token
     * to every request. Auto-redirects to login on 401.
     *
     * Usage: Writely.apiFetch('/assignments', { method: 'POST', body: JSON.stringify(x) })
     */
    apiFetch: async function(path, options = {}) {
        const url = `${this.API_URL}${path.startsWith('/') ? path : '/' + path}`;
        const headers = { ...(options.headers || {}) };

        // Attach ID token when a user is signed in
        try {
            const user = firebase.auth().currentUser;
            if (user) {
                const token = await user.getIdToken();
                headers['Authorization'] = `Bearer ${token}`;
            }
        } catch (e) { /* no user / sdk not loaded */ }

        // Set Content-Type automatically for JSON payloads (unless it's FormData)
        if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, { ...options, headers });

        if (response.status === 401) {
            console.warn('Auth expired — redirecting to login');
            // Only auto-redirect on actual pages, not from admin.html etc on first load
            if (!window.location.pathname.endsWith('index.html') && !window.location.pathname.endsWith('/')) {
                window.location.href = '/apps/seeker-web/index.html';
            }
        }
        return response;
    },

    fetchEvents: async function() {
        try {
            const response = await this.apiFetch('/events');
            if (!response.ok) return; // silently fail for non-admins
            this.events = await response.json();
            this.updateAdminUI();
        } catch (err) { console.error('API Sync Failed:', err); }
    },

    updateAdminUI: function() {
        const tableBody = document.querySelector('tbody');
        if(!tableBody) return;
        tableBody.innerHTML = this.events.map(e => `
            <tr>
                <td>#${e.id || 'SYNC'}</td>
                <td><span class="badge badge-purple">${e.service}</span></td>
                <td>${e.description}</td>
                <td><span class="status-dot bg-success"></span> ${e.status}</td>
                <td>${e.time || 'Live'}</td>
            </tr>
        `).join('');
    }
};

// --- AUTHENTICATION & REGISTRATION ---
window.registerUser = async function(event) {
    if (event) event.preventDefault();
    const submitBtn = document.getElementById('submitBtn');
    const fullName = document.getElementById('fullName').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const collegeEl = document.getElementById('collegeName');
    const phoneEl = document.getElementById('phoneNumber');
    const collegeName = collegeEl ? collegeEl.value : '';
    const phoneNumber = phoneEl ? phoneEl.value : '';
    const role = (typeof selectedRole !== 'undefined' ? selectedRole : 'seeker').toUpperCase();

    try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = "Creating account..."; }
        const userCredential = await firebase.auth().createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        await firebase.firestore().collection('users').doc(user.uid).set({
            uid: user.uid,
            email: user.email,
            displayName: fullName,
            fullName: fullName,
            collegeName: collegeName,
            phoneNumber: phoneNumber,
            role: role,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            metrics: { totalSpent: 0, activeOrders: 0 }
        });

        alert("Account created successfully!");
        if (role === 'WRITER') {
            window.location.href = window.location.pathname.includes('seeker-web') ? '../writer-mobile/writer.html' : 'writer.html';
        } else {
            window.location.href = 'dashboard.html';
        }
    } catch (error) {
        alert("Registration Failed: " + error.message);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = "Create Account"; }
    }
};

window.loginUser = async function(event) {
    if (event) event.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const submitBtn = document.querySelector('button[type="submit"]');

    try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = "Signing in..."; }
        const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        const userDoc = await firebase.firestore().collection('users').doc(user.uid).get();
        if (userDoc.exists && userDoc.data().role === 'WRITER') {
            window.location.href = window.location.pathname.includes('seeker-web') ? '../writer-mobile/writer.html' : 'writer.html';
        } else {
            window.location.href = 'dashboard.html';
        }
    } catch (error) {
        alert("Login Failed: " + error.message);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = "Sign In"; }
    }
};

// --- PROFILE & SETTINGS ---
Writely.getUserProfile = async function() {
    return new Promise((resolve) => {
        firebase.auth().onAuthStateChanged(async (user) => {
            if (user) {
                const doc = await firebase.firestore().collection("users").doc(user.uid).get();
                resolve(doc.exists ? doc.data() : null);
            } else {
                resolve(null);
            }
        });
    });
};

Writely.updateUserProfile = async function(data) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("No user logged in");
    await firebase.firestore().collection("users").doc(user.uid).update({
        ...data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
};

Writely.uploadProfilePhoto = async function(file) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("No user logged in");

    const storageRef = firebase.storage().ref();
    const photoRef = storageRef.child("avatars/" + user.uid + "." + file.name.split(".").pop());
    
    const snapshot = await photoRef.put(file);
    const photoUrl = await snapshot.ref.getDownloadURL();

    await firebase.firestore().collection("users").doc(user.uid).update({
        avatarUrl: photoUrl,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    return photoUrl;
};

Writely.getJobFeed = async function() {
    try {
        const response = await this.apiFetch('/assignments');
        if (!response.ok) throw new Error("Failed to fetch jobs");
        return await response.json();
    } catch (err) {
        console.error("Job Feed Error:", err);
        return [];
    }
};

Writely.submitBid = async function(assignmentId, bidData) {
    try {
        const response = await this.apiFetch(`/assignments/${assignmentId}/bid`, {
            method: 'POST',
            body: JSON.stringify(bidData)
        });
        return await response.json();
    } catch (err) {
        console.error("Bid Error:", err);
        throw err;
    }
};

Writely.assignWriter = async function(assignmentId, writerId) {
    try {
        const response = await this.apiFetch(`/assignments/${assignmentId}/assign`, {
            method: 'POST',
            body: JSON.stringify({ writerId })
        });
        return await response.json();
    } catch (err) {
        console.error("Assign Error:", err);
        throw err;
    }
};

Writely.createAssignment = async function(formData) {
    try {
        const response = await this.apiFetch('/assignments', {
            method: 'POST',
            body: formData
        });
        return await response.json();
    } catch (err) {
        console.error("Post Error:", err);
        throw err;
    }
};

Writely.buySubscription = async function() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("Please login first");
    
    const configRes = await this.apiFetch('/payments/razorpay/config');
    const { keyId } = await configRes.json();

    const response = await this.apiFetch('/payments/razorpay/create-order', {
        method: 'POST',
        body: JSON.stringify({ amount: 120 })
    });
    const order = await response.json();
    if (!order || !order.id) throw new Error("Failed to initialize payment");

    return new Promise((resolve, reject) => {
        const options = {
            key: keyId,
            amount: order.amount,
            currency: "INR",
            name: "Writely",
            description: "Seeker One-Day Delivery Pass",
            order_id: order.id,
            handler: async function (res) {
                try {
                    const verifyResponse = await Writely.apiFetch('/payments/razorpay/verify', {
                        method: 'POST',
                        body: JSON.stringify({
                            planType: 'SEEKER_PASS',
                            razorpay_order_id: res.razorpay_order_id,
                            razorpay_payment_id: res.razorpay_payment_id,
                            razorpay_signature: res.razorpay_signature,
                            userId: user.uid
                        })
                    });

                    const result = await verifyResponse.json();
                    if (!verifyResponse.ok) throw new Error(result.error || "Payment verification failed");
                    
                    resolve(new Date(result.expiresAt));
                } catch (err) {
                    console.error("Payment Verification Error:", err);
                    reject(err);
                }
            },
            prefill: { email: user.email },
            theme: { color: "#6366F1" }
        };
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', function (response){ reject(new Error(response.error.description)); });
        rzp.open();
    });
};

Writely.buyWriterSubscription = async function() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("Please login first");
    
    const response = await this.apiFetch('/payments/razorpay/create-order', {
        method: 'POST',
        body: JSON.stringify({ amount: 30 })
    });
    const order = await response.json();
    if (!order || !order.id) throw new Error("Failed to initialize payment");

    return new Promise((resolve, reject) => {
        const options = {
            key: "rzp_test_mock",
            amount: order.amount,
            currency: "INR",
            name: "Writely",
            description: "Writer Zero-Fee Pass (24 Hours)",
            order_id: order.id,
            handler: async function (res) {
                try {
                    const endDate = new Date();
                    endDate.setHours(endDate.getHours() + 24);
                    
                    await firebase.firestore().collection('users').doc(user.uid).update({
                        writerSubscription: {
                            type: 'ZERO_FEE_PASS',
                            expiresAt: firebase.firestore.Timestamp.fromDate(endDate)
                        }
                    });
                    await Writely.apiFetch('/payments/razorpay/verify', {
                        method: 'POST',
                        body: JSON.stringify({
                            planType: 'WRITER_ZERO_FEE',
                            razorpay_order_id: order.id,
                            razorpay_payment_id: res.razorpay_payment_id,
                            razorpay_signature: res.razorpay_signature
                        })
                    });
                    resolve(endDate);
                } catch (err) { reject(err); }
            },
            prefill: { email: user.email },
            theme: { color: "#10B981" }
        };
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', function (response){ reject(new Error(response.error.description)); });
        rzp.open();
    });
};

Writely.logout = async function() {
    if(confirm("Are you sure you want to logout?")) {
        try {
            await firebase.auth().signOut();
            window.location.href = 'index.html';
        } catch (err) {
            console.error("Logout failed:", err);
        }
    }
};

// --- AI SUPPORT BOT LOGIC ---
const chatHistory = [];

window.toggleSupport = function() {
    const chatWin = document.getElementById('supportWindow');
    const trigger = document.getElementById('aiSupport');
    if (!chatWin) return;
    
    const isVisible = chatWin.style.display === 'flex';
    chatWin.style.display = isVisible ? 'none' : 'flex';
    if (trigger) trigger.classList.toggle('active', !isVisible);

    if (!isVisible && document.getElementById('aiMessages').children.length === 0) {
        addBotMessage("Hi! I'm the Writely Concierge. How can I help you today?");
    }
};

function addBotMessage(text) {
    const container = document.getElementById('aiMessages');
    const msg = document.createElement('div');
    msg.className = 'msg msg-bot';
    msg.innerText = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    chatHistory.push({ role: 'model', text });
}

function addUserMessage(text) {
    const container = document.getElementById('aiMessages');
    const msg = document.createElement('div');
    msg.className = 'msg msg-user';
    msg.innerText = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    chatHistory.push({ role: 'user', text });
}

window.askAI = async function() {
    const input = document.getElementById('supportInput');
    const text = input.value.trim();
    if (!text) return;

    addUserMessage(text);
    input.value = '';
    
    const typingMsg = document.createElement('div');
    typingMsg.className = 'msg msg-bot';
    typingMsg.innerText = '...';
    document.getElementById('aiMessages').appendChild(typingMsg);

    try {
        const response = await Writely.apiFetch('/support/chat', {
            method: 'POST',
            body: JSON.stringify({ message: text, history: chatHistory.slice(-6) })
        });
        const data = await response.json();
        typingMsg.remove();
        addBotMessage(data.text || data.error || "I encountered an error.");
    } catch (err) {
        if (typingMsg) typingMsg.remove();
        addBotMessage("Sorry, I'm having trouble connecting. Is the API running?");
    }
};

// Handle Enter Key
document.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'supportInput') {
        askAI();
    }
});

// --- REAL-TIME NOTIFICATIONS ---
Writely.initNotifications = function(userId) {
    if (!userId) return;
    
    // Request permission for browser notifications
    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }

    // Listen for project status changes (Seeker/Writer)
    firebase.firestore().collection('assignments')
        .where('seekerId', '==', userId)
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                if (change.type === 'modified') {
                    const job = change.doc.data();
                    Writely.showToast(`Project Update: "${job.title}" is now ${job.status}`);
                    Writely.pushNotify(`Project Update`, `"${job.title}" is now ${job.status}`);
                }
            });
        });

    // Listen for new messages
    firebase.firestore().collection('messages')
        .where('receiverId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                if (change.type === 'added') {
                    const msg = change.doc.data();
                    // Only notify if message is recent (within 10s) to avoid old alerts
                    if (msg.createdAt && (Date.now() - msg.createdAt.toMillis() < 10000)) {
                        Writely.showToast(`New Message: ${msg.text.substring(0, 30)}...`);
                        Writely.pushNotify(`New Message from Writely`, msg.text);
                    }
                }
            });
        });
};

Writely.showToast = function(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
        background: var(--ink-purple); color: white; padding: 12px 24px;
        border-radius: 50px; z-index: 9999; font-weight: 600; font-size: 14px;
        box-shadow: 0 10px 25px rgba(109, 40, 217, 0.3); animation: slideUp 0.3s ease-out;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

Writely.pushNotify = function(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/favicon.ico' });
    }
};

// Global Exposure
window.logout = Writely.logout;
Writely.registerUser = window.registerUser;
Writely.loginUser = window.loginUser;
window.Writely = Writely;

// ============================================
// 📱 Mobile Navigation — Auto-inject across all pages
// ============================================
(function injectMobileNav() {
    function setupTopNav() {
        document.querySelectorAll('nav').forEach(nav => {
            const links = nav.querySelector('.nav-links');
            if (!links) return;
            if (nav.querySelector('.hamburger-btn')) return;

            const btn = document.createElement('button');
            btn.className = 'hamburger-btn';
            btn.setAttribute('aria-label', 'Toggle menu');
            btn.setAttribute('aria-expanded', 'false');
            btn.innerHTML = '<span></span><span></span><span></span>';

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = links.classList.toggle('open');
                btn.classList.toggle('active', isOpen);
                btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            });

            links.addEventListener('click', (e) => {
                if (e.target.tagName === 'A') {
                    links.classList.remove('open');
                    btn.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');
                }
            });
            document.addEventListener('click', (e) => {
                if (!nav.contains(e.target) && links.classList.contains('open')) {
                    links.classList.remove('open');
                    btn.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');
                }
            });

            const container = nav.querySelector('.container') || nav;
            container.appendChild(btn);
        });
    }

    function setupDashboardSidebar() {
        // Matches sidebars across ALL dashboard pages: seeker, writer, admin, tenant
        const sidebar = document.querySelector(
            'aside.sidebar, .dashboard-sidebar, .admin-sidebar, .tenant-sidebar, .onboarding-sidebar'
        );
        if (!sidebar) return;
        // Main content area — try common class names in order of specificity
        const main = document.querySelector(
            '.main-content, main.main-content, .admin-content, .onboarding-main'
        );
        if (!main) return;
        if (document.querySelector('.dashboard-mobile-topbar')) return;

        // Top bar with menu button (mobile only — CSS hides on desktop)
        const topbar = document.createElement('div');
        topbar.className = 'dashboard-mobile-topbar';
        topbar.innerHTML = `
            <button class="sidebar-toggle-btn" aria-label="Open menu" aria-expanded="false">
                <span></span><span></span><span></span>
            </button>
            <div class="dashboard-mobile-title">Writely</div>
        `;
        main.insertBefore(topbar, main.firstChild);

        // Backdrop overlay
        const backdrop = document.createElement('div');
        backdrop.className = 'sidebar-backdrop';
        document.body.appendChild(backdrop);

        const toggleBtn = topbar.querySelector('.sidebar-toggle-btn');
        const closeSidebar = () => {
            sidebar.classList.remove('open');
            backdrop.classList.remove('open');
            toggleBtn.classList.remove('active');
            toggleBtn.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        };
        const openSidebar = () => {
            sidebar.classList.add('open');
            backdrop.classList.add('open');
            toggleBtn.classList.add('active');
            toggleBtn.setAttribute('aria-expanded', 'true');
            document.body.style.overflow = 'hidden';
        };

        toggleBtn.addEventListener('click', () => {
            if (sidebar.classList.contains('open')) closeSidebar();
            else openSidebar();
        });
        backdrop.addEventListener('click', closeSidebar);
        sidebar.addEventListener('click', (e) => {
            // Close sidebar when user taps any link OR nav-item (tenant_admin uses divs)
            const clickable = e.target.closest('a, .nav-item, .menu-item, .admin-menu-item');
            if (clickable && sidebar.contains(clickable)) closeSidebar();
        });
        // Close on resize back to desktop
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) closeSidebar();
        });
    }

    function getLogoSrc() {
        // Compute path to logo.png relative to current page depth.
        const scriptEl = document.querySelector('script[src*="shared/utils/logic.js"]');
        if (scriptEl) {
            return scriptEl.getAttribute('src').replace(/utils\/logic\.js.*$/, 'assets/logo.png');
        }
        return '/shared/assets/logo.png';
    }

    function replaceLogoMarks() {
        const logoSrc = getLogoSrc();
        document.querySelectorAll('.logo-mark').forEach(mark => {
            mark.innerHTML = `<img src="${logoSrc}" alt="Seekers & Writers" style="width:100%;height:100%;object-fit:cover;object-position:center 38%;transform:scale(2);" />`;
        });
    }

    function setFavicon() {
        const logoSrc = getLogoSrc();
        // Remove any existing favicons to avoid duplicates
        document.querySelectorAll('link[rel*="icon"]').forEach(el => el.remove());
        // Add the new one
        const link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/png';
        link.href = logoSrc;
        document.head.appendChild(link);
        // Also Apple touch icon for iOS bookmarks/PWA
        const apple = document.createElement('link');
        apple.rel = 'apple-touch-icon';
        apple.href = logoSrc;
        document.head.appendChild(apple);
    }

    function setup() {
        setFavicon();
        replaceLogoMarks();
        setupTopNav();
        setupDashboardSidebar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
