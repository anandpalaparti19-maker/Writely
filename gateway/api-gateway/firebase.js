import admin from 'firebase-admin';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let serviceAccount;
try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log("🔐 Loaded Firebase credentials from serviceAccountKey.json (local dev mode)");
} catch (err) {
    // serviceAccountKey.json is gitignored — production uses FIREBASE_SERVICE_ACCOUNT env var instead
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log("🔐 Loaded Firebase credentials from FIREBASE_SERVICE_ACCOUNT env var (production mode)");
        } catch (parseErr) {
            console.error("❌ FIREBASE_SERVICE_ACCOUNT env var is not valid JSON:", parseErr.message);
            serviceAccount = null;
        }
    } else {
        console.error("❌ No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT env var OR add serviceAccountKey.json to gateway/api-gateway/");
        serviceAccount = null;
    }
}

if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://writely-304a8-default-rtdb.firebaseio.com",
    storageBucket: "writely-304a8.firebasestorage.app"
  });
  console.log("✅ Firebase Admin initialized with Service Account (writely-304a8)");
} else if (!admin.apps.length) {
    console.warn("⚠️ Firebase Admin NOT initialized. Please provide serviceAccountKey.json");
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

export { admin, db, bucket };
