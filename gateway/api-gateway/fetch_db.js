import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBZBhQH4t7CDmaZNOZ-_FJufF3JsxmxG6Y",
  authDomain: "writely-3eac3.firebaseapp.com",
  databaseURL: "https://writely-3eac3-default-rtdb.firebaseio.com",
  projectId: "writely-3eac3",
  storageBucket: "writely-3eac3.firebasestorage.app",
  messagingSenderId: "36682383507",
  appId: "1:36682383507:web:d86934945ed79c4dfb8d66",
  measurementId: "G-93GE5VTESZ"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function viewDatabase() {
    console.log("🔍 Connecting to Writely Database (Firestore)...");
    
    try {
        const assignmentsSnap = await getDocs(collection(db, "assignments"));
        
        if (assignmentsSnap.empty) {
            console.log("\n📦 The database is currently EMPTY.");
            console.log("Go to your Dashboard and post an assignment to add data!");
        } else {
            console.log(`\n✅ Found ${assignmentsSnap.size} Assignments in the database:\n`);
            assignmentsSnap.forEach((doc) => {
                console.log(`--- Assignment ID: ${doc.id} ---`);
                console.log(JSON.stringify(doc.data(), null, 2));
                console.log("-----------------------------------\n");
            });
        }
    } catch (error) {
        console.error("\n❌ Error connecting to database:", error.message);
    }
    
    process.exit();
}

viewDatabase();
