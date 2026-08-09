import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
const firebaseConfig={apiKey:"AIzaSyBG6oid29bMq8GVvBkNvPtSDZTRO5K09uk",authDomain:"focus-game-1c7ee.firebaseapp.com",databaseURL:"https://focus-game-1c7ee-default-rtdb.europe-west1.firebasedatabase.app",projectId:"focus-game-1c7ee",storageBucket:"focus-game-1c7ee.firebasestorage.app",messagingSenderId:"856695121197",appId:"1:856695121197:web:294befb970cd8092499fa4"};
const app=initializeApp(firebaseConfig); const db=getDatabase(app); const auth=getAuth(app);
async function ensureAuth(){if(auth.currentUser)return auth.currentUser;const r=await signInAnonymously(auth);return r.user}
export {db,auth,ensureAuth};
