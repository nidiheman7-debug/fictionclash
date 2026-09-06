// Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";
  import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
  import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyBdX_FexQxlPJ_8ZbIUBahDFDoqKHNNfHc",
    authDomain: "fictionclash-c1557.firebaseapp.com",
    projectId: "fictionclash-c1557",
    storageBucket: "fictionclash-c1557.firebasestorage.app",
    messagingSenderId: "675848845904",
    appId: "1:675848845904:web:7fba6d1d91865ddae5ef55",
    measurementId: "G-1RLLEYSBMQ"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);
  const auth = getAuth(app);
  const db = getFirestore(app);

  // Payment endpoints (create-payment, verify-payment, and the Paystack
  // webhook) moved off Vercel to Render — firebase-admin's dependency
  // tree was too heavy for Vercel's serverless function size limit.
  // Everything else (vote, comment, like, etc.) stays on Vercel and
  // uses relative paths as before; only these two calls need the full
  // Render URL.
  window.PAYMENT_API_BASE = 'https://fictionclash-backend.onrender.com';

  // Exposed for the rest of the page's module script to use
  window.firebaseApp = app;
  window.firebaseAnalytics = analytics;
  window.firebaseAuth = auth;
  window.firebaseDb = db;
