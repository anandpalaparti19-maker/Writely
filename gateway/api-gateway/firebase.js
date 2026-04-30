import admin from 'firebase-admin';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let serviceAccount;
try {
    serviceAccount = require('./serviceAccountKey.json');
} catch (err) {
    console.error("❌ ERROR: serviceAccountKey.json not found in gateway/api-gateway/");
    console.error("Please place your Firebase Service Account JSON file here and rename it to serviceAccountKey.json");
    // Fallback to environment variables if available
    serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
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
